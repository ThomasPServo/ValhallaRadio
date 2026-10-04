// Song facts from open music data, so every AI (or none) can program music from facts instead of
// memory: a small local model doesn't need to "know" a song to place it well.
//
//  - Deezer (keyless): popularity rank, tempo when known, release date, album genres; related artists
//    and their top tracks for catalog discovery.
//  - MusicBrainz (keyless, 1 request/s): original release year, artist type (group/person), gender,
//    country and community genres.
//  - iTunes Search (keyless): genre fallback.
// Combined with Valhalla's own audio analysis (tempo, loudness, intro, ending) into `track.facts`.

import { userAgent } from '../feeds/http.js';
import { chartLine } from './charts.js';

const DEEZER = 'https://api.deezer.com';
const MB = 'https://musicbrainz.org/ws/2';

async function get(url, { timeout = 12000, mb = false } = {}) {
  if (mb) await mbTurn();
  const res = await fetch(url, { headers: { 'User-Agent': userAgent(), Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const d = await res.json();
  if (d?.error && !mb) throw new Error(`${new URL(url).host}: ${d.error.message || d.error.type || 'error'}`);
  return d;
}

// MusicBrainz asks for at most one request per second per client
let mbNext = 0;
function mbTurn() {
  const now = Date.now();
  const at = Math.max(now, mbNext);
  mbNext = at + 1100;
  return new Promise((r) => setTimeout(r, at - now));
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\(.*?\)|\[.*?\]/g, '').replace(/\b(feat|ft)\.?.*$/, '').replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
const VERSION = /remix|live|karaoke|instrumental|acoustic|demo|sped up|slowed|mix\)|edit\)/i;

/** Deezer rank (roughly 0 … 1,000,000) on a 0-100 popularity scale. */
export function popularityFromRank(rank) {
  if (!rank || rank < 1000) return 0;
  return Math.max(0, Math.min(100, Math.round(((Math.log10(rank) - 3) / 3) * 100)));
}

/** Who sings: from the credited artists and MusicBrainz artist data. */
export function voiceOf({ credits = 1, type = null, gender = null }) {
  if (credits > 1) return 'duet/collab';
  if (type === 'Group' || type === 'Orchestra' || type === 'Choir') return 'group';
  if (gender === 'Female') return 'female';
  if (gender === 'Male') return 'male';
  return null;
}

/** Energy 1-5 estimated from tempo, loudness and genre (used when nobody has rated the song). */
export function estimateEnergy({ bpm = null, loudness = null, genre = '' }) {
  if (!bpm && loudness == null) return null;
  const g = String(genre).toLowerCase();
  let tempo = 0.6;
  if (bpm) tempo = bpm < 80 ? 0.1 : bpm < 96 ? 0.45 : bpm < 112 ? 0.75 : bpm < 130 ? 1 : 1.2;
  const loud = loudness == null ? 0.5 : Math.max(0, Math.min(1, (loudness + 14) / 8));
  let boost = 0;
  if (/dance|edm|electro|house|techno|metal|punk|hard rock|drum and bass|dubstep/.test(g)) boost += 0.6;
  if (/ballad|soul|jazz|acoustic|folk|singer|ambient|classical|lo-fi|soft/.test(g)) boost -= 0.5;
  return Math.max(1, Math.min(5, Math.round(1.2 + 2 * tempo + 1.3 * loud + boost)));
}

function tempoWord(bpm) {
  if (!bpm) return '';
  return bpm < 90 ? 'slow' : bpm < 115 ? 'mid-tempo' : 'uptempo';
}

const albumGenres = new Map();
const artistCache = new Map();

async function deezerTrack(t) {
  let d = null;
  if (t.isrc) { try { d = await get(`${DEEZER}/track/isrc:${encodeURIComponent(t.isrc)}`); } catch { d = null; } }
  if (!d?.id) {
    const wa = String(t.artist).split(',')[0].trim();
    const bare = (x) => String(x).replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
    let r = await get(`${DEEZER}/search?q=${encodeURIComponent(`artist:"${bare(wa)}" track:"${bare(t.title)}"`)}&limit=25`);
    if (!r.data?.length) r = await get(`${DEEZER}/search?q=${encodeURIComponent(`${wa} ${bare(t.title)}`)}&limit=50`);
    const want = norm(t.title);
    // a remix or live take carries other credits and its own popularity: only the song itself counts
    const ok = (x) => norm(x.title) === want && norm(x.artist?.name).includes(norm(wa)) && !VERSION.test(x.title) && (VERSION.test(t.title) || !VERSION.test(x.album?.title || ''));
    const hit = (r.data || []).filter(ok).sort((a, b) => (b.rank || 0) - (a.rank || 0))[0];
    if (!hit) return null;
    d = await get(`${DEEZER}/track/${hit.id}`);
  }
  let genres = [];
  const albumId = d.album?.id;
  if (albumId) {
    if (!albumGenres.has(albumId)) {
      try { albumGenres.set(albumId, ((await get(`${DEEZER}/album/${albumId}`)).genres?.data || []).map((g) => g.name)); } catch { albumGenres.set(albumId, []); }
    }
    genres = albumGenres.get(albumId);
  }
  return { id: d.id, artistId: d.artist?.id, rank: d.rank, bpm: d.bpm > 40 ? Math.round(d.bpm) : null, gain: d.gain, released: d.release_date || d.album?.release_date || null, genres, credits: (d.contributors || []).filter((c) => /main|featured/i.test(c.role || 'Main')).length || 1 };
}

async function musicBrainz(t) {
  const q = t.isrc ? `isrc:${t.isrc}` : `recording:"${String(t.title).replace(/"/g, '')}" AND artist:"${String(t.artist).split(',')[0].replace(/"/g, '')}"`;
  const r = await get(`${MB}/recording?query=${encodeURIComponent(q)}&fmt=json&limit=${t.isrc ? 5 : 40}`, { mb: true });
  const recs = (r.recordings || []).filter((x) => x.score >= 90 && !/\b(live|demo|remix|karaoke|instrumental|rehearsal)\b/i.test(`${x.disambiguation || ''} ${x.title || ''}`) && (!x.video));
  if (!recs.length) return null;
  const years = recs.map((x) => Number(String(x['first-release-date'] || '').slice(0, 4))).filter((y) => y > 1900);
  const credit = recs[0]['artist-credit'] || [];
  const mainId = credit[0]?.artist?.id;
  let artist = null;
  if (mainId) {
    if (!artistCache.has(mainId)) {
      try {
        const a = await get(`${MB}/artist/${mainId}?inc=genres&fmt=json`, { mb: true });
        artistCache.set(mainId, { type: a.type || null, gender: a.gender || null, country: a.country || null, genres: (a.genres || []).sort((x, y) => y.count - x.count).slice(0, 4).map((g) => g.name) });
      } catch { artistCache.set(mainId, null); }
    }
    artist = artistCache.get(mainId);
  }
  return { firstYear: originalYear(years, Boolean(t.isrc)), credits: credit.length || 1, artist };
}

/** Earliest release year another recording backs up (one stray, mis-dated demo doesn't move a song's year). */
export function originalYear(years, exact = false) {
  const ys = years.filter((y) => y > 1900).sort((a, b) => a - b);
  if (!ys.length) return null;
  if (exact || ys.length < 3) return ys[0];
  return ys.find((y, i) => ys.slice(i + 1).some((z) => z - y <= 1)) ?? ys[0];
}

/** Primary genre on iTunes (one quick keyless request). */
export async function itunesGenre(t) {
  const r = await get(`https://itunes.apple.com/search?term=${encodeURIComponent(`${t.artist} ${t.title}`)}&entity=song&limit=5`);
  const want = norm(t.title);
  const hit = (r.results || []).find((x) => norm(x.trackName) === want) || null;
  return hit ? { genre: hit.primaryGenreName || null, released: hit.releaseDate || null } : null;
}

/**
 * Look up everything open data knows about a song.
 * @returns {Promise<object>} facts: genre, genres, firstYear, popularity, bpm, voice, country, energy, sources
 */
export async function lookupFacts(t) {
  const sources = [];
  const [dz, mb] = await Promise.all([
    deezerTrack(t).then((x) => { if (x) sources.push('deezer'); return x; }).catch(() => null),
    musicBrainz(t).then((x) => { if (x) sources.push('musicbrainz'); return x; }).catch(() => null),
  ]);
  let genres = [...(mb?.artist?.genres || []), ...(dz?.genres || []).map((g) => g.toLowerCase())];
  if (!genres.length) {
    const it = await itunesGenre(t).catch(() => null);
    if (it?.genre) { genres.push(it.genre.toLowerCase()); sources.push('itunes'); }
  }
  genres = [...new Set(genres)].slice(0, 4);
  const analysisBpm = t.analysis?.headTempo?.confidence >= 0.8 ? Math.round(t.analysis.headTempo.bpm) : null;
  const bpm = dz?.bpm || analysisBpm || null;
  const dzYear = dz?.released ? Number(String(dz.released).slice(0, 4)) : null;
  const years = [mb?.firstYear, dzYear, t.year].filter((y) => y > 1900);
  const credits = Math.max(dz?.credits || 1, mb?.credits || 1, String(t.artist).split(/,|&| feat\.? | x | with /i).length);
  const facts = {
    genre: genres[0] || null,
    genres,
    firstYear: years.length ? Math.min(...years) : null,
    popularity: dz?.rank ? popularityFromRank(dz.rank) : null,
    bpm,
    tempo: tempoWord(bpm),
    voice: voiceOf({ credits, type: mb?.artist?.type, gender: mb?.artist?.gender }),
    country: mb?.artist?.country || null,
    deezerArtistId: dz?.artistId || null,
    sources,
    checkedAt: Date.now(),
  };
  facts.energy = estimateEnergy({ bpm, loudness: t.analysis?.loudness ?? null, genre: genres.join(' ') });
  return facts;
}

/** A compact, factual one-liner for prompts: what any model needs to place a song. */
export function factLine(t, { at = Date.now() } = {}) {
  const f = t.facts || {};
  const intro = t.markers?.intro ?? (t.lyrics?.status === 'found' ? t.lyrics.vocalStart : null);
  const end = t.markers?.endType || t.analysis?.endType;
  const bpm = f.bpm || (t.analysis?.headTempo?.confidence >= 0.8 ? Math.round(t.analysis.headTempo.bpm) : null);
  const energy = t.energy ?? f.energy ?? estimateEnergy({ bpm, loudness: t.analysis?.loudness ?? null, genre: (f.genres || []).join(' ') });
  const last = t.lastPlayed ? `last ${Math.round((at - t.lastPlayed) / 3600_000)}h ago` : 'never played';
  return [
    t.year || f.firstYear,
    f.genres?.length ? f.genres.slice(0, 2).join('/') : null,
    f.voice ? `${f.voice} vocal` : null,
    bpm ? `${bpm} bpm ${tempoWord(bpm)}` : null,
    energy ? `energy ${energy}${t.energy == null ? ' (est)' : ''}` : null,
    f.popularity != null ? `popularity ${f.popularity}` : null,
    intro != null ? `intro ${Math.round(intro)}s` : 'intro unknown',
    end ? `${end} end` : null,
    chartLine(t) || null,
    last,
  ].filter(Boolean).join(', ');
}

// ------------------------------------------------------------------ catalog discovery

/** Deezer artist id for a name (cached). */
const artistIds = new Map();
export async function deezerArtistId(name) {
  const key = norm(name);
  if (artistIds.has(key)) return artistIds.get(key);
  const r = await get(`${DEEZER}/search/artist?q=${encodeURIComponent(name)}&limit=5`);
  const hit = (r.data || []).find((a) => norm(a.name) === key) || null;
  artistIds.set(key, hit?.id || null);
  return hit?.id || null;
}

/**
 * Artists related to the ones the station already plays (Deezer's listener graph), most relevant first.
 * @param {string[]} seedArtists
 * @returns {Promise<{name: string, via: string}[]>}
 */
export async function relatedArtists(seedArtists, { perSeed = 4 } = {}) {
  const out = []; const seen = new Set(seedArtists.map(norm));
  for (const name of seedArtists) {
    const id = await deezerArtistId(name).catch(() => null);
    if (!id) continue;
    const rel = await get(`${DEEZER}/artist/${id}/related?limit=${perSeed + 4}`).catch(() => ({ data: [] }));
    let n = 0;
    for (const a of rel.data || []) {
      if (n >= perSeed || seen.has(norm(a.name))) continue;
      seen.add(norm(a.name));
      out.push({ name: a.name, via: name, fans: a.nb_fan || 0 });
      n++;
    }
  }
  return out;
}
