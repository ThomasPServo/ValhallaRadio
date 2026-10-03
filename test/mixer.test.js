import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sine } from './helpers.js';
import { analyze, normalizeGain, overlapSec, mixSource, limitToInt16, dbToGain, gainToDb, fadeOutCurve, fadeInCurve } from '../server/engine/mixer.js';

test('analyze trims leading and trailing silence', () => {
  const pcm = sine(2, { padStart: 0.5, padEnd: 1 });
  const a = analyze(pcm);
  assert.ok(Math.abs(a.startFrame - 22050) < 50, `start ${a.startFrame}`);
  assert.ok(Math.abs(a.endFrame - (22050 + 88200)) < 50, `end ${a.endFrame}`);
});

test('analyze loudness tracks amplitude (~6 dB per halving)', () => {
  const loud = analyze(sine(2, { amp: 0.5 })).loudnessDb;
  const quiet = analyze(sine(2, { amp: 0.25 })).loudnessDb;
  assert.ok(Math.abs(loud - quiet - 6.02) < 0.2, `${loud} vs ${quiet}`);
});

test('normalizeGain moves items to target and is capped at ±12 dB', () => {
  assert.ok(Math.abs(gainToDb(normalizeGain(-20, -17)) - 3) < 1e-9);
  assert.ok(Math.abs(gainToDb(normalizeGain(-60, -17)) - 12) < 1e-9);
  assert.ok(Math.abs(gainToDb(normalizeGain(0, -17)) + 12) < 1e-9);
  assert.equal(normalizeGain(-90), 1);
});

test('fade curves are equal-power', () => {
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(Math.abs(fadeOutCurve(p) ** 2 + fadeInCurve(p) ** 2 - 1) < 1e-9);
  }
});

test('overlap rules: crossfade songs, talk-up from voice into music, tight spots', () => {
  const o = { crossfadeSec: 3, talkOverSec: 6, curDurSec: 200, nextDurSec: 200 };
  assert.equal(overlapSec('music', 'music', o), 3);
  assert.equal(overlapSec('voice', 'music', { ...o, curDurSec: 20 }), 6);
  // short break: talk-over never exceeds the break minus 1.5s
  assert.equal(overlapSec('voice', 'music', { ...o, curDurSec: 4 }), 2.5);
  assert.equal(overlapSec('spot', 'spot', o), 0.1);
  assert.ok(overlapSec('imaging', 'music', { ...o, curDurSec: 4 }) <= 1.2);
  // never longer than the incoming item
  assert.ok(overlapSec('music', 'music', { ...o, nextDurSec: 2 }) <= 1.8);
});

test('mixSource applies gain, bus ramp and fades, and advances position', () => {
  const src = { pcm: sine(1, { amp: 0.5 }), pos: 0, endFrame: 44100, gain: 1 };
  const out = new Float32Array(1000 * 2);
  const n = mixSource(out, 0, src, 1000, 0.5, 0.5);
  assert.equal(n, 1000);
  assert.equal(src.pos, 1000);
  const peak = Math.max(...out.map(Math.abs));
  assert.ok(peak > 0.2 && peak <= 0.26, `peak ${peak}`);

  const fading = { pcm: sine(1, { amp: 0.5 }), pos: 0, endFrame: 44100, gain: 1, fadeOut: { at: 0, frames: 1000 } };
  const out2 = new Float32Array(1000 * 2);
  mixSource(out2, 0, fading, 1000);
  const tail = Math.max(...out2.slice(1980).map(Math.abs)); // last 10 frames
  assert.ok(tail < 0.02, `fade tail ${tail}`);
});

test('mixSource stops at endFrame', () => {
  const src = { pcm: sine(1), pos: 44000, endFrame: 44100, gain: 1 };
  const out = new Float32Array(1000 * 2);
  assert.equal(mixSource(out, 0, src, 1000), 100);
  assert.equal(out[300], 0);
});

test('limiter keeps output under the ceiling', () => {
  const buf = new Float32Array(20000).map((_, i) => Math.sin(i / 10) * 1.8);
  const out = limitToInt16(buf, {});
  const peak = Math.max(...Array.from(out, (v) => Math.abs(v))) / 32767;
  assert.ok(peak <= 0.971, `peak ${peak}`);
  assert.ok(dbToGain(0) === 1);
});
