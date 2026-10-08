// Rule-based rotation engine. Claude makes the creative choices, but these rules are
// the guard rails every pick must pass (artist/title separation, category rest).

const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '');

export function artistKeys(track) {
  return String(track.artist || '')
    .split(/,|&| feat\.? | ft\.? | x | and /i)
    .map(norm)
    .filter(Boolean);
}

// Recent plays are indexed once per plays list (by track, title and artist), so checking a song is a
// few map lookups instead of a regex pass over every play: with thousands of songs and hundreds of
// recent plays, building an hour went from seconds (blocking the audio thread) to milliseconds.
const indexes = new WeakMap(); // plays array -> index (extended as planned songs are appended)
function playIndex(plays) {
  let ix = indexes.get(plays);
  if (!ix || ix.n > plays.length) {
    ix = { n: 0, byTrack: new Map(), byTitle: new Map(), byArtist: new Map() };
    indexes.set(plays, ix);
  }
  const add = (map, k, v) => { const l = map.get(k); if (l) l.push(v); else map.set(k, [v]); };
  for (; ix.n < plays.length; ix.n++) {
    const p = plays[ix.n];
    add(ix.byTrack, p.trackId, p.at);
    add(ix.byTitle, norm(p.title), p.at);
    for (const k of new Set(artistKeys(p))) add(ix.byArtist, k, ix.n);
  }
  return ix;
}

const keysCache = new WeakMap(); // track -> its normalised title and artists (recomputed if they change)
function trackKeys(track) {
  let k = keysCache.get(track);
  if (!k || k.title !== track.title || k.artist !== track.artist) {
    k = { title: track.title, artist: track.artist, tKey: norm(track.title), aKeys: [...new Set(artistKeys(track))] };
    keysCache.set(track, k);
  }
  return k;
}

/**
 * @param {object} track
 * @param {object} ctx { at, plays: [{at, trackId, title, artist}], rotation, category }
 * @returns {{ok:boolean, reason?:string}}
 */
export function checkRules(track, ctx) {
  const { at, plays, rotation, category } = ctx;
  const ix = playIndex(plays);
  const { tKey, aKeys } = trackKeys(track);
  const artistSepMs = (rotation.artistSeparationMin || 0) * 60_000;
  const titleSepMs = (rotation.titleSeparationMin || 0) * 60_000;
  const restMs = (category?.minRestHours || 0) * 3600_000;
  const within = (times, ms) => times?.some((t) => Math.abs(at - t) < ms);

  if (within(ix.byTrack.get(track.id), Math.max(restMs, titleSepMs))) return { ok: false, reason: 'track rested' };
  if (within(ix.byTitle.get(tKey), titleSepMs)) return { ok: false, reason: 'title separation' };
  let thisHour = null; // plays (not keys) sharing an artist within the hour: a duet counts once
  for (const k of aKeys) {
    for (const i of ix.byArtist.get(k) || []) {
      const dt = Math.abs(at - plays[i].at);
      if (dt < artistSepMs) return { ok: false, reason: 'artist separation' };
      if (dt < 3600_000) (thisHour ||= new Set()).add(i);
    }
  }
  if (rotation.maxSameArtistPerHour && (thisHour?.size || 0) >= rotation.maxSameArtistPerHour) {
    return { ok: false, reason: 'artist hourly cap' };
  }
  return { ok: true };
}

/** Higher = more due to play. Least-recently-played wins, with a little randomness. */
export function dueScore(track, at, rand = Math.random) {
  const last = track.lastPlayed || 0;
  const hoursSince = last ? (at - last) / 3600_000 : 24 * 30;
  return Math.min(hoursSince, 24 * 30) + rand() * 2;
}

/**
 * Candidates for a category, ordered by how "due" they are.
 * Falls back to relaxing rules (title-only) when the category is too thin.
 */
export function candidatesFor(library, ctx, limit = 40) {
  const scored = [];
  for (const t of library) if (t.category === ctx.category.id && !t.disabled) scored.push({ t, s: dueScore(t, ctx.at) });
  scored.sort((a, b) => b.s - a.s);
  // most due first, so rules only need checking until enough songs pass
  const ok = [];
  for (const x of scored) {
    if (checkRules(x.t, ctx).ok) { ok.push(x.t); if (ok.length >= limit) break; }
  }
  if (ok.length) return ok;
  // relaxed: allow artist rule breaks but never the same track twice within an hour
  const byTrack = playIndex(ctx.plays).byTrack;
  const out = [];
  for (const x of scored) {
    if (byTrack.get(x.t.id)?.some((t) => Math.abs(ctx.at - t) < 3600_000)) continue;
    out.push(x.t);
    if (out.length >= limit) break;
  }
  return out;
}

export function pickRuleBased(library, ctx) {
  return candidatesFor(library, ctx, 1)[0] || null;
}
