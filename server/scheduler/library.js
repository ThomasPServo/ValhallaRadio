import { store } from '../store.js';
import * as mono from '../sources/monochrome.js';
import { findCleanVersion } from '../sources/clean.js';

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

// id -> song index, rebuilt when the library array is replaced or changes length; a miss falls back
// to a scan (and a rebuild), so songs changed in place are still always found
let byId = null; let byIdLib = null; let byIdLen = -1;
function indexLibrary(lib) {
  byId = new Map();
  for (const t of lib) byId.set(t.id, t);
  byIdLib = lib; byIdLen = lib.length;
}
export function findTrack(id) {
  const lib = store.data.library;
  const key = String(id);
  if (byIdLib !== lib || byIdLen !== lib.length) indexLibrary(lib);
  const hit = byId.get(key);
  if (hit && hit.id === key) return hit;
  const found = lib.find((t) => t.id === key);
  if (found || hit) indexLibrary(lib); // something changed in place: refresh the index
  return found;
}

/** Clean-only mode: explicit songs never air (radio edits only). */
export const cleanOnly = () => store.settings.cleanOnly !== false;

/** Songs the schedulers may pick: enabled, and clean when clean-only mode is on. */
export function playable() {
  const clean = cleanOnly();
  return store.data.library.filter((t) => !t.disabled && !(clean && t.explicit));
}

/**
 * Add a song. In clean-only mode an explicit song is swapped for its clean version (radio edit);
 * if none exists the add is refused with code EXPLICIT.
 */
const COMPILATION = /\b(hits|mix|mixtape|collection|greatest|best of|essentials?|playlist|anthology|compilation|now that's|ultimate|vol\.?\s*\d|volume \d|party|top \d+|songs of|summer songs|workout|throwback|classics|the very best|hit list|\d+ (greatest|essential))\b/i;

/** Is this album a compilation or playlist release rather than the original album? */
export function isCompilation(album) {
  return COMPILATION.test(String(album || ''));
}

/**
 * The year a recording was made. Compilations and reissues carry their own (later) release year,
 * but the ISRC keeps the year the recording was registered: USAR19200123 → 1992.
 */
export function originalYear(t, nowYear = new Date().getFullYear()) {
  const m = String(t.isrc || '').toUpperCase().match(/^[A-Z]{2}[A-Z0-9]{3}(\d{2})\d{5}$/);
  let isrcYear = null;
  if (m) {
    const yy = Number(m[1]);
    isrcYear = yy <= (nowYear % 100) + 1 ? 2000 + yy : 1900 + yy;
  }
  const y = Number(t.year) || null;
  if (isrcYear && isrcYear >= 1950 && (!y || isrcYear < y)) return isrcYear;
  return y;
}

/** One-time repair for libraries built before compilation years were corrected. */
export function repairYears() {
  let n = 0;
  for (const t of store.data.library) {
    const y = originalYear(t);
    const comp = isCompilation(t.album);
    if (y !== t.year || comp !== Boolean(t.compilation)) {
      // a never-played seed filed as a current because of its compilation year is really a gold title
      if (y && t.year && t.year - y >= 8 && !t.plays && ['A', 'B', 'N'].includes(t.category) && store.data.categories.some((c) => c.id === 'G')) t.category = 'G';
      t.releaseYear ??= t.year; t.year = y; t.compilation = comp; n++;
    }
  }
  if (n) store.save();
  return n;
}

export async function addTrack(track, category = 'N', extra = {}) {
  if (cleanOnly() && track.explicit) {
    const clean = await findCleanVersion(track);
    if (!clean) throw Object.assign(new Error(`No clean version of "${track.title}" is available`), { code: 'EXPLICIT', status: 409 });
    track = clean;
    extra = { ...extra, note: extra.note || 'clean version' };
  }
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
    year: originalYear(enriched) || null,
    releaseYear: enriched.year || null,
    compilation: isCompilation(enriched.album),
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
  for (const k of ['category', 'energy', 'tags', 'note', 'disabled', 'title', 'artist', 'analysis', 'lyrics', 'markers']) {
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

let sweep = null;

/**
 * Replace explicit songs in the library with their clean versions (keeping category, plays and
 * markers); songs with no clean version are disabled. Runs in the background.
 */
export function cleanSweep(onProgress = () => {}) {
  if (sweep) return sweep;
  sweep = (async () => {
    const targets = store.data.library.filter((t) => t.explicit && !t.disabled);
    const result = { checked: targets.length, replaced: 0, disabled: 0, done: 0 };
    for (const t of targets) {
      try {
        const clean = await findCleanVersion(t);
        if (clean && !findTrack(clean.id)) {
          const enriched = await enrich(clean);
          Object.assign(t, {
            id: String(enriched.id), title: enriched.title, artist: enriched.artist, album: enriched.album || t.album,
            albumId: enriched.albumId || '', year: enriched.year || t.year, artwork: enriched.artwork || t.artwork,
            duration: enriched.duration || t.duration, isrc: enriched.isrc || '', explicit: false,
            note: t.note || 'clean version', analysis: undefined, lyrics: undefined,
          });
          result.replaced++;
        } else if (clean) {
          t.disabled = true; t.note = 'explicit (clean version already in library)';
          result.disabled++;
        } else {
          t.disabled = true; t.note = 'explicit: no clean version available';
          result.disabled++;
        }
      } catch (err) {
        t.note = `clean check failed: ${err.message}`;
      }
      result.done++;
      onProgress({ ...result });
    }
    store.save();
    return result;
  })().finally(() => { sweep = null; });
  return sweep;
}
