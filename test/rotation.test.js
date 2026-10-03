import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRules, candidatesFor, artistKeys } from '../server/scheduler/rotation.js';

const H = 3600_000;
const rotation = { artistSeparationMin: 60, titleSeparationMin: 180, maxSameArtistPerHour: 1 };
const now = Date.UTC(2026, 9, 3, 12);

test('artistKeys splits collaborations', () => {
  assert.deepEqual(artistKeys({ artist: 'Daft Punk, Pharrell Williams & Nile Rodgers' }), ['daftpunk', 'pharrellwilliams', 'nilerodgers']);
});

test('artist separation blocks featured artists too', () => {
  const plays = [{ at: now - 30 * 60_000, trackId: 'x', title: 'Happy', artist: 'Pharrell Williams' }];
  const r = checkRules({ id: 'y', title: 'Get Lucky', artist: 'Daft Punk, Pharrell Williams' }, { at: now, plays, rotation, category: {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'artist separation');
  const later = checkRules({ id: 'y', title: 'Get Lucky', artist: 'Daft Punk, Pharrell Williams' }, { at: now + 2 * H, plays, rotation, category: {} });
  assert.equal(later.ok, true);
});

test('title separation catches alternate versions', () => {
  const plays = [{ at: now - H, trackId: 'a', title: 'One More Time (Radio Edit)', artist: 'Daft Punk' }];
  const r = checkRules({ id: 'b', title: 'One More Time', artist: 'Someone Else' }, { at: now, plays, rotation, category: {} });
  assert.equal(r.ok, false);
});

test('category rest blocks a recently played song', () => {
  const plays = [{ at: now - 2 * H, trackId: 'a', title: 'Song', artist: 'Band' }];
  const r = checkRules({ id: 'a', title: 'Song', artist: 'Band' }, { at: now, plays, rotation: { ...rotation, titleSeparationMin: 0, artistSeparationMin: 0 }, category: { minRestHours: 3 } });
  assert.equal(r.ok, false);
});

test('candidatesFor orders by most due and filters by category', () => {
  const library = [
    { id: '1', title: 'A', artist: 'X', category: 'A', lastPlayed: now - 1 * H },
    { id: '2', title: 'B', artist: 'Y', category: 'A', lastPlayed: now - 20 * H },
    { id: '3', title: 'C', artist: 'Z', category: 'B', lastPlayed: 0 },
    { id: '4', title: 'D', artist: 'W', category: 'A', lastPlayed: 0, disabled: true },
  ];
  const c = candidatesFor(library, { at: now, plays: [], rotation, category: { id: 'A', minRestHours: 0 } });
  assert.deepEqual(c.map((t) => t.id), ['2', '1']);
});

test('candidatesFor relaxes artist rules when a category is exhausted, but never repeats a track within the hour', () => {
  const library = [
    { id: '1', title: 'A', artist: 'X', category: 'A' },
    { id: '2', title: 'B', artist: 'X', category: 'A' },
  ];
  const plays = [{ at: now - 10 * 60_000, trackId: '1', title: 'A', artist: 'X' }];
  const c = candidatesFor(library, { at: now, plays, rotation, category: { id: 'A' } });
  assert.deepEqual(c.map((t) => t.id), ['2']);
});
