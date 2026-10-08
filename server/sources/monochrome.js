// Music sourcing from monochrome.st (https://github.com/monochrome-music/monochrome).
//
// Primary API: tracks.monochrome.st ("Music API Proxy & Track Streamer")
//   GET /search?q=                 unified search (tracks, releases, artists, playlists)
//   GET /search/tracks?q=&limit=   track search
//   GET /search/releases?q=&limit= release search
//   GET /search/artists?q=&limit=  artist search
//   GET /releases/:id              release + tracklist
//   GET /artists/:id               artist profile + topTracks
//   GET /track/:id                 lossless audio (FLAC), supports HTTP ranges. Slow and cut after ~30 s
//                                  per connection, so songs are fetched in parallel chunks (fetcher.js).

import fs from 'node:fs';
import path from 'node:path';
import { MUSIC_CACHE_DIR } from '../config.js';
import { store } from '../store.js';
import { getFetch, activeFetch, fetcherStatus, BACKGROUND, CHUNK } from './fetcher.js';
import * as arcod from './arcod.js';
import { ensurePeaks } from '../audio/peakFile.js';
import { queueAnalysis } from '../audio/trackAnalyzer.js';
import { findTrack } from '../scheduler/library.js';
import * as cacheIndex from './cacheIndex.js';
import { altVersion } from './versions.js';

const UA = 'ValhallaRadio/0.1 (+radio automation)';

function base() {
  return (store.settings.monochromeBase || 'https://tracks.monochrome.st').replace(/\/+$/, '');
}

async function getJson(url, { retries = 2, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if ([502, 503, 504, 520, 521, 522, 524].includes(res.status) && attempt < retries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Normalize a raw monochrome track into the shape used across Valhalla. */
export function normalizeTrack(item, extra = {}) {
  if (!item) return null;
  const id = String(item.trackId || item.id || '');
  if (!id) return null;
  const artists = Array.isArray(item.artists) && item.artists.length
    ? item.artists.map((a) => a.displayName || a.name).filter(Boolean)
    : Array.isArray(item.artistNames) ? item.artistNames : [];
  const durMs = Number(item.duration || 0);
  const releaseDate = item.releaseDate || extra.releaseDate || '';
  return {
    id,
    title: item.title || 'Unknown Title',
    artist: artists.join(', ') || extra.artist || 'Unknown Artist',
    artistIds: item.artistIds || (item.artists || []).map((a) => String(a.artistId || a.id)).filter(Boolean),
    album: item.albumTitle || item.releaseTitle || extra.album || '',
    albumId: String(item.releaseId || extra.albumId || ''),
    year: releaseDate ? Number(String(releaseDate).slice(0, 4)) || null : null,
    artwork: item.artwork || item.cover || extra.artwork || '',
    duration: durMs > 1000 ? Math.round(durMs / 1000) : Math.round(durMs),
    isrc: item.isrc || '',
    explicit: Boolean(item.explicit),
    playable: item.playable !== false,
    source: 'monochrome',
  };
}

async function monoSearchTracks(query, limit = 20) {
  const q = String(query || '').trim();
  if (!q) return [];
  const data = await getJson(`${base()}/search/tracks?q=${encodeURIComponent(q)}&limit=${limit}`);
  return (data.tracks || []).map((t) => normalizeTrack(t)).filter((t) => t && t.playable);
}

async function monoSearch(query) {
  const q = String(query || '').trim();
  if (!q) return { tracks: [], releases: [], artists: [] };
  const data = await getJson(`${base()}/search?q=${encodeURIComponent(q)}`);
  return {
    tracks: (data.tracks || []).map((t) => normalizeTrack(t)).filter((t) => t && t.playable),
    releases: (data.releases || []).map((r) => ({
      id: String(r.releaseId || r.id),
      title: r.title,
      artist: (r.artists || []).map((a) => a.displayName || a.name).join(', ') || (r.artistNames || []).join(', '),
      artwork: r.artwork || '',
      year: r.releaseDate ? Number(String(r.releaseDate).slice(0, 4)) : null,
      type: r.releaseType || '',
    })),
    artists: (data.artists || []).map((a) => ({
      id: String(a.artistId || a.id),
      name: a.displayName || a.name,
      avatar: a.avatar || '',
    })),
  };
}

async function monoGetRelease(id) {
  const data = await getJson(`${base()}/releases/${encodeURIComponent(id)}`);
  const artist = (data.artists || []).map((a) => a.displayName || a.name).join(', ');
  const tracks = (data.tracks || [])
    .map((t) => normalizeTrack(t, { album: data.title, albumId: data.releaseId, artwork: data.artwork, releaseDate: data.releaseDate, artist }))
    .filter((t) => t && t.playable);
  return {
    id: String(data.releaseId || id),
    title: data.title,
    artist,
    artwork: data.artwork,
    year: data.releaseDate ? Number(String(data.releaseDate).slice(0, 4)) : null,
    label: data.label || '',
    tracks,
  };
}

async function monoGetArtist(id) {
  const data = await getJson(`${base()}/artists/${encodeURIComponent(id)}`);
  const name = data.displayName || data.name;
  return {
    id: String(data.artistId || id),
    name,
    bio: data.biography || data.bio || '',
    avatar: data.avatar || '',
    topTracks: (data.topTracks || []).map((t) => normalizeTrack(t, { artist: name })).filter((t) => t && t.playable),
  };
}

/**
 * Find the best monochrome match for a free-text "artist - title" suggestion
 * (used when Claude recommends songs that aren't in the library yet).
 */
const normMatch = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\(.*?\)|\[.*?\]/g, '').replace(/\b(feat|ft)\.?.*$/, '').replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');

/**
 * How well a catalogue track matches a suggested song (0-100). Title and artist both have to match:
 * a same-titled song by someone else is a different record.
 */
export function matchScore(want, got) {
  const wantT = normMatch(want.title); const gotT = normMatch(got.title);
  const wantA = normMatch(want.artist); const gotA = normMatch(got.artist);
  if (!wantT || !gotT || !wantA || !gotA) return 0;
  let title = 0; let artist = 0;
  if (gotT === wantT) title = 60; else if (gotT.includes(wantT) || wantT.includes(gotT)) title = 35;
  if (gotA === wantA) artist = 40;
  else if (gotA.includes(wantA) || wantA.includes(gotA)) artist = 25;
  else {
    // "Ella Langley, Riley Green" vs "Riley Green": any credited artist counts
    const parts = (s) => String(s || '').split(/,|&| and | x | with | feat\.? | ft\.? /i).map(normMatch).filter(Boolean);
    if (parts(got.artist).some((a) => parts(want.artist).includes(a))) artist = 25;
  }
  if (!title || !artist) return 0;
  let score = title + artist;
  const alt = altVersion(got.title);
  if (alt && alt !== altVersion(want.title)) score -= 30; // a live take or remix that wasn't asked for
  return score;
}

// ------------------------------------------------------------------ the music source (arcod or monochrome)

/** Which catalogue new music comes from: arcod (Qobuz, fast, MP3 320 or FLAC) or monochrome (TIDAL, lossless, slow). */
export const musicSource = () => (store.settings.musicSource === 'monochrome' ? 'monochrome' : 'arcod');
const fromArcod = (id) => arcod.isArcodId(id);

export const searchTracks = (q, limit) => (musicSource() === 'arcod' ? arcod.searchTracks(q, limit) : monoSearchTracks(q, limit));
export const search = (q) => (musicSource() === 'arcod' ? arcod.search(q) : monoSearch(q));
export const getRelease = (id) => (fromArcod(id) ? arcod.getRelease(id) : monoGetRelease(id));
export const getArtist = (id) => (fromArcod(id) ? arcod.getArtist(id) : monoGetArtist(id));

export async function resolveSuggestion({ artist, title }) {
  const results = await searchTracks(`${artist} ${title}`, 8);
  let best = null;
  let bestScore = 0;
  for (const t of results) {
    const score = matchScore({ artist, title }, t);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return bestScore >= 75 ? best : null;
}

export function streamUrl(trackId) {
  return `${base()}/track/${encodeURIComponent(trackId)}`;
}

export function cachedPath(trackId) {
  return path.join(MUSIC_CACHE_DIR, `${String(trackId).replace(/[^\w-]/g, '')}.audio`);
}

/**
 * Fetch a song into the local cache: small Range chunks over a shared pool of parallel connections,
 * resumed across dropped connections and restarts (see fetcher.js for why one connection can't keep up).
 * A lower priority number is fetched first (0 = needed now).
 * @returns {import('./fetcher.js').TrackFetch | null} null when the song is already cached
 */
export function fetchTrack(trackId, { priority = 1000 } = {}) {
  const final = cachedPath(trackId);
  if (fs.existsSync(final) && fs.statSync(final).size > 10000) {
    try { const now = new Date(); fs.utimesSync(final, now, now); } catch { /* fine */ } // recently used: last to be evicted
    return null;
  }
  const id = String(trackId);
  let f;
  if (fromArcod(id)) {
    f = getFetch(id, arcodResolver(id), final, { priority, chunkSize: ARCOD_CHUNK, group: 'arcod' });
  } else if (musicSource() === 'arcod') {
    // a monochrome song in the library: fetch the same recording from arcod (fast) when it has it
    f = getFetch(id, async () => {
      const t = findTrack(id) || { id };
      if (t.arcodId === undefined && t.title) {
        t.arcodId = (await arcod.findEquivalent(t, matchScore).catch(() => null))?.id || null;
        store.save();
      }
      if (t.arcodId) return arcodResolver(t.arcodId)();
      return { url: streamUrl(id), chunkSize: CHUNK, tag: null };
    }, final, { priority });
  } else {
    f = getFetch(id, streamUrl(id), final, { priority });
  }
  if (!f._pruneHooked) { // waveform, ending and fade point as soon as the file is in
    f._pruneHooked = true;
    f.done.then((file) => { cacheIndex.noteFile(path.basename(file)); if (!queueAnalysis(id)) ensurePeaks(id, file); pruneCache(); }, () => {});
  }
  return f;
}

const ARCOD_CHUNK = 1024 * 1024 * 1024; // arcod sends megabytes per second: the whole song in one request (a dropped one resumes)
const arcodResolver = (arcodId) => async () => ({ url: await arcod.playUrl(arcodId), chunkSize: ARCOD_CHUNK, tag: `arcod:${arcod.quality()}`, group: 'arcod' });

/** Download a track to the local cache; resolves with its path. */
export async function download(trackId, { priority = 500 } = {}) {
  const final = cachedPath(trackId);
  if (fs.existsSync(final) && fs.statSync(final).size > 10000) {
    const now = new Date();
    fs.utimesSync(final, now, now);
    return final;
  }
  const f = fetchTrack(trackId, { priority });
  f.wanted = true;
  try { return await f.done; } catch (err) { throw new Error(`download failed for ${trackId}: ${err.message}`); }
}

export function isCached(trackId) {
  return cacheIndex.hasSong(path.basename(cachedPath(trackId)));
}

/** Bytes the finished songs in the cache take. */
export function cacheBytes() {
  return cacheIndex.totalBytes();
}

const cacheLimitBytes = () => (Number(store.settings.musicCacheMaxMb) || 8192) * 1048576;

/**
 * Warm the cache with the library while nothing urgent is fetching: one song at a time, power rotation
 * first, at the lowest priority, until the cache is 90% full. Rotation repeats songs, so once the
 * rotation is cached the station barely needs the (slow) origin at all.
 */
export function startCacheWarmer(songs, { everyMs = 10_000 } = {}) {
  const order = ['A', 'B', 'N', 'C', 'G'];
  const tick = () => {
    if (store.settings.warmCache === false) return;
    const st = fetcherStatus();
    if (st.songs.some((s) => s.priority >= BACKGROUND) || st.songs.length >= 3) return; // busy, or already warming one
    if (cacheBytes() > cacheLimitBytes() * 0.9) return;
    // the most-played song of the highest-rotation category that isn't cached yet
    const rank = (t) => (order.indexOf(t.category) + 1) || 9;
    let next = null;
    for (const t of songs()) {
      if (isCached(t.id)) continue;
      if (!next || rank(t) < rank(next) || (rank(t) === rank(next) && (t.plays || 0) > (next.plays || 0))) next = t;
    }
    if (next) fetchTrack(next.id, { priority: BACKGROUND });
  };
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return tick;
}

/** Keep the music cache under the configured size, evicting least-recently used files. */
export function pruneCache() {
  const maxBytes = cacheLimitBytes();
  if (cacheBytes() <= maxBytes) return; // the usual case: no need to look at the files
  try {
    const files = fs.readdirSync(MUSIC_CACHE_DIR)
      .filter((f) => f.endsWith('.audio'))
      .map((f) => {
        const p = path.join(MUSIC_CACHE_DIR, f);
        const st = fs.statSync(p);
        return { f, p, size: st.size, t: st.mtimeMs };
      })
      .sort((a, b) => a.t - b.t);
    let total = files.reduce((s, f) => s + f.size, 0);
    for (const f of files) {
      if (total <= maxBytes) break;
      fs.rmSync(f.p, { force: true });
      cacheIndex.noteFile(f.f);
      total -= f.size;
    }
  } catch { /* best effort */ }
}

export function cachedTrackIds() {
  try {
    return fs.readdirSync(MUSIC_CACHE_DIR).filter((f) => f.endsWith('.audio')).map((f) => f.replace(/\.audio$/, ''));
  } catch {
    return [];
  }
}
