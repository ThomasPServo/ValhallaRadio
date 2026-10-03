// Rule-based rotation engine. Claude makes the creative choices, but these rules are
// the guard rails every pick must pass (artist/title separation, category rest).

const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '');

export function artistKeys(track) {
  return String(track.artist || '')
    .split(/,|&| feat\.? | ft\.? | x | and /i)
    .map(norm)
    .filter(Boolean);
}

/**
 * @param {object} track
 * @param {object} ctx { at, plays: [{at, trackId, title, artist}], rotation, category }
 * @returns {{ok:boolean, reason?:string}}
 */
export function checkRules(track, ctx) {
  const { at, plays, rotation, category } = ctx;
  const aKeys = new Set(artistKeys(track));
  const tKey = norm(track.title);
  const artistSepMs = (rotation.artistSeparationMin || 0) * 60_000;
  const titleSepMs = (rotation.titleSeparationMin || 0) * 60_000;
  const restMs = (category?.minRestHours || 0) * 3600_000;
  let sameArtistThisHour = 0;

  for (const p of plays) {
    const dt = Math.abs(at - p.at);
    if (p.trackId === track.id && dt < Math.max(restMs, titleSepMs)) return { ok: false, reason: 'track rested' };
    if (norm(p.title) === tKey && dt < titleSepMs) return { ok: false, reason: 'title separation' };
    const pKeys = artistKeys(p);
    const shared = pKeys.some((k) => aKeys.has(k));
    if (shared && dt < artistSepMs) return { ok: false, reason: 'artist separation' };
    if (shared && dt < 3600_000) sameArtistThisHour++;
  }
  if (rotation.maxSameArtistPerHour && sameArtistThisHour >= rotation.maxSameArtistPerHour) {
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
  const pool = library.filter((t) => t.category === ctx.category.id && !t.disabled);
  const scored = pool
    .map((t) => ({ t, rule: checkRules(t, ctx), s: dueScore(t, ctx.at) }))
    .sort((a, b) => b.s - a.s);
  const ok = scored.filter((x) => x.rule.ok).map((x) => x.t);
  if (ok.length) return ok.slice(0, limit);
  // relaxed: allow artist rule breaks but never the same track twice within an hour
  return scored
    .filter((x) => !ctx.plays.some((p) => p.trackId === x.t.id && Math.abs(ctx.at - p.at) < 3600_000))
    .map((x) => x.t)
    .slice(0, limit);
}

export function pickRuleBased(library, ctx) {
  return candidatesFor(library, ctx, 1)[0] || null;
}
