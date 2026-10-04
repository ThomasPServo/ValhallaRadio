// Claude as music director: picks songs for each music slot of an hour, balancing
// flow, energy, era and variety, inside the hard rotation rules. Can also go
// "crate digging" on monochrome to discover new songs that fit the format.

import { store } from '../store.js';
import { claudeAvailable, claudeJson } from './claude.js';
import { candidatesFor, checkRules } from '../scheduler/rotation.js';
import * as library from '../scheduler/library.js';
import * as mono from '../sources/monochrome.js';
import { weekdayName, spokenTime } from '../util/time.js';

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
  const hrs = t.lastPlayed ? Math.round((at - t.lastPlayed) / 3600_000) + 'h ago' : 'never';
  const intro = t.markers?.intro ?? (t.lyrics?.status === 'found' ? t.lyrics.vocalStart : null);
  const bpm = t.analysis?.headTempo?.confidence >= 0.8 ? Math.round(t.analysis.headTempo.bpm) : null;
  const bits = [t.year, t.energy ? `energy ${t.energy}` : null, (t.tags || []).join('/') || null, intro != null ? `intro ${Math.round(intro)}s` : null, bpm ? `${bpm} bpm` : null, `last ${hrs}`].filter(Boolean);
  return `${t.id} | ${t.artist} - ${t.title} (${bits.join(', ')})`;
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

  if (store.settings.allowDiscovery && claudeAvailable()) {
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
          'You are the music director of a professional commercial radio station. You build each hour so it flows: ' +
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
      chosen = candidatesFor(lib, ctx, 10).find((t) => !used.has(t.id)) || null;
      why = chosen ? 'rotation rules' : '';
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

/** Ask Claude for songs that fit the format, resolve them on monochrome, add them to the library. */
export async function discover({ category = 'N', count = 10, guidance = '' } = {}) {
  if (!claudeAvailable()) throw new Error('Music discovery needs Claude: sign in to Claude Code on this machine, or add an Anthropic API key.');
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
