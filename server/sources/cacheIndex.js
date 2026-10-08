// What's in the music cache, held in memory. The cache warmer, the log's prefetch and song replacement
// ask about it constantly, and asking the disk about thousands of files each time blocks the audio thread
// for tens of milliseconds. Changes made here update it at once; a rescan every few minutes picks up
// anything else (a file deleted by hand).

import fs from 'node:fs';
import path from 'node:path';
import { MUSIC_CACHE_DIR } from '../config.js';

const RESCAN_MS = 5 * 60_000;
const MIN_BYTES = 10000; // anything smaller is an error page, not a song
const sizes = new Map(); // file name -> bytes, finished songs only
let total = 0;
let scannedAt = 0;

function scan() {
  sizes.clear();
  total = 0;
  let names = [];
  try { names = fs.readdirSync(MUSIC_CACHE_DIR); } catch { /* nothing cached yet */ }
  for (const n of names) {
    if (!n.endsWith('.audio')) continue;
    try { const b = fs.statSync(path.join(MUSIC_CACHE_DIR, n)).size; sizes.set(n, b); total += b; } catch { /* just removed */ }
  }
  scannedAt = Date.now();
}

function fresh() { if (!scannedAt || Date.now() - scannedAt > RESCAN_MS) scan(); }

/** Is this cache file (e.g. "qz-123.audio") a finished song? */
export function hasSong(name) { fresh(); return (sizes.get(name) || 0) > MIN_BYTES; }

/** Bytes the finished songs take. */
export function totalBytes() { fresh(); return total; }

/** A cache file was written or removed. */
export function noteFile(name) {
  if (!scannedAt || !name.endsWith('.audio')) return;
  const old = sizes.get(name) || 0;
  let now = -1;
  try { now = fs.statSync(path.join(MUSIC_CACHE_DIR, name)).size; } catch { /* removed */ }
  if (now < 0) sizes.delete(name); else sizes.set(name, now);
  total += Math.max(0, now) - old;
}

/** Many files changed: look again next time. */
export function rescan() { scannedAt = 0; }
