// Background enrichment: fills every library song's facts (genre, original year, popularity, tempo,
// vocal type) from open music data, one song at a time, so the music director and DJ work from facts.
import { store } from '../store.js';
import { lookupFacts } from '../sources/songFacts.js';

const STALE = 120 * 86400_000;
let timer = null;
let busy = false;
export const enrichStatus = { done: 0, total: 0, last: null, error: null };

function next() {
  const lib = store.data.library;
  enrichStatus.total = lib.length;
  enrichStatus.done = lib.filter((t) => t.facts && Date.now() - t.facts.checkedAt < STALE).length;
  // songs on air soon first: never-checked, then the most played
  return lib.filter((t) => !t.disabled && (!t.facts || Date.now() - t.facts.checkedAt > STALE))
    .sort((a, b) => Number(Boolean(a.facts)) - Number(Boolean(b.facts)) || (b.plays || 0) - (a.plays || 0))[0] || null;
}

/** Apply looked-up facts to a library entry (and correct a compilation/reissue year). */
export function applyFacts(t, facts) {
  t.facts = facts;
  if (facts.firstYear && (!t.year || facts.firstYear < t.year)) { t.releaseYear ??= t.year; t.year = facts.firstYear; }
}

async function step() {
  if (busy) return;
  const t = next();
  if (!t) return;
  busy = true;
  try {
    applyFacts(t, await lookupFacts(t));
    enrichStatus.last = `${t.artist} - ${t.title}`;
    enrichStatus.error = null;
    store.save();
  } catch (err) {
    enrichStatus.error = err.message;
    t.facts = { checkedAt: Date.now() - STALE + 86400_000, sources: [], error: err.message }; // retry tomorrow
  } finally {
    busy = false;
  }
}

export function startEnricher(intervalMs = 2500) {
  if (timer) return;
  timer = setInterval(() => step().catch(() => {}), intervalMs);
  timer.unref?.();
}
