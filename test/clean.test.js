import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCleanCandidate, matchTitle } from '../server/sources/clean.js';
import { store } from '../server/store.js';
import * as library from '../server/scheduler/library.js';
import { candidatesFor } from '../server/scheduler/rotation.js';

const explicitHumble = { id: 'e1', title: 'HUMBLE.', artist: 'Kendrick Lamar', duration: 177, explicit: true };

test('matchTitle ignores featured artists, edit suffixes and punctuation', () => {
  assert.equal(matchTitle('rockstar (feat. 21 Savage)'), matchTitle('rockstar'));
  assert.equal(matchTitle('Paint The Town Red - Radio Edit'), matchTitle('Paint The Town Red'));
  assert.equal(matchTitle('HUMBLE.'), 'humble');
});

test('picks the clean twin: same song, shared artist, similar length', () => {
  const candidates = [
    { id: 'e1', title: 'HUMBLE.', artist: 'Kendrick Lamar', duration: 177, explicit: true },
    { id: 'r1', title: 'HUMBLE. - SKRILLEX REMIX', artist: 'Skrillex, Kendrick Lamar', duration: 157, explicit: false },
    { id: 'c1', title: 'HUMBLE.', artist: 'Kendrick Lamar', duration: 177, explicit: false },
    { id: 'x1', title: 'Humble', artist: 'Someone Else', duration: 177, explicit: false },
  ];
  assert.equal(pickCleanCandidate(explicitHumble, candidates).id, 'c1');
});

test('matches a clean version listed without the featured artist in the title', () => {
  const orig = { id: 'e', title: 'rockstar (feat. 21 Savage)', artist: 'Post Malone, 21 Savage', duration: 218, explicit: true };
  const pick = pickCleanCandidate(orig, [{ id: 'c', title: 'rockstar', artist: 'Post Malone, 21 Savage', duration: 218, explicit: false }]);
  assert.equal(pick.id, 'c');
});

test('refuses remixes, other artists, and versions of a very different length', () => {
  assert.equal(pickCleanCandidate(explicitHumble, [
    { id: 'r', title: 'HUMBLE. (Remix)', artist: 'Kendrick Lamar', duration: 177, explicit: false },
    { id: 'o', title: 'HUMBLE.', artist: 'A Cover Band', duration: 177, explicit: false },
    { id: 'l', title: 'HUMBLE.', artist: 'Kendrick Lamar', duration: 240, explicit: false },
  ]), null);
});

test('clean-only mode keeps explicit songs out of every rotation pool', () => {
  store.data.library = [
    { id: '1', title: 'Clean Song', artist: 'A', category: 'A', explicit: false },
    { id: '2', title: 'Explicit Song', artist: 'B', category: 'A', explicit: true },
    { id: '3', title: 'Off Song', artist: 'C', category: 'A', explicit: false, disabled: true },
  ];
  store.settings.cleanOnly = true;
  assert.deepEqual(library.playable().map((t) => t.id), ['1']);
  const pool = candidatesFor(library.playable(), { at: Date.now(), plays: [], rotation: store.data.rotation, category: { id: 'A' } });
  assert.deepEqual(pool.map((t) => t.id), ['1']);
  store.settings.cleanOnly = false;
  assert.deepEqual(library.playable().map((t) => t.id).sort(), ['1', '2']);
  store.settings.cleanOnly = true;
});
