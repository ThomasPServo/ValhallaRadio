// Pure production DSP: voice chains, synthesized sound design and element templates.
// No I/O except writing the rendered WAV, so it can run in the analysis worker thread and never
// stall the real-time audio loop.

import fs from 'node:fs';
import { Biquad, Reverb } from './dsp.js';

const SR = 44100;

// ------------------------------------------------------------------ buffers

/** Stereo float buffer helpers: { l: Float32Array, r: Float32Array } */
const make = (sec) => { const n = Math.max(1, Math.round(sec * SR)); return { l: new Float32Array(n), r: new Float32Array(n) }; };
const lenSec = (b) => b.l.length / SR;

function fromInt16(pcm) {
  const n = pcm.length / 2; const b = { l: new Float32Array(n), r: new Float32Array(n) };
  for (let i = 0; i < n; i++) { b.l[i] = pcm[i * 2] / 32768; b.r[i] = pcm[i * 2 + 1] / 32768; }
  return b;
}

/** Add `src` into `dst` at time `at` (sec) with gain and optional pan (-1..1). */
function mixAt(dst, src, at, gain = 1, pan = 0) {
  const o = Math.round(at * SR);
  const gl = gain * Math.min(1, 1 - pan); const gr = gain * Math.min(1, 1 + pan);
  for (let i = 0; i < src.l.length; i++) {
    const j = o + i;
    if (j < 0) continue;
    if (j >= dst.l.length) break;
    dst.l[j] += src.l[i] * gl; dst.r[j] += src.r[i] * gr;
  }
}

/** Trim leading/trailing silence (TTS engines pad their output) so markers are exact. */
function trimSilence(b, thresholdDb = -46) {
  const thr = Math.pow(10, thresholdDb / 20); const n = b.l.length;
  let s = 0; while (s < n && Math.abs(b.l[s]) < thr && Math.abs(b.r[s]) < thr) s++;
  let e = n; while (e > s && Math.abs(b.l[e - 1]) < thr && Math.abs(b.r[e - 1]) < thr) e--;
  s = Math.max(0, s - Math.round(0.02 * SR)); e = Math.min(n, e + Math.round(0.08 * SR));
  return e - s < SR * 0.1 ? b : { l: b.l.slice(s, e), r: b.r.slice(s, e) };
}

function peakOf(b) { let p = 0; for (let i = 0; i < b.l.length; i++) p = Math.max(p, Math.abs(b.l[i]), Math.abs(b.r[i])); return p; }
function scale(b, g) { for (let i = 0; i < b.l.length; i++) { b.l[i] *= g; b.r[i] *= g; } return b; }
function normalizePeak(b, db = -1) { const p = peakOf(b); return p > 0 ? scale(b, Math.pow(10, db / 20) / p) : b; }

function filter(b, makeFilters) {
  const fl = makeFilters(); const fr = makeFilters();
  for (let i = 0; i < b.l.length; i++) {
    let l = b.l[i]; let r = b.r[i];
    for (const f of fl) l = f.process(l);
    for (const f of fr) r = f.process(r);
    b.l[i] = l; b.r[i] = r;
  }
  return b;
}

/** Feed-forward compressor (stereo-linked) used for voice and imaging. */
function compress(b, { thresholdDb = -20, ratio = 3, attack = 0.005, release = 0.12, makeupDb = 0, knee = 6 } = {}) {
  const ca = Math.exp(-1 / (attack * SR)); const cr = Math.exp(-1 / (release * SR));
  let env = 0; const mk = Math.pow(10, makeupDb / 20);
  for (let i = 0; i < b.l.length; i++) {
    const x = Math.max(Math.abs(b.l[i]), Math.abs(b.r[i]));
    env = x > env ? x + (env - x) * ca : x + (env - x) * cr;
    const lvl = 20 * Math.log10(env + 1e-9);
    const over = lvl - thresholdDb;
    let gr = 0;
    if (over >= knee / 2) gr = over * (1 - 1 / ratio);
    else if (over > -knee / 2) gr = ((1 - 1 / ratio) * (over + knee / 2) ** 2) / (2 * knee);
    const g = Math.pow(10, -gr / 20) * mk;
    b.l[i] *= g; b.r[i] *= g;
  }
  return b;
}

/** Split-band de-esser: compresses only the 5-10 kHz band when it gets spitty. */
function deEss(b, { thresholdDb = -28, ratio = 4 } = {}) {
  const mk = () => [new Biquad().highpass(SR, 5200, 0.7), new Biquad().lowpass(SR, 10000, 0.7)];
  const bl = mk(); const br = mk();
  let env = 0; const ca = Math.exp(-1 / (0.002 * SR)); const cr = Math.exp(-1 / (0.06 * SR));
  for (let i = 0; i < b.l.length; i++) {
    const sl = bl[1].process(bl[0].process(b.l[i])); const sr = br[1].process(br[0].process(b.r[i]));
    const x = Math.max(Math.abs(sl), Math.abs(sr));
    env = x > env ? x + (env - x) * ca : x + (env - x) * cr;
    const over = 20 * Math.log10(env + 1e-9) - thresholdDb;
    if (over > 0) {
      const g = Math.pow(10, (-over * (1 - 1 / ratio)) / 20);
      b.l[i] += sl * (g - 1); b.r[i] += sr * (g - 1);
    }
  }
  return b;
}

function reverb(b, { wet = 0.25, room = 0.84, damp = 0.4, tail = 1.8 } = {}) {
  const out = make(lenSec(b) + tail);
  const rv = new Reverb(SR, { room, damp, wet: 1, width: 1 });
  for (let i = 0; i < out.l.length; i++) {
    const l = i < b.l.length ? b.l[i] : 0; const r = i < b.r.length ? b.r[i] : 0;
    const [wl, wr] = rv.process(l, r);
    out.l[i] = l + wl * wet; out.r[i] = r + wr * wet;
  }
  return out;
}

/** Ping-pong echo applied only to audio after `fromSec` (the classic imaging "throw"). */
function echoThrow(b, fromSec, { delay = 0.3, feedback = 0.48, wet = 0.45, tail = 2.2 } = {}) {
  const out = make(lenSec(b) + tail);
  const d = Math.round(delay * SR); const from = Math.round(fromSec * SR);
  const bufL = new Float32Array(d); const bufR = new Float32Array(d); let p = 0;
  const lpL = new Biquad().lowpass(SR, 3200, 0.7); const lpR = new Biquad().lowpass(SR, 3200, 0.7);
  const hpL = new Biquad().highpass(SR, 350, 0.7); const hpR = new Biquad().highpass(SR, 350, 0.7);
  for (let i = 0; i < out.l.length; i++) {
    const l = i < b.l.length ? b.l[i] : 0; const r = i < b.r.length ? b.r[i] : 0;
    const send = i >= from ? (l + r) * 0.5 : 0;
    const dl = bufL[p]; const dr = bufR[p];
    bufL[p] = hpL.process(lpL.process(send + dr * feedback)); // cross-feed = ping-pong
    bufR[p] = hpR.process(lpR.process(dl * feedback));
    p = (p + 1) % d;
    out.l[i] = l + dl * wet; out.r[i] = r + dr * wet;
  }
  return out;
}

// ------------------------------------------------------------------ sound design

let seed = 1;
const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };

/** Filtered-noise whoosh sweeping up through the spectrum and across the stereo field. */
export function whoosh(dur = 1, { peakAt = 0.65, gain = 0.5, reverse = false } = {}) {
  const b = make(dur);
  const bp = new Biquad(); const n = b.l.length;
  let pinkB0 = 0; let pinkB1 = 0; let pinkB2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n; const tt = reverse ? 1 - t : t;
    if (i % 32 === 0) bp.bandpass(SR, 300 * Math.pow(30, tt), 1.4);
    const w = noise();
    pinkB0 = 0.997 * pinkB0 + w * 0.029591; pinkB1 = 0.985 * pinkB1 + w * 0.032534; pinkB2 = 0.95 * pinkB2 + w * 0.048056;
    const pink = pinkB0 + pinkB1 + pinkB2 + w * 0.05;
    const env = t < peakAt ? Math.pow(t / peakAt, 2.2) : Math.pow(1 - (t - peakAt) / (1 - peakAt), 1.6);
    const y = bp.process(pink) * env * gain * 6;
    const pan = -0.8 + 1.6 * t;
    b.l[i] = y * Math.min(1, 1 - pan); b.r[i] = y * Math.min(1, 1 + pan);
  }
  return reverb(b, { wet: 0.18, tail: 0.6 });
}

/** Rising tension: noise sweep plus a gliding saw-ish tone, ends on the hit. */
export function riser(dur = 1.6, { gain = 0.35 } = {}) {
  const b = make(dur);
  const hp = new Biquad(); let ph = 0; let ph2 = 0;
  for (let i = 0; i < b.l.length; i++) {
    const t = i / b.l.length;
    if (i % 32 === 0) hp.highpass(SR, 200 * Math.pow(25, t), 0.8);
    const f = 180 * Math.pow(6, t);
    ph += (2 * Math.PI * f) / SR; ph2 += (2 * Math.PI * f * 1.007) / SR;
    const tone = (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.33 * Math.sin(3 * ph2)) * 0.25;
    const y = (hp.process(noise()) * 0.8 + tone * 0.6) * Math.pow(t, 2.5) * gain;
    b.l[i] = y * (1 - 0.3 * Math.sin(ph * 0.002)); b.r[i] = y * (1 + 0.3 * Math.sin(ph * 0.002));
  }
  return b;
}

/** Cinematic impact: sub drop + transient crack + boom, with a big tail. */
export function impact({ gain = 0.9 } = {}) {
  const b = make(1.6);
  const lp = new Biquad().lowpass(SR, 2800, 0.7); const boom = new Biquad().lowpass(SR, 180, 0.9);
  let ph = 0;
  for (let i = 0; i < b.l.length; i++) {
    const t = i / SR;
    const f = 38 + 60 * Math.exp(-t / 0.18);
    ph += (2 * Math.PI * f) / SR;
    const sub = Math.sin(ph) * Math.exp(-t / 0.45) * 0.9;
    const crack = t < 0.012 ? lp.process(noise()) * (1 - t / 0.012) * 1.4 : 0;
    const bm = boom.process(noise()) * Math.exp(-t / 0.25) * 2.2;
    const y = (sub + crack + bm) * gain;
    b.l[i] = y; b.r[i] = y;
  }
  return reverb(b, { wet: 0.35, room: 0.88, tail: 1.6 });
}

/** FM bell chord used for news/info sounders. */
export function sting(notes = [523.25, 659.25, 783.99, 1174.66], { spacing = 0.09, dur = 1.6, gain = 0.32 } = {}) {
  const b = make(dur + spacing * notes.length);
  notes.forEach((f, k) => {
    const o = Math.round(k * spacing * SR);
    for (let i = 0; i < Math.round(dur * SR); i++) {
      const t = i / SR;
      const idx = 2.2 * Math.exp(-t / 0.25);
      const y = Math.sin(2 * Math.PI * f * t + idx * Math.sin(2 * Math.PI * f * 2 * t)) * Math.exp(-t / 0.55) * gain;
      const pan = (k / (notes.length - 1 || 1)) * 1.2 - 0.6;
      const j = o + i;
      if (j < b.l.length) { b.l[j] += y * (1 - Math.max(0, pan)); b.r[j] += y * (1 + Math.min(0, pan)); }
    }
  });
  return reverb(b, { wet: 0.3, tail: 1.2 });
}

/** Low-key ticking news bed: soft pulse, ticking hats and a sustained pad. Loops to `dur`. */
export function bed(dur, { bpm = 100, gain = 0.22 } = {}) {
  const b = make(dur);
  const beat = 60 / bpm;
  const hp = new Biquad().highpass(SR, 7000, 0.7); const padLp = new Biquad().lowpass(SR, 1100, 0.7); const padLpR = new Biquad().lowpass(SR, 1100, 0.7);
  const chord = [110, 164.81, 220, 277.18]; // A minor-ish open voicing
  const phases = chord.map(() => 0);
  for (let i = 0; i < b.l.length; i++) {
    const t = i / SR;
    const inBeat = t % beat; const inEighth = t % (beat / 2);
    const kickF = 52 + 40 * Math.exp(-inBeat / 0.03);
    const kick = Math.sin(2 * Math.PI * kickF * inBeat) * Math.exp(-inBeat / 0.12) * 0.38;
    const tick = hp.process(noise()) * Math.exp(-inEighth / 0.012) * 0.22;
    let pad = 0;
    for (let k = 0; k < chord.length; k++) {
      phases[k] += (2 * Math.PI * chord[k] * (1 + 0.002 * Math.sin(t * 0.7 + k))) / SR;
      const p = phases[k] % (2 * Math.PI);
      pad += (p / Math.PI - 1) * 0.12; // saw
    }
    const swell = 0.6 + 0.4 * Math.sin((2 * Math.PI * t) / (beat * 16));
    const pl = padLp.process(pad) * swell; const pr = padLpR.process(pad) * swell;
    b.l[i] = (kick + tick * 0.8 + pl) * gain; b.r[i] = (kick + tick + pr) * gain;
  }
  // fade the ends so it can start/stop anywhere
  const f = Math.min(b.l.length / 2, Math.round(SR * 0.6));
  for (let i = 0; i < f; i++) { const g = i / f; b.l[i] *= g; b.r[i] *= g; b.l[b.l.length - 1 - i] *= g; b.r[b.r.length - 1 - i] *= g; }
  return b;
}

// ------------------------------------------------------------------ voice chains

export function voiceChain(b, style = 'dj') {
  const p = {
    dj: { hp: 80, mud: -2.5, pres: 2.5, air: 2, thr: -22, ratio: 3, rel: 0.12 },
    imaging: { hp: 110, mud: -3, pres: 4.5, air: 3.5, thr: -24, ratio: 5, rel: 0.08 },
    news: { hp: 90, mud: -2, pres: 3, air: 1.5, thr: -22, ratio: 3.5, rel: 0.1 },
    spot: { hp: 70, mud: -1, pres: 1.5, air: 1.5, thr: -20, ratio: 2.5, rel: 0.15 },
  }[style] || {};
  filter(b, () => [
    new Biquad().highpass(SR, p.hp, 0.7),
    new Biquad().peaking(SR, 320, 1, p.mud),
    new Biquad().peaking(SR, 3400, 0.9, p.pres),
    new Biquad().highshelf(SR, 10500, p.air, 0.8),
  ]);
  normalizePeak(b, -6);
  compress(b, { thresholdDb: p.thr, ratio: p.ratio, attack: 0.004, release: p.rel, makeupDb: 4 });
  deEss(b);
  return normalizePeak(b, -1);
}

// ------------------------------------------------------------------ WAV output

export function writeWav(file, b) {
  const n = b.l.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(b.l[i] * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(b.r[i] * 32767))), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

// ------------------------------------------------------------------ templates

/** Imaging FX styles. `true` picks the classic default for the element type, `false` is dry. */
export const FX_STYLES = ['punch', 'riser', 'smooth', 'stutter', 'music', 'dry'];
const DEFAULT_FX = { toh_id: 'riser', id: 'punch', sweeper: 'punch', promo: 'punch', liner: 'smooth' };

/** Read a 16-bit stereo WAV written by writeWav (used for the music-bed imaging style). */
export function readWav(file) {
  const buf = fs.readFileSync(file);
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4); const size = buf.readUInt32LE(p + 4);
    if (id === 'data') {
      const n = Math.floor(Math.min(size, buf.length - p - 8) / 4);
      const b = { l: new Float32Array(n), r: new Float32Array(n) };
      for (let i = 0; i < n; i++) { b.l[i] = buf.readInt16LE(p + 8 + i * 4) / 32768; b.r[i] = buf.readInt16LE(p + 10 + i * 4) / 32768; }
      return b;
    }
    p += 8 + size + (size & 1);
  }
  throw new Error('no audio data in WAV');
}

/** End of the first syllable (sec), for stutter edits: the first energy dip after the onset. */
export function firstSyllable(b) {
  const hop = Math.round(0.01 * SR); const frames = Math.min(40, Math.floor(b.l.length / hop));
  const e = [];
  for (let k = 0; k < frames; k++) {
    let s = 0;
    for (let i = k * hop; i < (k + 1) * hop; i++) s += b.l[i] * b.l[i] + b.r[i] * b.r[i];
    e.push(Math.sqrt(s / (2 * hop)));
  }
  let peak = 0; let k = 0;
  for (; k < Math.min(e.length, 18); k++) peak = Math.max(peak, e[k]);
  let best = 8; let min = Infinity;
  for (let j = 8; j < Math.min(e.length, 26); j++) if (e[j] < min) { min = e[j]; best = j; }
  for (let j = 8; j < Math.min(e.length, 26); j++) if (e[j] < peak * 0.45 && e[j] <= min * 1.15) { best = j; break; }
  return Math.max(0.08, Math.min(0.26, best * 0.01));
}

function slice(b, from, to, fadeMs = 4) {
  const s = Math.round(from * SR); const e = Math.min(b.l.length, Math.round(to * SR));
  const out = { l: b.l.slice(s, e), r: b.r.slice(s, e) };
  const f = Math.min(Math.round((fadeMs / 1000) * SR), Math.floor(out.l.length / 2));
  for (let i = 0; i < f; i++) { const g = i / f; out.l[i] *= g; out.r[i] *= g; out.l[out.l.length - 1 - i] *= g; out.r[out.r.length - 1 - i] *= g; }
  return out;
}

function produceImaging(voice, type, fx, { bedFile = null } = {}) {
  let style = fx === false ? 'dry' : typeof fx === 'string' && FX_STYLES.includes(fx) ? fx : DEFAULT_FX[type] || 'punch';
  if (style === 'music' && !bedFile) style = 'punch';
  const v = voiceChain(voice, 'imaging');
  const vlen = lenSec(v);
  const done = (out, m) => ({ buffer: normalizePeak(out, -1), markers: m, style });

  if (style === 'dry') {
    const out = reverb(v, { wet: 0.05, tail: 0.4 });
    return done(out, { voiceStart: 0, voiceEnd: vlen, post: vlen, tailStart: vlen + 0.1 });
  }
  if (style === 'riser') { // big build into a hit: legal IDs, big statements
    const rise = riser(1.7);
    const vs = 1.75;
    const thrown = echoThrow(reverb(v, { wet: 0.16, tail: 0.4 }), Math.max(0, vlen - 0.7));
    const out = make(vs + lenSec(thrown) + 0.2);
    mixAt(out, rise, 0, 0.8);
    mixAt(out, impact(), 1.68, 0.85);
    mixAt(out, thrown, vs, 1);
    return done(out, { voiceStart: vs, voiceEnd: vs + vlen, post: vs + vlen, tailStart: vs + vlen + 0.35 });
  }
  if (style === 'smooth') { // soft swell, lush reverb, a light chime: AC, liners
    const swell = whoosh(1.1, { gain: 0.2, reverse: true, peakAt: 0.85 });
    const vs = 0.75;
    const wet = reverb(v, { wet: 0.2, room: 0.88, tail: 1.6 });
    const out = make(vs + lenSec(wet) + 0.2);
    mixAt(out, swell, 0, 0.55);
    mixAt(out, wet, vs, 1);
    mixAt(out, sting([783.99, 1046.5, 1318.51], { spacing: 0.07, dur: 1.3, gain: 0.14 }), vs + vlen - 0.08, 0.5);
    return done(out, { voiceStart: vs, voiceEnd: vs + vlen, post: vs + vlen, tailStart: vs + vlen + 0.3 });
  }
  if (style === 'stutter') { // "M- M- Mix one oh one nine": the first syllable hits twice before the line
    const syl = firstSyllable(v);
    const hit = slice(v, 0, syl);
    const tel = filter({ l: hit.l.slice(), r: hit.r.slice() }, () => [new Biquad().highpass(SR, 420, 0.7), new Biquad().lowpass(SR, 3200, 0.7)]);
    const step = Math.max(0.12, syl + 0.035);
    const vs = 0.45;
    const thrown = echoThrow(reverb(v, { wet: 0.12, tail: 0.3 }), Math.max(0, vlen - 0.6));
    const full = vs + 2 * step;
    const out = make(full + lenSec(thrown) + 0.3);
    mixAt(out, whoosh(0.6, { gain: 0.4 }), 0, 0.6);
    mixAt(out, tel, vs, 1.1);
    mixAt(out, hit, vs + step, 1);
    mixAt(out, thrown, full, 1);
    const post = full + vlen - 0.05;
    mixAt(out, impact({ gain: 0.7 }), post, 0.7);
    return done(out, { voiceStart: vs, voiceEnd: full + vlen, post, tailStart: full + vlen + 0.35 });
  }
  if (style === 'music') { // voiced over a few bars of the station's music bed, ending on a button
    const bed = readWav(bedFile);
    const vs = 0.7;
    const total = vs + vlen + 1.3;
    const n = Math.round(total * SR); const L = bed.l.length;
    const music = make(total);
    const a = Math.round(vs * SR); const z = Math.round((vs + vlen) * SR);
    const end = Math.round((vs + vlen + 0.45) * SR);
    for (let i = 0; i < n; i++) {
      // full level for the intro, ducked under the voice, back up for a beat, then out
      let g = i < a - 2200 ? 1 : i < a ? 1 - 0.6 * ((i - (a - 2200)) / 2200) : i < z ? 0.4 : i < z + 3500 ? 0.4 + 0.6 * ((i - z) / 3500) : 1;
      if (i < 1300) g *= i / 1300;
      if (i > end) g *= Math.max(0, 1 - (i - end) / (SR * 0.5));
      music.l[i] = bed.l[i % L] * g * 0.6; music.r[i] = bed.r[i % L] * g * 0.6;
    }
    const thrown = echoThrow(reverb(v, { wet: 0.12, tail: 0.3 }), Math.max(0, vlen - 0.6));
    const out = make(total + 0.6);
    mixAt(out, music, 0, 1);
    mixAt(out, thrown, vs, 1);
    mixAt(out, impact({ gain: 0.55 }), vs + vlen + 0.42, 0.6);
    return done(out, { voiceStart: vs, voiceEnd: vs + vlen, post: vs + vlen + 0.42, tailStart: vs + vlen + 0.9 });
  }
  // punch: whoosh in, voice, impact on the last word with an echo throw
  const w = whoosh(1.0, { gain: 0.5 });
  const vs = 0.5;
  const thrown = echoThrow(reverb(v, { wet: 0.14, tail: 0.3 }), Math.max(0, vlen - 0.6));
  const post = vs + vlen - 0.05;
  const out = make(vs + lenSec(thrown) + 0.3);
  mixAt(out, w, 0, 0.75);
  mixAt(out, thrown, vs, 1);
  mixAt(out, impact({ gain: 0.7 }), post, 0.7);
  return done(out, { voiceStart: vs, voiceEnd: vs + vlen, post, tailStart: vs + vlen + 0.35 });
}

function produceInfo(voice, kind, useBed) {
  const v = voiceChain(voice, 'news');
  const vlen = lenSec(v);
  const s = kind === 'news' ? sting() : sting([659.25, 987.77], { spacing: 0.12, dur: 1.1, gain: 0.28 });
  const vs = kind === 'news' ? 1.45 : 0.9;
  const total = vs + vlen + (useBed ? 1.8 : 0.4);
  const out = make(total);
  mixAt(out, whoosh(0.7, { gain: 0.3 }), 0, 0.5);
  mixAt(out, s, 0.05, 1);
  if (useBed) {
    const bd = bed(total - 0.2, { bpm: kind === 'traffic' ? 112 : 100 });
    mixAt(out, bd, 0.2, kind === 'news' ? 0.75 : 0.6);
  }
  mixAt(out, v, vs, 1);
  return { buffer: normalizePeak(out, -1), markers: { voiceStart: vs, voiceEnd: vs + vlen, post: vs + vlen, tailStart: vs + vlen + 0.3, bed: Boolean(useBed) } };
}

/**
 * Render a template to a WAV file. `pcm` is the raw voice (interleaved Int16 @ 44.1 kHz).
 * @returns {{voiceStart:number, voiceEnd:number, post:number, tailStart:number}}
 */
export function renderTemplate({ template, pcm, type, fx = true, bed: useBed = true, bedFile = null, out }) {
  const voice = trimSilence(fromInt16(pcm));
  let r;
  if (template === 'imaging') r = produceImaging(voice, type, fx, { bedFile });
  else if (template === 'info') r = produceInfo(voice, type, useBed);
  else { const b = voiceChain(voice, template === 'spot' ? 'spot' : 'dj'); r = { buffer: b, markers: { voiceStart: 0, voiceEnd: lenSec(b), post: lenSec(b), tailStart: lenSec(b) } }; }
  writeWav(out, r.buffer);
  return r.markers;
}

/** Render a preview of the imaging FX bed alone (no voice) — used by tests and the UI demo. */
export function demoFx(file) {
  const out = make(4);
  mixAt(out, riser(1.5), 0, 0.8);
  mixAt(out, impact(), 1.45, 0.9);
  mixAt(out, whoosh(1), 2.2, 0.7);
  writeWav(file, normalizePeak(out, -1));
  return file;
}
