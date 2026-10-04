// Vocal timing from synced lyrics (LRCLIB, free, no key). The first sung line tells us where an
// intro "post" is, and the last line tells us where the outro becomes vocal-free. Those are the
// two numbers a DJ needs to never talk over vocals.

const UA = 'Valhalla Radio Automation/0.2 (https://github.com/ThomasPServo/ValhallaRadio)';
const memo = new Map();

const NON_VOCAL = /^[\s♪♫…\.\-–—*]*$|^\(?\s*(instrumental|music|intro|outro|interlude|solo)\s*\)?$/i;

/** Parse LRC text into [{t, text}] sorted by time (seconds). Honours the [offset:] tag. */
export function parseLrc(lrc) {
  if (!lrc) return [];
  let offset = 0;
  const lines = [];
  for (const raw of String(lrc).split(/\r?\n/)) {
    const off = raw.match(/^\[offset:\s*([+-]?\d+)\]/i);
    if (off) { offset = Number(off[1]) / 1000; continue; }
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const s of stamps) lines.push({ t: Number(s[1]) * 60 + Number(String(s[2]).replace(':', '.')), text });
  }
  // a positive offset means the lyrics should be shown earlier
  return lines.map((l) => ({ t: Math.max(0, l.t - offset), text: l.text })).sort((a, b) => a.t - b.t);
}

/** First and last sung moments from parsed lines. */
export function vocalWindow(lines) {
  const sung = lines.filter((l) => !NON_VOCAL.test(l.text));
  if (!sung.length) return null;
  const first = sung[0];
  const last = sung[sung.length - 1];
  // line lengths from consecutive timestamps give a typical line duration
  const gaps = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i].t - lines[i - 1].t);
  gaps.sort((a, b) => a - b);
  const typical = Math.min(6, Math.max(1.8, gaps[Math.floor(gaps.length / 2)] || 3));
  const after = lines.find((l) => l.t > last.t);
  // an empty/non-vocal timestamp after the last line marks where it ends
  const end = after && NON_VOCAL.test(after.text) ? Math.min(after.t, last.t + 8) : last.t + typical;
  return { vocalStart: first.t, vocalEnd: end, lines: sung.length };
}

const clean = (s) => String(s || '')
  .replace(/\s*[-–]\s*(radio edit|single version|remaster(ed)?( \d{4})?|edit|mono|stereo).*$/i, '')
  .replace(/\s*[([](feat\.?|ft\.?|with|radio edit|remaster)[^)\]]*[)\]]/gi, '')
  .trim();
const primaryArtist = (a) => String(a || '').split(/,|&| feat\.? | ft\.? | x /i)[0].trim();

async function lrclib(path) {
  const res = await fetch(`https://lrclib.net${path}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB HTTP ${res.status}`);
  return res.json();
}

/**
 * Look up vocal timing for a track.
 * @returns {Promise<{status:'found'|'instrumental'|'none'|'mismatch', vocalStart?, vocalEnd?, source:'lyrics', lrclibId?}>}
 */
export async function lookupVocalTiming({ title, artist, album, duration }) {
  const key = `${artist}|${title}|${duration}`;
  if (memo.has(key)) return memo.get(key);
  const t = clean(title);
  const a = primaryArtist(artist);
  let rec = null;
  try {
    const q = new URLSearchParams({ track_name: t, artist_name: a });
    if (album) q.set('album_name', clean(album));
    if (duration) q.set('duration', String(Math.round(duration)));
    rec = await lrclib(`/api/get?${q}`);
    if (!rec || !rec.syncedLyrics) {
      const list = await lrclib(`/api/search?${new URLSearchParams({ track_name: t, artist_name: a })}`);
      const candidates = (list || []).filter((r) => r.syncedLyrics || r.instrumental);
      rec = candidates.sort((x, y) => Math.abs((x.duration || 0) - duration) - Math.abs((y.duration || 0) - duration))[0] || rec;
    }
  } catch (err) {
    return { status: 'error', error: err.message, source: 'lyrics' }; // not memoized: retry later
  }
  let out;
  if (!rec) out = { status: 'none', source: 'lyrics' };
  else if (duration && rec.duration && Math.abs(rec.duration - duration) > 3) out = { status: 'mismatch', source: 'lyrics', lrclibId: rec.id };
  else if (rec.instrumental) out = { status: 'instrumental', source: 'lyrics', lrclibId: rec.id };
  else {
    const w = vocalWindow(parseLrc(rec.syncedLyrics));
    // lyrics timed to a different edit (e.g. album version vs radio edit) are worse than none
    const fits = w && (!duration || (w.vocalEnd <= duration + 0.5 && w.vocalStart < duration * 0.7));
    if (!w) out = { status: 'none', source: 'lyrics' };
    else if (!fits) out = { status: 'mismatch', source: 'lyrics', lrclibId: rec.id };
    else out = { status: 'found', source: 'lyrics', lrclibId: rec.id, vocalStart: round2(w.vocalStart), vocalEnd: round2(w.vocalEnd) };
  }
  memo.set(key, out);
  return out;
}

const round2 = (x) => Math.round(x * 100) / 100;
