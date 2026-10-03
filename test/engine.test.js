import { sine } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../server/store.js';
import { Playout } from '../server/engine/playout.js';
import { dbToGain } from '../server/engine/mixer.js';

const SR = 44100;

function setup(queue) {
  const items = queue.map(([id, type, pcm]) => ({ id, type, status: 'ready', title: id }));
  const scheduler = {
    next: () => {
      const it = items.find((i) => i.status === 'ready');
      return it ? { item: it } : {};
    },
    pendingItems: () => items.filter((i) => i.status === 'ready'),
    upcoming: () => [],
    findItem: (id) => items.find((i) => i.id === id),
  };
  const streamer = { listeners: new Set(), write() {}, start() {}, stop() {}, setTitle() {}, icecastStatus: 'off' };
  const engine = new Playout(scheduler, streamer);
  engine.running = true;
  queue.forEach(([id, , pcm]) => engine.prepared.set(id, { pcm, startFrame: 0, endFrame: pcm.length / 2, gain: 1, durationSec: pcm.length / 2 / SR }));
  return { engine, items };
}

function rmsWindows(int16, win = 2205) {
  const out = [];
  for (let f = 0; f + win <= int16.length / 2; f += win) {
    let s = 0;
    for (let i = f; i < f + win; i++) s += (int16[i * 2] / 32768) ** 2;
    out.push(Math.sqrt(s / win));
  }
  return out;
}

test('songs crossfade with no gap and the next song starts crossfadeSec before the end', () => {
  store.data.settings.crossfadeSec = 1;
  const { engine, items } = setup([['a', 'music', sine(3, { freq: 440, amp: 0.4 })], ['b', 'music', sine(3, { freq: 660, amp: 0.4 })]]);
  const chunks = [];
  let bStartedAt = null;
  for (let t = 0; t < 4.5 * SR; t += 2205) {
    chunks.push(engine.render(2205));
    if (bStartedAt === null && items[1].status === 'playing') bStartedAt = (t + 2205) / SR;
  }
  assert.ok(bStartedAt > 1.9 && bStartedAt < 2.15, `b started at ${bStartedAt}`);
  const all = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  const rms = rmsWindows(all).slice(0, 80); // first 4s
  assert.ok(Math.min(...rms) > 0.15, `dip during crossfade: ${Math.min(...rms).toFixed(3)}`);
  assert.equal(items[0].status, 'played');
});

test('music under a DJ talk-up is ducked, then restored when the voice ends', () => {
  store.data.settings.talkOverSec = 2;
  store.data.settings.duckDb = -12;
  const { engine, items } = setup([['dj', 'dj', sine(6, { freq: 220, amp: 0.3 })], ['song', 'music', sine(8, { freq: 1000, amp: 0.4 })]]);
  const timeline = [];
  for (let t = 0; t < 8 * SR; t += 1024) {
    engine.render(1024);
    timeline.push({ t: (t + 1024) / SR, duck: engine.duck, song: items[1].status, dj: items[0].status });
  }
  const songStart = timeline.find((x) => x.song === 'playing').t;
  assert.ok(songStart > 3.9 && songStart < 4.1, `song should start under the last 2s of talk, started ${songStart}`);
  const during = timeline.find((x) => x.t > 5);
  assert.ok(Math.abs(during.duck - dbToGain(-12)) < 0.01, `duck during voice ${during.duck}`);
  const after = timeline.find((x) => x.t > 7.5);
  assert.equal(after.dj, 'played');
  assert.ok(after.duck > 0.95, `duck released ${after.duck}`);
});

test('a short break never lets the song swallow the whole talk', () => {
  store.data.settings.talkOverSec = 6;
  const { engine, items } = setup([['dj', 'dj', sine(3, { freq: 220, amp: 0.3 })], ['song', 'music', sine(8)]]);
  let songStart = null;
  for (let t = 0; t < 4 * SR && songStart === null; t += 1024) {
    engine.render(1024);
    if (items[1].status === 'playing') songStart = (t + 1024) / SR;
  }
  assert.ok(songStart >= 1.45 && songStart < 1.6, `talk-over capped at break length - 1.5s, started ${songStart}`);
});

test('skip fades the current item quickly and starts the next one', () => {
  const { engine, items } = setup([['a', 'music', sine(30)], ['b', 'music', sine(30, { freq: 550 })]]);
  engine.render(SR);
  assert.equal(items[0].status, 'playing');
  engine.skip();
  engine.render(SR);
  assert.equal(items[1].status, 'playing');
  engine.render(SR);
  assert.equal(items[0].status, 'played');
});

test('stopping mid-item re-queues it so a restart cannot hang on released audio', () => {
  const { engine, items } = setup([['a', 'music', sine(30)]]);
  engine.render(SR);
  assert.equal(items[0].status, 'playing');
  engine.stop();
  assert.equal(items[0].status, 'scheduled');
});
