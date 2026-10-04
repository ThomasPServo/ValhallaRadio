// Music beds, synthesized: short instrumental loops that sit under DJ talk when there's no song
// intro to talk over. Pure DSP (runs in the worker thread), no samples, no keys.
//
// Each style is a 16-bar arrangement (drums, bass, keys, pad, arp) written as note events. The
// loop is rendered three times back to back so reverb tails and envelopes from the previous pass
// are already ringing at the top of the middle pass; the middle pass is cut out with a short
// equal-power crossfade into the start of the third pass, so it loops seamlessly. The mix keeps a
// gentle dip in the voice range (2-3 kHz) so the DJ always sits on top.

import { Biquad, Reverb } from './dsp.js';

const SR = 44100;
const TAU = Math.PI * 2;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const bus = (n) => ({ l: new Float32Array(n), r: new Float32Array(n) });

function polyBlepSaw(phase, dt) {
  let y = 2 * phase - 1;
  if (phase < dt) { const x = phase / dt; y -= x + x - x * x - 1; } else if (phase > 1 - dt) { const x = (phase - 1) / dt; y -= x * x + x + x + 1; }
  return y;
}

// ------------------------------------------------------------------ instruments
// Each writes one note into a bus at sample offset `o`.

function epiano(b, o, dur, midi, vel, { pan = 0, bright = 1 } = {}) {
  const f = mtof(midi); const rel = 0.32;
  const decay = 1.5 * Math.pow(2, -(midi - 60) / 24);
  const n = Math.round((dur + rel) * SR);
  const gl = vel * 0.2 * (1 - Math.max(0, pan)); const gr = vel * 0.2 * (1 + Math.min(0, pan));
  for (let i = 0; i < n; i++) {
    const j = o + i; if (j < 0) continue; if (j >= b.l.length) break;
    const t = i / SR;
    const env = (t < 0.004 ? t / 0.004 : 1) * Math.exp(-t / decay) * (t > dur ? Math.max(0, 1 - (t - dur) / rel) : 1);
    const idx = 0.22 + 1.5 * bright * Math.exp(-t / 0.22);
    const ph = TAU * f * t;
    const y = (Math.sin(ph + idx * Math.sin(ph)) + 0.1 * Math.sin(2 * ph) * Math.exp(-t / 0.5) + 0.04 * Math.sin(14 * ph) * Math.exp(-t / 0.025)) * env;
    b.l[j] += y * gl; b.r[j] += y * gr;
  }
}

function pad(b, o, dur, midi, vel, { cutoff = 1500, pan = 0 } = {}) {
  const f = mtof(midi); const att = 0.45; const rel = 1.0;
  const n = Math.round((dur + rel) * SR);
  const det = [-7, 0, 6.5].map((c) => f * Math.pow(2, c / 1200));
  const ph = [0.11, 0.53, 0.87];
  const lpL = new Biquad().lowpass(SR, cutoff, 0.6); const lpR = new Biquad().lowpass(SR, cutoff * 0.93, 0.6);
  const g = vel * 0.075;
  for (let i = 0; i < n; i++) {
    const j = o + i; if (j < 0) continue; if (j >= b.l.length) break;
    const t = i / SR;
    const env = Math.min(1, t / att) * (t > dur ? Math.max(0, 1 - (t - dur) / rel) : 1);
    let l = 0; let r = 0;
    for (let k = 0; k < 3; k++) {
      const dt = det[k] / SR;
      ph[k] += dt; if (ph[k] >= 1) ph[k] -= 1;
      const s = polyBlepSaw(ph[k], dt);
      l += s * (k === 2 ? 0.6 : 1); r += s * (k === 0 ? 0.6 : 1);
    }
    b.l[j] += lpL.process(l) * env * g * (1 - Math.max(0, pan));
    b.r[j] += lpR.process(r) * env * g * (1 + Math.min(0, pan));
  }
}

function bass(b, o, dur, midi, vel, { decay = 0.9, grit = 0.2 } = {}) {
  const f = mtof(midi); const rel = 0.05;
  const n = Math.round((dur + rel) * SR);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const j = o + i; if (j < 0) continue; if (j >= b.l.length) break;
    const t = i / SR;
    ph += (TAU * f) / SR;
    const env = (t < 0.004 ? t / 0.004 : 1) * (0.55 + 0.45 * Math.exp(-t / decay)) * (t > dur ? Math.max(0, 1 - (t - dur) / rel) : 1);
    const y = Math.tanh((Math.sin(ph) + 0.28 * Math.sin(2 * ph) + grit * Math.sin(3 * ph)) * 1.3) * env * vel * 0.42;
    b.l[j] += y; b.r[j] += y;
  }
}

function pluck(b, o, midi, vel, { pan = 0 } = {}) {
  const f = mtof(midi); const n = Math.round(0.5 * SR);
  const gl = vel * 0.13 * (1 - Math.max(0, pan)); const gr = vel * 0.13 * (1 + Math.min(0, pan));
  for (let i = 0; i < n; i++) {
    const j = o + i; if (j < 0) continue; if (j >= b.l.length) break;
    const t = i / SR; const ph = TAU * f * t;
    const y = Math.sin(ph + 0.9 * Math.sin(2 * ph) * Math.exp(-t / 0.05)) * Math.exp(-t / 0.18) * (t < 0.002 ? t / 0.002 : 1);
    b.l[j] += y * gl; b.r[j] += y * gr;
  }
}

function chug(b, o, dur, midi, vel) {
  // palm-muted power chord: root + fifth + octave saws through a low-pass
  const notes = [midi, midi + 7, midi + 12].map(mtof);
  const n = Math.round((dur + 0.04) * SR);
  const lp = new Biquad().lowpass(SR, 900, 0.8);
  const ph = [0, 0.3, 0.6];
  for (let i = 0; i < n; i++) {
    const j = o + i; if (j < 0) continue; if (j >= b.l.length) break;
    const t = i / SR;
    let s = 0;
    for (let k = 0; k < 3; k++) { const dt = notes[k] / SR; ph[k] += dt; if (ph[k] >= 1) ph[k] -= 1; s += polyBlepSaw(ph[k], dt); }
    const env = Math.exp(-t / 0.11) * (t > dur ? Math.max(0, 1 - (t - dur) / 0.04) : 1);
    const y = Math.tanh(lp.process(s) * 1.5) * env * vel * 0.1;
    b.l[j] += y * 0.8; b.r[j] += y;
  }
}

function kick(b, o, vel) {
  const n = Math.round(0.45 * SR); let ph = 0;
  for (let i = 0; i < n; i++) {
    const j = o + i; if (j < 0) continue; if (j >= b.l.length) break;
    const t = i / SR;
    ph += (TAU * (46 + 80 * Math.exp(-t / 0.032))) / SR;
    const y = (Math.sin(ph) * Math.exp(-t / 0.17) * (t < 0.001 ? t / 0.001 : 1)) * vel * 0.85;
    b.l[j] += y; b.r[j] += y;
  }
}

function noiseHit(b, o, vel, { seed, len, decay, hp, bp, bpQ = 0.8, pan = 0, attack = 0, bursts = null, tone = null }) {
  const rnd = rng(seed);
  const n = Math.round(len * SR);
  const f1 = hp ? new Biquad().highpass(SR, hp, 0.7) : null;
  const f2 = bp ? new Biquad().bandpass(SR, bp, bpQ) : null;
  const gl = vel * (1 - Math.max(0, pan)); const gr = vel * (1 + Math.min(0, pan));
  for (let i = 0; i < n; i++) {
    const j = o + i; if (j < 0) continue; if (j >= b.l.length) break;
    const t = i / SR;
    let env = Math.exp(-t / decay) * (attack ? Math.min(1, t / attack) : 1);
    if (bursts) { // clap: a few quick re-triggers before the tail
      const k = bursts.findLastIndex((x) => x <= t);
      env = k < bursts.length - 1 ? Math.exp(-(t - bursts[k]) / 0.006) : Math.exp(-(t - bursts[k]) / decay);
    }
    let x = rnd() * 2 - 1;
    if (f1) x = f1.process(x);
    if (f2) x = f2.process(x);
    let y = x * env;
    if (tone) y += Math.sin(TAU * tone.f * t) * Math.exp(-t / tone.decay) * tone.gain;
    b.l[j] += y * gl; b.r[j] += y * gr;
  }
}

const DRUMS = {
  kick: (b, o, v) => kick(b, o, v),
  clap: (b, o, v, s) => noiseHit(b, o, v * 0.55, { seed: s, len: 0.35, decay: 0.09, bp: 1150, bpQ: 0.9, bursts: [0, 0.011, 0.022, 0.033], pan: -0.05 }),
  snare: (b, o, v, s) => noiseHit(b, o, v * 0.5, { seed: s, len: 0.4, decay: 0.12, bp: 2400, bpQ: 0.6, tone: { f: 185, decay: 0.05, gain: 0.9 } }),
  rim: (b, o, v, s) => noiseHit(b, o, v * 0.45, { seed: s, len: 0.12, decay: 0.014, bp: 1700, bpQ: 1.5, tone: { f: 830, decay: 0.018, gain: 0.5 }, pan: 0.1 }),
  hat: (b, o, v, s) => noiseHit(b, o, v * 0.2, { seed: s, len: 0.12, decay: 0.028, hp: 7800, pan: 0.25 }),
  ohat: (b, o, v, s) => noiseHit(b, o, v * 0.17, { seed: s, len: 0.6, decay: 0.2, hp: 7000, pan: 0.25 }),
  crash: (b, o, v, s) => noiseHit(b, o, v * 0.14, { seed: s, len: 2.2, decay: 0.8, hp: 5200, pan: -0.3 }),
  shaker: (b, o, v, s) => noiseHit(b, o, v * 0.16, { seed: s, len: 0.14, decay: 0.05, attack: 0.012, bp: 6200, bpQ: 1.2, pan: -0.2 }),
};

// ------------------------------------------------------------------ arrangements
// Events are in beats from the top of the loop: { at, inst, midi, dur, vel, pan }

const STYLES = {
  pulse: {
    name: 'Pulse', description: 'Modern pop pulse: four-on-the-floor, sidechained pads and a sub bass (CHR, Hot AC, dance).',
    bpm: 112, sidechain: 0.5,
    chords: [{ root: 45, notes: [57, 60, 64] }, { root: 41, notes: [57, 60, 65] }, { root: 48, notes: [55, 60, 64] }, { root: 43, notes: [55, 59, 62] }],
    bar(ev, b, c, lift) {
      for (let q = 0; q < 4; q++) ev.push({ at: q, inst: 'kick', vel: q % 2 ? 0.82 : 0.95 });
      ev.push({ at: 1, inst: 'clap', vel: 0.6 }, { at: 3, inst: 'clap', vel: 0.62 });
      for (let q = 0; q < 4; q++) ev.push({ at: q + 0.5, inst: 'hat', vel: 0.75 });
      if (lift) for (let q = 0; q < 4; q++) ev.push({ at: q + 0.25, inst: 'hat', vel: 0.3 }, { at: q + 0.75, inst: 'hat', vel: 0.35 });
      if (b % 4 === 3) ev.push({ at: 3.5, inst: 'ohat', vel: 0.7 });
      for (let k = 0; k < 8; k++) ev.push({ at: k / 2, inst: 'bass', midi: c.root + (k % 4 === 3 ? 12 : 0), dur: 0.42, vel: k % 2 ? 0.7 : 0.85, decay: 0.25 });
      if (b % 2 === 0) for (const m of c.notes) ev.push({ at: 0, inst: 'pad', midi: m, dur: 7.9, vel: 0.85, cutoff: lift ? 2100 : 1500 });
      if (lift) {
        const arp = [...c.notes, c.notes[0] + 12].map((m) => m + 12);
        for (let k = 0; k < 16; k++) if (k % 4 !== 3) ev.push({ at: k / 4, inst: 'pluck', midi: arp[k % arp.length], vel: 0.55, pan: k % 2 ? 0.35 : -0.35 });
      }
      if (b === 15) ev.push({ at: 3, inst: 'clap', vel: 0.35 }, { at: 3.25, inst: 'clap', vel: 0.45 }, { at: 3.5, inst: 'clap', vel: 0.55 }, { at: 3.75, inst: 'clap', vel: 0.65 });
      if (b === 0 || b === 8) ev.push({ at: 0, inst: 'crash', vel: 0.6 });
    },
  },
  warm: {
    name: 'Warm', description: 'Soft electric piano, brushed groove and a round bass (AC, country, talk).',
    bpm: 88, sidechain: 0,
    chords: [{ root: 41, notes: [53, 57, 60, 64] }, { root: 45, notes: [55, 57, 60, 64] }, { root: 46, notes: [53, 57, 58, 62] }, { root: 48, notes: [53, 55, 58, 60] }],
    bar(ev, b, c, lift, next) {
      ev.push({ at: 0, inst: 'kick', vel: 0.62 }, { at: 2.5, inst: 'kick', vel: 0.5 });
      if (b % 2) ev.push({ at: 1.75, inst: 'kick', vel: 0.35 });
      ev.push({ at: 1, inst: 'rim', vel: 0.7 }, { at: 3, inst: 'rim', vel: 0.75 });
      for (let k = 0; k < 16; k++) ev.push({ at: k / 4, inst: 'shaker', vel: k % 2 ? 0.8 : 0.45 });
      const v = b % 2 ? 0.85 : 1;
      for (const m of c.notes) {
        ev.push({ at: 0, inst: 'keys', midi: m, dur: 1.4, vel: 0.62 * v });
        ev.push({ at: 1.5, inst: 'keys', midi: m, dur: 0.45, vel: 0.4 * v });
        ev.push({ at: 2.5, inst: 'keys', midi: m, dur: 1.3, vel: 0.5 * v });
      }
      if (lift && b % 2 === 0) ev.push({ at: 3.5, inst: 'keys', midi: c.notes.at(-1) + 5, dur: 0.45, vel: 0.35 });
      ev.push({ at: 0, inst: 'bass', midi: c.root, dur: 1.6, vel: 0.85, decay: 1.2, grit: 0.05 });
      ev.push({ at: 2, inst: 'bass', midi: c.root + 7, dur: 0.9, vel: 0.7, decay: 1.2, grit: 0.05 });
      if (b % 2) ev.push({ at: 3.5, inst: 'bass', midi: next.root - 1, dur: 0.4, vel: 0.55, decay: 0.4, grit: 0.05 });
      if (lift && b % 2 === 0) for (const m of c.notes) ev.push({ at: 0, inst: 'pad', midi: m + 12, dur: 7.9, vel: 0.35, cutoff: 1300 });
    },
  },
  drive: {
    name: 'Drive', description: 'Driving pop-rock: backbeat, eighth-note bass and muted power chords (rock, classic hits, alternative).',
    bpm: 124, sidechain: 0,
    chords: [{ root: 38, notes: [54, 57, 62] }, { root: 33, notes: [52, 57, 61] }, { root: 35, notes: [54, 59, 62] }, { root: 31, notes: [55, 59, 62] }],
    bar(ev, b, c, lift) {
      ev.push({ at: 0, inst: 'kick', vel: 0.95 }, { at: 2, inst: 'kick', vel: 0.9 }, { at: 2.5, inst: 'kick', vel: 0.6 });
      ev.push({ at: 1, inst: 'snare', vel: 0.85 }, { at: 3, inst: 'snare', vel: 0.9 });
      for (let k = 0; k < 8; k++) ev.push({ at: k / 2, inst: 'hat', vel: k % 2 ? 0.6 : 0.85 });
      for (let k = 0; k < 8; k++) ev.push({ at: k / 2, inst: 'bass', midi: c.root, dur: 0.45, vel: k % 2 ? 0.72 : 0.85, decay: 0.35, grit: 0.35 });
      for (let k = 0; k < 8; k++) ev.push({ at: k / 2, inst: 'chug', midi: c.root + 12, dur: lift && k % 4 === 0 ? 0.9 : 0.3, vel: k % 2 ? 0.75 : 1 });
      if (b % 2 === 0) for (const m of c.notes) ev.push({ at: 0, inst: 'pad', midi: m + 12, dur: 7.9, vel: lift ? 0.6 : 0.4, cutoff: 2300 });
      if (b === 0 || b === 8) ev.push({ at: 0, inst: 'crash', vel: 0.85 });
      if (b === 15) for (const x of [3, 3.25, 3.5, 3.75]) ev.push({ at: x, inst: 'snare', vel: 0.4 + (x - 3) * 0.6 });
    },
  },
  chill: {
    name: 'Chill', description: 'Laid-back lo-fi groove: dusty keys, swung hats, deep sub (urban, R&B, late night).',
    bpm: 84, sidechain: 0.15, swing: 0.6,
    chords: [{ root: 36, notes: [51, 55, 58, 62] }, { root: 41, notes: [51, 55, 56, 60] }, { root: 34, notes: [50, 55, 56, 60] }, { root: 39, notes: [50, 53, 55, 58] }],
    bar(ev, b, c, lift) {
      ev.push({ at: 0, inst: 'kick', vel: 0.85 }, { at: 1.75, inst: 'kick', vel: 0.45 }, { at: 2.5, inst: 'kick', vel: 0.8 });
      ev.push({ at: 1, inst: 'snare', vel: 0.55 }, { at: 3, inst: 'snare', vel: 0.6 });
      for (let k = 0; k < 8; k++) ev.push({ at: k / 2, inst: 'hat', vel: k % 2 ? 0.55 : 0.8 });
      if (b % 4 === 3) ev.push({ at: 3.75, inst: 'hat', vel: 0.4 });
      for (const m of c.notes) ev.push({ at: 0, inst: 'keys', midi: m, dur: 3.2, vel: 0.6, bright: 0.45 });
      if (lift) ev.push({ at: 3, inst: 'keys', midi: c.notes.at(-1) + 2, dur: 0.45, vel: 0.32, bright: 0.45 }, { at: 3.5, inst: 'keys', midi: c.notes.at(-1), dur: 0.45, vel: 0.3, bright: 0.45 });
      ev.push({ at: 0, inst: 'bass', midi: c.root, dur: 1.5, vel: 0.9, decay: 1.5, grit: 0 });
      ev.push({ at: 2.5, inst: 'bass', midi: c.root, dur: 1.2, vel: 0.75, decay: 1.5, grit: 0 });
      if (lift && b % 2) ev.push({ at: 3.5, inst: 'bass', midi: c.root + 12, dur: 0.4, vel: 0.6, decay: 0.5, grit: 0 });
    },
  },
};

export const BED_STYLES = Object.fromEntries(Object.entries(STYLES).map(([id, s]) => [id, { id, name: s.name, description: s.description, bpm: s.bpm }]));

/** All note events for one 16-bar pass, with seeded humanization (identical every pass). */
export function arrangement(styleId) {
  const s = STYLES[styleId];
  if (!s) throw new Error(`unknown bed style ${styleId}`);
  const ev = [];
  const bars = 16;
  for (let b = 0; b < bars; b++) {
    const ci = Math.floor(b / 2) % s.chords.length;
    const c = s.chords[ci]; const next = s.chords[(ci + 1) % s.chords.length];
    const at = ev.length;
    s.bar(ev, b, c, b >= 8, next);
    for (let k = at; k < ev.length; k++) ev[k].at += b * 4;
  }
  const rnd = rng(7 + styleId.length);
  for (const e of ev) {
    if (s.swing) { const frac = e.at % 1; if (Math.abs(frac - 0.5) < 1e-6) e.at += (s.swing - 0.5); else if (Math.abs(frac - 0.75) < 1e-6) e.at += (s.swing - 0.5) / 2; }
    if (DRUMS[e.inst] && !(e.inst === 'kick' && e.at % 4 === 0)) e.at += (rnd() - 0.5) * 0.012 * (s.bpm / 60); // ±6 ms
    e.vel *= 0.94 + rnd() * 0.12;
  }
  return { style: s, events: ev, beats: bars * 4 };
}

// ------------------------------------------------------------------ render

/**
 * Render a seamless loop for a bed style.
 * @returns {{ l: Float32Array, r: Float32Array, bpm: number, bars: number, seconds: number }}
 */
export function renderBedLoop(styleId) {
  const { style: s, events, beats } = arrangement(styleId);
  const spb = 60 / s.bpm;
  const L = Math.round(beats * spb * SR); // frames per pass
  const total = L * 3 + Math.round(SR * 0.5);
  const drums = bus(total); const tonal = bus(total); const send = bus(total);
  const keysBus = bus(total);

  let seed = 1;
  for (let pass = 0; pass < 3; pass++) {
    seed = 1; // same noise every pass, so the passes match sample for sample
    for (const e of events) {
      const o = pass * L + Math.round(e.at * spb * SR);
      const dur = (e.dur || 0) * spb;
      seed++;
      if (DRUMS[e.inst]) { DRUMS[e.inst](drums, o, e.vel, seed * 7919); continue; }
      if (e.inst === 'bass') bass(tonal, o, dur, e.midi, e.vel, e);
      else if (e.inst === 'pad') pad(keysBus, o, dur, e.midi, e.vel, { cutoff: e.cutoff || 1500, pan: ((e.midi % 5) - 2) * 0.12 });
      else if (e.inst === 'keys') epiano(keysBus, o, dur, e.midi, e.vel, { pan: ((e.midi % 7) - 3) * 0.08, bright: e.bright ?? 1 });
      else if (e.inst === 'pluck') pluck(keysBus, o, e.midi, e.vel, { pan: e.pan || 0 });
      else if (e.inst === 'chug') chug(tonal, o, dur, e.midi, e.vel);
    }
  }

  // sidechain pump from the kick pattern
  if (s.sidechain) {
    const kicks = [];
    for (let pass = 0; pass < 3; pass++) for (const e of events) if (e.inst === 'kick') kicks.push(pass * L + Math.round(e.at * spb * SR));
    kicks.sort((a, b) => a - b);
    let k = 0; let last = -1e9;
    for (let i = 0; i < total; i++) {
      while (k < kicks.length && kicks[k] <= i) last = kicks[k++];
      const g = 1 - s.sidechain * Math.exp(-(i - last) / (0.13 * SR));
      keysBus.l[i] *= g; keysBus.r[i] *= g; tonal.l[i] *= 0.6 + 0.4 * g; tonal.r[i] *= 0.6 + 0.4 * g;
    }
  }

  // reverb send: keys/pads plenty, a touch on the snare/clap
  for (let i = 0; i < total; i++) {
    send.l[i] = keysBus.l[i] * 0.55 + drums.l[i] * 0.12; send.r[i] = keysBus.r[i] * 0.55 + drums.r[i] * 0.12;
  }
  const rv = new Reverb(SR, { room: 0.86, damp: 0.45, wet: 1, width: 1 });
  const hpL = new Biquad().highpass(SR, 32, 0.7); const hpR = new Biquad().highpass(SR, 32, 0.7);
  const dipL = new Biquad().peaking(SR, 2400, 0.7, -3.5); const dipR = new Biquad().peaking(SR, 2400, 0.7, -3.5);
  const lowL = new Biquad().lowshelf(SR, 95, 1.5); const lowR = new Biquad().lowshelf(SR, 95, 1.5);
  const mix = bus(total);
  let env = 0; const ca = Math.exp(-1 / (0.01 * SR)); const cr = Math.exp(-1 / (0.18 * SR));
  for (let i = 0; i < total; i++) {
    const [wl, wr] = rv.process(send.l[i], send.r[i]);
    let l = drums.l[i] + tonal.l[i] + keysBus.l[i] + wl * 0.9;
    let r = drums.r[i] + tonal.r[i] + keysBus.r[i] + wr * 0.9;
    l = lowL.process(dipL.process(hpL.process(l))); r = lowR.process(dipR.process(hpR.process(r)));
    // gentle glue compression
    const x = Math.max(Math.abs(l), Math.abs(r));
    env = x > env ? x + (env - x) * ca : x + (env - x) * cr;
    const over = 20 * Math.log10(env + 1e-9) + 14;
    const g = over > 0 ? Math.pow(10, (-over * 0.5) / 20) : 1;
    mix.l[i] = l * g; mix.r[i] = r * g;
  }

  // cut the middle pass, crossfading its head with the head of the third pass
  const X = Math.round(0.25 * SR);
  const out = bus(L);
  for (let i = 0; i < L; i++) {
    let l = mix.l[L + i]; let r = mix.r[L + i];
    if (i < X) {
      const a = Math.sin((Math.PI / 2) * (i / X)); const z = Math.cos((Math.PI / 2) * (i / X));
      l = l * a + mix.l[2 * L + i] * z; r = r * a + mix.r[2 * L + i] * z;
    }
    out.l[i] = l; out.r[i] = r;
  }
  let peak = 0;
  for (let i = 0; i < L; i++) peak = Math.max(peak, Math.abs(out.l[i]), Math.abs(out.r[i]));
  const g = peak > 0 ? Math.pow(10, -1 / 20) / peak : 1;
  for (let i = 0; i < L; i++) { out.l[i] *= g; out.r[i] *= g; }
  return { ...out, bpm: s.bpm, bars: 16, seconds: L / SR };
}

/**
 * Make any audio loop seamlessly by crossfading its tail into its head (for uploaded beds).
 * @param {Int16Array} pcm interleaved stereo
 * @returns {Int16Array} interleaved stereo loop, `xfadeSec` shorter than the input
 */
export function makeLoop(pcm, xfadeSec = 1.5) {
  const n = pcm.length / 2;
  const X = Math.min(Math.round(xfadeSec * SR), Math.floor(n / 3));
  const L = n - X;
  const out = new Int16Array(L * 2);
  for (let i = 0; i < L; i++) {
    let l = pcm[i * 2]; let r = pcm[i * 2 + 1];
    if (i < X) {
      const a = Math.sin((Math.PI / 2) * (i / X)); const z = Math.cos((Math.PI / 2) * (i / X));
      l = l * a + pcm[(L + i) * 2] * z; r = r * a + pcm[(L + i) * 2 + 1] * z;
    }
    out[i * 2] = Math.max(-32768, Math.min(32767, Math.round(l)));
    out[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(r)));
  }
  return out;
}
