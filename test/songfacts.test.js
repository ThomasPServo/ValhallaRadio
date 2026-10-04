import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { popularityFromRank, voiceOf, estimateEnergy, factLine, lookupFacts, originalYear } from '../server/sources/songFacts.js';
import { applyFacts } from '../server/scheduler/enricher.js';
import { pickByFlow, categoryProfile } from '../server/ai/musicDirector.js';
import { placeQuery } from '../server/feeds/http.js';
import { relevantHeadline } from '../server/feeds/traffic.js';
import { speakable } from '../server/voice/speech.js';
import { weatherBrief } from '../server/ai/dj.js';

test('popularity: Deezer rank on a 0-100 log scale', () => {
  assert.equal(popularityFromRank(0), 0);
  assert.equal(popularityFromRank(999), 0);
  assert.equal(popularityFromRank(1_000_000), 100);
  assert.equal(popularityFromRank(31_623), 50);
  assert.ok(popularityFromRank(900_000) > popularityFromRank(300_000));
});

test('vocal type from credits and artist data', () => {
  assert.equal(voiceOf({ credits: 2, gender: 'Male' }), 'duet/collab');
  assert.equal(voiceOf({ type: 'Group' }), 'group');
  assert.equal(voiceOf({ type: 'Person', gender: 'Female' }), 'female');
  assert.equal(voiceOf({ type: 'Person', gender: 'Male' }), 'male');
  assert.equal(voiceOf({}), null);
});

test('original year: earliest one another release backs up', () => {
  assert.equal(originalYear([2009, 2001, 2003, 2004, 2005, 2016]), 2003, 'a lone mis-dated demo is ignored');
  assert.equal(originalYear([1987, 1987, 1994]), 1987);
  assert.equal(originalYear([2001, 2009], false), 2001, 'too few to judge');
  assert.equal(originalYear([2001, 2009, 2010], true), 2001, 'an exact ISRC match is trusted');
  assert.equal(originalYear([]), null);
});

test('energy estimate from tempo, loudness and genre', () => {
  assert.equal(estimateEnergy({}), null);
  const ballad = estimateEnergy({ bpm: 72, loudness: -12, genre: 'soul ballad' });
  const banger = estimateEnergy({ bpm: 128, loudness: -6, genre: 'dance' });
  assert.ok(ballad <= 2, `ballad ${ballad}`);
  assert.equal(banger, 5);
  assert.ok(estimateEnergy({ bpm: 105, loudness: -9 }) >= 3);
});

test('fact line: everything a model needs to place a song, without knowing it', () => {
  const t = { year: 2003, facts: { genres: ['alternative rock', 'indie rock', 'rock'], voice: 'group', bpm: 148, popularity: 80 }, markers: { intro: 8.2, endType: 'cold' }, analysis: { loudness: -7 }, lastPlayed: Date.now() - 5 * 3600_000 };
  const line = factLine(t);
  for (const bit of ['2003', 'alternative rock/indie rock', 'group vocal', '148 bpm uptempo', 'energy 5 (est)', 'popularity 80', 'intro 8s', 'cold end', 'last 5h ago']) assert.ok(line.includes(bit), `${bit} in: ${line}`);
  assert.ok(factLine({ year: 1990 }).includes('intro unknown'));
  assert.ok(factLine({ energy: 2, facts: {} }).includes('energy 2'));
  assert.ok(!factLine({ energy: 2, facts: {} }).includes('(est)'));
});

test('lookupFacts combines Deezer and MusicBrainz (original year, genres, voice, popularity)', async () => {
  const real = globalThis.fetch;
  const json = (d) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.includes('api.deezer.com/track/isrc:')) return json({ id: 1, rank: 900000, bpm: 0, release_date: '2010-01-01', album: { id: 9 }, artist: { id: 77 }, contributors: [{ role: 'Main' }] });
    if (url.includes('api.deezer.com/album/9')) return json({ genres: { data: [{ name: 'Pop' }] } });
    if (url.includes('musicbrainz.org/ws/2/recording')) return json({ recordings: [{ score: 100, 'first-release-date': '1987-05-02', 'artist-credit': [{ artist: { id: 'wh' } }] }, { score: 95, 'first-release-date': '1990' }] });
    if (url.includes('musicbrainz.org/ws/2/artist/wh')) return json({ type: 'Person', gender: 'Female', country: 'US', genres: [{ name: 'r&b', count: 3 }, { name: 'pop', count: 9 }] });
    throw new Error(`unexpected ${url}`);
  };
  try {
    const t = { artist: 'Whitney Houston', title: 'I Wanna Dance with Somebody', isrc: 'USAR18700001', year: 2010, analysis: { loudness: -8, headTempo: { bpm: 119, confidence: 0.9 } } };
    const f = await lookupFacts(t);
    assert.equal(f.firstYear, 1987);
    assert.deepEqual(f.genres, ['pop', 'r&b']);
    assert.equal(f.genre, 'pop');
    assert.equal(f.voice, 'female');
    assert.equal(f.popularity, popularityFromRank(900000));
    assert.equal(f.bpm, 119, 'falls back to our own tempo analysis when Deezer has none');
    assert.ok(f.energy >= 3);
    assert.deepEqual(f.sources.sort(), ['deezer', 'musicbrainz']);
    applyFacts(t, f);
    assert.equal(t.year, 1987, 'a reissue/compilation year is corrected to the original release');
    assert.equal(t.releaseYear, 2010);
  } finally { globalThis.fetch = real; }
});

test('flow picker: due songs first, but no same artist, varied voices, intros after the DJ', () => {
  const s = (id, artist, o = {}) => ({ id, artist, title: id, ...o });
  const prev = s('p', 'Adele', { facts: { voice: 'female', genre: 'pop' } });
  // the most-due song is the same artist: skipped for the next one
  assert.equal(pickByFlow([s('a', 'Adele'), s('b', 'Coldplay')], { prev }).id, 'b');
  // nearly as due: a different voice and genre win
  const near = [s('c', 'Dua Lipa', { facts: { voice: 'female', genre: 'pop' } }), s('d', 'Coldplay', { facts: { voice: 'group', genre: 'rock' } }), ...[1, 2, 3, 4, 5, 6].map((n) => s(`z${n}`, `Z${n}`, { facts: { voice: 'female', genre: 'pop' } }))];
  assert.equal(pickByFlow(near, { prev }).id, 'd');
  // after the DJ talks, a song with an intro to talk over beats a cold vocal start
  const talk = [s('e', 'X', { markers: { intro: 0 } }), s('f', 'Y', { markers: { intro: 12 } })];
  assert.equal(pickByFlow(talk, { after: 'dj' }).id, 'f');
  // songs already used this hour are skipped
  assert.equal(pickByFlow([s('g', 'G'), s('h', 'H')], { used: new Set(['g']) }).id, 'h');
});

test('category profile: era and sound of a category, from facts', () => {
  const lib = [2001, 2003, 2005, 2007, 2009].map((y, i) => ({ id: `t${i}`, category: 'R', artist: `A${i % 2}`, title: `S${i}`, year: y, plays: i, facts: { genres: ['pop rock'] } }));
  const p = categoryProfile('R', lib);
  assert.equal(p.count, 5);
  assert.ok(p.yearFrom <= 2001 && p.yearFrom >= 1997);
  assert.ok(p.yearTo >= 2009 && p.yearTo <= 2012);
  assert.deepEqual(p.genres, ['pop rock']);
  assert.deepEqual(p.artists.sort(), ['A0', 'A1']);
});

test('Dartmouth, MA market: state-qualified searches, out-of-state stories dropped', () => {
  assert.equal(placeQuery({ name: 'Dartmouth, Massachusetts, United States', state: 'Massachusetts' }), '"Dartmouth" "Massachusetts"');
  assert.equal(placeQuery({ name: 'Freetown, Bristol County, Massachusetts' }), '"Freetown" "Bristol County"');
  assert.equal(placeQuery({ name: 'Austin' }), '"Austin"');
  const places = ['Dartmouth', 'Massachusetts', 'Freetown', 'Massachusetts'];
  assert.equal(relevantHeadline('Crash closes Route 6 in Dartmouth', places), true);
  assert.equal(relevantHeadline('Crash near Dartmouth College closes road in Hanover, New Hampshire', places), false);
  assert.equal(relevantHeadline('Rollover crash in Thetford, Vermont', places), false);
});

test('route abbreviations and calm weather read naturally', () => {
  assert.match(speakable('Crash on Rte. 24 in Freetown'), /Route twenty-four/);
  assert.match(speakable('Delays on Rt 140 north'), /Route one forty/);
  const brief = weatherBrief({ units: 'imperial', current: { temp: 58, conditions: 'Fog/Mist', wind: 0 }, periods: [{ name: 'Tonight', conditions: 'Patchy fog.', low: 52 }] });
  assert.ok(!brief.includes('/'), brief);
  assert.ok(!/\b0 mph/.test(brief), brief);
});
