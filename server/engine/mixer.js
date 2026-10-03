// Pure DSP helpers for the playout engine. PCM is interleaved stereo Int16.

export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-9));

/**
 * Analyse a decoded item: trim points (leading/trailing silence) and loudness.
 * Loudness is a gated RMS over 400ms windows — a cheap stand-in for LUFS that is
 * good enough to level songs, voice and spots against each other.
 */
export function analyze(pcm, sampleRate = 44100, { silenceDb = -48 } = {}) {
  const frames = Math.floor(pcm.length / 2);
  const thr = dbToGain(silenceDb) * 32768;
  let start = 0;
  while (start < frames && Math.abs(pcm[start * 2]) < thr && Math.abs(pcm[start * 2 + 1]) < thr) start++;
  let end = frames;
  while (end > start && Math.abs(pcm[(end - 1) * 2]) < thr && Math.abs(pcm[(end - 1) * 2 + 1]) < thr) end--;

  const win = Math.floor(sampleRate * 0.4);
  const blocks = [];
  let peak = 0;
  for (let f = start; f < end; f += win) {
    let sum = 0;
    const stop = Math.min(end, f + win);
    for (let i = f; i < stop; i++) {
      const l = pcm[i * 2] / 32768;
      const r = pcm[i * 2 + 1] / 32768;
      sum += (l * l + r * r) / 2;
      const a = Math.max(Math.abs(l), Math.abs(r));
      if (a > peak) peak = a;
    }
    blocks.push(sum / Math.max(1, stop - f));
  }
  // absolute gate (-70dB) then relative gate (-10dB under the ungated mean), like BS.1770
  const abs = blocks.filter((p) => p > 1e-7);
  const mean1 = abs.reduce((a, b) => a + b, 0) / Math.max(1, abs.length);
  const rel = abs.filter((p) => p > mean1 * 0.1);
  const mean = rel.reduce((a, b) => a + b, 0) / Math.max(1, rel.length);
  const loudnessDb = mean > 0 ? 10 * Math.log10(mean) : -90;
  return { startFrame: start, endFrame: end, loudnessDb, peak };
}

/** Gain that brings an item to the target loudness, capped at +12/-12 dB. */
export function normalizeGain(loudnessDb, targetDb = -17) {
  if (loudnessDb <= -80) return 1;
  const db = Math.max(-12, Math.min(12, targetDb - loudnessDb));
  return dbToGain(db);
}

/** Equal-power fade-out curve value for progress p in [0,1]. */
export const fadeOutCurve = (p) => Math.cos(Math.min(1, Math.max(0, p)) * Math.PI / 2);
export const fadeInCurve = (p) => Math.sin(Math.min(1, Math.max(0, p)) * Math.PI / 2);

/**
 * Mix `frames` frames of a source into a Float32 interleaved buffer.
 * @param {Float32Array} out
 * @param {number} outOffset   frame offset into `out`
 * @param {object} src  { pcm, pos, endFrame, gain, fadeOut?: {at, frames}, fadeIn?: {at, frames} }
 * @param {number} frames
 * @param {number} busGain0 bus gain (ducking) at start of block
 * @param {number} busGain1 bus gain at end of block (linearly interpolated)
 * @returns {number} frames actually mixed
 */
export function mixSource(out, outOffset, src, frames, busGain0 = 1, busGain1 = 1) {
  const n = Math.max(0, Math.min(frames, src.endFrame - src.pos));
  const pcm = src.pcm;
  for (let i = 0; i < n; i++) {
    const f = src.pos + i;
    let g = src.gain * (busGain0 + (busGain1 - busGain0) * (i / frames));
    if (src.fadeOut && f >= src.fadeOut.at) g *= fadeOutCurve((f - src.fadeOut.at) / src.fadeOut.frames);
    if (src.fadeIn && f < src.fadeIn.at + src.fadeIn.frames) g *= fadeInCurve((f - src.fadeIn.at) / src.fadeIn.frames);
    const o = (outOffset + i) * 2;
    out[o] += (pcm[f * 2] / 32768) * g;
    out[o + 1] += (pcm[f * 2 + 1] / 32768) * g;
  }
  src.pos += n;
  return n;
}

/**
 * Simple look-ahead-free peak limiter with smooth gain recovery, then convert to Int16.
 * `state.gain` persists between calls.
 */
export function limitToInt16(buf, state, ceiling = 0.97, releasePerSample = 0.00005) {
  const out = new Int16Array(buf.length);
  let g = state.gain ?? 1;
  for (let i = 0; i < buf.length; i += 2) {
    const peak = Math.max(Math.abs(buf[i]), Math.abs(buf[i + 1]));
    if (peak * g > ceiling) g = ceiling / peak;
    else g = Math.min(1, g + releasePerSample);
    out[i] = Math.max(-32768, Math.min(32767, Math.round(buf[i] * g * 32767)));
    out[i + 1] = Math.max(-32768, Math.min(32767, Math.round(buf[i + 1] * g * 32767)));
  }
  state.gain = g;
  return out;
}

/** Move a value toward a target at a fixed rate per second. */
export function approach(current, target, ratePerSec, dtSec) {
  const step = ratePerSec * dtSec;
  if (current < target) return Math.min(target, current + step);
  return Math.max(target, current - step);
}

/**
 * Seconds before the end of `cur` at which `next` should start.
 * @param {string} cur  kind of the outgoing item: music | voice | imaging | spot
 * @param {string} next kind of the incoming item
 * @param {object} o    { crossfadeSec, talkOverSec, curDurSec, nextDurSec }
 */
export function overlapSec(cur, next, o) {
  const { crossfadeSec = 3, talkOverSec = 6, curDurSec = 0, nextDurSec = 0 } = o;
  let s = 0;
  if (cur === 'music') {
    if (next === 'music') s = crossfadeSec;
    else if (next === 'imaging') s = Math.min(1.5, crossfadeSec);
    else if (next === 'voice') s = Math.min(2, crossfadeSec);
    else s = 0.3;
  } else if (cur === 'voice') {
    // the next song's intro runs under the end of the DJ's talk
    s = next === 'music' ? Math.max(0, Math.min(talkOverSec, curDurSec - 1.5)) : 0.3;
  } else if (cur === 'imaging') {
    s = next === 'music' ? Math.min(1.2, curDurSec * 0.25) : 0.15;
  } else if (cur === 'spot') {
    s = 0.1;
  }
  return Math.max(0, Math.min(s, curDurSec * 0.9, nextDurSec > 0 ? nextDurSec * 0.9 : s));
}
