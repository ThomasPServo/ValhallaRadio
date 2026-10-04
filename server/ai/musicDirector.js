// Claude as music director: picks songs for each music slot of an hour, balancing
// flow, energy, era and variety, inside the hard rotation rules. Can also go
// "crate digging" on monochrome to discover new songs that fit the format.

import { store } from '../store.js';
import { claudeAvailable, claudeJson } from './claude.js';
import { candidatesFor, checkRules } from '../scheduler/rotation.js';
import * as library from '../scheduler/library.js';
import * as mono from '../sources/monochrome.js';
import { weekdayName, spokenTime } from '../util/time.js';
import { factLine, relatedArtists } from '../sources/songFacts.js';
import { claudeProvider } from './claude.js';

const log = (...a) => console.log('[music-director]', ...a);

const PICKS_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slot: { type: 'integer' },
          trackId: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['slot', 'trackId', 'why'],
        additionalProperties: false,
      },
    },
    hourNote: { type: 'string' },
  },
  required: ['picks', 'hourNote'],
  additionalProperties: false,
};

const SUGGEST_SCHEMA = {
  type: 'object',
  properties: {
    songs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          artist: { type: 'string' },
          title: { type: 'string' },
          category: { type: 'string' },
          energy: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['artist', 'title', 'category', 'energy', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['songs'],
  additionalProperties: false,
};

function fmtTrack(t, at) {
  return `${t.id} | ${t.artist} - ${t.title} (${factLine(t, { at })})`;
}

// ------------------------------------------------------------------ flow rules (no AI needed)

const fx = (t) => t?.facts || {};
const introOf = (t) => t?.markers?.intro ?? (t?.lyrics?.status === 'found' ? t.lyrics.vocalStart : null);
const energyOf = (t) => t?.energy ?? fx(t).energy ?? null;
const POST_BREAK = new Set(['spot', 'liner', 'id', 'toh_id', 'stopset']);

/**
 * Pick the best-flowing song from candidates already sorted most-due first: vary the voice and genre
 * from the previous song, keep energy moving smoothly, put an instrumental intro after a DJ break and a
 * familiar, high-energy song after a stopset or at the top of the hour.
 */
export function pickByFlow(cands, { prev = null, after = null, first = false, used = new Set() } = {}) {
  let best = null; let bestScore = -Infinity;
  cands.forEach((t, i) => {
    if (used.has(t.id)) return;
    let score = ((cands.length - i) / cands.length) * 4; // due-ness matters most
    if (prev) {
      if (t.artist === prev.artist) score -= 5;
      if (fx(t).voice && fx(prev).voice && fx(t).voice !== fx(prev).voice) score += 1.2;
      if (fx(t).genre && fx(prev).genre && fx(t).genre !== fx(prev).genre) score += 0.6;
      const e1 = energyOf(prev); const e2 = energyOf(t);
      if (e1 && e2 && Math.abs(e1 - e2) > 2) score -= 0.8;
    }
    if (after === 'dj') { const intro = introOf(t); score += intro >= 5 ? 1.5 : intro == null ? -0.3 : -0.8; }
    if (first || POST_BREAK.has(after)) score += ((fx(t).popularity ?? 50) / 100) * 1.5 + ((energyOf(t) ?? 3) >= 4 ? 0.8 : 0);
    if (score > bestScore) { bestScore = score; best = t; }
  });
  return best;
}

/**
 * @param {object} p
 * @param {number} p.at          start time of the hour (ms)
 * @param {Array}  p.slots       [{slot, category, estAt}]
 * @param {object} p.daypart
 * @returns {Promise<Map<number, {track, why}>>}
 */
export async function selectForHour({ at, slots, daypart, planned: plannedElsewhere = [] }) {
  const { categories, rotation } = store.data;
  const lib = library.playable(); // clean-only aware
  const tz = store.station.timezone;
  const plays = [...library.musicPlays(), ...plannedElsewhere];
  const result = new Map();
  if (!slots.length) return result;

  if (store.settings.allowDiscovery) {
    await topUpThinCategories(slots).catch((e) => log('discovery failed:', e.message));
  }

  // Candidate lists per category (rules are re-checked per pick below).
  const catIds = [...new Set(slots.map((s) => s.category))];
  const cands = {};
  for (const id of catIds) {
    const category = categories.find((c) => c.id === id) || { id, minRestHours: 0 };
    cands[id] = candidatesFor(lib, { at, plays, rotation, category }, 30);
  }

  let aiPicks = [];
  if (store.settings.useClaudeForMusic && claudeAvailable() && Object.values(cands).some((c) => c.length)) {
    try {
      const recent = plays.filter((p) => p.at <= at).sort((a, b) => a.at - b.at).slice(-15).map((p) => `${p.artist} - ${p.title}`).join('\n') || '(nothing yet)';
      const prompt = [
        `Station: ${store.station.name} (${store.station.callSign})`,
        `Format: ${store.station.format}`,
        `Hour starting: ${weekdayName(new Date(at), tz)}, ${spokenTime(new Date(at), tz)}`,
        `Daypart: ${daypart?.name || 'General'} — ${daypart?.mood || ''}`,
        '',
        'Most recently played (oldest first):',
        recent,
        '',
        'Music slots to fill, in airplay order (other elements like breaks/sweepers sit between some of them):',
        ...slots.map((s) => `slot ${s.slot}: category ${s.category}${s.after ? ` (after ${s.after})` : ''}`),
        '',
        'Candidates per category (id | artist - title (details)). Only use these ids, and only from the slot\'s category:',
        ...catIds.flatMap((id) => [`== Category ${id} (${(categories.find((c) => c.id === id) || {}).name || ''}) ==`, ...cands[id].map((t) => fmtTrack(t, at))]),
      ].join('\n');
      const out = await claudeJson({
        system:
          'You are the music director of a professional commercial radio station. Judge every song only by the facts listed with it ' +
          '(year, genre, vocal, tempo, energy, popularity, intro, ending, last play) — do not rely on your own memory of songs. You build each hour so it flows: ' +
          'vary tempo and energy in a pleasing arc, avoid two similar-sounding songs back to back, mix eras and male/female/group artists, ' +
          'open the hour strong, make songs after a stopset familiar and high-energy to win listeners back, and match the daypart mood. ' +
          'Right after a DJ break, prefer a song with an instrumental intro of 5+ seconds (intro shown in the list) so the DJ can talk up to the vocals. ' +
          'Never use the same track or artist twice in the hour. Prefer songs that are more "due" (played longer ago) when the choice is otherwise close.',
        prompt,
        maxTokens: 6000,
        effort: 'medium',
        schema: PICKS_SCHEMA,
      });
      aiPicks = out.picks || [];
      if (out.hourNote) log('hour note:', out.hourNote);
    } catch (err) {
      log('Claude selection failed, using rules:', err.message);
    }
  }

  // Validate and assign; anything missing/invalid is filled by the rotation rules.
  const planned = [...plays];
  const used = new Set();
  for (const s of slots) {
    const category = categories.find((c) => c.id === s.category) || { id: s.category, minRestHours: 0 };
    const ctx = { at: s.estAt || at, plays: planned, rotation, category };
    let chosen = null;
    let why = '';
    const ai = aiPicks.find((p) => p.slot === s.slot);
    if (ai) {
      const t = cands[s.category]?.find((c) => c.id === String(ai.trackId));
      if (t && !used.has(t.id) && checkRules(t, ctx).ok) {
        chosen = t;
        why = ai.why;
      }
    }
    if (!chosen) {
      const prev = [...result.values()].at(-1)?.track || null;
      chosen = pickByFlow(candidatesFor(lib, ctx, 12), { prev, after: s.after, first: s.slot === slots[0].slot, used });
      why = chosen ? 'rotation rules + flow' : '';
    }
    if (!chosen) {
      // category empty: borrow from any category so there's never dead air
      chosen = lib.filter((t) => !used.has(t.id))
        .find((t) => checkRules(t, { ...ctx, category: { minRestHours: 0 } }).ok) || null;
      why = chosen ? `borrowed (category ${s.category} empty)` : '';
    }
    if (chosen) {
      used.add(chosen.id);
      planned.push({ at: ctx.at, trackId: chosen.id, title: chosen.title, artist: chosen.artist });
      result.set(s.slot, { track: chosen, why });
    }
  }
  return result;
}

/**
 * Find new music for a category. Two ways, combined:
 *  - "ai": the AI suggests songs from its own knowledge; each is verified on monochrome (big models know music well).
 *  - "catalog": real songs from artists related to the ones the station plays (open listener data), filtered to the
 *    category's era and popularity; the AI only chooses among verified songs, so it can't invent anything.
 * Auto uses the catalog for local models (which don't know music reliably) and to top up whatever the AI missed.
 */
export async function discover({ category = 'N', count = 10, guidance = '' } = {}) {
  const mode = store.settings.discoveryMode || 'auto';
  const provider = claudeProvider();
  const useAi = provider && mode !== 'catalog' && !(mode === 'auto' && provider === 'lmstudio');
  let res = { added: [], missed: [] };
  if (useAi) {
    try { res = await discoverWithAi({ category, count, guidance }); } catch (err) { log('AI discovery failed:', err.message); }
  }
  if (res.added.length < count && mode !== 'ai') {
    const more = await discoverFromCatalog({ category, count: count - res.added.length, guidance }).catch((err) => { log('catalog discovery failed:', err.message); return { added: [], missed: [] }; });
    res = { added: [...res.added, ...more.added], missed: res.missed, catalog: more.added.length };
  }
  return res;
}

/** Era and popularity a category actually plays, from its current songs. */
export function categoryProfile(categoryId, lib = store.data.library) {
  const songs = lib.filter((t) => t.category === categoryId && !t.disabled);
  const years = songs.map((t) => t.year).filter(Boolean).sort((a, b) => a - b);
  const q = (p) => years[Math.min(years.length - 1, Math.floor(p * (years.length - 1)))];
  const genres = {};
  for (const t of songs) for (const g of t.facts?.genres || []) genres[g] = (genres[g] || 0) + 1;
  return {
    count: songs.length,
    yearFrom: years.length >= 3 ? q(0.1) - 2 : null,
    yearTo: years.length >= 3 ? q(0.9) + 2 : null,
    genres: Object.entries(genres).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([g]) => g),
    artists: [...new Set(songs.sort((a, b) => (b.plays || 0) - (a.plays || 0)).map((t) => t.artist.split(',')[0].trim()))],
  };
}

export async function discoverFromCatalog({ category = 'N', count = 10, guidance = '' } = {}) {
  const prof = categoryProfile(category);
  const seeds = (prof.artists.length ? prof.artists : categoryProfile(null, store.data.library.map((t) => ({ ...t, category: null }))).artists).slice(0, 6);
  if (!seeds.length) throw new Error('the library is empty: nothing to find related music from');
  const have = new Set(store.data.library.map((t) => `${t.artist}|${t.title}`.toLowerCase()));
  const pool = [];
  for (const a of await relatedArtists(seeds, { perSeed: 3 })) {
    try {
      const res = await mono.search(a.name);
      const artist = res.artists.find((x) => x.name.toLowerCase() === a.name.toLowerCase());
      if (!artist) continue;
      const info = await mono.getArtist(artist.id);
      for (const [rank, t] of info.topTracks.slice(0, 6).entries()) {
        if (have.has(`${t.artist}|${t.title}`.toLowerCase()) || t.duration < 110 || t.duration > 420 || /remix|live|acoustic|instrumental|sped up|slowed/i.test(t.title)) continue;
        const year = library.originalYear(t);
        if (prof.yearFrom && year && (year < prof.yearFrom || year > prof.yearTo)) continue;
        if (library.cleanOnly() && t.explicit) continue; // addTrack would look for a clean twin, but keep the pool clean
        pool.push({ ...t, year, rank, via: a.via });
      }
    } catch { /* skip this artist */ }
    if (pool.length >= count * 4) break;
  }
  if (!pool.length) return { added: [], missed: [] };
  let picks = pool.slice().sort((a, b) => a.rank - b.rank).slice(0, count).map((t) => ({ t, reason: `fits ${category}: similar to ${t.via}` }));
  if (claudeAvailable() && pool.length > count) {
    try {
      const out = await claudeJson({
        system: 'You are a radio music director. Choose only from the listed real songs, judging by the facts given.',
        prompt: [`Format: ${store.station.format}`, `Category ${category}: ${prof.count} songs, years ${prof.yearFrom || '?'}-${prof.yearTo || '?'}, genres ${prof.genres.join(', ') || 'unknown'}.`, guidance ? `Direction: ${guidance}` : '',
          `Choose the ${count} best fits:`, ...pool.map((t, i) => `${i} | ${t.artist} - ${t.title} (${t.year || '?'}, #${t.rank + 1} most popular for this artist, similar to ${t.via})`)].filter(Boolean).join('\n'),
        maxTokens: 3000, effort: 'low',
        schema: { type: 'object', additionalProperties: false, required: ['choices'], properties: { choices: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['index', 'reason'], properties: { index: { type: 'integer' }, reason: { type: 'string' } } } } } },
      });
      const chosen = (out.choices || []).filter((c) => pool[c.index]).slice(0, count).map((c) => ({ t: pool[c.index], reason: c.reason }));
      if (chosen.length) picks = chosen;
    } catch (err) { log('catalog ranking by AI failed, using popularity:', err.message); }
  }
  const added = []; const missed = [];
  for (const { t, reason } of picks) {
    try { added.push(await library.addTrack(t, category, { note: reason })); } catch (err) { missed.push(`${t.artist} - ${t.title} (${err.message})`); }
  }
  log(`catalog discovery: ${added.length} songs for ${category} from artists related to ${seeds.slice(0, 3).join(', ')}`);
  return { added, missed };
}

async function discoverWithAi({ category = 'N', count = 10, guidance = '' } = {}) {
  const cats = store.data.categories.map((c) => `${c.id} = ${c.name}`).join(', ');
  const existing = store.data.library.slice(-300).map((t) => `${t.artist} - ${t.title}`).join('\n');
  const out = await claudeJson({
    system: 'You are an expert radio music director with encyclopedic knowledge of popular music charts and radio airplay. You only suggest real, released songs with their exact official titles and primary artist names.',
    prompt: [
      `Station format: ${store.station.format}`,
      `Market: ${store.station.market?.name || 'general'}`,
      `Categories: ${cats}`,
      `Suggest ${count} songs for category "${category}" that fit this format${guidance ? `. Extra direction: ${guidance}` : ''}.`,
      library.cleanOnly() ? 'The station only airs clean versions: suggest songs that have a clean radio edit (no songs that only exist with explicit lyrics).' : '',
      'Use the requested category for every song. Energy is 1 (mellow) to 5 (peak).',
      'Do not repeat anything already in the library:',
      existing || '(library is empty)',
    ].join('\n'),
    maxTokens: 6000,
    effort: 'low',
    schema: SUGGEST_SCHEMA,
  });
  const added = [];
  const missed = [];
  for (const s of out.songs || []) {
    try {
      const t = await mono.resolveSuggestion(s);
      if (!t) { missed.push(`${s.artist} - ${s.title}`); continue; }
      const entry = await library.addTrack(t, category || s.category, { energy: s.energy, note: s.reason });
      added.push(entry);
    } catch (err) {
      missed.push(`${s.artist} - ${s.title} (${err.message})`);
    }
  }
  log(`discovered ${added.length} tracks for ${category}, ${missed.length} not found`);
  return { added, missed };
}

async function topUpThinCategories(slots) {
  const need = {};
  for (const s of slots) need[s.category] = (need[s.category] || 0) + 1;
  for (const [cat, n] of Object.entries(need)) {
    const have = library.playable().filter((t) => t.category === cat).length;
    // keep at least ~4x the hourly usage in each category so rotation rules have room
    if (have < n * 4) await discover({ category: cat, count: Math.max(8, n * 4 - have) });
  }
}
