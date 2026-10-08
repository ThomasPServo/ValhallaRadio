// Clean versions (radio edits) for broadcast. monochrome lists explicit and clean releases of the
// same song separately (same title and length, different release), so an explicit track can
// usually be swapped for its clean twin automatically.

import * as mono from './monochrome.js';
import { altVersion } from './versions.js';

/** Title for matching: no featured artists, no "(Radio Edit)"-style suffixes, no punctuation. */
export const matchTitle = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\s*[-–]\s*(radio edit|clean|clean version|edited|edit|single version|explicit)\b.*$/i, '')
  .replace(/\(.*?\)|\[.*?\]/g, '')
  .replace(/\b(feat|ft|featuring)\.?\s.*$/, '')
  .replace(/[^a-z0-9]/g, '');

export const artistKeys = (a) => String(a || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .split(/,|&| feat\.? | ft\.? | x | and | with /).map((s) => s.replace(/[^a-z0-9]/g, '')).filter(Boolean);

/**
 * Choose the clean twin of `original` among candidate tracks (pure, unit tested).
 * Same song title, at least one shared artist, a similar length, not explicit, the same take (no remix
 * or live cut standing in for the record).
 */
export function pickCleanCandidate(original, candidates) {
  const title = matchTitle(original.title);
  const artists = new Set(artistKeys(original.artist));
  const take = altVersion(original.title);
  let best = null;
  let bestScore = -Infinity;
  for (const c of candidates || []) {
    if (!c || c.explicit || c.id === original.id || c.playable === false) continue;
    if (matchTitle(c.title) !== title || altVersion(c.title) !== take) continue;
    if (!artistKeys(c.artist).some((a) => artists.has(a))) continue;
    const dd = original.duration && c.duration ? Math.abs(c.duration - original.duration) : 0;
    if (dd > 12) continue;
    let score = 100 - dd * 3;
    if (/clean|radio edit|edited/i.test(c.title)) score += 5;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

const primary = (a) => String(a || '').split(/,|&| feat\.? | ft\.? | x /i)[0].trim();
const displayTitle = (t) => String(t || '').replace(/\s*[([](feat\.?|ft\.?|with)[^)\]]*[)\]]/gi, '').trim();

/**
 * Find the clean version of a track on monochrome. Returns the track itself if it isn't explicit,
 * the clean twin if one exists, or null.
 */
export async function findCleanVersion(track) {
  if (!track?.explicit) return track;
  const queries = [`${primary(track.artist)} ${displayTitle(track.title)}`, `${displayTitle(track.title)} ${primary(track.artist)} clean`];
  for (const q of queries) {
    const pick = pickCleanCandidate(track, await mono.searchTracks(q, 25));
    if (pick) return pick;
  }
  return null;
}
