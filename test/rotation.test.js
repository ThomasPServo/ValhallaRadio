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

// The original rule check (a pass over every play), kept here as the reference for the indexed one.
function referenceCheck(track, { at, plays, rotation, category }) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '');
  const aKeys = new Set(artistKeys(track)); const tKey = norm(track.title);
  const artistSepMs = (rotation.artistSeparationMin || 0) * 60_000; const titleSepMs = (rotation.titleSeparationMin || 0) * 60_000;
  const restMs = (category?.minRestHours || 0) * 3600_000;
  let n = 0;
  for (const p of plays) {
    const dt = Math.abs(at - p.at);
    if (p.trackId === track.id && dt < Math.max(restMs, titleSepMs)) return false;
    if (norm(p.title) === tKey && dt < titleSepMs) return false;
    const shared = artistKeys(p).some((k) => aKeys.has(k));
    if (shared && dt < artistSepMs) return false;
    if (shared && dt < 3600_000) n++;
  }
  return !(rotation.maxSameArtistPerHour && n >= rotation.maxSameArtistPerHour);
}

test('indexed rule checks agree with the original on thousands of random cases', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const artists = ['A', 'B', 'C', 'D', 'A & B', 'C, D', 'B feat. E', 'E x F', 'F and G', ''];
  const titles = ['One', 'Two', 'One (Live)', 'Three [Remix]', '', 'Four'];
  let disagreements = 0; let checks = 0;
  for (let round = 0; round < 60; round++) {
    const plays = Array.from({ length: Math.floor(rnd() * 40) }, () => ({
      at: now + Math.round((rnd() - 0.7) * 6 * H), trackId: String(Math.floor(rnd() * 12)), title: pick(titles), artist: pick(artists),
    }));
    const rot = { artistSeparationMin: pick([0, 30, 60, 120]), titleSeparationMin: pick([0, 60, 180]), maxSameArtistPerHour: pick([0, 1, 2]) };
    const ctx = { at: now, plays, rotation: rot, category: { minRestHours: pick([0, 1, 3]) } };
    for (let k = 0; k < 40; k++) {
      const track = { id: String(Math.floor(rnd() * 12)), title: pick(titles), artist: pick(artists) };
      checks++;
      if (checkRules(track, ctx).ok !== referenceCheck(track, ctx)) disagreements++;
    }
    // the plays list grows as an hour is planned: the index must pick up appended plays
    plays.push({ at: now + 5 * 60_000, trackId: '3', title: 'Two', artist: 'A' });
    const t = { id: '9', title: 'Two', artist: 'A, Z' };
    checks++;
    if (checkRules(t, ctx).ok !== referenceCheck(t, ctx)) disagreements++;
  }
  assert.equal(disagreements, 0, `${disagreements} of ${checks} checks disagree`);
});
