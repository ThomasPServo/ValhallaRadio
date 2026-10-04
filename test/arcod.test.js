import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import './helpers.js';
import { store } from '../server/store.js';
import * as arcod from '../server/sources/arcod.js';
import * as mono from '../server/sources/monochrome.js';
import { matchScore } from '../server/sources/monochrome.js';

// A stand-in arcod: Qobuz-shaped catalogue JSON and signed play URLs that expire after one use.
const song = crypto.randomBytes(3 * 1024 * 1024 + 777);
const QTRACK = {
  id: 31907362, title: 'Hangar 18', version: null, duration: 313, isrc: 'USCA29000005', parental_warning: false,
  performer: { id: 121232, name: 'Megadeth' }, release_date_original: '1990-09-24',
  album: { id: '0060254789932', title: 'Rust In Peace', image: { large: 'https://img/600.jpg' }, genre: { name: 'Metal' }, release_date_original: '1990-09-24' },
};
const seen = { plays: 0, expired: 0, quality: null };
const tokens = new Set();
let server; let base;
before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (d) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: true, data: d })); };
    if (u.pathname === '/api/player/search') return json({ tracks: { items: [QTRACK, { ...QTRACK, id: 2, title: 'Hangar 18 (Live)', isrc: 'X' }] }, albums: { items: [] }, artists: { items: [] } });
    if (u.pathname.startsWith('/api/player/stream/play')) {
      const t = u.searchParams.get('t');
      if (!tokens.has(t)) { seen.expired++; res.statusCode = 403; return res.end('expired'); }
      tokens.delete(t); // one use, like a short-lived signed URL
      seen.plays++;
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      const from = m ? Number(m[1]) : 0; const to = m && m[2] ? Math.min(Number(m[2]), song.length - 1) : song.length - 1;
      res.writeHead(m ? 206 : 200, { 'content-type': 'audio/mpeg', 'content-length': to - from + 1, ...(m ? { 'content-range': `bytes ${from}-${to}/${song.length}` } : {}) });
      return res.end(song.subarray(from, to + 1));
    }
    if (u.pathname.startsWith('/api/player/stream/')) {
      seen.quality = u.searchParams.get('quality');
      const t = crypto.randomBytes(8).toString('hex');
      tokens.add(t);
      return res.end(JSON.stringify({ url: `/api/player/stream/play?t=${t}` })); // relative, like the real one
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(store.data.settings, { musicSource: 'arcod', arcodBase: base, arcodQuality: '5' });
});
after(() => server.close());

test('Qobuz tracks become Valhalla tracks', () => {
  const t = arcod.normalizeTrack({ ...QTRACK, version: '2004 Remaster', parental_warning: true, artists: [{ name: 'Guest', roles: ['featured-artist'] }] });
  assert.equal(t.id, 'qz-31907362');
  assert.equal(t.title, 'Hangar 18', 'remaster labels are not part of the title the DJ reads');
  assert.equal(arcod.normalizeTrack({ ...QTRACK, version: 'Live' }).title, 'Hangar 18 (Live)', 'a live version is a different record');
  assert.equal(arcod.cleanTitle('Dreams (2001 Remaster)'), 'Dreams');
  assert.equal(arcod.cleanTitle('Africa (Album Version)'), 'Africa');
  assert.equal(arcod.cleanTitle('Layla - 2011 Remastered'), 'Layla');
  assert.equal(arcod.cleanTitle('Shout (Radio Edit)'), 'Shout (Radio Edit)', 'an edit is a different record');
  assert.equal(t.artist, 'Megadeth, Guest');
  assert.equal(t.album, 'Rust In Peace');
  assert.equal(t.albumId, 'qz-0060254789932');
  assert.equal(t.year, 1990);
  assert.equal(t.explicit, true);
  assert.equal(t.genre, 'Metal');
  assert.equal(t.isrc, 'USCA29000005');
  // artist top tracks name artists as {name: {display}}
  assert.equal(arcod.normalizeTrack({ id: 5, title: 'X', artist: { id: 1, name: { display: 'Megadeth' } } }).artist, 'Megadeth');
});

test('the catalogue follows the chosen source; ids say where a song comes from', async () => {
  const hits = await mono.searchTracks('hangar 18', 5);
  assert.equal(hits[0].id, 'qz-31907362');
  assert.ok(arcod.isArcodId(hits[0].id) && !arcod.isArcodId('154044341319372800'));
  const sug = await mono.resolveSuggestion({ artist: 'Megadeth', title: 'Hangar 18' });
  assert.equal(sug.id, 'qz-31907362', 'the studio version, not the live one');
});

test('an arcod song is fetched from a signed URL, refreshed when it expires', async () => {
  const f = mono.fetchTrack('qz-31907362', { priority: 0 });
  // expire the first signed URL before it is used: the fetcher has to ask for a new one
  await f.resolve();
  tokens.clear();
  const file = await f.done;
  assert.ok(fs.readFileSync(file).equals(song), 'cached file matches');
  assert.equal(seen.quality, '5', 'MP3 320 by default');
  assert.ok(seen.expired >= 1, 'an expired URL was met');
  assert.equal(f.tag, 'arcod:5');
  assert.ok(seen.plays <= 3, 'big chunks: only a couple of requests for the whole song');
});

test('a monochrome song in the library is fetched from arcod when it has the same recording', async () => {
  const id = '154044341319372801';
  store.data.library.push({ id, title: 'Hangar 18', artist: 'Megadeth', isrc: 'USCA29000005', explicit: false });
  const f = mono.fetchTrack(id, { priority: 0 });
  const file = await f.done;
  assert.ok(fs.readFileSync(file).equals(song));
  assert.equal(store.data.library.find((t) => t.id === id).arcodId, 'qz-31907362', 'matched by ISRC and remembered');
  assert.equal(path.basename(file), `${id}.audio`, 'cached under the library id');
});

test('equivalents never swap a clean edit for an explicit version', async () => {
  const t = { title: 'Hangar 18', artist: 'Megadeth', explicit: false, isrc: '' };
  const orig = QTRACK.parental_warning;
  QTRACK.parental_warning = true;
  try { assert.equal(await arcod.findEquivalent(t, matchScore), null); } finally { QTRACK.parental_warning = orig; }
});
