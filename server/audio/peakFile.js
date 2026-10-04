// Whole-song waveform overviews, computed in one quick pass as soon as a song's file is complete.
//
// While a song plays, the decoder only runs a bounded distance ahead of the playhead, so a waveform
// built from it fills in a piece at a time. Songs now arrive as whole files well before air, so the
// full overview is computed up front: ffmpeg decodes to low-rate mono (a fraction of a second for a
// whole MP3) and each 50 ms window becomes a (min, max) pair, the same format the decoder produces.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, FFMPEG } from '../config.js';

export const PEAKS_DIR = path.join(CACHE_DIR, 'peaks');
const PEAK_RES = 0.05; // seconds per point, as in stream.js
const RATE = 16000; // plenty for an overview: 800 samples per point
fs.mkdirSync(PEAKS_DIR, { recursive: true });

export const peaksPath = (id) => path.join(PEAKS_DIR, `${String(id).replace(/[^\w-]/g, '')}.i8`);
export const hasPeaks = (id) => fs.existsSync(peaksPath(id));

export function readPeaks(id) {
  try {
    const b = fs.readFileSync(peaksPath(id));
    return b.length ? new Int8Array(b.buffer, b.byteOffset, b.length) : null;
  } catch { return null; }
}

/** The waveform overview of a whole audio file: Int8 (min, max) pairs, one per 50 ms. */
export function computePeaks(file) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const step = Math.round(RATE * PEAK_RES);
    let out = new Int8Array(8192); let count = 0;
    let lo = 0; let hi = 0; let n = 0;
    let rem = null; let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    proc.stdout.on('data', (buf) => {
      if (rem) { buf = Buffer.concat([rem, buf]); rem = null; }
      const usable = buf.length - (buf.length % 2);
      if (usable < buf.length) rem = Buffer.from(buf.subarray(usable));
      for (let i = 0; i < usable; i += 2) {
        const v = buf.readInt16LE(i);
        if (v < lo) lo = v; if (v > hi) hi = v;
        if (++n >= step) {
          if (count * 2 + 2 > out.length) { const g = new Int8Array(out.length * 2); g.set(out); out = g; }
          out[count * 2] = Math.round((lo / 32768) * 127);
          out[count * 2 + 1] = Math.round((hi / 32768) * 127);
          count++; lo = 0; hi = 0; n = 0;
        }
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0 || !count) return reject(new Error(`waveform: ${err.trim().split('\n').pop() || `ffmpeg exited ${code}`}`));
      resolve(out.slice(0, count * 2));
    });
  });
}

const inflight = new Map();

/** Make sure a song has its whole-file overview on disk (once; concurrent calls share the work). */
export function ensurePeaks(id, file) {
  if (hasPeaks(id)) return Promise.resolve(true);
  if (inflight.has(id)) return inflight.get(id);
  const job = computePeaks(file)
    .then((pk) => {
      const dest = peaksPath(id);
      fs.writeFileSync(`${dest}.tmp`, Buffer.from(pk.buffer, pk.byteOffset, pk.byteLength));
      fs.renameSync(`${dest}.tmp`, dest);
      return true;
    })
    .catch(() => false)
    .finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}
