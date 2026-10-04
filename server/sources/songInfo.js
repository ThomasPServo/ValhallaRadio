// Song lookups for when an AI doesn't know a song: everything open data says about it in one answer,
// for the music director's lookup tool, the DJ's talk-ups and the studio's song info panel.
//  - facts: original year, genres, vocal, tempo, popularity (MusicBrainz, Deezer, iTunes; see songFacts)
//  - charts: where it sits on this station's charts now, and its best peak
//  - story: the Wikipedia summary of the song (what it's about, the album, who wrote it), keyless

import { store } from '../store.js';
import { userAgent } from '../feeds/http.js';
import { lookupFacts, factLine } from './songFacts.js';
import { getChart, stationCharts, chartPosition, sameSong, primaryArtist } from './charts.js';

const WIKI = 'https://en.wikipedia.org';
const STORY_STALE = 60 * 86400_000;
const cache = new Map();

const plain = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '');

async function wiki(url) {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent(), Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from Wikipedia`);
  return res.json();
}

/** The Wikipedia article about this song (not a same-named song by someone else), summarized. */
export async function songStory({ artist, title }) {
  const q = `"${String(title).replace(/\(.*?\)|"/g, '').trim()}" ${String(artist).split(/,| feat| featuring| & /i)[0]} song`;
  const s = await wiki(`${WIKI}/w/api.php?action=query&list=search&format=json&srlimit=6&srsearch=${encodeURIComponent(q)}`);
  const want = plain(title); const who = primaryArtist(artist);
  const hit = (s.query?.search || []).find((r) => plain(r.title.replace(/\((?:[^)]*\b)?song\)/i, '')).startsWith(want)
    && plain(r.snippet.replace(/<[^>]+>/g, '')).includes(who));
  if (!hit) return null;
  const d = await wiki(`${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`);
  if (d.type !== 'standard' || !d.extract) return null;
  if (!plain(d.extract).includes(who)) return null; // a disambiguation-like miss
  return { title: d.title, description: d.description || '', extract: d.extract.slice(0, 700), url: d.content_urls?.desktop?.page || '' };
}

async function currentCharts() {
  const out = [];
  for (const id of stationCharts()) { try { out.push(await getChart(id)); } catch { /* skip */ } }
  return out;
}

/**
 * Everything known about a song. Library songs answer from their stored facts; anything else is looked up.
 * @returns {Promise<{artist, title, inLibrary, year, facts, chart, story, line}>}
 */
export async function songInfo({ artist, title }, { story = true } = {}) {
  const key = `${primaryArtist(artist)}|${plain(title)}|${story}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.value;
  const t = store.data.library.find((x) => sameSong(x, { artist, title }));
  const subject = t || { artist, title };
  const facts = t?.facts?.checkedAt ? t.facts : await lookupFacts(subject).catch(() => null);
  const charts = await currentCharts();
  const pos = chartPosition(subject, charts);
  let st = null;
  if (story) {
    if (t?.story && Date.now() - t.story.checkedAt < STORY_STALE) st = t.story.found ? t.story : null;
    else {
      st = await songStory(subject).catch(() => null);
      if (t) { t.story = { ...(st || {}), found: Boolean(st), checkedAt: Date.now() }; store.save(); }
    }
  }
  const view = { ...subject, year: t?.year || facts?.firstYear || null, facts: facts || {}, chart: pos || t?.chart, chartPeak: t?.chartPeak };
  const value = {
    artist: subject.artist, title: subject.title, inLibrary: Boolean(t), id: t?.id || null,
    year: view.year, facts: facts || null, chart: pos || null, chartPeak: t?.chartPeak || null,
    story: st,
    line: factLine(view).replace(/, (intro unknown|never played)/g, ''),
  };
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

/** Lookup results as prompt text. */
export function infoText(i) {
  return `${i.artist} - ${i.title}: ${i.line || 'no data found'}${i.story ? `\n  About it (Wikipedia): ${i.story.description ? `${i.story.description}. ` : ''}${i.story.extract}` : ''}`;
}
