// Music from arcod (player.arcod.xyz): the Qobuz catalogue, streamed as 320 kbps MP3 or FLAC.
//
//   GET /api/player/search?q=&limit=&offset=          tracks, albums, artists (Qobuz objects)
//   GET /api/player/artists/:id                       artist with top_tracks and releases
//   GET /api/player/get-album?album_id=                album with its tracks
//   GET /api/player/stream/:trackId?quality=           { url } for a short-lived signed play URL
//
// Qobuz quality codes: 5 = MP3 320 kbps, 6 = FLAC 16-bit/44.1 kHz, 7 = FLAC 24/96, 27 = FLAC 24/192.
// Play URLs are fast (megabytes per second, one connection, HTTP ranges), unlike monochrome's origin.
// No account is needed. Track, album and artist ids carry a "qz-" prefix so they never collide with
// monochrome ids in the library.

import { store } from '../store.js';

export const PREFIX = 'qz-';
export const QUALITIES = { 5: 'MP3 320 kbps', 6: 'FLAC 16-bit / 44.1 kHz', 7: 'FLAC 24-bit / 96 kHz', 27: 'FLAC 24-bit / 192 kHz' };
const UA = 'ValhallaRadio/0.2 (+radio automation)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const isArcodId = (id) => String(id || '').startsWith(PREFIX);
const raw = (id) => String(id || '').replace(/^qz-/, '');
export function base() {
  return (store.settings.arcodBase || 'https://player.arcod.xyz').replace(/\/+$/, '');
}
export function quality() {
  const q = String(store.settings.arcodQuality || '5');
  return QUALITIES[q] ? q : '5';
}

async function getJson(path, { retries = 2, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${base()}${path}`, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 && attempt < retries) { // be polite: wait as long as asked (capped)
        await sleep(Math.min(30, Number(res.headers.get('retry-after')) || 3) * 1000);
        continue;
      }
      if (res.status >= 500 && attempt < retries) { await sleep(500 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`arcod: HTTP ${res.status} for ${path.split('?')[0]}`);
      const d = await res.json();
      if (d && d.success === false) throw new Error(`arcod: ${d.error || d.message || 'request failed'}`);
      return d?.data ?? d;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

const nameOf = (a) => (typeof a?.name === 'object' ? a.name?.display : a?.name) || '';
const yearOf = (d) => (d ? Number(String(d).slice(0, 4)) || null : null);
const imageOf = (img) => img?.large || img?.small || img?.thumbnail || '';

/** A Qobuz track as a Valhalla track. */
export function normalizeTrack(t, extra = {}) {
  if (!t?.id) return null;
  const album = t.album || {};
  const main = nameOf(t.performer) || nameOf(t.artist) || nameOf(album.artist) || extra.artist || '';
  const featured = (t.artists || []).filter((a) => (a.roles || []).includes('featured-artist')).map(nameOf).filter(Boolean);
  // keep versions that change the record (live, remix, acoustic, edit), not catalogue labels the DJ shouldn't read
  const label = /remaster|^mono$|^stereo$|deluxe|anniversary|expanded|edition|bonus/i.test(t.version || '');
  const title = t.version && !label && !String(t.title).includes(t.version) ? `${t.title} (${t.version})` : t.title;
  return {
    id: `${PREFIX}${t.id}`,
    title: title || 'Unknown Title',
    artist: [main || 'Unknown Artist', ...featured.filter((f) => f !== main)].join(', '),
    artistIds: [t.performer?.id || t.artist?.id || album.artist?.id].filter(Boolean).map((x) => `${PREFIX}${x}`),
    album: album.title || extra.album || '',
    albumId: album.id ? `${PREFIX}${album.id}` : extra.albumId || '',
    year: yearOf(t.release_date_original || album.release_date_original || extra.releaseDate),
    artwork: imageOf(album.image) || extra.artwork || '',
    duration: Math.round(Number(t.duration) || 0),
    isrc: t.isrc || '',
    explicit: Boolean(t.parental_warning),
    genre: album.genre?.name || extra.genre || '',
    playable: t.streamable !== false && (t.rights?.streamable ?? true) !== false,
    source: 'arcod',
  };
}

function normalizeAlbum(a) {
  return {
    id: `${PREFIX}${a.id}`,
    title: a.version ? `${a.title} (${a.version})` : a.title,
    artist: nameOf(a.artist) || (a.artists || []).map(nameOf).join(', '),
    artwork: imageOf(a.image),
    year: yearOf(a.release_date_original || a.dates?.original),
    type: a.release_type || (a.tracks_count <= 3 ? 'single' : 'album'),
  };
}

export async function searchTracks(query, limit = 20) {
  const q = String(query || '').trim();
  if (!q) return [];
  const d = await getJson(`/api/player/search?${new URLSearchParams({ q, limit: String(limit), offset: '0' })}`);
  return (d.tracks?.items || []).map((t) => normalizeTrack(t)).filter((t) => t && t.playable);
}

export async function search(query) {
  const q = String(query || '').trim();
  if (!q) return { tracks: [], releases: [], artists: [] };
  const d = await getJson(`/api/player/search?${new URLSearchParams({ q, limit: '25', offset: '0' })}`);
  return {
    tracks: (d.tracks?.items || []).map((t) => normalizeTrack(t)).filter((t) => t && t.playable),
    releases: (d.albums?.items || []).map(normalizeAlbum),
    artists: (d.artists?.items || []).map((a) => ({ id: `${PREFIX}${a.id}`, name: nameOf(a), avatar: a.image?.large || a.picture || '' })),
  };
}

export async function getRelease(id) {
  const d = await getJson(`/api/player/get-album?${new URLSearchParams({ album_id: raw(id) })}`);
  const album = normalizeAlbum(d);
  const tracks = (d.tracks?.items || [])
    .map((t) => normalizeTrack({ ...t, album: t.album || d }, { album: d.title, albumId: album.id, artwork: album.artwork, releaseDate: d.release_date_original, artist: album.artist }))
    .filter((t) => t && t.playable);
  return { ...album, label: d.label?.name || '', tracks };
}

export async function getArtist(id) {
  const d = await getJson(`/api/player/artists/${encodeURIComponent(raw(id))}`);
  const a = d.artist || d;
  const name = nameOf(a);
  return {
    id: `${PREFIX}${a.id || raw(id)}`,
    name,
    bio: a.biography?.content || '',
    avatar: a.images?.portrait?.large || '',
    topTracks: (a.top_tracks || []).map((t) => normalizeTrack(t, { artist: name })).filter((t) => t && t.playable),
  };
}

/** A short-lived signed URL for the song's audio in the configured quality. */
export async function playUrl(trackId, q = quality()) {
  const d = await getJson(`/api/player/stream/${encodeURIComponent(raw(trackId))}?quality=${encodeURIComponent(q)}`, { retries: 2 });
  if (!d?.url) throw new Error('arcod returned no stream URL');
  return new URL(d.url, base()).href;
}

/** The arcod track for a song from another catalogue: same ISRC, or same artist and title. */
export async function findEquivalent(t, matchScore) {
  const results = await searchTracks(`${String(t.artist).split(',')[0]} ${t.title}`, 10).catch(() => []);
  if (t.isrc) {
    const same = results.find((r) => r.isrc && r.isrc === t.isrc);
    if (same) return same;
  }
  let best = null; let bestScore = 0;
  for (const r of results) {
    if (Boolean(r.explicit) !== Boolean(t.explicit) && !t.explicit) continue; // never swap a clean edit for an explicit one
    const s = matchScore(t, r);
    if (s > bestScore) { best = r; bestScore = s; }
  }
  return bestScore >= 85 ? best : null;
}
