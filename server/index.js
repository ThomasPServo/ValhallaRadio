import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { PORT, HOST, ADMIN_PASSWORD, PUBLIC_DIR, UPLOAD_DIR, TTS_CACHE_DIR } from './config.js';
import { store, uid } from './store.js';
import * as mono from './sources/monochrome.js';
import * as library from './scheduler/library.js';
import { Scheduler } from './scheduler/logs.js';
import { Streamer } from './engine/streamer.js';
import { Playout } from './engine/playout.js';
import { probeFfmpeg, loadAudio } from './engine/audio.js';
import { claudeAvailable, claudeStatus, checkClaudeCode, claudeText } from './ai/claude.js';
import { discover } from './ai/musicDirector.js';
import { writeBreak, personaFor, renderImagingText } from './ai/dj.js';
import { designStation, applyDesign } from './ai/programmer.js';
import { synthesize, ttsAvailable, activeProvider } from './voice/tts.js';
import { kokoroStatus, installKokoro, installEvents, KOKORO_VOICES } from './voice/kokoro.js';
import { produceElement } from './audio/production.js';
import { PRESETS, resolveParams } from './audio/processor.js';
import { analyzeTrack, trackDetail } from './audio/trackAnalyzer.js';
import { formatList } from './setup/formats.js';
import { applyFormat, buildLibrary, setupStatus, setupEvents } from './setup/setup.js';
import { geocode, marketWeather, timezoneFor } from './feeds/weather.js';
import { getNews } from './feeds/news.js';
import { getTraffic } from './feeds/traffic.js';
import { zoned, applyMarketTimezone, marketZones, validZone } from './util/time.js';
import { findCleanVersion } from './sources/clean.js';
import { bedList, chosenBedId, bedUrl, bedFile } from './audio/beds.js';
import { BED_STYLES } from './audio/bedSynth.js';
import { createImaging, imagingJobStatus, imagingEvents, startAutoImaging } from './audio/imagingCreator.js';
import { startEnricher, enrichStatus } from './scheduler/enricher.js';
import { CHARTS, FORMAT_CHARTS, stationCharts, getChart, refreshCharts, chartStatus, startChartWatch, sameSong } from './sources/charts.js';
import { songInfo } from './sources/songInfo.js';
import { classifyImaging, imagingName } from './audio/imagingImport.js';
import { startJanitor, forgetSong, janitorStatus } from './scheduler/janitor.js';
import { computePeaks, ensurePeaks, readPeaks } from './audio/peakFile.js';
import { cleanTitle } from './sources/arcod.js';
import { gzipJson, gzipStatic } from './http/compress.js';

const scheduler = new Scheduler();
const streamer = new Streamer();
const engine = new Playout(scheduler, streamer);
const ffmpegVersion = await probeFfmpeg();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// ------------------------------------------------------------------ public routes (no login)
app.get('/stream.mp3', (req, res) => {
  if (!engine.running) return res.status(503).send('Station is off air');
  streamer.handle(req, res);
});
function publicStation() {
  const st = store.station;
  return { name: st.name, callSign: st.callSign, frequency: st.frequency, slogan: st.slogan, logo: st.logo ? `/station-logo?v=${encodeURIComponent(st.logo)}` : null, website: st.website, socials: st.socials, phone: st.phone };
}
app.get('/api/nowplaying', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const s = engine.state();
  res.json({
    station: publicStation(),
    onAir: s.running,
    now: s.now && { title: s.now.title, artist: s.now.artist, artwork: s.now.artwork, type: s.now.type },
    recent: store.data.history.filter((h) => h.type === 'music').slice(-10).reverse().map((h) => ({ title: h.title, artist: h.artist, at: h.at })),
    listeners: s.listeners,
  });
});
app.get('/listen', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'listen.html')));
// Installable on phones and tablets ("Add to Home Screen"), named after the station.
app.get('/manifest.webmanifest', (req, res) => {
  const st = store.station;
  const logo = st.logo ? [{ src: `/station-logo?v=${encodeURIComponent(st.logo)}`, sizes: '512x512', purpose: 'any' }] : [];
  res.type('application/manifest+json').json({
    name: `${st.name || 'Valhalla'} Studio`, short_name: st.name || 'Studio', start_url: '/#studio', scope: '/', display: 'standalone',
    background_color: '#07090d', theme_color: '#07090d',
    icons: [...logo, { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  });
});
app.get('/icon.svg', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'icon.svg')));
app.get('/station-logo', (req, res) => {
  const f = store.station.logo && path.join(UPLOAD_DIR, store.station.logo);
  if (f && fs.existsSync(f)) return res.sendFile(f);
  res.status(404).end();
});

// ------------------------------------------------------------------ admin auth
function checkAuth(req) {
  if (!ADMIN_PASSWORD) return true;
  const h = req.headers.authorization || '';
  const [, b64] = h.split(' ');
  const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  const a = Buffer.from(crypto.createHash('sha256').update(pass).digest('hex'));
  const b = Buffer.from(crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex'));
  return crypto.timingSafeEqual(a, b);
}
app.use((req, res, next) => {
  if (checkAuth(req)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Valhalla Studio"').status(401).send('Authentication required');
});

app.use(gzipStatic(PUBLIC_DIR)); // the studio's files, pre-compressed in memory
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/tts', express.static(TTS_CACHE_DIR));
app.use(express.json({ limit: '5mb' }));
app.use(gzipJson); // big JSON responses gzipped off the main thread

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error('[api]', req.method, req.path, err.message);
  res.status(err.status || 500).json({ error: err.message });
});
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

// ------------------------------------------------------------------ bootstrap / state
function capabilities() {
  return {
    ffmpeg: ffmpegVersion,
    claude: claudeAvailable(),
    ai: claudeStatus(),
    tts: ttsAvailable(),
    voice: { provider: activeProvider(), kokoro: kokoroStatus() },
    traffic: true, // keyless: DOT work-zone feeds, public dispatch feeds and local headlines
  };
}

function bootstrap() {
  const d = store.data;
  return {
    station: d.station,
    settings: store.publicSettings(),
    stream: { ...d.stream, icecast: { ...d.stream.icecast, password: d.stream.icecast.password ? '••••' : '' } },
    categories: d.categories,
    rotation: d.rotation,
    clocks: d.clocks,
    grid: d.grid,
    dayparts: d.dayparts,
    personas: d.personas,
    imaging: d.imaging,
    advertisers: d.advertisers,
    spots: d.spots,
    processing: { ...d.processing, params: resolveParams(d.processing?.preset, d.processing?.overrides), presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, { name: v.name, description: v.description }])) },
    libraryCount: d.library.length,
    explicitCount: d.library.filter((t) => t.explicit && !t.disabled).length,
    songFacts: { ...enrichStatus },
    charts: { available: Object.entries(CHARTS).map(([id, c]) => ({ id, name: c.name })), station: stationCharts(), formatDefault: FORMAT_CHARTS[d.station.formatId]?.charts || ['hot100'], status: chartStatus },
    marketZones: marketZones(d.station),
    formats: formatList(),
    kokoroVoices: KOKORO_VOICES,
    capabilities: capabilities(),
  };
}
app.get('/api/bootstrap', wrap(async (req, res) => { await checkClaudeCode(); res.json(bootstrap()); }));
app.get('/api/state', (req, res) => res.json({ ...engine.state(), ...engine.decksState() }));
app.get('/api/timeline', (req, res) => res.json(engine.timeline()));
app.get('/api/peaks/:id', (req, res) => {
  const p = engine.peaksFor(req.params.id);
  if (!p) return res.status(404).json({ error: 'no waveform yet' });
  res.json(p);
});

// ------------------------------------------------------------------ setup wizard
app.get('/api/setup/status', (req, res) => res.json(setupStatus()));
app.post('/api/setup', wrap(async (req, res) => {
  const { station = {}, formatId, locations = [], startOnAir = false, cleanOnly } = req.body;
  if (!formatId) throw bad('pick a format');
  if (cleanOnly !== undefined) store.settings.cleanOnly = Boolean(cleanOnly);
  if (!String(station.name || '').trim()) throw bad('your station needs a name');
  applyFormat(formatId, station);
  for (const name of locations.filter(Boolean)) {
    try {
      const g = await geocode(name);
      if (g) store.data.station.market.locations.push(g);
    } catch (err) { console.warn('[setup] geocode', name, err.message); }
  }
  if (station.timezone && validZone(station.timezone)) { store.data.station.timezone = station.timezone; store.data.station.timezoneMode = 'manual'; }
  applyMarketTimezone(store.data.station);
  store.save();
  bedFile(chosenBedId()).then(() => engine.running && engine.reloadBed()).catch(() => {}); // the format's bed, rendered ahead of time
  for (const k of [...scheduler.logs.keys()]) if (!scheduler.logs.get(k).items.some((i) => i.status === 'playing')) scheduler.logs.delete(k);
  const job = buildLibrary(formatId);
  let early = false; // on air before the whole library was in
  if (startOnAir) {
    // on air once there's variety for a proper first hour (a dozen artists), or when the build is done
    const go = (p) => {
      const artists = new Set(store.data.library.map((t) => String(t.artist).split(/,|\s+(?:feat\.?|ft\.|&|x)\s+/i)[0].trim().toLowerCase())).size;
      const ready = store.data.library.length >= 15 && (artists >= 12 || p.done);
      if (ready && !engine.running && ffmpegVersion) { early = !p.done; engine.start(); }
      if (ready || p.done) setupEvents.off('progress', go);
    };
    setupEvents.on('progress', go);
  }
  // the coming hour, if it was planned while the library was still coming in, is planned again from all of it
  const replan = (p) => {
    if (!p.done) return;
    setupEvents.off('progress', replan);
    if (early && engine.running) scheduler.replanNext().catch((err) => console.warn('[setup] re-plan', err.message));
  };
  setupEvents.on('progress', replan);
  res.json({ ...bootstrap(), job });
}));

// ------------------------------------------------------------------ engine / live assist
app.post('/api/engine/start', wrap(async (req, res) => {
  if (!ffmpegVersion) throw bad('ffmpeg is not installed — it is required for playout and streaming.');
  if (!store.data.library.length && !claudeAvailable()) throw bad('The music library is empty. Run the setup wizard or add music from monochrome (Library).');
  await engine.start();
  res.json(engine.state());
}));
app.post('/api/engine/stop', (req, res) => { engine.stop(); res.json(engine.state()); });
app.post('/api/engine/skip', (req, res) => { engine.skip(); res.json({ ok: true }); });

app.get('/api/log', wrap(async (req, res) => {
  if (!scheduler.logs.size && req.query.ensure) await scheduler.ensure();
  res.json(scheduler.snapshot());
}));
app.post('/api/log/build', wrap(async (req, res) => { await scheduler.ensure(); res.json(scheduler.snapshot()); }));
app.post('/api/log/regenerate', wrap(async (req, res) => { await scheduler.regenerate(req.body.hourKey); res.json(scheduler.snapshot()); }));
app.post('/api/log/insert', wrap(async (req, res) => {
  const b = req.body;
  let partial;
  if (b.trackId) {
    let t = library.findTrack(b.trackId);
    if (!t && b.track) t = await library.addTrack(b.track, b.category || 'N'); // swaps to the clean version if needed
    if (!t) throw bad('unknown track');
    if (library.cleanOnly() && t.explicit) {
      const clean = await findCleanVersion(t);
      if (!clean) throw bad(`"${t.title}" only exists as an explicit version (clean versions only is on)`);
      t = await library.addTrack(clean, t.category);
    }
    partial = { type: 'music', category: t.category, trackId: t.id, title: t.title, artist: t.artist, artwork: t.artwork, duration: t.duration, why: 'inserted by operator' };
  } else if (b.imagingId) {
    const im = store.data.imaging.items.find((i) => i.id === b.imagingId);
    if (!im) throw bad('unknown imaging item');
    if (im.type === 'bed') throw bad('beds play automatically under talk (or fire one as a cart)');
    partial = { type: im.type, imagingId: im.id, title: im.name, artist: 'Imaging' };
  } else if (b.script) {
    partial = { type: 'say', script: String(b.script), title: 'Live Read', persona: b.persona || personaFor(Date.now())?.name };
  } else if (['dj', 'weather', 'traffic', 'news'].includes(b.type)) {
    partial = { type: b.type, mode: b.mode || 'auto', title: { dj: 'DJ Break', weather: 'Weather', traffic: 'Traffic', news: 'Newscast' }[b.type] };
  } else throw bad('nothing to insert');
  const it = scheduler.insertNext(partial);
  if (!it) throw bad('no active log — go on air or build the log first');
  res.json(it);
}));
app.post('/api/log/:id/remove', (req, res) => { scheduler.remove(req.params.id); res.json({ ok: true }); });
app.post('/api/log/:id/move', (req, res) => { scheduler.move(req.params.id, Number(req.body.dir)); res.json({ ok: true }); });
app.post('/api/log/:id/moveTo', (req, res) => { scheduler.moveTo(req.params.id, req.body.beforeId); res.json({ ok: true }); });
app.post('/api/carts/:id/fire', wrap(async (req, res) => {
  if (!engine.running) throw bad('station is off air');
  await engine.fireCart(req.params.id);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ processing (engineering)
app.get('/api/processing', (req, res) => res.json(bootstrap().processing));
app.put('/api/processing', (req, res) => {
  const { preset, overrides, bypass } = req.body;
  const cur = store.data.processing || {};
  const next = { preset: preset || cur.preset || 'streaming', overrides: overrides ?? (preset && preset !== cur.preset ? {} : cur.overrides || {}) };
  if (bypass !== undefined) next.overrides = { ...next.overrides, bypass: Boolean(bypass) };
  engine.setProcessing(next);
  res.json(bootstrap().processing);
});

// ------------------------------------------------------------------ monochrome + library
app.get('/api/monochrome/search', wrap(async (req, res) => res.json(await mono.search(req.query.q))));
app.get('/api/monochrome/tracks', wrap(async (req, res) => res.json(await mono.searchTracks(req.query.q, Number(req.query.limit) || 25))));
app.get('/api/monochrome/artist/:id', wrap(async (req, res) => res.json(await mono.getArtist(req.params.id))));
app.get('/api/monochrome/release/:id', wrap(async (req, res) => res.json(await mono.getRelease(req.params.id))));
// Song previews in the studio: from the cache, or from a chunked fetch as it fills (one direct connection to the origin is too slow for FLAC)
app.get('/api/monochrome/stream/:id', wrap(async (req, res) => {
  const id = String(req.params.id).replace(/[^\w-]/g, '');
  const typeOf = (head) => (head.subarray(0, 4).toString('latin1') === 'fLaC' ? 'audio/flac' : 'audio/mpeg'); // FLAC (monochrome, arcod lossless) or MP3 (arcod 320)
  if (mono.isCached(id)) {
    const fd = fs.openSync(mono.cachedPath(id), 'r'); const head = Buffer.alloc(4); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
    return res.type(typeOf(head)).sendFile(mono.cachedPath(id));
  }
  const f = mono.fetchTrack(id, { priority: 100 });
  // arcod delivers a whole song in a second or two: wait for it and send the file, so the player can scrub
  if (mono.musicSource() === 'arcod') {
    const file = await Promise.race([f.done.catch(() => null), new Promise((r) => setTimeout(r, 20_000, null))]);
    if (file && mono.isCached(id)) {
      const fd = fs.openSync(file, 'r'); const head = Buffer.alloc(4); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
      return res.type(typeOf(head)).sendFile(file);
    }
  }
  let gone = false;
  req.on('close', () => { gone = true; });
  try {
    for await (const chunk of f.read(0)) {
      if (gone) break;
      if (!res.headersSent) res.type(typeOf(chunk));
      if (!res.write(chunk)) {
        await new Promise((r) => {
          const done = () => { res.off('drain', done); res.off('close', done); r(); };
          res.once('drain', done); res.once('close', done);
        });
      }
    }
    res.end();
  } catch { res.destroy(); }
}));

/** What a library table row shows (the full entries, with analysis, facts and lyric timing, are ~10x bigger). */
function libraryRow(t) {
  const m = t.markers; const ly = t.lyrics; const a = t.analysis; const f = t.facts;
  return {
    id: t.id, title: t.title, artist: t.artist, album: t.album, year: t.year, artwork: t.artwork, category: t.category,
    explicit: t.explicit, note: t.note, disabled: t.disabled, plays: t.plays, lastPlayed: t.lastPlayed,
    chart: t.chart ? { rank: t.chart.rank, chart: t.chart.chart } : undefined,
    chartPeak: t.chartPeak ? { peak: t.chartPeak.peak, chart: t.chartPeak.chart } : undefined,
    facts: f ? { genre: f.genre, voice: f.voice, popularity: f.popularity } : undefined,
    markers: m ? { intro: m.intro, instrumental: m.instrumental, endType: m.endType } : undefined,
    lyrics: ly ? { status: ly.status, vocalStart: ly.vocalStart } : undefined,
    analysis: a ? { startSec: a.startSec, endType: a.endType, headTempo: a.headTempo?.bpm ? { bpm: a.headTempo.bpm } : undefined } : undefined,
  };
}
const collator = new Intl.Collator(); // same order as localeCompare, without building a collator per comparison
app.get('/api/library', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const cat = req.query.category;
  let items = store.data.library;
  if (cat) items = items.filter((t) => t.category === cat);
  if (q) items = items.filter((t) => `${t.artist} ${t.title} ${t.album}`.toLowerCase().includes(q));
  items = items.slice().sort((a, b) => collator.compare(a.artist, b.artist) || collator.compare(a.title, b.title));
  res.json(req.query.full ? items : items.map(libraryRow));
});
async function addMany(tracks, category) {
  const added = []; const skipped = [];
  for (const t of tracks.filter(Boolean)) {
    try {
      const e = await library.addTrack(t, category || 'N');
      if (!added.includes(e)) added.push(e);
    } catch (err) {
      if (err.code !== 'EXPLICIT') throw err;
      skipped.push({ title: t.title, artist: t.artist, reason: 'explicit only' });
    }
  }
  return { added, skipped, swapped: added.filter((e) => e.note === 'clean version').length };
}
app.post('/api/library', wrap(async (req, res) => {
  const tracks = Array.isArray(req.body.tracks) ? req.body.tracks : [req.body.track];
  res.json(await addMany(tracks, req.body.category));
}));
app.post('/api/library/import', wrap(async (req, res) => {
  const { kind, id, category, limit } = req.body;
  const src = kind === 'artist' ? (await mono.getArtist(id)).topTracks : (await mono.getRelease(id)).tracks;
  res.json(await addMany(src.slice(0, Number(limit) || 10), category));
}));
let sweepStatus = null;
function startCleanSweep() {
  if (sweepStatus?.running) return sweepStatus;
  sweepStatus = { running: true, checked: 0, replaced: 0, disabled: 0, done: 0 };
  library.cleanSweep((p) => { sweepStatus = { ...p, running: true }; broadcast('cleanSweep', sweepStatus); })
    .then((r) => { sweepStatus = { ...r, running: false }; broadcast('cleanSweep', sweepStatus); })
    .catch((err) => { sweepStatus = { running: false, error: err.message }; broadcast('cleanSweep', sweepStatus); });
  return sweepStatus;
}
app.post('/api/library/clean', (req, res) => res.json(startCleanSweep()));
app.get('/api/library/clean', (req, res) => res.json(sweepStatus || { running: false }));
app.post('/api/library/discover', wrap(async (req, res) => res.json(await discover(req.body || {}))));
app.get('/api/songinfo', wrap(async (req, res) => {
  const { artist, title } = req.query;
  if (!artist || !title) throw bad('artist and title are required');
  res.json(await songInfo({ artist: String(artist), title: String(title) }));
}));

// ------------------------------------------------------------------ charts
app.get('/api/charts/:id', wrap(async (req, res) => {
  const c = await getChart(req.params.id, { date: req.query.date ? String(req.query.date) : null });
  const lib = store.data.library;
  res.json({ ...c, entries: c.entries.map((e) => { const t = lib.find((x) => sameSong(x, e)); return { ...e, trackId: t?.id || null, category: t?.category || null }; }) });
}));
/** The whole waveform of anything the studio can preview: uploads, rendered audio, songs. */
app.get('/api/waveform', wrap(async (req, res) => {
  const src = String(req.query.src || '');
  let peaks = null;
  const song = /^\/api\/monochrome\/stream\/([\w-]+)$/.exec(src);
  if (song) {
    const id = song[1];
    peaks = readPeaks(id);
    if (!peaks) {
      if (!mono.isCached(id)) await mono.download(id).catch(() => null);
      if (mono.isCached(id)) { await ensurePeaks(id, mono.cachedPath(id)); peaks = readPeaks(id); }
    }
  } else {
    const m = /^\/(uploads|tts)\/([\w.-]+)$/.exec(src.split('?')[0]);
    if (!m) throw bad('unknown audio');
    const file = path.join(m[1] === 'uploads' ? UPLOAD_DIR : TTS_CACHE_DIR, m[2]);
    if (!fs.existsSync(file)) throw Object.assign(new Error('not found'), { status: 404 });
    peaks = await computePeaks(file);
  }
  if (!peaks) throw Object.assign(new Error('no waveform yet'), { status: 404 });
  res.json({ res: 0.05, data: Buffer.from(peaks.buffer, peaks.byteOffset, peaks.byteLength).toString('base64') });
}));

app.post('/api/charts/refresh', wrap(async (req, res) => res.json(await refreshCharts())));
app.post('/api/charts/add', wrap(async (req, res) => {
  const songs = (req.body.songs || []).slice(0, 50);
  const added = []; const missed = [];
  for (const s of songs) {
    try {
      const t = await mono.resolveSuggestion(s);
      if (!t) { missed.push(`${s.artist} - ${s.title}`); continue; }
      const e = await library.addTrack(t, req.body.category || 'N', { note: s.note || '' });
      added.push(e);
    } catch (err) { missed.push(`${s.artist} - ${s.title} (${err.code === 'EXPLICIT' ? 'explicit only' : err.message})`); }
  }
  if (added.length) refreshCharts().catch(() => {});
  res.json({ added, missed });
}));

app.get('/api/library/:id/detail', (req, res) => {
  const d = trackDetail(req.params.id);
  if (!d) return res.status(404).json({ error: 'unknown track' });
  res.json(d);
});
app.post('/api/library/:id/analyze', wrap(async (req, res) => res.json(await analyzeTrack(req.params.id))));
app.put('/api/library/:id/markers', (req, res) => {
  const m = {};
  for (const k of ['intro', 'outro', 'mixOut']) if (req.body[k] !== undefined && req.body[k] !== null && req.body[k] !== '') m[k] = Number(req.body[k]);
  if (['cold', 'fade'].includes(req.body.endType)) m.endType = req.body.endType;
  if (req.body.instrumental) m.instrumental = true;
  res.json(library.updateTrack(req.params.id, { markers: m }));
});
app.patch('/api/library/:id', (req, res) => res.json(library.updateTrack(req.params.id, req.body)));
app.delete('/api/library/:id', (req, res) => { library.removeTrack(req.params.id); forgetSong(req.params.id, scheduler.allItems()); res.json({ ok: true }); });

// ------------------------------------------------------------------ configuration
const sections = {
  station: (v) => {
    const st = store.data.station;
    if (v.timezone && !validZone(v.timezone)) throw bad(`unknown time zone "${v.timezone}"`);
    Object.assign(st, v, { market: { ...st.market, ...(v.market || {}) }, socials: { ...st.socials, ...(v.socials || {}) } });
    if (st.timezoneMode === 'auto') applyMarketTimezone(st);
  },
  stream: (v) => {
    const ic = { ...store.data.stream.icecast, ...(v.icecast || {}) };
    if (v.icecast?.password === '••••') ic.password = store.data.stream.icecast.password;
    store.data.stream = { ...store.data.stream, ...v, icecast: ic };
    if (engine.running) streamer.restartIcecast();
  },
  categories: (v) => { store.data.categories = v; },
  rotation: (v) => { store.data.rotation = { ...store.data.rotation, ...v }; },
  clocks: (v) => { store.data.clocks = v; },
  grid: (v) => { store.data.grid = v; },
  dayparts: (v) => { store.data.dayparts = v; },
  personas: (v) => { store.data.personas = v; },
  imaging: (v) => { store.data.imaging = v; },
  advertisers: (v) => { store.data.advertisers = v; },
  spots: (v) => { store.data.spots = v; },
};
app.put('/api/settings', wrap(async (req, res) => {
  const wasClean = library.cleanOnly();
  if (req.body.autoBed) req.body.autoBed = { ...store.settings.autoBed, ...req.body.autoBed };
  if (req.body.autoImaging) req.body.autoImaging = { ...store.settings.autoImaging, ...req.body.autoImaging, lastRun: store.settings.autoImaging?.lastRun || 0 };
  store.updateSettings(req.body);
  if (!wasClean && library.cleanOnly()) startCleanSweep(); // swap explicit songs for radio edits
  if (req.body.autoBed && engine.running) engine.reloadBed();
  if (req.body.charts || req.body.chartRotation !== undefined) refreshCharts().catch(() => {});
  await checkClaudeCode(true);
  res.json(bootstrap());
}));
app.put('/api/:section', (req, res) => {
  const fn = sections[req.params.section];
  if (!fn) return res.status(404).json({ error: 'unknown section' });
  if (Array.isArray(req.body)) for (const x of req.body) if (x && typeof x === 'object' && !x.id && req.params.section !== 'grid') x.id = uid();
  if (req.params.section === 'imaging') for (const x of req.body.items || []) if (!x.id) x.id = uid('img_');
  fn(req.body);
  store.save();
  if (['imaging', 'station'].includes(req.params.section) && engine.running) engine.reloadBed(); // uploaded beds / format may change the bed
  res.json(bootstrap());
});

// ------------------------------------------------------------------ auto-sweeper creator
app.get('/api/imaging/create', (req, res) => res.json(imagingJobStatus()));
app.post('/api/imaging/create', wrap(async (req, res) => {
  const count = Math.max(1, Math.min(20, Number(req.body.count) || 6));
  if (imagingJobStatus().running) throw Object.assign(new Error('already writing imaging'), { status: 409 });
  createImaging({ count, guidance: String(req.body.guidance || '').slice(0, 600) });
  res.json(imagingJobStatus());
}));
imagingEvents.on('progress', (p) => { broadcast('imagingJob', p); if (p.done) broadcast('bootstrap', bootstrap()); });

// ------------------------------------------------------------------ auto-bed
app.get('/api/beds', (req, res) => res.json({ beds: bedList(), chosen: chosenBedId(), settings: store.settings.autoBed, styles: BED_STYLES }));
app.post('/api/beds/preview', wrap(async (req, res) => {
  const id = String(req.body.id || chosenBedId());
  res.json({ id, audio: await bedUrl(id) });
}));

app.post('/api/market/locations', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) throw bad('location name required');
  const g = await geocode(name);
  if (!g) throw bad(`could not find "${name}"`);
  store.data.station.market.locations.push(g);
  applyMarketTimezone(store.data.station); // the station clock follows the primary market location
  store.save();
  res.json(bootstrap());
}));
app.delete('/api/market/locations/:idx', (req, res) => {
  store.data.station.market.locations.splice(Number(req.params.idx), 1);
  applyMarketTimezone(store.data.station);
  store.save();
  res.json(bootstrap());
});
app.post('/api/market/primary', (req, res) => {
  const locs = store.data.station.market.locations;
  const i = Number(req.body.idx);
  if (locs[i]) locs.unshift(...locs.splice(i, 1));
  applyMarketTimezone(store.data.station);
  store.save();
  res.json(bootstrap());
});

// ------------------------------------------------------------------ AI & voice
app.get('/api/ai/status', wrap(async (req, res) => { await checkClaudeCode(true); res.json(claudeStatus()); }));
app.post('/api/ai/test', wrap(async (req, res) => {
  const t0 = Date.now();
  const text = await claudeText({ system: 'You are a radio DJ. Reply with one short, natural sentence.', prompt: `Say hi to the listeners of ${store.station.name}.`, maxTokens: 200, effort: 'low' });
  res.json({ text, ms: Date.now() - t0, status: claudeStatus() });
}));
app.get('/api/voice/status', (req, res) => res.json({ provider: activeProvider(), available: ttsAvailable(), kokoro: kokoroStatus() }));
app.post('/api/voice/kokoro/install', wrap(async (req, res) => {
  installKokoro().then(() => broadcast('voiceInstall', { done: true, status: kokoroStatus() })).catch((err) => broadcast('voiceInstall', { done: true, error: err.message }));
  res.json({ started: true });
}));
installEvents.on('progress', (line) => broadcast('voiceInstall', { line }));

app.get('/api/feeds/weather', wrap(async (req, res) => res.json(await marketWeather())));
app.get('/api/feeds/news', wrap(async (req, res) => res.json(await getNews())));
app.get('/api/feeds/traffic', wrap(async (req, res) => res.json(await getTraffic())));

app.post('/api/dj/preview', wrap(async (req, res) => {
  const kind = req.body.kind || 'auto';
  const hist = store.data.history.filter((h) => h.type === 'music').slice(-2).map((h) => library.findTrack(h.trackId) || h);
  const lib = store.data.library;
  const previous = hist.length ? hist : lib.slice(0, 1);
  const next = lib.length ? lib[Math.floor(Math.random() * lib.length)] : null;
  const talkWindow = next?.lyrics?.status === 'found' ? next.lyrics.vocalStart : null;
  const out = await writeBreak({ kind, previous, next, at: Date.now(), talkWindow });
  let audio = null;
  if (ttsAvailable() && req.body.voice !== false) {
    const type = ['weather', 'traffic', 'news'].includes(kind) ? kind : 'dj';
    const el = await produceElement({ type, script: out.text, persona: out.persona?.name });
    audio = '/tts/' + path.basename(el.file);
  }
  res.json({ text: out.text, persona: out.persona?.name, audio });
}));
app.post('/api/tts/preview', wrap(async (req, res) => {
  const { text, voice, imaging, imagingId } = req.body;
  if (imagingId) {
    const el = await produceElement({ type: store.data.imaging.items.find((i) => i.id === imagingId)?.type, imagingId });
    return res.json({ audio: el.file.startsWith(UPLOAD_DIR) ? `/uploads/${path.basename(el.file)}` : `/tts/${path.basename(el.file)}`, markers: el.markers });
  }
  const spoken = imaging ? renderImagingText(text) : text;
  const file = await synthesize(spoken, voice || store.data.imaging.voice);
  const a = await loadAudio(file, { normalize: false });
  res.json({ audio: '/tts/' + path.basename(file), duration: a.durationSec });
}));
app.post('/api/ai/design', wrap(async (req, res) => {
  if (!req.body.brief) throw bad('describe the station you want');
  res.json(await designStation(req.body.brief));
}));
app.post('/api/ai/design/apply', wrap(async (req, res) => {
  applyDesign(req.body.design);
  for (const k of [...scheduler.logs.keys()]) if (!scheduler.logs.get(k).items.some((i) => i.status === 'playing')) scheduler.logs.delete(k);
  res.json(bootstrap());
}));

// ------------------------------------------------------------------ uploads
app.post('/api/upload', express.raw({ type: '*/*', limit: '60mb' }), wrap(async (req, res) => {
  const original = String(req.query.name || 'audio').replace(/[^\w.\-]/g, '_');
  const ext = path.extname(original) || '.mp3';
  const file = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), req.body);
  try {
    const a = await loadAudio(path.join(UPLOAD_DIR, file), { normalize: false });
    res.json({ file, duration: Math.round(a.durationSec * 10) / 10 });
  } catch (err) {
    fs.rmSync(path.join(UPLOAD_DIR, file), { force: true });
    console.warn('[upload] rejected:', err.message);
    throw bad('Not a playable audio file.');
  }
}));
/** Import a produced imaging file (one per request): stored, checked, typed from its name and added to the library. */
app.post('/api/imaging/import', express.raw({ type: '*/*', limit: '60mb' }), wrap(async (req, res) => {
  const original = String(req.query.name || 'imaging.mp3');
  const ext = (path.extname(original).toLowerCase().match(/^\.[a-z0-9]{2,4}$/) || ['.mp3'])[0];
  if (!req.body?.length) throw bad('empty file');
  const file = `img_${Date.now()}_${crypto.randomBytes(3).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), req.body);
  let a;
  try { a = await loadAudio(path.join(UPLOAD_DIR, file), { normalize: false }); } catch (err) {
    fs.rmSync(path.join(UPLOAD_DIR, file), { force: true });
    throw bad(`${path.basename(original)} is not a playable audio file`);
  }
  const duration = Math.round(a.durationSec * 10) / 10;
  const type = ['toh_id', 'id', 'sweeper', 'liner', 'promo', 'bed'].includes(req.query.type) ? req.query.type : classifyImaging(original, duration);
  const item = { id: uid('img_'), type, name: imagingName(original), text: '', file, enabled: true, imported: true, duration, importedAt: Date.now() };
  store.data.imaging.items.push(item);
  store.save();
  if (type === 'bed' && engine.running) engine.reloadBed();
  res.json({ item });
}));
app.post('/api/station/logo', express.raw({ type: 'image/*', limit: '8mb' }), wrap(async (req, res) => {
  const type = String(req.headers['content-type'] || '');
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/gif': '.gif' }[type];
  if (!ext || !req.body?.length) throw bad('upload a PNG, JPEG, WebP, GIF or SVG image');
  const file = `logo_${Date.now()}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), req.body);
  store.data.station.logo = file;
  store.save();
  res.json(bootstrap());
}));

// ------------------------------------------------------------------ reports
app.get('/api/history', (req, res) => {
  const type = req.query.type;
  const limit = Number(req.query.limit) || 200;
  let h = store.data.history;
  if (type) h = h.filter((x) => x.type === type);
  res.json(h.slice(-limit).reverse());
});
app.get('/api/reports/affidavit', (req, res) => {
  const date = req.query.date || zoned(new Date(), store.station.timezone).dateKey;
  const plays = store.data.history.filter((h) => h.type === 'spot' && zoned(new Date(h.at), store.station.timezone).dateKey === date);
  res.json({ date, plays, totals: store.data.spotLog[date] || {} });
});

// ------------------------------------------------------------------ websocket
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws') || !checkAuth(req)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.topics = new Set();
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'sub') {
        const had = ws.topics;
        ws.topics = new Set(m.topics || []);
        countWatchers();
        // a screen that just opened gets the current picture now rather than at the next update
        if (!had.has('timeline') && ws.topics.has('timeline')) ws.send(JSON.stringify({ type: 'timeline', data: engine.timeline() }));
        if (!had.has('decks') && ws.topics.has('decks')) ws.send(JSON.stringify({ type: 'decks', data: engine.decksState() }));
      }
      if (m.type === 'peaks') {
        const p = engine.peaksFor(m.id);
        if (p) ws.send(JSON.stringify({ type: 'peaks', data: p }));
      }
    });
    ws.on('close', countWatchers);
    ws.send(JSON.stringify({ type: 'state', data: engine.state() }));
    ws.send(JSON.stringify({ type: 'log', data: scheduler.snapshot() }));
  });
});
/** Live feeds (meters, scope, timeline) are computed and sent only while some screen shows them. */
function countWatchers() {
  const n = { level: 0, meters: 0, scope: 0, timeline: 0, decks: 0 };
  for (const c of wss.clients) if (c.readyState === 1) for (const t of c.topics) if (t in n) n[t]++;
  engine.watch(n);
}
function broadcast(type, data, topic) {
  const msg = JSON.stringify({ type, data });
  for (const c of wss.clients) if (c.readyState === 1 && (!topic || c.topics?.has(topic))) c.send(msg);
}
let logTimer = null;
const logChanged = () => {
  clearTimeout(logTimer);
  logTimer = setTimeout(() => broadcast('log', scheduler.snapshot()), 150);
};
scheduler.onChange = () => { engine.onLogChange(); logChanged(); };
engine.on('log', logChanged);
engine.on('state', (s) => broadcast('state', s));
engine.on('timeline', (t) => broadcast('timeline', t, 'timeline'));
engine.on('meters', (m) => broadcast('meters', m, 'meters'));
engine.on('scope', (m) => broadcast('scope', m, 'scope'));
engine.on('decks', (d) => broadcast('decks', d, 'decks'));
engine.on('nowPlaying', (i) => { broadcast('nowPlaying', i); logChanged(); });
setupEvents.on('progress', (p) => broadcast('setup', p));
setInterval(() => { if (engine.running && engine.watchers.level) broadcast('level', engine.level, 'level'); }, 80);

// locations saved before zones (and states, for traffic feeds) were tracked get them now (offline lookup)
{
  let changed = false;
  for (const l of store.data.station.market.locations) {
    if (!l.timezone && Number.isFinite(l.lat)) { l.timezone = timezoneFor(l.lat, l.lon); changed ||= Boolean(l.timezone); }
    if (!l.state && /, (US|PR)$/.test(l.name || '')) { l.state = l.name.split(',').map((x) => x.trim())[1] || ''; changed = true; }
  }
  if (changed) { applyMarketTimezone(store.data.station); store.save(); }
}

{ // catalogue labels ("(2001 Remaster)") out of song titles the DJ reads
  let n = 0;
  for (const t of store.data.library) { const c = cleanTitle(t.title); if (c && c !== t.title) { t.title = c; n++; } }
  if (n) { store.save(); console.log(`[library] cleaned ${n} song title(s)`); }
}
{ const fixed = library.repairYears(); if (fixed) console.log(`[library] corrected the year of ${fixed} song(s) released on compilations`); }
if (store.station.setupComplete) bedFile(chosenBedId()).catch((err) => console.warn('[bed]', err.message)); // render the bed in the background
const imagingCheck = startAutoImaging();
mono.startCacheWarmer(() => library.playable()); // fill the cache with the library while nothing urgent is fetching
startJanitor(() => scheduler.allItems()); // delete files nothing needs any more
startChartWatch(); // this station's charts: chart positions, peaks and chart-driven rotation
startEnricher(); // song facts (genre, original year, popularity, tempo, vocal) from open music data
setupEvents.on('progress', (p) => { if (p.done) setTimeout(imagingCheck, 5000); }); // a new station's first fresh imaging, once its library is in

server.listen(PORT, HOST, () => {
  console.log(`\n  Valhalla studio   →  http://localhost:${PORT}`);
  console.log(`  Station stream    →  http://localhost:${PORT}/stream.mp3`);
  console.log(`  Listener page     →  http://localhost:${PORT}/listen`);
  console.log(`  ffmpeg: ${ffmpegVersion ? 'ok' : 'NOT FOUND (required)'} | voice: ${activeProvider()} | station: ${store.station.setupComplete ? store.station.name : 'not set up yet (open the studio)'}\n`);
  if (process.env.AUTOSTART === '1' && ffmpegVersion && store.data.library.length) engine.start();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.flush();
    engine.stop();
    process.exit(0);
  });
}
