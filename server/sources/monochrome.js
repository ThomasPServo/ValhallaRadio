// Music sourcing from monochrome.st (https://github.com/monochrome-music/monochrome).
//
// Primary API: tracks.monochrome.st ("Music API Proxy & Track Streamer")
//   GET /search?q=                 unified search (tracks, releases, artists, playlists)
//   GET /search/tracks?q=&limit=   track search
//   GET /search/releases?q=&limit= release search
//   GET /search/artists?q=&limit=  artist search
//   GET /releases/:id              release + tracklist
//   GET /artists/:id               artist profile + topTracks
//   GET /track/:id                 lossless audio stream (FLAC), supports HTTP ranges
//
// Fallback: a hifi-api style instance (api.monochrome.tf) which returns base64 manifests.

import fs from 'node:fs';
import path from 'node:path';
import { MUSIC_CACHE_DIR } from '../config.js';
import { store } from '../store.js';

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

export async function searchTracks(query, limit = 20) {
  const q = String(query || '').trim();
  if (!q) return [];
  const data = await getJson(`${base()}/search/tracks?q=${encodeURIComponent(q)}&limit=${limit}`);
  return (data.tracks || []).map((t) => normalizeTrack(t)).filter((t) => t && t.playable);
}

export async function search(query) {
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

export async function getRelease(id) {
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

export async function getArtist(id) {
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
export async function resolveSuggestion({ artist, title }) {
  const results = await searchTracks(`${artist} ${title}`, 8);
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, '').replace(/\b(feat|ft)\.?.*$/, '').replace(/[^a-z0-9]/g, '');
  const wantT = norm(title);
  const wantA = norm(artist);
  let best = null;
  let bestScore = 0;
  for (const t of results) {
    let score = 0;
    const gotT = norm(t.title);
    const gotA = norm(t.artist);
    if (gotT === wantT) score += 60; else if (gotT.includes(wantT) || wantT.includes(gotT)) score += 35;
    if (gotA === wantA) score += 40; else if (gotA.includes(wantA) || wantA.includes(gotA)) score += 25;
    if (/remix|live|karaoke|instrumental|sped up|slowed|acoustic/i.test(t.title) && !/remix|live|acoustic/i.test(title)) score -= 30;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return bestScore >= 60 ? best : null;
}

export function streamUrl(trackId) {
  return `${base()}/track/${encodeURIComponent(trackId)}`;
}

export function cachedPath(trackId) {
  return path.join(MUSIC_CACHE_DIR, `${String(trackId).replace(/[^\w-]/g, '')}.audio`);
}

const inflight = new Map();

/**
 * Download a track to the local cache. The upstream origin is occasionally flaky
 * (Cloudflare 52x, truncated transfers), so this resumes with HTTP Range requests.
 */
export function download(trackId, { attempts = 6 } = {}) {
  const final = cachedPath(trackId);
  if (fs.existsSync(final) && fs.statSync(final).size > 10000) {
    const now = new Date();
    fs.utimesSync(final, now, now);
    return Promise.resolve(final);
  }
  if (inflight.has(trackId)) return inflight.get(trackId);

  const job = (async () => {
    const part = final + '.part';
    let total = null;
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
      if (total && have >= total) break;
      try {
        const headers = { 'User-Agent': UA };
        if (have > 0) headers.Range = `bytes=${have}-`;
        const res = await fetch(streamUrl(trackId), { headers, signal: AbortSignal.timeout(120000) });
        if (!(res.status === 200 || res.status === 206)) throw new Error(`HTTP ${res.status}`);
        const type = res.headers.get('content-type') || '';
        if (type.startsWith('text/')) throw new Error(`unexpected ${type}`);
        if (res.status === 200 && have > 0) fs.truncateSync(part, 0); // server ignored Range
        const len = Number(res.headers.get('content-length') || 0);
        const range = res.headers.get('content-range');
        if (range && /\/(\d+)$/.test(range)) total = Number(range.match(/\/(\d+)$/)[1]);
        else if (res.status === 200 && len) total = len;
        const out = fs.createWriteStream(part, { flags: res.status === 206 ? 'a' : 'w' });
        for await (const chunk of res.body) {
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        }
        await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
        const size = fs.statSync(part).size;
        if (!total || size >= total) break;
      } catch (err) {
        lastErr = err;
        await sleep(Math.min(8000, 500 * 2 ** i));
      }
    }
    const size = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (size < 10000 || (total && size < total)) {
      throw new Error(`download failed for ${trackId}: ${lastErr?.message || 'incomplete'}`);
    }
    fs.renameSync(part, final);
    pruneCache();
    return final;
  })().finally(() => inflight.delete(trackId));

  inflight.set(trackId, job);
  return job;
}

/** Keep the music cache under the configured size, evicting least-recently used files. */
export function pruneCache() {
  try {
    const maxBytes = (store.settings.musicCacheMaxMb || 4096) * 1024 * 1024;
    const files = fs.readdirSync(MUSIC_CACHE_DIR)
      .filter((f) => f.endsWith('.audio'))
      .map((f) => {
        const p = path.join(MUSIC_CACHE_DIR, f);
        const st = fs.statSync(p);
        return { p, size: st.size, t: st.mtimeMs };
      })
      .sort((a, b) => a.t - b.t);
    let total = files.reduce((s, f) => s + f.size, 0);
    for (const f of files) {
      if (total <= maxBytes) break;
      fs.rmSync(f.p, { force: true });
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
