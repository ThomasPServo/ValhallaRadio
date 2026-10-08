// Music charts from keyless public sources, so the station (and any AI, however little it knows about
// this week's music) programs current hits from real chart data:
//  - Billboard Hot 100: this week, and every week back to 1958 (a public mirror on GitHub), for gold eras
//  - Apple Music top songs and iTunes top songs by genre, per country
// Songs in the library carry their chart position and best peak, which the music director, the flow
// picker and the DJ all see; current formats can let the charts move songs between power, current and
// recurrent rotation.

import { store } from '../store.js';
import { getJson } from '../feeds/http.js';
import { FORMATS } from '../setup/formats.js';

const HOT100 = 'https://raw.githubusercontent.com/mhollingshead/billboard-hot-100/main';
const ITUNES_GENRES = { pop: 14, country: 6, rock: 21, alternative: 20, hiphop: 18, rnb: 15, dance: 17, christian: 22, latin: 12 };
const GENRE_LABEL = { pop: 'Pop', country: 'Country', rock: 'Rock', alternative: 'Alternative', hiphop: 'Hip-Hop/Rap', rnb: 'R&B/Soul', dance: 'Dance', christian: 'Christian', latin: 'Latin' };

export const CHARTS = {
  hot100: { name: 'Billboard Hot 100', short: 'Hot 100', weekly: true },
  'apple-top': { name: 'Apple Music Top Songs', short: 'Apple Music' },
  'itunes-all': { name: 'iTunes Top Songs', short: 'iTunes' },
  ...Object.fromEntries(Object.keys(ITUNES_GENRES).map((g) => [`itunes-${g}`, { name: `iTunes Top ${GENRE_LABEL[g]}`, short: `iTunes ${GENRE_LABEL[g]}` }])),
};

/** The charts that matter to each format, and the era a gold format draws its chart hits from. */
// `genres` tells a song that fits the format from one that doesn't (a general chart has every style on it).
export const FORMAT_CHARTS = {
  chr: { charts: ['hot100', 'apple-top', 'itunes-pop'], genres: /pop|dance|hip.?hop|rap|r&b|electro/i },
  hotac: { charts: ['hot100', 'itunes-pop', 'itunes-alternative'], gold: [2000, null], genres: /pop|rock|alternative|singer|adult|indie/i },
  ac: { charts: ['itunes-pop', 'hot100'], gold: [1980, null], genres: /pop|adult|soft|singer|r&b|soul/i },
  classichits: { charts: ['hot100'], gold: [1970, 1999], genres: /pop|rock|r&b|soul|disco|dance|new wave|funk|motown/i },
  classicrock: { charts: ['itunes-rock'], gold: [1965, 1995], genres: /rock|blues|metal/i },
  alternative: { charts: ['itunes-alternative', 'itunes-rock'], gold: [1990, null], genres: /alternative|indie|rock|punk/i },
  country: { charts: ['itunes-country', 'hot100'], gold: [1990, null], genres: /country/i },
  urban: { charts: ['itunes-hiphop', 'itunes-rnb', 'hot100'], gold: [1990, null], genres: /hip.?hop|rap|r&b|soul|trap/i },
  dance: { charts: ['itunes-dance', 'hot100'], gold: [1990, null], genres: /dance|electro|house|edm|techno/i },
  adulthits: { charts: ['hot100'], gold: [1975, 2015], genres: /pop|rock|alternative|new wave|r&b|soul|dance|disco|funk/i },
};

/** Charts that only list one style (no format check needed). */
export const genreChart = (id) => id.startsWith('itunes-') && id !== 'itunes-all';

/** Chart ids this station follows: its own choice in Settings, otherwise its format's. */
export function stationCharts() {
  const own = (store.settings.charts || []).filter((id) => CHARTS[id]);
  return own.length ? own : FORMAT_CHARTS[store.station.formatId]?.charts || ['hot100'];
}

const countryCode = () => String(store.station.market?.locations?.[0]?.countryCode || 'us').toLowerCase();

// ------------------------------------------------------------------ matching

const normTitle = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\(.*?\)|\[.*?\]/g, '').replace(/\s[-–]\s.*$/, '').replace(/\b(feat|ft)\.?\s.*$/, '').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
/** First credited artist, normalized ("Post Malone Featuring Morgan Wallen" → "postmalone"). */
export const primaryArtist = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .split(/\s+(?:featuring|feat\.?|ft\.?|f\/|with|x|vs\.?)\s+|\s*[,/&+]\s*|\s+and\s+(?=the\s)/)[0]
  .replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');

export function sameSong(a, b) {
  if (normTitle(a.title) !== normTitle(b.title) || !normTitle(a.title)) return false;
  const x = primaryArtist(a.artist); const y = primaryArtist(b.artist);
  return Boolean(x && y && (x === y || x.includes(y) || y.includes(x)));
}

// ------------------------------------------------------------------ fetching

const cache = new Map();
const TTL = 3 * 3600_000;

async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  try {
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    return value;
  } catch (err) {
    if (hit) return hit.value; // stale beats nothing
    throw err;
  }
}

const hot100Rows = (d) => (d.data || []).map((r) => ({ rank: r.this_week, artist: r.artist, title: r.song, lastWeek: r.last_week || null, peak: r.peak_position || r.this_week, weeks: r.weeks_on_chart || null }));

async function fetchChart(id, date) {
  if (id === 'hot100') {
    const d = await getJson(date ? `${HOT100}/date/${date}.json` : `${HOT100}/recent.json`, { timeout: 15000 });
    return { date: d.date, entries: hot100Rows(d) };
  }
  if (id === 'apple-top') {
    const d = await getJson(`https://rss.marketingtools.apple.com/api/v2/${countryCode()}/music/most-played/100/songs.json`, { timeout: 15000 });
    const at = new Date(d.feed?.updated || Date.now());
    return { date: Number.isNaN(at.getTime()) ? '' : at.toISOString().slice(0, 10), entries: (d.feed?.results || []).map((r, i) => ({ rank: i + 1, artist: r.artistName, title: r.name, year: Number(String(r.releaseDate || '').slice(0, 4)) || null, explicit: r.contentAdvisoryRating === 'Explict' || r.contentAdvisoryRating === 'Explicit' })) };
  }
  if (id.startsWith('itunes-')) {
    const g = ITUNES_GENRES[id.slice(7)];
    const d = await getJson(`https://itunes.apple.com/${countryCode()}/rss/topsongs/limit=100${g ? `/genre=${g}` : ''}/json`, { timeout: 15000 });
    return {
      date: (d.feed?.updated?.label || '').slice(0, 10),
      entries: (d.feed?.entry || []).map((e, i) => ({ rank: i + 1, artist: e['im:artist']?.label, title: e['im:name']?.label, year: Number(String(e['im:releaseDate']?.label || '').slice(0, 4)) || null })),
    };
  }
  throw new Error(`unknown chart ${id}`);
}

/**
 * One chart. `date` (YYYY-MM-DD) asks for a past Billboard Hot 100 week (the nearest published one).
 * @returns {Promise<{id, name, date, entries: {rank, artist, title, lastWeek?, peak?, weeks?, year?}[]}>}
 */
export async function getChart(id, { date = null } = {}) {
  if (!CHARTS[id]) throw new Error(`unknown chart ${id}`);
  if (date && id !== 'hot100') throw new Error('chart history is only available for the Hot 100');
  const week = date ? await nearestWeek(date) : null;
  const res = await cached(`${id}|${week || 'now'}`, week ? Infinity : TTL, () => fetchChart(id, week));
  return { id, name: CHARTS[id].name, short: CHARTS[id].short, ...res };
}

async function nearestWeek(date) {
  const weeks = await cached('hot100-weeks', 7 * 86400_000, () => getJson(`${HOT100}/valid_dates.json`, { timeout: 15000 }));
  let best = weeks[0];
  for (const w of weeks) { if (w <= date) best = w; else break; }
  return best;
}

/**
 * Big hits of an era from the Hot 100 archive: samples weeks across the years and keeps songs that
 * peaked at `maxPeak` or better. Each comes with its peak and chart year.
 */
export async function chartHits({ yearFrom, yearTo, maxPeak = 20, perYear = 4, maxYears = 12 } = {}) {
  const now = new Date().getFullYear();
  const from = Math.max(1959, yearFrom || now - 10);
  const to = Math.min(now, yearTo || now);
  const years = [];
  for (let y = from; y <= to; y++) years.push(y);
  const step = Math.max(1, Math.ceil(years.length / maxYears));
  const picked = years.filter((_, i) => i % step === 0);
  const months = ['02-15', '05-15', '08-15', '11-15', '04-01', '10-01'].slice(0, perYear);
  const out = new Map();
  for (const y of picked) {
    for (const m of months) {
      try {
        const c = await getChart('hot100', { date: `${y}-${m}` });
        for (const e of c.entries) {
          if (e.peak > maxPeak) continue;
          const key = `${primaryArtist(e.artist)}|${normTitle(e.title)}`;
          const prev = out.get(key);
          if (!prev || e.peak < prev.peak) out.set(key, { artist: e.artist, title: e.title, peak: e.peak, year: Number(c.date.slice(0, 4)) });
        }
      } catch { /* a missing week is fine */ }
    }
  }
  return [...out.values()].sort((a, b) => a.peak - b.peak);
}

// ------------------------------------------------------------------ library chart facts

export const chartStatus = { updatedAt: 0, charts: [], onChart: 0, moved: [], error: null };

/** Best current position of a song across the given charts. */
export function chartPosition(t, charts) {
  let best = null;
  for (const c of charts) {
    const e = c.entries.find((x) => sameSong(x, t));
    if (e && (!best || e.rank < best.rank || (e.rank === best.rank && e.weeks && !best.weeks))) best = { chart: c.short || c.name, rank: e.rank, lastWeek: e.lastWeek ?? null, peak: e.peak ?? e.rank, weeks: e.weeks ?? null };
  }
  return best;
}

/** Current rotation from the charts (current formats): power for the top of the chart, recurrent once a hit falls off. */
export function chartCategory(t, pos, wasOn) {
  if (!['A', 'B', 'C', 'N'].includes(t.category)) return null;
  if (pos) {
    const want = pos.rank <= 15 ? 'A' : 'B';
    return want === t.category ? null : want;
  }
  if (wasOn && (t.category === 'A' || t.category === 'B')) return 'C';
  return null;
}

/** Fetch this station's charts and mark every library song with its chart position and best peak. */
export async function refreshCharts() {
  const ids = stationCharts();
  const charts = [];
  for (const id of ids) {
    try { charts.push(await getChart(id)); } catch (err) { chartStatus.error = `${CHARTS[id]?.name || id}: ${err.message}`; }
  }
  if (!charts.length) return chartStatus;
  const current = FORMATS[store.station.formatId]?.mode !== 'gold';
  const rotate = current && store.settings.chartRotation !== false;
  const moved = [];
  let onChart = 0;
  for (const t of store.data.library) {
    const pos = chartPosition(t, charts);
    const wasOn = Boolean(t.chart);
    if (pos) {
      onChart++;
      t.chart = { ...pos, at: Date.now() };
      if (!t.chartPeak || pos.peak < t.chartPeak.peak) t.chartPeak = { peak: pos.peak, chart: pos.chart, year: new Date().getFullYear() };
    } else {
      delete t.chart;
    }
    if (rotate && !t.disabled) {
      const to = chartCategory(t, pos, wasOn);
      if (to) { moved.push(`${t.artist} - ${t.title}: ${t.category} → ${to}`); t.category = to; }
    }
  }
  Object.assign(chartStatus, { updatedAt: Date.now(), charts: charts.map((c) => ({ id: c.id, name: c.name, date: c.date, size: c.entries.length })), onChart, moved, error: charts.length === ids.length ? null : chartStatus.error });
  if (moved.length) console.log(`[charts] rotation moves: ${moved.join('; ')}`);
  store.save();
  return chartStatus;
}

let timer = null;
export function startChartWatch(intervalMs = 6 * 3600_000) {
  if (timer) return;
  const run = () => { if (store.station.setupComplete) refreshCharts().catch((err) => { chartStatus.error = err.message; }); };
  setTimeout(run, 20_000).unref?.();
  timer = setInterval(run, intervalMs);
  timer.unref?.();
}

/** A short chart line for prompts: "#4 on the Hot 100 (up from #6, 12 weeks)" or "peaked at #2". */
export function chartLine(t) {
  const c = t.chart;
  if (c) {
    const move = c.lastWeek ? (c.lastWeek > c.rank ? `, up from #${c.lastWeek}` : c.lastWeek < c.rank ? `, down from #${c.lastWeek}` : ', holding') : '';
    return `#${c.rank} ${c.chart}${move}${c.weeks ? `, ${c.weeks} wks` : ''}`;
  }
  if (t.chartPeak) return `peaked #${t.chartPeak.peak} ${t.chartPeak.chart}`;
  return '';
}
