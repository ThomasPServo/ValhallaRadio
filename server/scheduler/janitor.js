// Disk housekeeping: nothing Valhalla writes stays around once nothing needs it.
//
//  - music cache: songs no longer in the library or the log (after a day, so previews can be replayed),
//    on top of the size limit (LRU) in monochrome.js; abandoned partial downloads after a day
//  - waveforms (peaks) of songs that are gone
//  - voice/render cache: one-off DJ, weather, traffic and news renders after 6 hours, raw speech after
//    2 days, imaging, spot and bed renders after 30 days unused (reuse refreshes a file's age)
//  - uploads that no imaging piece, spot, bed or logo uses any more (after a day's grace)

import fs from 'node:fs';
import path from 'node:path';
import { store } from '../store.js';
import { MUSIC_CACHE_DIR, TTS_CACHE_DIR, UPLOAD_DIR } from '../config.js';
import { PEAKS_DIR } from '../audio/peakFile.js';
import { activeFetch } from '../sources/fetcher.js';
import * as cacheIndex from '../sources/cacheIndex.js';

const HOUR = 3600_000; const DAY = 24 * HOUR;
export const janitorStatus = { lastRun: 0, freedBytes: 0, removed: 0, totalFreed: 0 };

const safe = (id) => String(id).replace(/[^\w-]/g, '');

function sweep(dir, shouldRemove) {
  let freed = 0; let removed = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { freed, removed }; }
  const now = Date.now();
  for (const name of names) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    if (!shouldRemove(name, now - st.mtimeMs, st)) continue;
    try { fs.rmSync(p, { force: true }); freed += st.size; removed++; } catch { /* in use: next time */ }
  }
  return { freed, removed };
}

/** Song ids that must keep their files: the library and everything in the log. */
function songsInUse(logItems = []) {
  const ids = new Set(store.data.library.map((t) => safe(t.id)));
  for (const it of logItems) if (it.trackId) ids.add(safe(it.trackId));
  return ids;
}

export function ttsRule(name, age) {
  if (/^(dj|info)_/.test(name)) return age > 6 * HOUR; // a break airs once
  if (/^[0-9a-f]{40}\.(wav|mp3)$/.test(name)) return age > 2 * DAY; // raw speech: renders keep the result
  if (name.endsWith('.tmp')) return age > HOUR;
  return age > 30 * DAY; // imaging, spots, beds: kept while they're in use
}

/**
 * Clean up once. `logItems` are the scheduled log items (their songs stay cached).
 * @returns {{freedBytes: number, removed: number}}
 */
export function cleanUp(logItems = []) {
  const keep = songsInUse(logItems);
  let freed = 0; let removed = 0;
  const add = (r) => { freed += r.freed; removed += r.removed; };

  const songs = sweep(MUSIC_CACHE_DIR, (name, age) => {
    const id = name.replace(/\.audio(\.part(\.json)?)?$/, '');
    if (activeFetch(id)) return false;
    if (name.endsWith('.part') || name.endsWith('.part.json')) return age > DAY;
    if (name.endsWith('.audio')) return !keep.has(id) && age > DAY;
    return false;
  });
  if (songs.removed) cacheIndex.rescan();
  add(songs);
  add(sweep(PEAKS_DIR, (name, age) => name.endsWith('.tmp') ? age > HOUR : !keep.has(name.replace(/\.i8$/, '')) && age > DAY));
  add(sweep(TTS_CACHE_DIR, (name, age) => ttsRule(name.replace(/\.json$/, ''), age)));

  const used = new Set([
    store.data.station?.logo,
    ...(store.data.imaging?.items || []).map((i) => i.file),
    ...(store.data.spots || []).map((s) => s.file),
  ].filter(Boolean).map((f) => path.basename(f)));
  add(sweep(UPLOAD_DIR, (name, age) => !used.has(name) && age > DAY));

  Object.assign(janitorStatus, { lastRun: Date.now(), freedBytes: freed, removed, totalFreed: janitorStatus.totalFreed + freed });
  if (removed) console.log(`[janitor] removed ${removed} file(s), freed ${(freed / 1048576).toFixed(1)} MB`);
  return { freedBytes: freed, removed };
}

/** A song left the library: its cached audio and waveform go now (unless it's still in the log). */
export function forgetSong(id, logItems = []) {
  if (songsInUse(logItems).has(safe(id))) return;
  for (const p of [path.join(MUSIC_CACHE_DIR, `${safe(id)}.audio`), path.join(PEAKS_DIR, `${safe(id)}.i8`)]) {
    try { fs.rmSync(p, { force: true }); } catch { /* fine */ }
  }
  cacheIndex.noteFile(`${safe(id)}.audio`);
}

export function startJanitor(logItems, { everyMs = HOUR } = {}) {
  const run = () => { try { cleanUp(logItems()); } catch (err) { console.warn('[janitor]', err.message); } };
  setTimeout(run, 60_000).unref?.();
  setInterval(run, everyMs).unref?.();
}
