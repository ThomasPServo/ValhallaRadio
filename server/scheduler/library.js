import { store } from '../store.js';
import * as mono from '../sources/monochrome.js';

const releaseCache = new Map();

async function enrich(track) {
  if ((track.album && track.year) || !track.albumId) return track;
  try {
    let rel = releaseCache.get(track.albumId);
    if (!rel) {
      rel = await mono.getRelease(track.albumId);
      releaseCache.set(track.albumId, rel);
    }
    return { ...track, album: track.album || rel.title, year: track.year || rel.year, label: rel.label };
  } catch {
    return track;
  }
}

export function findTrack(id) {
  return store.data.library.find((t) => t.id === String(id));
}

export async function addTrack(track, category = 'N', extra = {}) {
  const existing = findTrack(track.id);
  if (existing) {
    Object.assign(existing, extra, { category: category || existing.category });
    store.save();
    return existing;
  }
  const enriched = await enrich(track);
  const entry = {
    id: String(enriched.id),
    title: enriched.title,
    artist: enriched.artist,
    album: enriched.album || '',
    albumId: enriched.albumId || '',
    year: enriched.year || null,
    artwork: enriched.artwork || '',
    duration: enriched.duration || 0,
    isrc: enriched.isrc || '',
    explicit: Boolean(enriched.explicit),
    category,
    energy: extra.energy ?? null, // 1-5, optional (Claude can fill this in)
    tags: extra.tags || [],
    note: extra.note || '',
    addedAt: Date.now(),
    lastPlayed: 0,
    plays: 0,
    disabled: false,
  };
  store.data.library.push(entry);
  store.save();
  return entry;
}

export function updateTrack(id, patch) {
  const t = findTrack(id);
  if (!t) return null;
  for (const k of ['category', 'energy', 'tags', 'note', 'disabled', 'title', 'artist']) {
    if (k in patch) t[k] = patch[k];
  }
  store.save();
  return t;
}

export function removeTrack(id) {
  const lib = store.data.library;
  const i = lib.findIndex((t) => t.id === String(id));
  if (i >= 0) lib.splice(i, 1);
  store.save();
}

export function markPlayed(id, at = Date.now()) {
  const t = findTrack(id);
  if (t) {
    t.lastPlayed = at;
    t.plays = (t.plays || 0) + 1;
    store.save();
  }
}

/** Music plays from history in the shape the rotation rules expect. */
export function musicPlays(sinceMs = 48 * 3600_000) {
  const cutoff = Date.now() - sinceMs;
  return store.data.history
    .filter((h) => h.type === 'music' && h.at >= cutoff)
    .map((h) => ({ at: h.at, trackId: h.trackId, title: h.title, artist: h.artist }));
}
