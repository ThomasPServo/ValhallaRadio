// Real-time playout engine.
//
// A frame-accurate master timeline: the planner decides when each element starts and how every
// source's level moves (fade + duck automation lanes), songs stream through StreamDecoders,
// short elements play from memory, the master bus runs through the broadcast processor, and the
// result is handed to the streamer.

import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { SAMPLE_RATE as SR, CACHE_DIR } from '../config.js';
import { store } from '../store.js';
import * as mono from '../sources/monochrome.js';
import { setPriority, dropFetches, fetcherStatus } from '../sources/fetcher.js';
import { ensurePeaks, readPeaks, hasPeaks } from '../audio/peakFile.js';
import { queueAnalysis, analysisEvents } from '../audio/trackAnalyzer.js';
import * as library from '../scheduler/library.js';
import { KIND, estDuration } from '../scheduler/logs.js';
import { loadAudio } from './audio.js';
import { StreamDecoder, PEAK_SECONDS } from '../audio/stream.js';
import { analyze } from '../audio/analysisPool.js';
import { peaks as computePeaks } from '../audio/analysis.js';
import { lookupVocalTiming } from '../audio/lyrics.js';
import { planTransition } from './planner.js';
import { BufferSource, StreamSource, LoopSource } from './sources.js';
import { BroadcastProcessor, resolveParams } from '../audio/processor.js';
import { writeBreak } from '../ai/dj.js';
import { produceElement } from '../audio/production.js';
import { chosenBedId, loadBed } from '../audio/beds.js';

const BLOCK = 256;
const PREBUFFER = Math.floor(SR * 0.5);
const ANALYSIS_VERSION = 2;
const HEAD_SEC = 48;
const PEAKS_DIR = path.join(CACHE_DIR, 'peaks');
fs.mkdirSync(PEAKS_DIR, { recursive: true });
const log = (...a) => console.log('[playout]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbToLin = (db) => Math.pow(10, db / 20);

export class Playout extends EventEmitter {
  constructor(scheduler, streamer) {
    super();
    analysisEvents.on('analyzed', (id, a) => { try { this.applyAnalysis(id, a); } catch (err) { log('analysis update failed:', err.message); } });
    this.scheduler = scheduler;
    this.streamer = streamer;
    this.running = false;
    this.frame = 0;
    this.sources = [];
    this.anchor = null;
    this.cue = null;
    this.preparing = new Set();
    this.prepared = new Set(); // items holding prepared audio (released when they air, leave the lookahead or the log)
    this.overlayDuck = 1;
    this.deadAir = 0;
    this.lastError = null;
    this.level = { l: 0, r: 0 };
    this.processor = new BroadcastProcessor(SR, this.processingParams());
    this.watchers = { level: 0, meters: 0, scope: 0, timeline: 0, decks: 0 }; // open screens that show each live feed
    this.processor.setMetering(false); // meter-only analysis runs while a screen shows the meters
    this.mixBuf = new Float32Array(0); // reused render buffer
    this.bed = null; // the auto-bed source while it's up (or fading)
    this.bedAudio = null; // decoded loop, ready to go
  }

  processingParams() {
    const p = store.data.processing || {};
    return resolveParams(p.preset || 'streaming', p.overrides || {});
  }

  setProcessing(cfg) {
    store.data.processing = { ...(store.data.processing || {}), ...cfg };
    store.save();
    this.processor.setParams(this.processingParams());
  }

  // ------------------------------------------------------------------ lifecycle

  async start() {
    if (this.running) return;
    this.running = true;
    this.streamer.start();
    this.t0 = performance.now();
    this.frame = 0;
    this.written = 0;
    this.startWall = Date.now();
    this.timer = setInterval(() => this.tick(), 20);
    this.prepTimer = setInterval(() => this.prepLoop(), 700);
    this.ensureTimer = setInterval(() => this.scheduler.ensure().catch((e) => this.fail(e)), 30_000);
    this.stateTimer = setInterval(() => { this.emit('state', this.state()); if (this.watchers.decks) this.emit('decks', this.decksState()); }, 1000);
    this.meterTimer = setInterval(() => this.emitMeters(), 50);
    this.timelineTimer = setInterval(() => { if (this.watchers.timeline) this.emit('timeline', this.timeline()); }, 500);
    this.scheduler.ensure().then(() => this.prepLoop()).catch((e) => this.fail(e));
    this.reloadBed();
    log('engine started');
    this.emit('state', this.state());
  }

  stop() {
    this.running = false;
    for (const t of [this.timer, this.prepTimer, this.ensureTimer, this.stateTimer, this.meterTimer, this.timelineTimer]) clearInterval(t);
    for (const s of this.sources) {
      // an interrupted item airs again from the top next time
      if (s.item.status === 'playing' && !s.overlay) s.item.status = 'scheduled';
      s.release();
    }
    if (this.cue) { this.cue.item.status = 'ready'; this.cue = null; }
    for (const it of [...this.prepared, ...this.scheduler.allItems()]) this.releasePrep(it);
    this.sources = [];
    this.anchor = null;
    this.bed = null;
    this.streamer.stop();
    log('engine stopped');
    this.emit('state', this.state());
  }

  fail(err) {
    this.lastError = `${new Date().toLocaleTimeString()}: ${err.message || err}`;
    console.error('[playout]', err.message || err);
  }

  nowSec() { return this.frame / SR; }

  /**
   * How many screens show each live feed ({ meters, scope, timeline, decks }). Feeds nobody shows aren't computed,
   * and with no meters on screen the processor skips its meter-only analysis (the audio is identical).
   */
  watch(counts) {
    Object.assign(this.watchers, counts);
    this.processor.setMetering(this.watchers.meters + this.watchers.scope > 0);
  }

  emitMeters() {
    if (this.watchers.scope) this.emit('scope', this.processor.scope());
    if (this.watchers.meters) this.emit('meters', this.processor.meters());
  }

  // ------------------------------------------------------------------ real-time loop

  tick() {
    const expected = Math.floor(((performance.now() - this.t0) / 1000) * SR) + PREBUFFER;
    let due = expected - this.written;
    if (due <= 0) return;
    if (due > SR) { // the event loop stalled; skip ahead rather than burst-render
      this.written = expected - Math.floor(SR * 0.1);
      due = Math.floor(SR * 0.1);
    }
    this.maybePlan();
    const buf = this.render(due);
    this.processor.process(buf, due);
    // a fresh output buffer each time (the encoder pipe may still hold the last one), from Node's pool when small
    const bytes = Buffer.allocUnsafe(due * 4);
    const out = new Int16Array(bytes.buffer, bytes.byteOffset, due * 2);
    let pl = 0; let pr = 0;
    for (let i = 0; i < out.length; i += 2) {
      const l = buf[i]; const r = buf[i + 1];
      out[i] = l * 32767; out[i + 1] = r * 32767;
      const al = l < 0 ? -l : l; const ar = r < 0 ? -r : r;
      if (al > pl) pl = al;
      if (ar > pr) pr = ar;
    }
    const lv = this.level;
    lv.l = Math.max(pl, lv.l * 0.8); lv.r = Math.max(pr, lv.r * 0.8);
    this.streamer.write(out);
    this.written += due;
  }

  render(frames) {
    const need = frames * 2;
    if (this.mixBuf.length < need) this.mixBuf = new Float32Array(Math.max(need, 4096));
    const buf = this.mixBuf.subarray(0, need);
    buf.fill(0);
    for (let off = 0; off < frames; off += BLOCK) {
      const n = Math.min(BLOCK, frames - off);
      const F = this.frame;
      if (this.cue && !this.cue.committed && F + n > this.cue.commitFrame) this.commitCue();
      if (this.cue && this.cue.startFrame < F + n) this.startCued(Math.max(this.cue.startFrame, F));

      const overlayOn = this.sources.some((s) => s.overlay && !s.done);
      const od0 = this.overlayDuck;
      this.overlayDuck += ((overlayOn ? 0.5 : 1) - this.overlayDuck) * Math.min(1, n / (SR * 0.08));
      this.updateBed(F);
      for (const s of this.sources) {
        if (s.done) continue;
        const o = Math.max(0, s.start - F);
        if (o >= n) continue;
        const m = s.kind === 'music' && !s.overlay;
        const g0 = s.gainAt(F + o) * (m ? od0 : 1);
        const g1 = s.gainAt(F + n) * (m ? this.overlayDuck : 1);
        const last = s.fade.pts[s.fade.pts.length - 1];
        if (g0 === 0 && g1 === 0 && last.v === 0 && last.f <= F) { s.done = true; continue; } // faded out for good
        s.mix(buf, off + o, n - o, g0, g1);
      }
      if (this.bed) {
        const b = this.bed;
        const g0 = b.gainAt(F); const g1 = b.gainAt(F + n);
        const last = b.fade.pts[b.fade.pts.length - 1];
        if (!b.on && g0 === 0 && g1 === 0 && last.f <= F) { b.release(); this.bed = null; } else b.mix(buf, off, n, g0, g1);
      }
      this.reap();
      this.frame += n;
      const audible = this.sources.some((s) => !s.done && !s.overlay);
      this.deadAir = audible || this.cue ? 0 : this.deadAir + n;
      if (this.deadAir > SR * 3 && this.frame > SR * 25) this.emergency(); // grace period while the first items prepare
    }
    return buf;
  }

  reap() {
    let any = false;
    for (const s of this.sources) if (s.done) { any = true; break; }
    if (!any) return;
    for (const s of [...this.sources]) {
      if (!s.done) continue;
      this.sources.splice(this.sources.indexOf(s), 1);
      if (s.item.status === 'playing') s.item.status = 'played';
      s.release();
      if (this.anchor === s) this.anchor = this.sources.filter((x) => !x.overlay).at(-1) || null;
      if (!s.overlay) this.emit('state', this.state());
    }
  }

  // ------------------------------------------------------------------ auto-bed

  /** Load (or switch to) the bed auto-bed should use. Safe to call any time. */
  async reloadBed() {
    const id = chosenBedId();
    if (this.bedAudio?.id === id) return;
    if (this.bedLoading?.id === id) return this.bedLoading.promise; // already on its way
    const promise = loadBed(id)
      .then((bed) => { this.bedAudio = bed; log(`auto-bed ready: ${bed.name} (${bed.seconds.toFixed(1)}s loop)`); })
      .catch((err) => this.fail(new Error(`auto-bed: ${err.message}`)))
      .finally(() => { if (this.bedLoading?.promise === promise) this.bedLoading = null; });
    this.bedLoading = { id, promise };
    return promise;
  }

  /** Does this element want a bed under it when there's no music to talk over? */
  bedWanted(item) {
    if (item.bed === false) return false;
    if (item.type === 'dj' || item.type === 'say') return true;
    return ['news', 'weather', 'traffic'].includes(item.type) && store.settings.production?.infoBeds === false;
  }

  /**
   * Auto-bed: bring a music bed up under talk that would otherwise be dry, and take it out when a
   * song (or a spot / imaging element) takes over. Runs once per render block.
   */
  updateBed(F) {
    const cfg = store.settings.autoBed || {};
    const live = this.sources.filter((s) => !s.done && !s.overlay);
    const voice = live.find((s) => s.kind === 'voice' && s.start <= F && this.bedWanted(s.item));
    const covering = (s) => s.kind === 'music' && s.start <= F && s.fade.value(F) * s.duck.value(F) > 0.08;
    const musicNow = live.some(covering);
    const blocking = live.some((s) => (s.kind === 'spot' || s.kind === 'imaging') && s.start <= F);
    let want = false;
    if (cfg.enabled !== false && this.bedAudio && voice && !musicNow && !blocking) {
      const vEnd = voice.start + Math.round(((voice.markers?.voiceEnd ?? voice.len) + 0.25) * SR);
      if (F < vEnd) {
        if (this.bed?.on) want = true; // already up: hold it while the talk stays dry
        else {
          // only bring a bed in for a real stretch of dry talk: a few seconds between the end of one song and
          // the intro of the next is natural (a bed fading in and straight out again would sound busier)
          let coverAt = vEnd;
          for (const s of live) if (s.kind === 'music' && s.start > F) coverAt = Math.min(coverAt, s.start);
          const c = this.cue;
          if (c?.item.type === 'music') coverAt = Math.min(coverAt, c.startFrame);
          else if (c?.item.prep?.kind === 'voice' && this.bedWanted(c.item) && c.startFrame <= vEnd + SR) {
            // talk that runs straight into more talk (weather into traffic) is one stretch
            const p = c.item.prep;
            coverAt = Math.max(coverAt, c.startFrame + Math.round(((p.markers?.voiceEnd ?? p.audio.durationSec) + 0.25) * SR));
          }
          want = coverAt - F > (cfg.minDrySec ?? 6) * SR;
        }
      }
    }
    const b = this.bed;
    if (want) {
      if (b?.on) { b.offAt = 0; return; }
      const level = dbToLin(cfg.levelDb ?? -12);
      if (b) { // still fading out: bring it back up from where it is
        b.on = true; b.offAt = 0;
        b.fade.ramp(F, F + Math.round(SR * 0.5), 1, 'cos');
        return;
      }
      this.bed = new LoopSource({ item: { id: 'bed', type: 'bed', title: this.bedAudio.name }, kind: 'bed', start: F, audio: this.bedAudio, base: this.bedAudio.gain * level });
      this.bed.on = true;
      this.bed.fade.ramp(F, F + Math.round(SR * 0.6), 1, 'cos');
      return;
    }
    if (!b?.on) return;
    if (musicNow || blocking) { // the song (or spot) takes over: get out of the way
      b.on = false;
      b.fade.ramp(F, F + Math.round(SR * (musicNow ? 1.5 : 0.5)), 0, 'db');
      return;
    }
    // talk ended: hold briefly in case another voice element follows (weather into traffic), then tail out
    if (!b.offAt) b.offAt = F + Math.round(SR * 1.0);
    if (F >= b.offAt) {
      b.on = false;
      b.fade.ramp(F, F + Math.round(SR * 1.4), 0, 'db');
    }
  }

  // ------------------------------------------------------------------ planning

  remainingOf(src) {
    return (src.start - this.frame) / SR + src.len;
  }

  maybePlan() {
    if (this.cue || !this.running) return;
    const a = this.anchor && !this.anchor.done ? this.anchor : null;
    let remaining = 0;
    if (a) {
      remaining = this.remainingOf(a);
      const tailKnown = a.kind !== 'music' || a.markers.endType;
      if (!tailKnown && remaining > 25) return; // wait for the tail analysis
      if (remaining > 75) return;
    }
    const r = this.scheduler.next(Date.now() + remaining * 1000, { urgent: !a || remaining < 2.5 });
    const item = r.item;
    if (!item || item.status !== 'ready' || !item.prep) return;
    this.planNext(item, { immediate: false });
  }

  planNext(item, { immediate }) {
    const nowSec = this.nowSec();
    const a = this.anchor && !this.anchor.done ? this.anchor : null;
    const others = this.sources.filter((s) => s !== a && !s.done && !s.overlay && s.kind === 'music').map((s) => ({ id: s.item.id, kind: 'music' }));
    const s = store.settings;
    const plan = planTransition({
      now: nowSec,
      prev: a ? this.describeSource(a) : null,
      next: this.describeNext(item),
      others,
      opts: { immediate, duckDb: s.duckDb ?? -12, postGap: s.postGap ?? 0.5, beatMatch: s.beatMatch !== false, talkOverOutroMax: s.talkOverOutroMax ?? 6 },
    });
    const startFrame = Math.round(plan.start * SR);
    let commitFrame = startFrame;
    for (const r of plan.ramps) if (r.target !== 'next') commitFrame = Math.min(commitFrame, Math.round(r.at * SR));
    this.cue = { item, plan, startFrame, commitFrame: Math.max(this.frame, commitFrame - Math.round(SR * 0.05)), committed: false };
    item.status = 'cued';
    item.transition = { type: plan.type, notes: plan.notes, at: this.startWall + plan.start * 1000 };
    if (immediate) this.commitCue();
    this.emit('log');
    if (this.watchers.timeline) this.emit('timeline', this.timeline());
  }

  commitCue() {
    const c = this.cue;
    c.committed = true;
    for (const r of c.plan.ramps) {
      if (r.target === 'next') continue;
      const src = r.target === 'prev' ? this.anchor : this.sources.find((s) => s.item.id === r.target);
      if (!src) continue;
      const f0 = Math.round(r.at * SR); const f1 = Math.round((r.at + r.dur) * SR);
      (r.lane === 'duck' ? src.duck : src.fade).ramp(f0, f1, r.to, r.curve);
    }
  }

  uncue() {
    if (!this.cue || this.cue.committed) return;
    if (this.cue.item.status === 'cued') this.cue.item.status = 'ready';
    this.cue.item.transition = null;
    this.cue = null;
  }

  /** Operator moved/removed/inserted items: re-plan if the cued item is no longer next. */
  onLogChange() {
    if (!this.cue || this.cue.committed) return;
    const first = this.scheduler.pendingItems().find((i) => i.status !== 'playing');
    if (first !== this.cue.item) this.uncue();
  }

  startCued(atFrame) {
    const { item, plan } = this.cue;
    this.cue = null;
    const prep = item.prep;
    if (!prep) { log('cued item lost its audio'); return; }
    let src;
    if (prep.kind === 'music') {
      const m = prep.markers;
      src = new StreamSource({
        item, kind: 'music', start: atFrame, decoder: prep.decoder, base: prep.gain, markers: m,
        trimStart: Math.round((m.startSec || 0) * SR), trimEnd: m.endSec ? Math.round(m.endSec * SR) : null, lenHint: m.duration || item.duration || 240,
      });
      prep.decoder = null; // ownership moves to the source
    } else {
      src = new BufferSource({ item, kind: prep.kind, start: atFrame, audio: prep.audio, base: prep.audio.gain, markers: prep.markers });
    }
    for (const r of plan.ramps) {
      if (r.target !== 'next') continue;
      (r.lane === 'duck' ? src.duck : src.fade).ramp(Math.round(r.at * SR), Math.round((r.at + r.dur) * SR), r.to, r.curve);
    }
    src.prep = prep;
    this.sources.push(src);
    this.anchor = src;
    item.prep = null;
    this.prepared.delete(item);
    item.status = 'playing';
    item.airedAt = this.startWall + (atFrame / SR) * 1000;
    item.audioDuration = src.len;
    this.onAir(item);
  }

  /** Planner view of a playing source (times relative to its trimmed start). */
  describeSource(s) {
    const d = { kind: s.kind, start: s.start / SR, len: s.len };
    const m = s.markers || {};
    if (s.kind === 'music') {
      const st = m.startSec || 0;
      d.endType = m.endType || null;
      d.mixOut = m.mixOut != null ? m.mixOut - st : null;
      d.vocalEnd = m.instrumental ? 0 : m.vocalEnd != null ? Math.max(0, m.vocalEnd - st) : null;
      if (m.tailTempo) d.beat = { period: m.tailTempo.period, phase: m.tailTempo.phase - st, confidence: m.tailTempo.confidence };
    } else Object.assign(d, { voiceStart: m.voiceStart, voiceEnd: m.voiceEnd, post: m.post, tailStart: m.tailStart, bedded: Boolean(m.bedded) });
    return d;
  }

  describeNext(item) {
    const p = item.prep;
    const m = p.markers || {};
    if (p.kind === 'music') {
      const st = m.startSec || 0;
      const len = (m.endSec || m.duration || item.duration || 240) - st;
      return {
        kind: 'music', len,
        vocalStart: m.instrumental ? len : m.vocalStart != null ? Math.max(0, m.vocalStart - st) : null,
        rampIn: m.rampIn || 0,
        firstBeat: m.firstBeat != null ? Math.max(0, m.firstBeat - st) : null,
        beat: m.headTempo ? { period: m.headTempo.period, confidence: m.headTempo.confidence } : null,
      };
    }
    return { kind: p.kind, len: p.audio.durationSec, voiceStart: m.voiceStart, voiceEnd: m.voiceEnd, post: m.post, tailStart: m.tailStart, bedded: Boolean(m.bedded) };
  }

  // ------------------------------------------------------------------ on air

  onAir(item) {
    const st = store.station;
    if (item.type === 'music') {
      if (!item.emergency) library.markPlayed(item.trackId);
      store.addHistory({ type: 'music', trackId: item.trackId, title: item.title, artist: item.artist, category: item.category });
      this.streamer.setTitle(`${item.artist} - ${item.title}`);
    } else if (item.type === 'spot') {
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: st.timezone }).format(new Date());
      const d = (store.data.spotLog[day] ||= {});
      d[item.spotId] = (d[item.spotId] || 0) + 1;
      store.addHistory({ type: 'spot', spotId: item.spotId, title: item.title, artist: item.artist });
    } else {
      store.addHistory({ type: item.type, title: item.title, artist: item.artist, script: item.script });
      if (item.type === 'toh_id' || item.type === 'id') this.streamer.setTitle(`${st.name}${st.slogan ? ` - ${st.slogan}` : ''}`);
    }
    log(`on air: [${item.type}] ${item.artist ? `${item.artist} - ` : ''}${item.title || ''}${item.transition ? ` (${item.transition.type})` : ''}`);
    this.emit('nowPlaying', this.publicItem(item));
    this.emit('state', this.state());
    if (this.watchers.timeline) this.emit('timeline', this.timeline());
  }

  skip() {
    if (!this.running) return;
    this.uncue();
    if (this.cue?.committed) return; // already in a transition
    const r = this.scheduler.next(Date.now(), { urgent: true });
    if (r.item && r.item.status === 'ready' && r.item.prep) this.planNext(r.item, { immediate: true });
    else {
      // nothing ready yet: pot everything down; dead-air protection takes over if needed
      const f = this.frame;
      for (const s of this.sources) if (!s.overlay) s.fade.ramp(f, f + Math.round(SR * 1.2), 0, 'cos');
    }
  }

  async fireCart(imagingId) {
    const im = store.data.imaging.items.find((i) => i.id === imagingId);
    if (!im) throw new Error('cart not found');
    const el = await produceElement({ type: im.type, imagingId: im.id });
    const audio = await loadAudio(el.file, { normalize: true, targetDb: -15 });
    const item = { id: `cart_${Date.now()}`, type: im.type, title: im.name, artist: 'Cart', status: 'playing' };
    this.sources.push(new BufferSource({ item, kind: 'imaging', start: this.frame + Math.round(SR * 0.05), audio, base: audio.gain, overlay: true }));
  }

  emergency() {
    this.deadAir = 0;
    const ids = mono.cachedTrackIds().filter((id) => !(library.cleanOnly() && library.findTrack(id)?.explicit));
    if (!ids.length) {
      if (!this.warnedNoEmergency) { this.fail(new Error('Dead air: nothing ready and no local emergency audio')); this.warnedNoEmergency = true; }
      return;
    }
    const id = ids[Math.floor(Math.random() * ids.length)];
    const t = library.findTrack(id) || { title: 'Emergency audio', artist: store.station.name };
    const decoder = new StreamDecoder({ file: mono.cachedPath(id), durationHint: t.duration, label: 'emergency' }).start();
    const item = { id: `em_${Date.now()}`, type: 'music', trackId: id, title: t.title, artist: t.artist, artwork: t.artwork, emergency: true, status: 'playing' };
    const src = new StreamSource({ item, kind: 'music', start: this.frame + Math.round(SR * 0.3), decoder, base: 1, markers: {}, lenHint: t.duration || 200 });
    this.sources.push(src);
    this.anchor = src;
    log('dead air: emergency audio from the local cache');
    this.onAir(item);
  }

  // ------------------------------------------------------------------ preparation

  async prepLoop() {
    if (!this.running) return;
    const upcoming = this.scheduler.upcoming((store.settings.lookaheadItems || 3) + 1);
    const keep = new Set(upcoming.map((i) => i.id));
    for (const it of this.scheduler.allItems()) if (!keep.has(it.id) && it.prep && it.status !== 'cued') this.releasePrep(it);
    if (this.prepared.size) { // a re-plan can drop items that were already prepared
      const inLog = new Set(this.scheduler.allItems());
      for (const it of [...this.prepared]) if (!inLog.has(it) && this.cue?.item !== it) this.releasePrep(it);
    }
    // songs and spoken elements prepare in separate lanes, so a slow voice render never holds up music
    const busy = { music: 0, other: 0 };
    for (const id of this.preparing) busy[this.scheduler.findItem(id)?.type === 'music' ? 'music' : 'other']++;
    this.prefetch();
    for (const it of upcoming) {
      const lane = it.type === 'music' ? 'music' : 'other';
      if (it.status !== 'scheduled' || this.preparing.has(it.id) || busy[lane] >= 2) continue;
      busy[lane]++;
      this.prepare(it);
    }
  }

  /** Fetch the songs coming up in the log into the cache, in airplay order, well before they air. */
  prefetch() {
    // arcod fetches a song in seconds: every song in the log is on disk long before it airs.
    // monochrome is slow, so only the next few are fetched, in order.
    const ahead = mono.musicSource() === 'arcod' ? Infinity : Math.max(0, Number(store.settings.prefetchSongs ?? 10));
    const songs = this.scheduler.pendingItems().filter((i) => i.type === 'music' && i.trackId);
    const keep = new Set();
    let n = 0;
    for (const it of songs) {
      if (n >= ahead) break;
      if (mono.isCached(it.trackId)) { queueAnalysis(it.trackId, { urgent: true }); continue; } // ending and fade point known before air
      n++;
      keep.add(String(it.trackId));
      const f = mono.fetchTrack(it.trackId, { priority: this.preparing.has(it.id) ? 0 : n });
      if (f && !this.preparing.has(it.id)) setPriority(String(it.trackId), n);
    }
    dropFetches(keep);
  }

  /** A song's background analysis finished: prepared or playing copies learn its real ending and fade point. */
  applyAnalysis(trackId, a) {
    const track = library.findTrack(trackId);
    const manual = track?.markers || {};
    for (const it of this.scheduler.allItems()) {
      if (it.trackId !== trackId || !it.prep?.markers) continue;
      const m = it.prep.markers;
      Object.assign(m, {
        endSec: a.endSec, endType: manual.endType || a.endType, mixOut: manual.mixOut ?? a.mixOut,
        duration: a.duration, tailTempo: a.tailTempo, loudness: m.loudness ?? a.loudness,
      });
      it.markers = this.publicMarkers(it.prep);
      const live = this.sources.find((s) => s.item === it);
      if (live) {
        live.trimEnd = Math.round(a.endSec * SR);
        live.markers = m;
        if (live === this.anchor && this.cue && !this.cue.committed) this.uncue(); // re-plan the segue on the real fade point
      }
    }
  }

  releasePrep(it) {
    this.prepared.delete(it);
    if (!it.prep) return;
    it.prep.decoder?.close();
    it.prep = null;
    if (['ready', 'cued', 'preparing'].includes(it.status)) it.status = 'scheduled';
  }

  async prepare(item) {
    this.preparing.add(item.id);
    item.status = 'preparing';
    const t0 = Date.now();
    try {
      const prep = item.type === 'music' ? await this.prepareMusic(item) : await this.prepareElement(item);
      if (item.status !== 'preparing' || !this.running) { prep.decoder?.close(); return; } // removed or stopped meanwhile
      item.prep = prep;
      this.prepared.add(item);
      item.audioDuration = prep.kind === 'music' ? (prep.markers.endSec || prep.markers.duration || item.duration) - (prep.markers.startSec || 0) : prep.audio.durationSec;
      item.markers = this.publicMarkers(prep);
      item.status = 'ready';
      log(`ready: [${item.type}] ${item.title || ''} (${Number(item.audioDuration).toFixed(1)}s, ${Date.now() - t0}ms)`);
    } catch (err) {
      item.error = err.message;
      if (item.type === 'music') {
        log(`music failed (${item.title}): ${err.message} — replacing`);
        if (!this.scheduler.replaceMusic(item, (t) => mono.isCached(t.id))) this.fail(err); // a song already in the cache is ready at once
      } else {
        log(`skipping [${item.type}] ${item.title}: ${err.message}`);
        item.status = 'skipped';
      }
    } finally {
      this.preparing.delete(item.id);
      this.emit('log');
    }
  }

  async prepareMusic(item) {
    const track = library.findTrack(item.trackId) || { id: item.trackId, title: item.title, artist: item.artist, album: item.album, duration: item.duration, explicit: item.explicit };
    if (library.cleanOnly() && track.explicit) throw new Error('explicit version blocked (clean versions only)');
    const cached = track.analysis?.v === ANALYSIS_VERSION ? track.analysis : null;
    const lyricsP = this.lyricsFor(track).catch(() => null);
    // from the cache, or from a chunked fetch that is filling the cache (playback starts on its first bytes)
    const fetch = mono.fetchTrack(track.id, { priority: 0 });
    const local = fetch ? null : mono.cachedPath(track.id);
    if (local && !queueAnalysis(track.id, { urgent: true })) ensurePeaks(track.id, local); // the analysis draws the waveform too
    // a song on disk whose ending is known needs no analysis while it plays: a short read-ahead, no
    // loudness or waveform pass, and no ffmpeg process at all until it goes to air
    const light = Boolean(local && cached?.endType);
    const decoder = new StreamDecoder({
      file: local || undefined, source: fetch || undefined, durationHint: track.duration, label: `${track.artist} - ${track.title}`,
      ...(light ? { maxAheadSec: 15, keepBehindSec: 2, analyse: !hasPeaks(track.id), releaseWhenIdle: true } : { maxAheadSec: 75, keepBehindSec: 45 }),
    }).start();
    try {
      await this.preroll(decoder, track, fetch ? 240_000 : 45_000, cached ? 5 : HEAD_SEC);
      if (fetch) await this.fetchInTime(fetch, track);
    } catch (err) {
      decoder.close();
      throw err;
    }
    const head = cached ? null : await analyze('head', decoder.range(0, Math.round(HEAD_SEC * SR)), {}, { handOver: true });
    const lyrics = await Promise.race([lyricsP, sleep(4000).then(() => null)]);
    const markers = this.musicMarkers(track, cached, head, lyrics);
    const prep = { kind: 'music', decoder, markers, gain: this.musicGain(markers.loudness), trackId: track.id };
    if (!cached || !cached.endType) {
      const onEnd = () => this.analyzeTail(item, prep, track).catch((e) => log('tail analysis failed:', e.message));
      if (decoder.ended) onEnd(); else decoder.once('end', onEnd);
    }
    decoder.on('error', (e) => log(`stream error (${track.title}): ${e.message}`));
    return prep;
  }

  /**
   * A song still being fetched airs only if the rest will arrive before playback gets there: the whole
   * file must be in within ~85% of the song's length at the current rate (prefetching usually means
   * it's long done). Waits up to 4 minutes for that, then gives up so the song can be replaced.
   */
  async fetchInTime(fetch, track) {
    const dur = track.duration || 200;
    const until = Date.now() + 240_000;
    while (!fetch.finished) {
      if (fetch.eta() <= dur * 0.85 - 5) return;
      if (Date.now() > until) throw new Error(`download too slow (${Math.round(fetch.rate.perSec() / 1024)} KB/s, ${Math.round(fetch.eta())}s to go)`);
      await sleep(2000);
    }
    if (fetch.error) throw fetch.error;
  }

  preroll(decoder, track, timeoutMs = 45_000, needSec = HEAD_SEC) {
    const need = Math.round(Math.min(needSec, Math.max(5, (track.duration || 200) - 2)) * SR);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (decoder.decoded > SR * 12 ? resolve() : reject(new Error('stream too slow'))), timeoutMs);
      const check = () => {
        if (decoder.error) { clearTimeout(timer); reject(decoder.error); }
        else if (decoder.decoded >= need || decoder.ended) { clearTimeout(timer); resolve(); }
      };
      decoder.on('progress', check);
      decoder.on('end', check);
      decoder.on('error', check);
      check();
    });
  }

  async lyricsFor(track) {
    const fresh = track.lyrics && track.lyrics.status !== 'error' && Date.now() - (track.lyrics.checkedAt || 0) < 30 * 86400_000;
    if (fresh) return track.lyrics;
    const l = await lookupVocalTiming({ title: track.title, artist: track.artist, album: track.album, duration: track.duration });
    if (l.status !== 'error' && library.findTrack(track.id)) library.updateTrack(track.id, { lyrics: { ...l, checkedAt: Date.now() } });
    return l;
  }

  musicMarkers(track, cached, head, lyrics) {
    const a = cached || {};
    const manual = track.markers || {};
    const ly = lyrics || track.lyrics || {};
    return {
      startSec: a.startSec ?? head?.startSec ?? 0,
      endSec: a.endSec ?? null,
      duration: a.duration ?? track.duration,
      loudness: a.loudness ?? head?.loudness ?? -14,
      rampIn: a.rampIn ?? head?.rampIn ?? 0,
      firstBeat: a.firstBeat ?? head?.firstBeat ?? null,
      headTempo: a.headTempo ?? head?.tempo ?? null,
      tailTempo: a.tailTempo ?? null,
      endType: manual.endType || a.endType || null,
      mixOut: manual.mixOut ?? a.mixOut ?? null,
      instrumental: ly.status === 'instrumental' || manual.instrumental === true,
      vocalStart: manual.intro ?? (ly.status === 'found' ? ly.vocalStart : null),
      vocalEnd: manual.outro ?? (ly.status === 'found' ? ly.vocalEnd : null),
      vocalSource: manual.intro != null || manual.outro != null ? 'manual' : ly.status === 'found' ? 'lyrics' : ly.status === 'instrumental' ? 'instrumental' : 'unknown',
    };
  }

  musicGain(loudness) {
    const target = store.settings.musicLoudness ?? -16;
    return dbToLin(Math.max(-12, Math.min(10, target - loudness)));
  }

  async analyzeTail(item, prep, track) {
    const src = this.sources.find((s) => s.item === item);
    const d = prep.decoder || src?.decoder;
    if (!d) return;
    const end = d.decoded;
    const from = Math.max(0, end - Math.round(75 * SR)); // long fades start well before the end
    const pcm = d.range(from, end);
    if (!pcm) return;
    const loudness = d.loudness();
    const tail = await analyze('tail', pcm, { offsetSec: from / SR, refLoudness: loudness }, { handOver: true });
    const m = prep.markers;
    Object.assign(m, {
      endSec: tail.endSec, endType: track.markers?.endType || tail.endType, mixOut: track.markers?.mixOut ?? tail.mixOut,
      tailTempo: tail.tempo, duration: end / SR, loudness,
    });
    const analysis = {
      v: ANALYSIS_VERSION, analyzedAt: Date.now(), duration: end / SR, loudness: Math.round(loudness * 10) / 10,
      startSec: m.startSec, endSec: tail.endSec, rampIn: m.rampIn, firstBeat: m.firstBeat, headTempo: m.headTempo,
      tailTempo: tail.tempo, endType: tail.endType, mixOut: tail.mixOut, lastLoud: tail.lastLoud,
    };
    if (library.findTrack(track.id)) library.updateTrack(track.id, { analysis });
    try {
      const pk = d.peaksArray();
      fs.writeFileSync(path.join(PEAKS_DIR, `${track.id}.i8`), Buffer.from(pk.buffer, pk.byteOffset, pk.byteLength));
    } catch { /* best effort */ }
    const live = this.sources.find((s) => s.item === item);
    if (live) {
      live.trimEnd = Math.round(tail.endSec * SR);
      live.markers = m;
      // a plan made on estimated markers is redone now that the real ending is known
      if (live === this.anchor && this.cue && !this.cue.committed) this.uncue();
    }
    item.markers = this.publicMarkers({ kind: 'music', markers: m });
    item.audioDuration = tail.endSec - (m.startSec || 0);
    this.emit('log');
  }

  async prepareElement(item) {
    const kind = KIND[item.type];
    if (kind === 'voice' && !item.script) {
      const ctx = this.scheduler.contextFor(item);
      const breakKind = item.type === 'dj' ? item.mode || 'auto' : item.type;
      const np = ctx.nextItem?.prep;
      const talkWindow = np?.kind === 'music' && np.markers.vocalStart != null ? Math.max(0, np.markers.vocalStart - (np.markers.startSec || 0)) : null;
      const res = await writeBreak({ kind: breakKind, ...ctx, at: this.estimateAirTime(item), talkWindow });
      item.script = res.text;
      item.persona = res.persona?.name;
      item.artist = res.persona?.name || item.artist;
    }
    const el = await produceElement(item);
    const audio = await loadAudio(el.file, { normalize: store.settings.normalize !== false, targetDb: kind === 'spot' ? -16 : -15 });
    const off = audio.startFrame / SR;
    const len = audio.durationSec;
    const rel = (t, dflt) => Math.min(len, Math.max(0, (t ?? dflt) - off));
    const markers = {
      voiceStart: rel(el.markers?.voiceStart, off),
      voiceEnd: rel(el.markers?.voiceEnd, off + len),
      post: rel(el.markers?.post ?? el.markers?.voiceEnd, off + len),
      tailStart: rel(el.markers?.tailStart, off + len),
      // a report produced over its own sounder and bed (older renders don't say: the setting decides)
      bedded: kind === 'voice' && (el.markers?.bed ?? (['news', 'weather', 'traffic'].includes(item.type) && store.settings.production?.infoBeds !== false)),
    };
    return { kind, audio, markers, peaks: computePeaks(audio.pcm.subarray(audio.startFrame * 2, audio.endFrame * 2), PEAK_SECONDS) };
  }

  estimateAirTime(item) {
    let t = Date.now();
    const a = this.anchor;
    if (a && !a.done) t += Math.max(0, a.len - a.position) * 1000;
    for (const it of this.scheduler.pendingItems()) {
      if (it.id === item.id) break;
      if (it.status === 'playing') continue;
      t += (it.audioDuration || estDuration(it)) * 1000;
    }
    return t;
  }

  // ------------------------------------------------------------------ UI data

  publicMarkers(prep) {
    const m = prep.markers || {};
    if (prep.kind !== 'music') return { voiceStart: m.voiceStart, voiceEnd: m.voiceEnd, post: m.post };
    const st = m.startSec || 0;
    const r = (x) => (x == null ? null : Math.round((x - st) * 100) / 100);
    return {
      intro: m.instrumental ? null : r(m.vocalStart), outro: m.instrumental ? null : r(m.vocalEnd), mixOut: r(m.mixOut),
      endType: m.endType, rampIn: m.rampIn, bpm: m.headTempo?.bpm || m.tailTempo?.bpm || null,
      vocalSource: m.vocalSource, loudness: m.loudness != null ? Math.round(m.loudness * 10) / 10 : null, instrumental: m.instrumental,
    };
  }

  publicItem(i) {
    if (!i) return null;
    return { id: i.id, type: i.type, title: i.title, artist: i.artist, artwork: i.artwork, script: i.script, category: i.category, airedAt: i.airedAt, duration: i.audioDuration, album: i.album, year: i.year, markers: i.markers, transition: i.transition };
  }

  /** Waveform overview for an item (progressive while a song is still decoding). */
  peaksFor(id) {
    const src = this.sources.find((s) => s.item.id === id);
    const it = src?.item || this.scheduler.findItem(id);
    let arr = null; let offset = 0;
    if (src?.decoder) { arr = src.decoder.peaksArray(); offset = src.trimStart / SR; }
    else if (src?.prep?.peaks) arr = src.prep.peaks;
    else if (it?.prep?.decoder) { arr = it.prep.decoder.peaksArray(); offset = it.prep.markers.startSec || 0; }
    else if (it?.prep?.peaks) arr = it.prep.peaks;
    else if (it?.trackId) {
      const f = path.join(PEAKS_DIR, `${it.trackId}.i8`);
      if (fs.existsSync(f)) { const b = fs.readFileSync(f); arr = new Int8Array(b.buffer, b.byteOffset, b.length); offset = library.findTrack(it.trackId)?.analysis?.startSec || 0; }
    }
    // the whole song's overview, computed when its file arrived, beats the decoder's partial one
    const trackId = it?.trackId || src?.item?.trackId;
    const full = trackId ? readPeaks(trackId) : null;
    let complete = !(src?.decoder && !src.decoder.ended);
    if (full && (!arr || full.length >= arr.length)) {
      arr = full; complete = true;
      if (!src?.decoder && !it?.prep) offset = library.findTrack(trackId)?.analysis?.startSec || 0;
    }
    if (!arr) return null;
    const skip = Math.min(arr.length, Math.round(offset / PEAK_SECONDS) * 2);
    const data = arr.subarray(skip);
    return { id, res: PEAK_SECONDS, complete, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64') };
  }

  timeline() {
    const nowF = this.frame;
    const rel = (f) => Math.round(((f - nowF) / SR) * 100) / 100;
    const lane = (l) => l.pts.filter((p) => Number.isFinite(p.f) && p.f > nowF - SR * 30).map((p) => [rel(p.f), Math.round(p.v * 1000) / 1000]);
    const items = this.sources.map((s) => ({
      id: s.item.id, type: s.item.type, kind: s.kind, title: s.item.title, artist: s.item.artist, overlay: s.overlay,
      start: rel(s.start), len: Math.round(s.len * 100) / 100, pos: Math.round(s.position * 100) / 100,
      markers: s.item.markers || null, fade: lane(s.fade), duck: lane(s.duck), playing: true,
    }));
    if (this.bed) {
      const b = this.bed;
      items.push({ id: 'bed', type: 'bed', kind: 'bed', title: b.item.title, artist: 'Auto-bed', overlay: true, start: rel(b.start), len: Math.round(((nowF - b.start) / SR + 2) * 100) / 100, pos: Math.round(((nowF - b.start) / SR) * 100) / 100, fade: lane(b.fade), duck: [], playing: true, on: b.on });
    }
    const mains = this.sources.filter((s) => !s.overlay && !s.done);
    let cursor = this.cue ? this.cue.startFrame : nowF + Math.max(0, ...mains.map((s) => s.start + Math.round(s.len * SR) - nowF));
    const upcoming = this.scheduler.pendingItems().filter((i) => i.status !== 'playing').slice(0, 6);
    for (const it of upcoming) {
      const isCue = this.cue?.item === it;
      const start = isCue ? this.cue.startFrame : cursor;
      const len = it.audioDuration || estDuration(it);
      items.push({
        id: it.id, type: it.type, kind: KIND[it.type], title: it.title, artist: it.artist, start: rel(start), len: Math.round(len * 100) / 100,
        markers: it.markers || null, cued: isCue, estimated: !isCue, status: it.status, transition: it.transition || null,
      });
      cursor = start + Math.round(Math.max(1, len - (KIND[it.type] === 'music' ? 3 : 0)) * SR);
    }
    return { now: Math.round((nowF / SR) * 100) / 100, wall: Date.now(), items };
  }

  state() {
    const a = this.anchor && !this.anchor.done ? this.anchor : null;
    let now = null;
    if (a) {
      const mk = a.item.markers || {};
      now = { ...this.publicItem(a.item), position: Math.round(a.position * 100) / 100, length: Math.round(a.len * 100) / 100, intro: mk.intro, outro: mk.outro, endType: mk.endType };
    }
    return {
      running: this.running,
      now,
      next: this.cue ? { ...this.publicItem(this.cue.item), in: Math.round(((this.cue.startFrame - this.frame) / SR) * 10) / 10 } : null,
      overlays: this.sources.filter((s) => s.overlay && !s.done).map((s) => ({ title: s.item.title, type: s.item.type, remaining: Math.max(0, s.len - s.position) })),
      listeners: this.streamer.listeners.size,
      icecast: this.streamer.icecastStatus,
      deadAir: this.running && !this.sources.some((s) => !s.done && !s.overlay),
      lastError: this.lastError,
      bed: { on: Boolean(this.bed?.on), name: this.bedAudio?.name || null, ready: Boolean(this.bedAudio) },
      processing: { preset: this.processor.p.preset, bypass: this.processor.p.bypass, loudness: this.processor.loudness() },
      wall: Date.now(),
    };
  }

  /** Decoders and song downloads in detail (the engineering screen). */
  decksState() {
    return { decks: this.deckStats(), fetcher: fetcherStatus() };
  }

  deckStats() {
    const out = [];
    for (const s of this.sources) if (s.decoder) out.push({ id: s.item.id, title: s.item.title, playing: true, underrun: s.underrun > 0, ...s.decoder.stats() });
    for (const it of this.scheduler.allItems()) if (it.prep?.decoder) out.push({ id: it.id, title: it.title, playing: false, ...it.prep.decoder.stats() });
    return out;
  }
}
