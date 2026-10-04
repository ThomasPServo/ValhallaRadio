// One-shot station setup: apply a format preset (categories, clocks, grid, dayparts, personas,
// imaging, processing) and build a starter library from monochrome in the background.

import { EventEmitter } from 'node:events';
import { store, uid } from '../store.js';
import * as mono from '../sources/monochrome.js';
import * as library from '../scheduler/library.js';
import { FORMATS, formatImaging, formatClocks } from './formats.js';
import { claudeAvailable } from '../ai/claude.js';
import { discover } from '../ai/musicDirector.js';

export const setupEvents = new EventEmitter();
let job = null;

const CAT_COLORS = { A: '#ef4444', B: '#f97316', C: '#eab308', G: '#22c55e', N: '#3b82f6' };
const SKIP = /\b(remix|live|acoustic|instrumental|sped up|slowed|karaoke|demo|extended|club mix|commentary|a cappella|reprise|interlude|skit)\b/i;

export function applyFormat(formatId, stationPatch = {}) {
  const f = FORMATS[formatId];
  if (!f) throw new Error(`unknown format ${formatId}`);
  const db = store.data;
  db.station = { ...db.station, ...stationPatch, market: { ...db.station.market, ...(stationPatch.market || {}) }, format: f.format, formatId, setupComplete: true };
  db.categories = f.categories.map((c) => ({ ...c, color: CAT_COLORS[c.id] || '#64748b' }));

  const [music, drive, night] = formatClocks().map((c) => ({ ...c, id: uid('clk_') }));
  db.clocks = [music, drive, night];
  db.grid = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => {
    if (h <= 5) return night.id;
    if (d >= 1 && d <= 5 && ((h >= 6 && h <= 9) || (h >= 16 && h <= 18))) return drive.id;
    return music.id;
  }));

  db.personas = f.personas.map((p) => ({
    id: uid('dj_'), name: p.name, style: p.style,
    voice: { kokoroVoice: p.kokoroVoice, elevenLabsVoiceId: p.elevenLabsVoiceId, openaiVoice: p.openaiVoice, instructions: `Natural, warm radio host. ${p.style}` },
  }));
  const [a, b] = [db.personas[0].id, (db.personas[1] || db.personas[0]).id];
  db.dayparts = [
    { id: uid('dp_'), name: 'Overnight', startHour: 0, endHour: 5, mood: 'Laid back and smoother, fewer high-energy picks. Intimate late-night tone, short breaks.', personaId: b },
    { id: uid('dp_'), name: 'Morning Drive', startHour: 6, endHour: 9, mood: 'High energy, the most familiar hits to wake people up. Time, weather and traffic often.', personaId: a },
    { id: uid('dp_'), name: 'Midday', startHour: 10, endHour: 14, mood: 'Steady at-work listening: lots of music, positive and familiar, quick breaks.', personaId: b },
    { id: uid('dp_'), name: 'Afternoon Drive', startHour: 15, endHour: 18, mood: 'Building energy for the drive home: upbeat and fun, traffic and weather on the way home.', personaId: a },
    { id: uid('dp_'), name: 'Evening', startHour: 19, endHour: 23, mood: 'More new music and discovery, energetic early, easing off later.', personaId: b },
  ];
  db.imaging = {
    voice: { kokoroVoice: formatId === 'classicrock' ? 'am_fenrir' : 'am_michael', elevenLabsVoiceId: 'onwK4e9ZLuTAKqWW03F9', openaiVoice: 'onyx', instructions: 'Deep, powerful, polished radio imaging voice. Punchy and dramatic.' },
    items: formatImaging(formatId).map((i) => ({ ...i, id: uid('img_'), file: '', enabled: true })),
  };
  db.processing = { preset: f.processing, overrides: {} };
  const catIds = new Set(db.categories.map((c) => c.id));
  for (const t of db.library) if (!catIds.has(t.category)) t.category = 'N';
  store.save();
}

/** Category for a seed track, from release year and its rank in the artist's top tracks. */
export function categorize(mode, year, rank, nowYear = new Date().getFullYear()) {
  const age = year ? nowYear - year : 20;
  if (mode === 'gold') {
    if (age <= 10) return 'N';
    return rank <= 1 ? 'A' : rank === 2 ? 'G' : rank === 3 ? 'B' : 'C';
  }
  if (age <= 1) return rank <= 1 ? 'A' : 'N';
  if (age <= 3) return 'B';
  if (age <= 8) return 'C';
  return 'G';
}

const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '');

async function seedArtist(name, f, perArtist) {
  const res = await mono.search(name);
  const artist = res.artists.find((a) => norm(a.name) === norm(name)) || res.artists[0];
  if (!artist) return [];
  const info = await mono.getArtist(artist.id);
  const added = [];
  const seen = new Set();
  let rank = 0;
  // original album versions first: playlist/compilation copies only if that's all there is
  const tops = [...info.topTracks].sort((a, b) => Number(library.isCompilation(a.album)) - Number(library.isCompilation(b.album)));
  for (const t of tops) {
    if (added.length >= perArtist) break;
    if (SKIP.test(t.title) || t.duration < 90 || t.duration > 480) continue;
    const k = norm(t.title);
    if (seen.has(k)) continue;
    seen.add(k);
    let entry;
    try {
      entry = await library.addTrack(t, 'N'); // swaps explicit songs for clean versions in clean-only mode
    } catch (err) {
      if (err.code === 'EXPLICIT') continue; // no radio edit exists: skip this song
      throw err;
    }
    if (added.includes(entry)) continue;
    entry.category = categorize(f.mode, entry.year, rank++);
    added.push(entry);
  }
  return added;
}

/** Make sure no category is starved: move songs from the fullest category if needed. */
function balance(minPerCategory = 6) {
  const lib = store.data.library;
  for (const c of store.data.categories) {
    let have = lib.filter((t) => t.category === c.id);
    while (have.length < minPerCategory) {
      const counts = store.data.categories.map((x) => [x.id, lib.filter((t) => t.category === x.id).length]).sort((p, q) => q[1] - p[1]);
      const donor = counts[0][0];
      if (donor === c.id || counts[0][1] <= minPerCategory) break;
      const t = lib.filter((x) => x.category === donor).sort((p, q) => (q.year || 0) - (p.year || 0))[c.id === 'G' || c.id === 'C' ? lib.filter((x) => x.category === donor).length - 1 : 0];
      t.category = c.id;
      have = lib.filter((x) => x.category === c.id);
    }
  }
  store.save();
}

export function setupStatus() {
  return job ? { ...job, running: !job.done } : { running: false, done: true, libraryCount: store.data.library.length };
}

/** Build a starter library in the background. Emits 'progress' events. */
export function buildLibrary(formatId, { perArtist = 5, useClaude = true } = {}) {
  if (job && !job.done) return job;
  const f = FORMATS[formatId];
  if (!f) throw new Error(`unknown format ${formatId}`);
  job = { formatId, total: f.seeds.length, done: false, completed: 0, added: 0, errors: [], startedAt: Date.now(), phase: 'seeding' };
  const emit = () => setupEvents.emit('progress', setupStatus());
  (async () => {
    const queue = [...f.seeds];
    const worker = async () => {
      while (queue.length) {
        const name = queue.shift();
        try {
          const added = await seedArtist(name, f, perArtist);
          job.added += added.length;
          job.last = `${name}: ${added.length} songs`;
        } catch (err) {
          job.errors.push(`${name}: ${err.message}`);
        }
        job.completed++;
        emit();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    balance();
    if (useClaude && claudeAvailable()) {
      job.phase = 'discovering';
      emit();
      try {
        const r = await discover({ category: 'N', count: 12, guidance: 'Fresh, high-quality picks that fit the format and complement the existing library.' });
        job.added += r.added.length;
      } catch (err) { job.errors.push(`discovery: ${err.message}`); }
    }
    job.phase = 'done';
    job.done = true;
    job.libraryCount = store.data.library.length;
    emit();
  })();
  return job;
}
