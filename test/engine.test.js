import { sine } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../server/store.js';
import { Playout } from '../server/engine/playout.js';

const SR = 44100;

/** Stand-in for StreamDecoder: fully decoded PCM with the same read API. */
class FakeDecoder {
  constructor(pcm) { this.pcm = pcm; this.decoded = pcm.length / 2; this.readPos = 0; this.ended = true; this.error = null; this.closed = false; }
  skipTo(f) { this.readPos = f; }
  aheadFrames() { return this.decoded - this.readPos; }
  mixInto(dst, off, frames, g0, g1) {
    const n = Math.max(0, Math.min(frames, this.decoded - this.readPos));
    for (let i = 0; i < n; i++) {
      const g = (g0 + ((g1 - g0) * i) / frames) / 32768;
      const s = (this.readPos + i) * 2; const o = (off + i) * 2;
      dst[o] += this.pcm[s] * g; dst[o + 1] += this.pcm[s + 1] * g;
    }
    this.readPos += frames;
    return n;
  }
  close() { this.closed = true; }
  peaksArray() { return new Int8Array(0); }
  stats() { return {}; }
}

function song(id, seconds, markers = {}, freq = 440) {
  const pcm = sine(seconds, { freq, amp: 0.4 });
  return { id, type: 'music', title: id, status: 'ready', prep: { kind: 'music', decoder: new FakeDecoder(pcm), gain: 1, markers: { startSec: 0, endSec: seconds, duration: seconds, ...markers } } };
}
function voice(id, seconds, type = 'dj') {
  const pcm = sine(seconds, { freq: 220, amp: 0.3 });
  return { id, type, title: id, status: 'ready', prep: { kind: 'voice', audio: { pcm, startFrame: 0, endFrame: pcm.length / 2, gain: 1, durationSec: seconds }, markers: { voiceStart: 0, voiceEnd: seconds, post: seconds, tailStart: seconds } } };
}

function setup(items) {
  const scheduler = {
    next: () => { const it = items.find((i) => i.status === 'ready'); return it ? { item: it } : {}; },
    pendingItems: () => items.filter((i) => ['ready', 'cued', 'scheduled', 'preparing'].includes(i.status)),
    upcoming: () => [],
    allItems: () => items,
    findItem: (id) => items.find((i) => i.id === id),
    contextFor: () => ({}),
    ensure: async () => {},
  };
  const streamer = { listeners: new Set(), write() {}, start() {}, stop() {}, setTitle() {}, icecastStatus: 'off' };
  const engine = new Playout(scheduler, streamer);
  engine.running = true;
  engine.startWall = Date.now();
  return { engine, items };
}

/** Run the engine for `seconds`, recording per-block info. */
function run(engine, seconds, probe) {
  const out = [];
  for (let t = 0; t < seconds * SR; t += 1024) {
    engine.maybePlan();
    const buf = engine.render(1024);
    let s = 0;
    for (let i = 0; i < buf.length; i += 2) s += buf[i] * buf[i];
    out.push({ t: (t + 1024) / SR, rms: Math.sqrt(s / 1024), ...(probe ? probe() : {}) });
  }
  return out;
}

test('fade ending: next song comes in at the mix-out point with no gap, old song faded out', () => {
  store.data.settings.beatMatch = false;
  const { engine, items } = setup([song('a', 6, { endType: 'fade', mixOut: 4 }), song('b', 6, {}, 660)]);
  let bAt = null;
  const tl = run(engine, 7, () => { if (bAt === null && items[1].status === 'playing') bAt = engine.nowSec(); return {}; });
  assert.ok(bAt > 3.9 && bAt < 4.1, `b started at ${bAt}`);
  assert.ok(Math.min(...tl.filter((x) => x.t > 0.1 && x.t < 6.5).map((x) => x.rms)) > 0.15, 'no dip during the segue');
  assert.equal(items[0].status, 'played');
  assert.equal(items[1].transition.type, 'segue');
});

test('cold ending: tight segue right at the end', () => {
  const { engine, items } = setup([song('a', 3, { endType: 'cold', mixOut: 2.95 }), song('b', 4, {}, 660)]);
  let bAt = null;
  run(engine, 4, () => { if (bAt === null && items[1].status === 'playing') bAt = engine.nowSec(); return {}; });
  assert.ok(bAt > 2.85 && bAt < 3.0, `b started at ${bAt}`);
});

test('DJ starts only after the outgoing vocals end, with the song ducked underneath', () => {
  const { engine, items } = setup([song('a', 8, { endType: 'cold', mixOut: 7.9, vocalEnd: 5 }), voice('v', 3)]);
  let vAt = null; let duckAtVoice = null;
  run(engine, 9, () => {
    if (vAt === null && items[1].status === 'playing') vAt = engine.nowSec();
    if (vAt !== null && duckAtVoice === null && engine.nowSec() > vAt + 0.3) duckAtVoice = engine.sources.find((s) => s.item.id === 'a')?.duck.value(engine.frame);
    return {};
  });
  assert.ok(vAt >= 5.35, `voice at ${vAt}`);
  assert.ok(duckAtVoice < 0.3, `song ducked under the voice (${duckAtVoice})`);
});

test('talk-up: the song starts under the DJ and its vocals land after the talk ends', () => {
  const { engine, items } = setup([voice('v', 3), song('b', 10, { vocalStart: 5 })]);
  let bAt = null; let duckEarly = null; let duckLate = null;
  run(engine, 9, () => {
    if (bAt === null && items[1].status === 'playing') bAt = engine.nowSec();
    const b = engine.sources.find((s) => s.item.id === 'b');
    if (b && duckEarly === null && engine.nowSec() > bAt + 0.2) duckEarly = b.duck.value(engine.frame);
    if (b && duckLate === null && engine.nowSec() > 4.5) duckLate = b.duck.value(engine.frame);
    return {};
  });
  assert.ok(bAt > 0.35 && bAt < 0.5, `song starts 0.4 s into the talk (at ${bAt})`);
  assert.ok(bAt + 5 >= 3 + 0.25, 'vocals after the talk');
  assert.ok(duckEarly < 0.3, `intro ducked under the voice (${duckEarly})`);
  assert.ok(duckLate > 0.95, `intro swells back after the talk (${duckLate})`);
});

test('unknown intro: the song waits for the talk to finish', () => {
  const { engine, items } = setup([voice('v', 2), song('b', 6, { vocalStart: null })]);
  let bAt = null;
  run(engine, 4, () => { if (bAt === null && items[1].status === 'playing') bAt = engine.nowSec(); return {}; });
  assert.ok(bAt >= 2, `song at ${bAt}`);
});

test('operator skip pots the current item down and takes the next one immediately', () => {
  const { engine, items } = setup([song('a', 30), song('b', 30, {}, 550)]);
  run(engine, 1);
  assert.equal(items[0].status, 'playing');
  engine.skip();
  run(engine, 0.5);
  assert.equal(items[1].status, 'playing');
  run(engine, 1.5);
  assert.equal(items[0].status, 'played');
});

test('stopping mid-item re-queues it so a restart cannot hang on released audio', () => {
  const { engine, items } = setup([song('a', 30)]);
  run(engine, 1);
  assert.equal(items[0].status, 'playing');
  engine.stop();
  assert.equal(items[0].status, 'scheduled');
});

test('timeline describes playing and cued items relative to now', () => {
  const { engine } = setup([song('a', 10, { endType: 'cold', mixOut: 9.9 }), song('b', 10, {}, 550)]);
  run(engine, 1);
  const tl = engine.timeline();
  const a = tl.items.find((i) => i.id === 'a');
  assert.ok(a.playing && a.start < 0 && a.len > 9);
  const b = tl.items.find((i) => i.id === 'b');
  assert.ok(b && b.start > 8, JSON.stringify(b));
});

test('automation lanes never produce NaN and hold their value before the first ramp', async () => {
  const { Lane } = await import('../server/engine/sources.js');
  const l = new Lane(1);
  l.ramp(1000, 2000, 0, 'db');
  for (const f of [-1e12, 0, 999, 1000, 1500, 1999, 2000, 5000]) {
    const v = l.value(f);
    assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `value at ${f} = ${v}`);
  }
  assert.equal(l.value(500), 1);
  assert.equal(l.value(2500), 0);
  const d = new Lane(1);
  d.ramp(100, 200, 0.25, 'lin');
  d.ramp(400, 500, 1, 'lin');
  assert.equal(d.value(300), 0.25);
  assert.ok(Math.abs(d.value(450) - 0.625) < 1e-9);
});

test('a song with an unanalysed ending is not planned until 25 s before its end', () => {
  const a = song('a', 60, {}); // no endType yet
  const { engine, items } = setup([a, song('b', 30, {}, 550)]);
  run(engine, 30);
  assert.equal(items[1].status, 'ready', 'too early to plan with 30 s left');
  run(engine, 8);
  assert.equal(items[1].status, 'cued', 'planned once inside the last 25 s');
});

// ------------------------------------------------------------------ auto-bed

function withBed(engine) {
  const pcm = sine(4, { freq: 110, amp: 0.3 });
  engine.bedAudio = { id: 'synth:test', name: 'Test bed', pcm, frames: pcm.length / 2, gain: 1, seconds: 4 };
  return engine;
}
function spot(id, seconds) {
  const pcm = sine(seconds, { freq: 330, amp: 0.3 });
  return { id, type: 'spot', title: id, status: 'ready', prep: { kind: 'spot', audio: { pcm, startFrame: 0, endFrame: pcm.length / 2, gain: 1, durationSec: seconds }, markers: { voiceStart: 0, voiceEnd: seconds, post: seconds, tailStart: seconds } } };
}
const bedGain = (engine) => (engine.bed ? engine.bed.gainAt(engine.frame) : 0);
const level = Math.pow(10, -12 / 20);

test('auto-bed: dry talk gets a bed that hands over to the song intro', () => {
  store.data.settings.autoBed = { enabled: true, levelDb: -12, bed: 'auto' };
  const { engine, items } = setup([voice('v', 6), song('b', 12, { vocalStart: 2 })]);
  withBed(engine);
  let bAt = null;
  const tl = run(engine, 9, () => {
    if (bAt === null && items[1].status === 'playing') bAt = engine.nowSec();
    return { bed: bedGain(engine), on: Boolean(engine.bed?.on) };
  });
  const at = (t) => tl.find((x) => x.t >= t);
  assert.ok(bAt > 4 && bAt < 5, `song comes in under the talk at ${bAt}`);
  assert.ok(at(0.8).bed > level * 0.95, `bed up under the dry talk (${at(0.8).bed})`);
  assert.ok(at(bAt - 0.2).on, 'bed holds until the song starts');
  assert.ok(!at(bAt + 0.1).on && at(bAt + 0.1).bed > 0, 'bed fades (not cuts) as the song comes in');
  assert.equal(at(bAt + 1.8).bed, 0, 'bed gone after the handover');
  assert.equal(engine.bed, null);
});

test('auto-bed: no bed when the DJ is talking over a song', () => {
  store.data.settings.autoBed = { enabled: true, levelDb: -12, bed: 'auto' };
  const { engine } = setup([song('a', 9, { endType: 'cold', mixOut: 8.9, vocalEnd: 3 }), voice('v', 3), song('b', 10, { vocalStart: 4 }, 660)]);
  withBed(engine);
  const tl = run(engine, 9, () => ({ bed: bedGain(engine) }));
  assert.equal(Math.max(...tl.map((x) => x.bed)), 0);
});

test('auto-bed: a short dry moment before the song gets no bed', () => {
  store.data.settings.autoBed = { enabled: true, levelDb: -12, bed: 'auto' };
  const { engine } = setup([voice('v', 3), song('b', 10, { vocalStart: 1.5 })]);
  withBed(engine);
  const tl = run(engine, 5, () => ({ bed: bedGain(engine) }));
  assert.equal(Math.max(...tl.map((x) => x.bed)), 0);
});

test('auto-bed: carries straight through back-to-back talk (weather into traffic)', () => {
  store.data.settings.autoBed = { enabled: true, levelDb: -12, bed: 'auto' };
  store.data.settings.production = { ...store.data.settings.production, infoBeds: false };
  const { engine, items } = setup([voice('w', 4, 'weather'), voice('t', 4, 'traffic'), song('b', 10, { vocalStart: null })]);
  withBed(engine);
  let bAt = null;
  const tl = run(engine, 12, () => {
    if (bAt === null && items[2].status === 'playing') bAt = engine.nowSec();
    return { bed: bedGain(engine) };
  });
  const span = tl.filter((x) => x.t > 1 && x.t < bAt - 0.1);
  assert.ok(Math.min(...span.map((x) => x.bed)) > level * 0.95, 'no dip between the two reports');
  assert.equal(tl.at(-1).bed, 0, 'bed out once the song is in');
  store.data.settings.production.infoBeds = true;
});

test('auto-bed: a spot takes the bed out quickly', () => {
  store.data.settings.autoBed = { enabled: true, levelDb: -12, bed: 'auto' };
  const { engine, items } = setup([voice('v', 4), spot('s', 4)]);
  withBed(engine);
  let sAt = null;
  const tl = run(engine, 7, () => {
    if (sAt === null && items[1].status === 'playing') sAt = engine.nowSec();
    return { bed: bedGain(engine) };
  });
  assert.ok(tl.find((x) => x.t >= 1).bed > level * 0.95);
  assert.equal(tl.find((x) => x.t >= sAt + 0.6).bed, 0, 'gone within 0.6 s of the spot');
});

test('auto-bed: off when disabled', () => {
  store.data.settings.autoBed = { enabled: false, levelDb: -12, bed: 'auto' };
  const { engine } = setup([voice('v', 6), song('b', 12, { vocalStart: 2 })]);
  withBed(engine);
  const tl = run(engine, 6, () => ({ bed: bedGain(engine) }));
  assert.equal(Math.max(...tl.map((x) => x.bed)), 0);
  store.data.settings.autoBed.enabled = true;
});
