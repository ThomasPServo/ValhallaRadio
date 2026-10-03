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
import { claudeAvailable } from './ai/claude.js';
import { discover } from './ai/musicDirector.js';
import { writeBreak, personaFor, renderImagingText } from './ai/dj.js';
import { designStation, applyDesign } from './ai/programmer.js';
import { synthesize, ttsAvailable } from './voice/tts.js';
import { geocode, marketWeather } from './feeds/weather.js';
import { getNews } from './feeds/news.js';
import { getTraffic } from './feeds/traffic.js';
import { zoned } from './util/time.js';

const scheduler = new Scheduler();
const streamer = new Streamer();
const engine = new Playout(scheduler, streamer);
const ffmpegVersion = await probeFfmpeg();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// ------------------------------------------------------------------ public routes
app.get('/stream.mp3', (req, res) => {
  if (!engine.running) return res.status(503).send('Station is off air');
  streamer.handle(req, res);
});
app.get('/api/nowplaying', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const s = engine.state();
  const st = store.station;
  res.json({
    station: { name: st.name, callSign: st.callSign, frequency: st.frequency, slogan: st.slogan },
    onAir: s.running,
    now: s.now && { title: s.now.title, artist: s.now.artist, artwork: s.now.artwork, type: s.now.type },
    recent: store.data.history.filter((h) => h.type === 'music').slice(-10).reverse().map((h) => ({ title: h.title, artist: h.artist, at: h.at })),
    listeners: s.listeners,
  });
});
app.get('/listen', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'listen.html')));

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
  res.set('WWW-Authenticate', 'Basic realm="Valhalla Radio Studio"').status(401).send('Authentication required');
});

app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/tts', express.static(TTS_CACHE_DIR));
app.use(express.json({ limit: '5mb' }));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error('[api]', req.method, req.path, err.message);
  res.status(err.status || 500).json({ error: err.message });
});
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

// ------------------------------------------------------------------ bootstrap / state
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
    libraryCount: d.library.length,
    capabilities: { ffmpeg: ffmpegVersion, claude: claudeAvailable(), tts: ttsAvailable(), traffic: Boolean(d.settings.tomtomApiKey) },
  };
}
app.get('/api/bootstrap', (req, res) => res.json(bootstrap()));
app.get('/api/state', (req, res) => res.json(engine.state()));

// ------------------------------------------------------------------ engine / live assist
app.post('/api/engine/start', wrap(async (req, res) => {
  if (!ffmpegVersion) throw bad('ffmpeg is not installed — it is required for playout and streaming.');
  if (!store.data.library.length && !claudeAvailable()) throw bad('The music library is empty. Add music from monochrome (Library tab) or configure Claude to discover music automatically.');
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
    if (!t && b.track) t = await library.addTrack(b.track, b.category || 'N');
    if (!t) throw bad('unknown track');
    partial = { type: 'music', category: t.category, trackId: t.id, title: t.title, artist: t.artist, artwork: t.artwork, duration: t.duration, why: 'inserted by operator' };
  } else if (b.imagingId) {
    const im = store.data.imaging.items.find((i) => i.id === b.imagingId);
    if (!im) throw bad('unknown imaging item');
    partial = { type: im.type, imagingId: im.id, title: im.name, artist: 'Imaging' };
  } else if (b.script) {
    partial = { type: 'say', script: String(b.script), title: 'Live Read', persona: b.persona || personaFor(Date.now())?.name };
  } else if (['dj', 'weather', 'traffic', 'news'].includes(b.type)) {
    partial = { type: b.type, mode: b.mode || 'auto', title: { dj: 'DJ Break', weather: 'Weather', traffic: 'Traffic', news: 'Newscast' }[b.type] };
  } else throw bad('nothing to insert');
  const it = scheduler.insertNext(partial);
  if (!it) throw bad('no active log — start the station or build the log first');
  broadcast('log', scheduler.snapshot());
  res.json(it);
}));
app.post('/api/log/:id/remove', (req, res) => { scheduler.remove(req.params.id); broadcast('log', scheduler.snapshot()); res.json({ ok: true }); });
app.post('/api/log/:id/move', (req, res) => { scheduler.move(req.params.id, Number(req.body.dir)); broadcast('log', scheduler.snapshot()); res.json({ ok: true }); });
app.post('/api/carts/:id/fire', wrap(async (req, res) => {
  if (!engine.running) throw bad('station is off air');
  await engine.fireCart(req.params.id);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ monochrome + library
app.get('/api/monochrome/search', wrap(async (req, res) => res.json(await mono.search(req.query.q))));
app.get('/api/monochrome/tracks', wrap(async (req, res) => res.json(await mono.searchTracks(req.query.q, Number(req.query.limit) || 25))));
app.get('/api/monochrome/artist/:id', wrap(async (req, res) => res.json(await mono.getArtist(req.params.id))));
app.get('/api/monochrome/release/:id', wrap(async (req, res) => res.json(await mono.getRelease(req.params.id))));
app.get('/api/monochrome/stream/:id', (req, res) => res.redirect(mono.streamUrl(req.params.id)));

app.get('/api/library', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const cat = req.query.category;
  let items = store.data.library;
  if (cat) items = items.filter((t) => t.category === cat);
  if (q) items = items.filter((t) => `${t.artist} ${t.title} ${t.album}`.toLowerCase().includes(q));
  res.json(items.slice().sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title)));
});
app.post('/api/library', wrap(async (req, res) => {
  const tracks = Array.isArray(req.body.tracks) ? req.body.tracks : [req.body.track];
  const out = [];
  for (const t of tracks.filter(Boolean)) out.push(await library.addTrack(t, req.body.category || 'N'));
  res.json(out);
}));
app.post('/api/library/import', wrap(async (req, res) => {
  const { kind, id, category, limit } = req.body;
  const src = kind === 'artist' ? (await mono.getArtist(id)).topTracks : (await mono.getRelease(id)).tracks;
  const out = [];
  for (const t of src.slice(0, Number(limit) || 10)) out.push(await library.addTrack(t, category || 'N'));
  res.json(out);
}));
app.post('/api/library/discover', wrap(async (req, res) => res.json(await discover(req.body || {}))));
app.patch('/api/library/:id', (req, res) => res.json(library.updateTrack(req.params.id, req.body)));
app.delete('/api/library/:id', (req, res) => { library.removeTrack(req.params.id); res.json({ ok: true }); });

// ------------------------------------------------------------------ configuration
const sections = {
  station: (v) => { Object.assign(store.data.station, v, { market: { ...store.data.station.market, ...(v.market || {}) } }); },
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
app.put('/api/settings', (req, res) => { store.updateSettings(req.body); res.json(bootstrap()); });
app.put('/api/:section', (req, res) => {
  const fn = sections[req.params.section];
  if (!fn) return res.status(404).json({ error: 'unknown section' });
  // assign ids to new list entries
  if (Array.isArray(req.body)) for (const x of req.body) if (x && typeof x === 'object' && !x.id && req.params.section !== 'grid') x.id = uid();
  if (req.params.section === 'imaging') for (const x of req.body.items || []) if (!x.id) x.id = uid('img_');
  fn(req.body);
  store.save();
  res.json(bootstrap());
});

app.post('/api/market/locations', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) throw bad('location name required');
  const g = await geocode(name);
  if (!g) throw bad(`could not find "${name}"`);
  // the first location sets the station clock, so "it's 7:20" is local time for the market
  if (!store.data.station.market.locations.length && g.timezone) store.data.station.timezone = g.timezone;
  store.data.station.market.locations.push(g);
  store.save();
  res.json(bootstrap());
}));
app.delete('/api/market/locations/:idx', (req, res) => {
  store.data.station.market.locations.splice(Number(req.params.idx), 1);
  store.save();
  res.json(bootstrap());
});

// ------------------------------------------------------------------ feeds & AI tools
app.get('/api/feeds/weather', wrap(async (req, res) => res.json(await marketWeather())));
app.get('/api/feeds/news', wrap(async (req, res) => res.json(await getNews())));
app.get('/api/feeds/traffic', wrap(async (req, res) => res.json(await getTraffic())));

app.post('/api/dj/preview', wrap(async (req, res) => {
  const kind = req.body.kind || 'auto';
  const hist = store.data.history.filter((h) => h.type === 'music').slice(-2).map((h) => library.findTrack(h.trackId) || h);
  const lib = store.data.library;
  const previous = hist.length ? hist : lib.slice(0, 1);
  const next = lib.length ? lib[Math.floor(Math.random() * lib.length)] : null;
  const out = await writeBreak({ kind, previous, next, at: Date.now() });
  let audio = null;
  if (ttsAvailable() && req.body.voice !== false) audio = '/tts/' + path.basename(await synthesize(out.text, out.persona?.voice || {}));
  res.json({ text: out.text, persona: out.persona?.name, audio });
}));
app.post('/api/tts/preview', wrap(async (req, res) => {
  const { text, voice, imaging } = req.body;
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
    ws.send(JSON.stringify({ type: 'state', data: engine.state() }));
    ws.send(JSON.stringify({ type: 'log', data: scheduler.snapshot() }));
  });
});
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}
let logTimer = null;
const logChanged = () => {
  clearTimeout(logTimer);
  logTimer = setTimeout(() => broadcast('log', scheduler.snapshot()), 200);
};
scheduler.onChange = logChanged;
engine.on('log', logChanged);
engine.on('state', (s) => broadcast('state', s));
engine.on('nowPlaying', (i) => { broadcast('nowPlaying', i); logChanged(); });
setInterval(() => { if (engine.running && wss.clients.size) broadcast('level', engine.level); }, 100);

server.listen(PORT, HOST, () => {
  console.log(`\n  Valhalla Radio studio  →  http://localhost:${PORT}`);
  console.log(`  Public stream          →  http://localhost:${PORT}/stream.mp3`);
  console.log(`  Listener page          →  http://localhost:${PORT}/listen`);
  console.log(`  ffmpeg: ${ffmpegVersion || 'NOT FOUND (required)'} | Claude: ${claudeAvailable() ? 'configured' : 'not configured'} | TTS: ${ttsAvailable() ? store.settings.ttsProvider : 'not configured'}\n`);
  if (process.env.AUTOSTART === '1' && ffmpegVersion) engine.start();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.flush();
    engine.stop();
    process.exit(0);
  });
}
