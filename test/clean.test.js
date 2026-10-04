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

test('original year from the ISRC when a song comes from a compilation', () => {
  assert.equal(library.originalYear({ isrc: 'USAR19200110', year: 2026 }, 2026), 1992);
  assert.equal(library.originalYear({ isrc: 'USUM72401234', year: 2024 }, 2026), 2024);
  assert.equal(library.originalYear({ isrc: 'USRC12600001', year: 2026 }, 2026), 2026);
  assert.equal(library.originalYear({ isrc: '', year: 2001 }, 2026), 2001);
  assert.equal(library.originalYear({ isrc: 'bogus', year: 1999 }, 2026), 1999);
  assert.ok(library.isCompilation('Summer Songs Mix: BBQ, Country & Beach Party Hits'));
  assert.ok(library.isCompilation('Greatest Hits'));
  assert.ok(!library.isCompilation('Brand New Man'));
  assert.ok(!library.isCompilation('Mixed Emotions'));
});

test('year repair moves never-played seeds from compilations to gold', () => {
  const saved = store.data.library;
  store.data.library = [
    { id: 'x1', title: "Boot Scootin' Boogie", artist: 'Brooks & Dunn', album: 'Summer Songs Mix: BBQ, Country & Beach Party Hits', year: 2026, isrc: 'USAR19200110', category: 'A', plays: 0 },
    { id: 'x2', title: 'Neon Moon', artist: 'Brooks & Dunn', album: 'Brand New Man', year: 1991, isrc: 'USAR19100123', category: 'G', plays: 3 },
    { id: 'x3', title: 'Played Already', artist: 'X', album: 'Hits Collection', year: 2025, isrc: 'USAB10500001', category: 'A', plays: 4 },
  ];
  assert.equal(library.repairYears(), 2);
  const [a, b, c] = store.data.library;
  assert.deepEqual([a.year, a.category, a.compilation, a.releaseYear], [1992, 'G', true, 2026]);
  assert.deepEqual([b.year, b.category], [1991, 'G']);
  assert.deepEqual([c.year, c.category], [2005, 'A'], 'played songs keep the category the station chose');
  store.data.library = saved;
});

test('discovery only accepts a catalogue match by the suggested artist', async () => {
  const { matchScore } = await import('../server/sources/monochrome.js');
  const want = { artist: 'Ashley McBryde', title: 'The Heart Wants What It Wants' };
  assert.equal(matchScore(want, { artist: 'Selena Gomez', title: 'The Heart Wants What It Wants' }), 0, 'same title, different artist');
  assert.equal(matchScore({ artist: 'Riley Green', title: 'Worst Way' }, { artist: 'Riley Green', title: 'Worst Way' }), 100);
  assert.ok(matchScore({ artist: 'Ella Langley', title: 'you look like you love me' }, { artist: 'Ella Langley, Riley Green', title: 'you look like you love me (feat. Riley Green)' }) >= 75);
  assert.ok(matchScore({ artist: 'Riley Green', title: 'you look like you love me' }, { artist: 'Ella Langley, Riley Green', title: 'you look like you love me' }) >= 75, 'featured artist credit');
  assert.ok(matchScore({ artist: 'The Killers', title: 'Mr. Brightside' }, { artist: 'Killers', title: 'Mr. Brightside' }) >= 75);
  assert.ok(matchScore({ artist: 'Riley Green', title: 'Worst Way' }, { artist: 'Riley Green', title: 'Worst Way (Live)' }) < 75, 'no live versions');
});
