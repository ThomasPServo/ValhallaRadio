// Song analysis on decoded PCM (interleaved stereo Int16 @ 44.1 kHz). Everything here is pure
// and synchronous; the engine runs it in a worker thread (analysisWorker.js) so the real-time
// audio loop never waits on it.
//
// What we extract, in seconds of track time:
//   start/end trim points, K-weighted loudness (curve + gated integrated),
//   intro ramp (soft vs. hard start), tempo + beat phase (spectral-flux onsets + autocorrelation),
//   ending type (cold vs. fade) and the mix-out point for segues,
// Vocal timing deliberately does NOT come from here: a DSP vocal detector was measured against
// synced-lyrics ground truth and was not reliable enough to protect vocals, so vocal in/out
// points come from LRCLIB or from markers set in the studio (see lyrics.js / markers).

import { kWeighting, FFT } from './dsp.js';

export const FS = 44100;
const DS = 4; // analysis downsample factor -> 11025 Hz
const AFS = FS / DS;

/** Leading/trailing silence trim (frames). */
export function trimPoints(pcm, thresholdDb = -54) {
  const frames = pcm.length >> 1;
  const thr = Math.pow(10, thresholdDb / 20) * 32768;
  let s = 0;
  while (s < frames && Math.abs(pcm[s * 2]) < thr && Math.abs(pcm[s * 2 + 1]) < thr) s++;
  let e = frames;
  while (e > s && Math.abs(pcm[(e - 1) * 2]) < thr && Math.abs(pcm[(e - 1) * 2 + 1]) < thr) e--;
  return { start: s, end: e };
}

/**
 * Momentary loudness (400 ms window) every `hop` seconds, plus gated integrated loudness.
 * @returns {{ curve: Float32Array, hop: number, integrated: number, blocks: Float64Array }}
 */
export function loudnessProfile(pcm, { hop = 0.1 } = {}) {
  const frames = pcm.length >> 1;
  const [a1, a2] = kWeighting(FS); const [b1, b2] = kWeighting(FS);
  const hopN = Math.round(FS * hop);
  const nBlocks = Math.floor(frames / hopN);
  const blocks = new Float64Array(nBlocks); // mean square per hop
  let acc = 0; let n = 0; let bi = 0;
  for (let i = 0; i < frames && bi < nBlocks; i++) {
    const l = a2.process(a1.process(pcm[i * 2] / 32768));
    const r = b2.process(b1.process(pcm[i * 2 + 1] / 32768));
    acc += l * l + r * r;
    if (++n === hopN) { blocks[bi++] = acc / n; acc = 0; n = 0; }
  }
  const win = Math.max(1, Math.round(0.4 / hop));
  const curve = new Float32Array(nBlocks);
  const gated = [];
  for (let i = 0; i < nBlocks; i++) {
    let s = 0; let c = 0;
    for (let k = Math.max(0, i - win + 1); k <= i; k++) { s += blocks[k]; c++; }
    const ms = s / c;
    curve[i] = -0.691 + 10 * Math.log10(ms + 1e-12);
    if (i >= win - 1 && curve[i] > -70) gated.push(ms);
  }
  return { curve, hop, integrated: gatedLoudness(gated), blocks };
}

export function gatedLoudness(meanSquares) {
  if (!meanSquares.length) return -70;
  const mean = meanSquares.reduce((s, v) => s + v, 0) / meanSquares.length;
  const kept = meanSquares.filter((v) => v >= mean * 0.1);
  const m = kept.reduce((s, v) => s + v, 0) / Math.max(1, kept.length);
  return -0.691 + 10 * Math.log10(m + 1e-12);
}

/** Downsampled mono (mid) signal at 11025 Hz (boxcar anti-alias is plenty for onset analysis). */
export function midSide(pcm) {
  const frames = pcm.length >> 1;
  const n = Math.floor(frames / DS);
  const mid = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let k = 0; k < DS; k++) { const j = (i * DS + k) * 2; m += pcm[j] + pcm[j + 1]; }
    mid[i] = m / (2 * DS * 32768);
  }
  return { mid };
}

/** Log-compressed spectral-flux onset envelope at ~100 Hz. */
export function onsetEnvelope(mid) {
  const N = 256; const hop = 110; const fft = new FFT(N);
  const frames = Math.max(0, Math.floor((mid.length - N) / hop));
  const env = new Float32Array(frames);
  const re = new Float64Array(N); const im = new Float64Array(N);
  let prev = new Float64Array(N / 2); let cur = new Float64Array(N / 2);
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) { re[i] = mid[o + i] * fft.window[i]; im[i] = 0; }
    fft.transform(re, im);
    let flux = 0;
    for (let b = 1; b < N / 2; b++) {
      const m = Math.log1p(1000 * Math.hypot(re[b], im[b]));
      cur[b] = m;
      const d = m - prev[b];
      if (d > 0) flux += d;
    }
    env[f] = flux;
    const t = prev; prev = cur; cur = t;
  }
  return { env, rate: AFS / hop };
}

/**
 * Tempo and beat phase from an onset envelope (autocorrelation with a perceptual prior).
 * @returns {{bpm:number, period:number, phase:number, confidence:number}|null} period/phase in seconds
 */
export function estimateTempo(env, rate) {
  if (env.length < rate * 6) return null;
  // high-pass the envelope (remove slow trend), half-wave rectify
  const w = Math.round(rate * 0.5);
  const x = new Float32Array(env.length);
  let run = 0;
  for (let i = 0; i < env.length; i++) {
    run += env[i] - (i >= w ? env[i - w] : 0);
    const avg = run / Math.min(i + 1, w);
    x[i] = Math.max(0, env[i] - avg);
  }
  const minLag = Math.floor((rate * 60) / 190); const maxLag = Math.ceil((rate * 60) / 62);
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag];
    ac[lag] = s / (x.length - lag);
  }
  let best = -1; let bestScore = -Infinity;
  let sum = 0; let sum2 = 0; let cnt = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (rate * 60) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    // reward lags whose double also correlates (metrical consistency)
    const dbl = lag * 2 < ac.length ? ac[lag * 2] : 0;
    const score = (ac[lag] + 0.5 * dbl) * prior;
    sum += ac[lag]; sum2 += ac[lag] * ac[lag]; cnt++;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  if (best < 0) return null;
  // parabolic interpolation for sub-frame precision
  const y0 = ac[best - 1]; const y1 = ac[best]; const y2 = ac[best + 1];
  const den = y0 - 2 * y1 + y2;
  const lag = best + (den !== 0 ? (0.5 * (y0 - y2)) / den : 0);
  const mean = sum / cnt; const sd = Math.sqrt(Math.max(1e-12, sum2 / cnt - mean * mean));
  const confidence = Math.max(0, Math.min(1, (y1 - mean) / (sd * 4)));
  // beat phase: comb over the envelope
  let bestPhase = 0; let bestComb = -Infinity;
  for (let ph = 0; ph < lag; ph += 1) {
    let s = 0;
    for (let t = ph; t < x.length; t += lag) s += x[Math.round(t)] || 0;
    if (s > bestComb) { bestComb = s; bestPhase = ph; }
  }
  return { bpm: Math.round(((rate * 60) / lag) * 10) / 10, period: lag / rate, phase: bestPhase / rate, confidence: Math.round(confidence * 100) / 100 };
}

/**
 * Analyse the opening of a track (pcm starts at track time 0).
 * @param {Int16Array} pcm
 * @param {{refLoudness?: number}} opts loudness of the whole song if already known
 */
export function analyzeHead(pcm, { refLoudness } = {}) {
  const { start, end } = trimPoints(pcm);
  const prof = loudnessProfile(pcm);
  const ref = refLoudness ?? prof.integrated;
  const startSec = start / FS;
  let rampIn = 0;
  for (let i = Math.floor(startSec / prof.hop); i < prof.curve.length; i++) {
    if (prof.curve[i] >= ref - 6) { rampIn = Math.max(0, i * prof.hop - startSec); break; }
  }
  const { mid } = midSide(pcm);
  const on = onsetEnvelope(mid);
  const tempo = estimateTempo(on.env, on.rate);
  let firstBeat = null;
  if (tempo) {
    const mean = on.env.reduce((s, v) => s + v, 0) / Math.max(1, on.env.length);
    for (let t = tempo.phase; t < Math.min(pcm.length / 2 / FS, startSec + 20); t += tempo.period) {
      if (t < startSec - 0.05) continue;
      const v = on.env[Math.round(t * on.rate)] || 0;
      if (v > mean * 0.8) { firstBeat = t; break; }
    }
  }
  return {
    startSec: round(startSec), endSec: round(end / FS),
    loudness: round(prof.integrated), rampIn: round(rampIn),
    tempo, firstBeat: firstBeat === null ? null : round(firstBeat),
  };
}

/**
 * Analyse the end of a track. `offsetSec` is the track time of pcm[0].
 * @param {{offsetSec:number, refLoudness:number}} opts
 */
export function analyzeTail(pcm, { offsetSec = 0, refLoudness } = {}) {
  const prof = loudnessProfile(pcm);
  const ref = refLoudness ?? prof.integrated;
  const c = prof.curve; const hop = prof.hop;
  const { end } = trimPoints(pcm, -50);
  const endSec = offsetSec + end / FS;
  let lastLoud = -1;
  for (let i = c.length - 1; i >= 0; i--) if (c[i] >= ref - 6) { lastLoud = i; break; }
  const lastLoudSec = offsetSec + Math.max(0, lastLoud) * hop;
  const decay = endSec - lastLoudSec;
  // fade = a long, steady decline; cold = the music stops (maybe with a short ring-out)
  let endType = 'cold';
  if (lastLoud >= 0 && decay > 3.5) {
    const xs = []; const ys = [];
    for (let i = lastLoud; i < Math.min(c.length, Math.round((endSec - offsetSec) / hop)); i++) { xs.push(i); ys.push(c[i]); }
    const r = corr(xs, ys);
    const drop = ys[0] - Math.min(...ys);
    if (r < -0.75 && drop > 10) endType = 'fade';
  }
  let mixOut = endSec;
  if (endType === 'fade') {
    for (let i = Math.max(0, lastLoud); i < c.length; i++) if (c[i] <= ref - 9) { mixOut = offsetSec + i * hop; break; }
  } else {
    // let the final hit and its ring-out breathe; segue once it has decayed 18 dB
    for (let i = Math.max(0, lastLoud); i < c.length; i++) if (c[i] <= ref - 18) { mixOut = offsetSec + i * hop; break; }
    mixOut = Math.min(mixOut, endSec);
  }
  const { mid } = midSide(pcm);
  const on = onsetEnvelope(mid);
  const tempo = estimateTempo(on.env, on.rate);
  return {
    endSec: round(endSec), endType, mixOut: round(mixOut), lastLoud: round(lastLoudSec),
    tempo: tempo ? { ...tempo, phase: round(offsetSec + tempo.phase) } : null,
  };
}

/** Compact waveform peaks (per `res` seconds): Int8 pairs of min/max of the mono mix. */
export function peaks(pcm, res = 0.05) {
  const frames = pcm.length >> 1; const step = Math.max(1, Math.round(FS * res));
  const n = Math.ceil(frames / step);
  const out = new Int8Array(n * 2);
  for (let p = 0; p < n; p++) {
    let lo = 0; let hi = 0;
    for (let i = p * step; i < Math.min(frames, (p + 1) * step); i++) {
      const v = (pcm[i * 2] + pcm[i * 2 + 1]) / 2;
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    out[p * 2] = Math.round((lo / 32768) * 127); out[p * 2 + 1] = Math.round((hi / 32768) * 127);
  }
  return out;
}

function corr(xs, ys) {
  const n = xs.length; if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n; const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx; const dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxy / Math.sqrt(sxx * syy + 1e-12);
}

const round = (x) => Math.round(x * 100) / 100;
