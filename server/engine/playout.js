// Real-time playout engine. Renders the program log to PCM in real time:
// crossfades, DJ talk-ups over song intros, ducking under voice/imaging, tight
// commercial segues, loudness levelling and a final limiter, then hands the PCM
// to the streamer (MP3 encoder → listeners / Icecast).

import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { SAMPLE_RATE, UPLOAD_DIR } from '../config.js';
import { store } from '../store.js';
import * as mono from '../sources/monochrome.js';
import * as library from '../scheduler/library.js';
import { KIND, estDuration } from '../scheduler/logs.js';
import { loadAudio } from './audio.js';
import { mixSource, limitToInt16, approach, dbToGain, overlapSec } from './mixer.js';
import { writeBreak, personaFor, renderImagingText } from '../ai/dj.js';
import { synthesize, ttsAvailable } from '../voice/tts.js';
import { zoned } from '../util/time.js';

const BLOCK = 1024;
const PREBUFFER_FRAMES = Math.floor(SAMPLE_RATE * 0.25);
const log = (...a) => console.log('[playout]', ...a);

export class Playout extends EventEmitter {
  constructor(scheduler, streamer) {
    super();
    this.scheduler = scheduler;
    this.streamer = streamer;
    this.running = false;
    this.sources = []; // active sources being mixed
    this.main = null; // the source that owns the timeline
    this.prepared = new Map(); // itemId -> audio
    this.preparing = new Set();
    this.duck = 1;
    this.limiter = {};
    this.deadAirFrames = 0;
    this.emergency = null;
    this.forceNext = false;
    this.level = { l: 0, r: 0 };
    this.lastError = null;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.streamer.start();
    this.t0 = performance.now();
    this.written = 0;
    this.timer = setInterval(() => this.tick(), 20);
    this.prepTimer = setInterval(() => this.prepLoop(), 1000);
    this.ensureTimer = setInterval(() => this.scheduler.ensure().catch((e) => this.fail(e)), 30_000);
    this.stateTimer = setInterval(() => this.emit('state', this.state()), 1000);
    this.scheduler.ensure().catch((e) => this.fail(e));
    this.loadEmergency();
    log('engine started');
    this.emit('state', this.state());
  }

  stop() {
    this.running = false;
    for (const t of [this.timer, this.prepTimer, this.ensureTimer, this.stateTimer]) clearInterval(t);
    // the interrupted item airs again from the top next time (its audio was released when it started)
    for (const s of this.sources) if (s.item.status === 'playing' && !s.overlay) s.item.status = 'scheduled';
    this.sources = [];
    this.main = null;
    this.streamer.stop();
    log('engine stopped');
    this.emit('state', this.state());
  }

  fail(err) {
    this.lastError = `${new Date().toLocaleTimeString()}: ${err.message || err}`;
    console.error('[playout]', err);
  }

  // ---------------------------------------------------------------- real-time loop

  tick() {
    const expected = Math.floor(((performance.now() - this.t0) / 1000) * SAMPLE_RATE) + PREBUFFER_FRAMES;
    let due = expected - this.written;
    if (due <= 0) return;
    if (due > SAMPLE_RATE) { // event loop stalled; don't burst-render seconds of audio
      this.written = expected - Math.floor(SAMPLE_RATE * 0.1);
      due = Math.floor(SAMPLE_RATE * 0.1);
    }
    const out = this.render(due);
    this.streamer.write(out);
    this.written += due;
  }

  render(frames) {
    const buf = new Float32Array(frames * 2);
    for (let off = 0; off < frames; off += BLOCK) {
      const n = Math.min(BLOCK, frames - off);
      this.sequence();
      const voiceOn = this.sources.some((s) => s.kind === 'voice' && s.pos < s.endFrame);
      const imagingOn = this.sources.some((s) => (s.kind === 'imaging' || s.overlay) && s.pos < s.endFrame);
      const target = voiceOn ? dbToGain(store.settings.duckDb ?? -11) : imagingOn ? dbToGain(-5) : 1;
      const d0 = this.duck;
      const dt = n / SAMPLE_RATE;
      this.duck = approach(this.duck, target, this.duck > target ? 4 : 1.2, dt);
      for (const s of this.sources) {
        const ducked = s.kind === 'music';
        mixSource(buf, off, s, n, ducked ? d0 : 1, ducked ? this.duck : 1);
      }
      this.reap();
      if (!this.sources.length) this.deadAirFrames += n; else this.deadAirFrames = 0;
    }
    let pl = 0; let pr = 0;
    for (let i = 0; i < buf.length; i += 2) { pl = Math.max(pl, Math.abs(buf[i])); pr = Math.max(pr, Math.abs(buf[i + 1])); }
    this.level = { l: Math.max(pl, this.level.l * 0.85), r: Math.max(pr, this.level.r * 0.85) };
    return limitToInt16(buf, this.limiter);
  }

  /** Decide whether the next log item should start now. */
  sequence() {
    const main = this.main;
    const remaining = main ? Math.max(0, main.endFrame - main.pos) : 0;
    if (main && !this.forceNext && remaining > SAMPLE_RATE * 12) return;

    const r = this.scheduler.next(Date.now(), { urgent: !main || remaining < SAMPLE_RATE * 0.5 });
    const item = r.item;
    if (item && item.status === 'ready' && !this.prepared.has(item.id)) item.status = 'scheduled'; // audio was released; prepare again
    if (item && item.status === 'ready' && this.prepared.has(item.id)) {
      const audio = this.prepared.get(item.id);
      const kind = KIND[item.type];
      const ov = main && !this.forceNext
        ? overlapSec(main.kind, kind, {
          crossfadeSec: store.settings.crossfadeSec ?? 3,
          talkOverSec: store.settings.talkOverSec ?? 6,
          curDurSec: (main.endFrame - main.startFrame) / SAMPLE_RATE,
          nextDurSec: audio.durationSec,
        })
        : 0;
      if (main && !this.forceNext && remaining > ov * SAMPLE_RATE) return;
      this.startItem(item, audio);
      return;
    }
    // Nothing ready. If the timeline is empty for too long, play emergency audio.
    if ((!main || remaining === 0) && this.deadAirFrames > SAMPLE_RATE * 3 && this.emergency) {
      log('dead air — playing emergency audio');
      const em = this.emergency;
      this.emergency = null;
      this.startItem(em.item, em.audio);
      this.loadEmergency();
    }
  }

  startItem(item, audio) {
    const kind = KIND[item.type] || 'music';
    const prev = this.main;
    if (prev && prev.pos < prev.endFrame) {
      const left = prev.endFrame - prev.pos;
      if (this.forceNext) {
        const f = Math.min(left, Math.floor(SAMPLE_RATE * 0.8));
        prev.fadeOut = { at: prev.pos, frames: f };
        prev.endFrame = prev.pos + f;
      } else if (prev.kind === 'music' && left > 0) {
        prev.fadeOut = { at: prev.pos, frames: left };
      }
    }
    this.forceNext = false;
    const src = {
      item, kind, pcm: audio.pcm, pos: audio.startFrame, startFrame: audio.startFrame, endFrame: audio.endFrame, gain: audio.gain,
      fadeIn: kind === 'music' && prev?.kind === 'music' ? { at: audio.startFrame, frames: Math.floor(SAMPLE_RATE * 0.25) } : null,
    };
    this.sources.push(src);
    this.main = src;
    item.status = 'playing';
    item.airedAt = Date.now();
    item.audioDuration = audio.durationSec;
    this.prepared.delete(item.id);
    this.onAir(item);
  }

  reap() {
    for (const s of [...this.sources]) {
      if (s.pos < s.endFrame) continue;
      this.sources.splice(this.sources.indexOf(s), 1);
      if (s.item.status === 'playing') s.item.status = 'played';
      if (this.main === s) this.main = null;
      if (!s.overlay) this.emit('state', this.state());
    }
  }

  onAir(item) {
    const st = store.station;
    const z = zoned(new Date(), st.timezone);
    if (item.type === 'music') {
      if (!item.emergency) library.markPlayed(item.trackId);
      store.addHistory({ type: 'music', trackId: item.trackId, title: item.title, artist: item.artist, category: item.category });
      this.streamer.setTitle(`${item.artist} - ${item.title}`);
    } else if (item.type === 'spot') {
      const day = (store.data.spotLog[z.dateKey] ||= {});
      day[item.spotId] = (day[item.spotId] || 0) + 1;
      store.addHistory({ type: 'spot', spotId: item.spotId, title: item.title, artist: item.artist });
    } else {
      store.addHistory({ type: item.type, title: item.title, artist: item.artist, script: item.script });
      if (item.type === 'toh_id' || item.type === 'id') this.streamer.setTitle(`${st.name} - ${st.slogan}`);
    }
    log(`on air: [${item.type}] ${item.artist ? item.artist + ' - ' : ''}${item.title || ''}`);
    this.emit('nowPlaying', this.publicItem(item));
    this.emit('state', this.state());
  }

  // ---------------------------------------------------------------- live assist

  skip() {
    if (!this.main) return;
    this.forceNext = true;
  }

  /** Fire a cart (imaging item) on top of whatever is playing. */
  async fireCart(imagingId) {
    const im = store.data.imaging.items.find((i) => i.id === imagingId);
    if (!im) throw new Error('cart not found');
    const audio = await this.imagingAudio(im);
    const item = { id: `cart_${Date.now()}`, type: im.type, title: im.name, artist: 'Cart', status: 'playing' };
    this.sources.push({ item, kind: 'imaging', overlay: true, pcm: audio.pcm, pos: audio.startFrame, startFrame: audio.startFrame, endFrame: audio.endFrame, gain: audio.gain });
  }

  // ---------------------------------------------------------------- preparation

  async prepLoop() {
    if (!this.running) return;
    const n = (store.settings.lookaheadItems || 3) + 1;
    const upcoming = this.scheduler.upcoming(n);
    // free audio for items that are no longer upcoming
    const keep = new Set(upcoming.map((i) => i.id));
    for (const id of this.prepared.keys()) {
      const it = this.scheduler.findItem(id);
      if (!keep.has(id) && (!it || !['ready'].includes(it.status))) this.prepared.delete(id);
    }
    for (const it of upcoming) {
      if (it.status !== 'scheduled' || this.preparing.has(it.id) || this.preparing.size >= 2) continue;
      this.prepare(it);
    }
  }

  async prepare(item) {
    this.preparing.add(item.id);
    item.status = 'preparing';
    const t0 = Date.now();
    try {
      const audio = await this.audioFor(item);
      if (item.status !== 'preparing') return; // removed meanwhile
      this.prepared.set(item.id, audio);
      item.audioDuration = audio.durationSec;
      item.status = 'ready';
      log(`ready: [${item.type}] ${item.title || ''} (${audio.durationSec.toFixed(1)}s, ${Date.now() - t0}ms)`);
    } catch (err) {
      item.error = err.message;
      if (item.type === 'music') {
        log(`music failed (${item.title}): ${err.message} — replacing`);
        if (!this.scheduler.replaceMusic(item)) this.fail(err);
      } else {
        log(`skipping [${item.type}] ${item.title}: ${err.message}`);
        item.status = 'skipped';
      }
    } finally {
      this.preparing.delete(item.id);
      this.emit('log');
    }
  }

  normalizeOpts(kind) {
    // voice sits a touch hotter than music so it cuts through when ducked
    return { normalize: store.settings.normalize !== false, targetDb: kind === 'music' ? -17 : kind === 'spot' ? -17 : -16 };
  }

  async audioFor(item) {
    const kind = KIND[item.type];
    if (kind === 'music') {
      const file = await mono.download(item.trackId);
      return loadAudio(file, this.normalizeOpts('music'));
    }
    if (kind === 'imaging') {
      const im = store.data.imaging.items.find((i) => i.id === item.imagingId);
      if (!im) throw new Error('imaging item deleted');
      return this.imagingAudio(im);
    }
    if (kind === 'spot') {
      const spot = store.data.spots.find((s) => s.id === item.spotId);
      if (!spot) throw new Error('spot deleted');
      if (spot.file) return loadAudio(path.join(UPLOAD_DIR, spot.file), this.normalizeOpts('spot'));
      if (!ttsAvailable()) throw new Error('spot has no audio and no TTS is configured');
      const voice = spot.voice?.elevenLabsVoiceId || spot.voice?.openaiVoice ? spot.voice : store.data.imaging.voice;
      return loadAudio(await synthesize(spot.text, voice), this.normalizeOpts('spot'));
    }
    // voice: DJ / weather / traffic / news / live read
    if (!item.script) {
      const ctx = this.scheduler.contextFor(item);
      const kindName = item.type === 'dj' ? item.mode || 'auto' : item.type;
      const res = await writeBreak({ kind: kindName, ...ctx, at: this.estimateAirTime(item) });
      item.script = res.text;
      item.persona = res.persona?.name;
      item.artist = res.persona?.name || item.artist;
    }
    if (!ttsAvailable()) throw new Error('no TTS provider configured — script written but not voiced');
    const persona = store.data.personas.find((p) => p.name === item.persona) || personaFor(this.estimateAirTime(item));
    return loadAudio(await synthesize(item.script, persona?.voice || {}), this.normalizeOpts('voice'));
  }

  async imagingAudio(im) {
    if (im.file) return loadAudio(path.join(UPLOAD_DIR, im.file), this.normalizeOpts('imaging'));
    if (!ttsAvailable()) throw new Error('imaging has no audio file and no TTS is configured');
    return loadAudio(await synthesize(renderImagingText(im.text), store.data.imaging.voice), this.normalizeOpts('imaging'));
  }

  estimateAirTime(item) {
    let t = Date.now();
    if (this.main) t += ((this.main.endFrame - this.main.pos) / SAMPLE_RATE) * 1000;
    for (const it of this.scheduler.pendingItems()) {
      if (it.id === item.id) break;
      t += (it.audioDuration || estDuration(it)) * 1000;
    }
    return t;
  }

  async loadEmergency() {
    try {
      const upcoming = new Set(this.scheduler.pendingItems().map((i) => i.trackId).filter(Boolean));
      const all = mono.cachedTrackIds();
      const ids = all.filter((id) => !upcoming.has(id)).length ? all.filter((id) => !upcoming.has(id)) : all;
      if (!ids.length) return;
      const id = ids[Math.floor(Math.random() * ids.length)];
      const t = library.findTrack(id) || { title: 'Emergency audio', artist: store.station.name };
      const audio = await loadAudio(mono.cachedPath(id), this.normalizeOpts('music'));
      this.emergency = { audio, item: { id: `em_${Date.now()}`, type: 'music', trackId: id, title: t.title, artist: t.artist, artwork: t.artwork, emergency: true, status: 'ready' } };
    } catch (err) {
      log('emergency load failed:', err.message);
    }
  }

  // ---------------------------------------------------------------- state for the UI

  publicItem(i) {
    if (!i) return null;
    return { id: i.id, type: i.type, title: i.title, artist: i.artist, artwork: i.artwork, script: i.script, category: i.category, airedAt: i.airedAt, duration: i.audioDuration, album: i.album, year: i.year };
  }

  state() {
    const m = this.main;
    return {
      running: this.running,
      now: m ? {
        ...this.publicItem(m.item),
        position: (m.pos - m.startFrame) / SAMPLE_RATE,
        length: (m.endFrame - m.startFrame) / SAMPLE_RATE,
      } : null,
      overlays: this.sources.filter((s) => s !== m).map((s) => ({ title: s.item.title, type: s.item.type, remaining: (s.endFrame - s.pos) / SAMPLE_RATE })),
      listeners: this.streamer.listeners.size,
      icecast: this.streamer.icecastStatus,
      deadAir: this.running && !this.sources.length,
      lastError: this.lastError,
      level: this.level,
      emergencyReady: Boolean(this.emergency),
    };
  }
}

export function uploadExists(file) {
  return file && fs.existsSync(path.join(UPLOAD_DIR, file));
}
