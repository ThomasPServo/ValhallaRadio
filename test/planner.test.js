import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTransition, DEFAULTS } from '../server/engine/planner.js';

const song = (o = {}) => ({ kind: 'music', start: 0, len: 200, endType: 'fade', mixOut: 192, vocalEnd: 185, ...o });
const voice = (len, o = {}) => ({ kind: 'voice', len, voiceStart: 0, voiceEnd: len, ...o });
const sweeper = (o = {}) => ({ kind: 'imaging', len: 4, voiceStart: 0.6, voiceEnd: 2.6, post: 2.8, tailStart: 3.4, ...o });
const nextSong = (o = {}) => ({ kind: 'music', len: 210, vocalStart: 10, rampIn: 0.2, firstBeat: 0.1, ...o });

test('fade ending: the next song comes in as the fade gets going, then the old one is faded out', () => {
  const p = planTransition({ now: 150, prev: song(), next: nextSong() });
  assert.equal(p.type, 'segue');
  assert.ok(Math.abs(p.start - 192) < 0.01);
  const f = p.ramps.find((r) => r.target === 'prev' && r.lane === 'fade');
  assert.ok(f && f.at >= p.start && f.to === 0);
});

test('cold ending: tight segue right on the end', () => {
  const p = planTransition({ now: 150, prev: song({ endType: 'cold', mixOut: 199.6 }), next: nextSong() });
  assert.equal(p.type, 'cold');
  assert.ok(p.start > 199.5 && p.start <= 199.6);
});

test('soft intro starts a little earlier', () => {
  const p = planTransition({ now: 150, prev: song(), next: nextSong({ rampIn: 3 }) });
  assert.ok(p.start < 192 && p.start >= 190);
});

test('beat matching nudges the next song onto the outgoing beat grid', () => {
  const prev = song({ beat: { period: 0.5, phase: 0.1, confidence: 0.95 } });
  const p = planTransition({ now: 150, prev, next: nextSong({ firstBeat: 0.33, beat: { period: 0.5, confidence: 0.95 } }) });
  const downbeat = p.start + 0.33;
  const offGrid = Math.abs(((downbeat - 0.1) / 0.5) - Math.round((downbeat - 0.1) / 0.5));
  assert.ok(offGrid < 1e-6, `downbeat ${downbeat} off grid`);
  assert.ok(p.notes.includes('Beat-matched'));
});

test('beat matching is skipped when tempos differ or confidence is low', () => {
  const prev = song({ beat: { period: 0.5, phase: 0.1, confidence: 0.95 } });
  const p = planTransition({ now: 150, prev, next: nextSong({ firstBeat: 0.33, beat: { period: 0.6, confidence: 0.95 } }) });
  assert.ok(!p.notes.includes('Beat-matched'));
});

test('DJ talks over the instrumental outro only after the last vocal', () => {
  const p = planTransition({ now: 150, prev: song({ vocalEnd: 180, endType: 'cold', mixOut: 199.5 }), next: voice(8) });
  assert.equal(p.type, 'talkover');
  assert.ok(p.start >= 180.35, `voice at ${p.start}`);
  assert.ok(p.start <= 200, 'starts before the song is over');
  assert.ok(p.ramps.some((r) => r.target === 'prev' && r.lane === 'duck'));
});

test('unknown vocals: fade the song out first, then talk', () => {
  const p = planTransition({ now: 150, prev: song({ vocalEnd: null }), next: voice(8) });
  assert.equal(p.type, 'fade-talk');
  const f = p.ramps.find((r) => r.target === 'prev' && r.lane === 'fade');
  assert.ok(f.at + f.dur <= p.start + 1e-9, 'song fully out before the voice');
});

test('talk-up: long intro, short talk — song starts under the voice and vocals stay clear', () => {
  const V = { ...voice(6), start: 100 };
  const p = planTransition({ now: 99, prev: V, next: nextSong({ vocalStart: 10 }) });
  assert.equal(p.type, 'talkup');
  assert.ok(Math.abs(p.start - 100.4) < 1e-9);
  assert.ok(p.start + 10 >= 106 + DEFAULTS.minVocalGap);
  assert.ok(p.ramps.some((r) => r.target === 'next' && r.lane === 'duck' && r.to < 1));
});

test('talk-up: talk longer than the intro — vocals hit exactly postGap after the talk', () => {
  const V = { ...voice(9), start: 100 };
  const p = planTransition({ now: 99, prev: V, next: nextSong({ vocalStart: 4 }) });
  assert.ok(Math.abs(p.start + 4 - (109 + DEFAULTS.postGap)) < 1e-9);
});

test('unknown intro: the song starts as the talk ends', () => {
  const V = { ...voice(9), start: 100 };
  const p = planTransition({ now: 99, prev: V, next: nextSong({ vocalStart: null }) });
  assert.equal(p.type, 'post');
  assert.ok(p.start >= 109);
});

test('sweeper post lands on the next song\'s first downbeat', () => {
  const I = { ...sweeper(), start: 50 };
  const p = planTransition({ now: 49, prev: I, next: nextSong({ firstBeat: 0.4, vocalStart: 12 }) });
  assert.ok(Math.abs(p.start + 0.4 - 52.8) < 1e-9);
});

test('song still sounding under a DJ break is potted down when the next song comes in', () => {
  const V = { ...voice(6), start: 100 };
  const p = planTransition({ now: 99, prev: V, next: nextSong({ vocalStart: 10 }), others: [{ id: 'oldsong', kind: 'music' }] });
  assert.ok(p.ramps.some((r) => r.target === 'oldsong' && r.lane === 'fade' && r.to === 0));
});

test('spots butt together with a short gap', () => {
  const p = planTransition({ now: 10, prev: { kind: 'spot', start: 10, len: 30 }, next: { kind: 'spot', len: 30 } });
  assert.ok(Math.abs(p.start - 40.2) < 1e-9);
});

test('operator take fades everything and starts right away', () => {
  const p = planTransition({ now: 77, prev: song({ start: 0 }), next: nextSong(), opts: { immediate: true } });
  assert.equal(p.type, 'cut');
  assert.ok(p.start - 77 < 0.3);
});

// ---------------------------------------------------------------- property tests: never talk over vocals
function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
const fadedOutBy = (ramps, target, t) => ramps.some((r) => r.target === target && r.lane === 'fade' && r.to === 0 && r.at + r.dur <= t + 1e-9);

test('property: a DJ voice never starts over the outgoing song\'s vocals', () => {
  const R = rng(42);
  for (let i = 0; i < 2000; i++) {
    const len = 120 + R() * 200;
    const endType = R() < 0.5 ? 'fade' : 'cold';
    const mixOut = endType === 'fade' ? len - 3 - R() * 12 : len - R() * 0.5;
    const known = R() < 0.7;
    const vocalEnd = known ? len - R() * 40 : null;
    const prev = { kind: 'music', start: 0, len, endType, mixOut, vocalEnd };
    const vlen = 2 + R() * 25;
    const p = planTransition({ now: len - 60, prev, next: voice(vlen) });
    const voiceAt = p.start;
    const clear = known ? voiceAt >= vocalEnd + 0.3 - 1e-9 : voiceAt >= len - 1e-9;
    assert.ok(clear || fadedOutBy(p.ramps, 'prev', voiceAt), `case ${i}: ${JSON.stringify({ prev, vlen, p })}`);
  }
});

test('property: incoming song vocals never start under a DJ voice or imaging voice', () => {
  const R = rng(7);
  for (let i = 0; i < 2000; i++) {
    const known = R() < 0.8;
    const vocalStart = known ? R() * 40 : null;
    const isVoice = R() < 0.5;
    const prev = isVoice
      ? { kind: 'voice', start: 100, len: 1 + R() * 25 }
      : { kind: 'imaging', start: 100, len: 3 + R() * 4, voiceStart: R() * 1.5 };
    if (!isVoice) { prev.voiceEnd = prev.voiceStart + 0.5 + R() * 2; prev.post = prev.voiceEnd + R() * 0.5; prev.tailStart = Math.min(prev.len, prev.post + 0.5); }
    const voiceEndAbs = prev.start + (prev.voiceEnd ?? prev.len);
    const p = planTransition({ now: 99, prev, next: nextSong({ vocalStart, firstBeat: R() * 3 }) });
    if (known) assert.ok(p.start + vocalStart >= voiceEndAbs + DEFAULTS.minVocalGap - 1e-9, `case ${i}`);
    else assert.ok(p.start >= voiceEndAbs - 0.02 - 1e-9, `case ${i}`);
  }
});

test('property: imaging voice never lands on the outgoing song\'s vocals', () => {
  const R = rng(99);
  for (let i = 0; i < 2000; i++) {
    const len = 150 + R() * 100;
    const endType = R() < 0.5 ? 'fade' : 'cold';
    const mixOut = endType === 'fade' ? len - 3 - R() * 10 : len - R() * 0.4;
    const known = R() < 0.6;
    const vocalEnd = known ? len - R() * 30 : null;
    const sw = sweeper({ voiceStart: R() * 1.5 });
    const p = planTransition({ now: len - 60, prev: { kind: 'music', start: 0, len, endType, mixOut, vocalEnd }, next: sw });
    const voiceAt = p.start + sw.voiceStart;
    const clear = known ? voiceAt >= vocalEnd + 0.2 - 1e-9 : (endType === 'cold' ? voiceAt >= len - 1e-9 : false);
    assert.ok(clear || fadedOutBy(p.ramps, 'prev', voiceAt), `case ${i}: ${JSON.stringify({ len, endType, mixOut, vocalEnd, voiceAt, p })}`);
  }
});

test('property: plans never start in the past', () => {
  const R = rng(5);
  const kinds = ['music', 'voice', 'imaging', 'spot'];
  for (let i = 0; i < 1000; i++) {
    const pk = kinds[Math.floor(R() * 4)]; const nk = kinds[Math.floor(R() * 4)];
    const prev = pk === 'music' ? song({ start: 0 }) : pk === 'imaging' ? { ...sweeper(), start: 190 } : { kind: pk, start: 190, len: 8 };
    const next = nk === 'music' ? nextSong() : nk === 'imaging' ? sweeper() : nk === 'voice' ? voice(5) : { kind: 'spot', len: 30 };
    const now = 195 + R() * 20;
    const p = planTransition({ now, prev, next });
    assert.ok(p.start >= now, `${pk}->${nk} starts ${p.start} before now ${now}`);
  }
});
