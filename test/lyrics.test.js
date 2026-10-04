import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc, vocalWindow } from '../server/audio/lyrics.js';

test('parseLrc handles multiple stamps, offsets and metadata', () => {
  const lines = parseLrc('[ar:X]\n[offset:+500]\n[00:10.50][01:00.00] chorus\n[00:05.00] verse');
  assert.deepEqual(lines.map((l) => l.t), [4.5, 10, 59.5]);
  assert.equal(lines[1].text, 'chorus');
});

test('vocalWindow skips instrumental markers and uses the closing timestamp', () => {
  const w = vocalWindow(parseLrc('[00:00.50] ♪\n[00:12.20] First line\n[00:15.00] Second\n[03:10.00] Last line\n[03:13.40] '));
  assert.equal(w.vocalStart, 12.2);
  assert.equal(w.vocalEnd, 193.4);
});

test('vocalWindow estimates the end of the last line when no closing stamp exists', () => {
  const w = vocalWindow(parseLrc('[00:10.00] a\n[00:13.00] b\n[00:16.00] c'));
  assert.equal(w.vocalEnd, 19);
});

test('vocalWindow returns null for instrumental-only lyrics', () => {
  assert.equal(vocalWindow(parseLrc('[00:01.00] ♪\n[00:30.00] (Instrumental)')), null);
});
