import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTail, loudnessProfile, FS } from '../server/audio/analysis.js';
import { planTransition } from '../server/engine/planner.js';

// Stereo "music": noise at a steady level, with a gain envelope in dB over time.
function music(seconds, envDb, seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const n = Math.round(seconds * FS);
  const pcm = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const g = 10 ** (envDb(i / FS) / 20) * 0.3;
    pcm[i * 2] = Math.round(rnd() * g * 32767);
    pcm[i * 2 + 1] = Math.round(rnd() * g * 32767);
  }
  return pcm;
}
const refOf = (pcm) => loudnessProfile(pcm).integrated;

test('a fade-out is found, and the segue point is early in the fade, not at the end', () => {
  // 60 s full level, then a 30 s fade to silence
  const song = music(90, (t) => (t < 60 ? 0 : -60 * ((t - 60) / 30)));
  const ref = refOf(song.subarray(0, 60 * FS * 2));
  const from = 15; // the last 75 s, as the analyzer looks at them
  const tail = analyzeTail(song.subarray(from * FS * 2), { offsetSec: from, refLoudness: ref });
  assert.equal(tail.endType, 'fade');
  assert.ok(tail.mixOut > 62 && tail.mixOut < 70, `mix point ${tail.mixOut}s is a few seconds into the fade`);
  assert.ok(tail.endSec - tail.mixOut > 15, 'well before the music actually ends');
});

test('a long fade that began before the analysed window is still a fade', () => {
  // a 90 s fade (full level to -45 dB) that started before the last 75 s, the part the analyzer looks at
  const song = music(100, (t) => (t < 10 ? 0 : -45 * ((t - 10) / 90)));
  const ref = refOf(song.subarray(0, 10 * FS * 2));
  const from = 25;
  const tail = analyzeTail(song.subarray(from * FS * 2), { offsetSec: from, refLoudness: ref });
  assert.equal(tail.endType, 'fade', 'not mistaken for a cold ending');
  assert.ok(tail.mixOut < tail.endSec - 20, `segue (${tail.mixOut}s) long before the end (${tail.endSec}s)`);
});

test('a cold ending stays cold: the segue waits for the final hit to ring out', () => {
  const song = music(40, (t) => (t < 35 ? 0 : -80));
  const ref = refOf(song.subarray(0, 35 * FS * 2));
  const tail = analyzeTail(song, { offsetSec: 0, refLoudness: ref });
  assert.equal(tail.endType, 'cold');
  assert.ok(tail.mixOut >= 34.5 && tail.mixOut <= 35.5, `mix point ${tail.mixOut}s at the stop`);
});

test('the planner starts the next song at the fade point, overlapping the fade', () => {
  const plan = planTransition({
    now: 0,
    prev: { id: 'a', kind: 'music', start: 0, len: 200, endType: 'fade', mixOut: 182, vocalEnd: 170 },
    next: { id: 'b', kind: 'music', len: 210, vocalStart: 12, rampIn: 0.2, firstBeat: 0.1 },
  });
  assert.ok(plan.start >= 181 && plan.start <= 183, `next song starts at ${plan.start}s, at the fade point`);
  assert.ok(200 - plan.start > 15, 'over the fade, not after it');
});
