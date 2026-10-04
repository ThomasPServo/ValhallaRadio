// On-demand analysis of a library song (for the marker editor): streams the song once — nothing
// is written to disk — and returns markers, loudness, tempo, synced-lyrics timing and the waveform.

import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { CACHE_DIR } from '../config.js';
import * as mono from '../sources/monochrome.js';
import * as library from '../scheduler/library.js';
import { StreamDecoder, SR, PEAK_SECONDS } from './stream.js';
import { analyze } from './analysisPool.js';
import { lookupVocalTiming } from './lyrics.js';

const PEAKS_DIR = path.join(CACHE_DIR, 'peaks');
const running = new Map();

export function peaksFile(id) { return path.join(PEAKS_DIR, `${id}.i8`); }

/** 'analyzed' (id, analysis): a song's ending and fade point are now known. */
export const analysisEvents = new EventEmitter();

const TAIL_SEC = 75; // long enough to see a long fade from its start

const queue = [];
let draining = false;
/**
 * Analyse songs in the background, one at a time, as soon as their files are in: the ending type and the
 * fade's mix-out point are then known when the segue is planned, not discovered as the song ends.
 */
export function queueAnalysis(id) {
  const t = library.findTrack(id);
  if (!t || (t.analysis?.v === 2 && t.analysis.endType) || running.has(id) || queue.includes(id)) return;
  queue.push(id);
  if (draining) return;
  draining = true;
  (async () => {
    while (queue.length) {
      const next = queue.shift();
      try { await analyzeTrack(next); } catch { /* skipped; tried again next time it comes up */ }
    }
    draining = false;
  })();
}

export function analyzeTrack(id) {
  if (running.has(id)) return running.get(id);
  const job = (async () => {
    const t = library.findTrack(id);
    if (!t) throw new Error('unknown track');
    const fetch = mono.fetchTrack(id, { priority: 2000 }); // behind anything that's going to air
    const local = fetch ? null : mono.cachedPath(id);
    const d = new StreamDecoder({ file: local || undefined, source: fetch || undefined, durationHint: t.duration, maxAheadSec: 1200, keepBehindSec: 1200, label: `analyze ${t.title}` }).start();
    try {
      await new Promise((resolve, reject) => {
        d.on('end', resolve);
        d.on('error', reject);
      });
      const end = d.decoded;
      const loudness = d.loudness();
      const head = await analyze('head', d.range(0, Math.round(48 * SR)), { refLoudness: loudness });
      const from = Math.max(0, end - Math.round(TAIL_SEC * SR));
      const tail = await analyze('tail', d.range(from, end), { offsetSec: from / SR, refLoudness: loudness });
      const lyrics = await lookupVocalTiming({ title: t.title, artist: t.artist, album: t.album, duration: end / SR });
      const analysis = {
        v: 2, analyzedAt: Date.now(), duration: end / SR, loudness: Math.round(loudness * 10) / 10,
        startSec: head.startSec, endSec: tail.endSec, rampIn: head.rampIn, firstBeat: head.firstBeat, headTempo: head.tempo,
        tailTempo: tail.tempo, endType: tail.endType, mixOut: tail.mixOut, lastLoud: tail.lastLoud,
      };
      library.updateTrack(id, { analysis, ...(lyrics.status !== 'error' ? { lyrics: { ...lyrics, checkedAt: Date.now() } } : {}) });
      analysisEvents.emit('analyzed', id, analysis);
      fs.mkdirSync(PEAKS_DIR, { recursive: true });
      const pk = d.peaksArray();
      fs.writeFileSync(peaksFile(id), Buffer.from(pk.buffer, pk.byteOffset, pk.byteLength));
      return trackDetail(id);
    } finally {
      d.close();
    }
  })().finally(() => running.delete(id));
  running.set(id, job);
  return job;
}

/** Everything the marker editor needs about a song. Times are seconds in the original file. */
export function trackDetail(id) {
  const t = library.findTrack(id);
  if (!t) return null;
  let peaks = null;
  if (fs.existsSync(peaksFile(id))) peaks = fs.readFileSync(peaksFile(id)).toString('base64');
  return {
    id, title: t.title, artist: t.artist, artwork: t.artwork, duration: t.analysis?.duration || t.duration,
    analysis: t.analysis || null, lyrics: t.lyrics || null, markers: t.markers || {}, peaks, peakRes: PEAK_SECONDS,
  };
}
