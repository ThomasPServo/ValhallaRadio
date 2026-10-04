// Broadcast audio processor for the master bus, in the spirit of an FM/streaming air chain:
//   input trim → subsonic/DC filter → phase rotator → wideband gated AGC → stereo width + bass mono
//   → EQ (bass / warmth / presence / air) → 5-band phase-compensated LR4 multiband compressor
//   → soft clipper → look-ahead peak limiter → output.
// Metering: input/output peaks, BS.1770 loudness (momentary / short-term / integrated),
// 4x-oversampled true peak, gain reduction for every stage, 1/3-octave spectrum,
// stereo correlation and goniometer points.

import { Biquad, LR4, kWeighting, FFT, coef, dbToLin, linToDb } from './dsp.js';

const BANDS = 5;

export const PRESETS = {
  streaming: {
    name: 'Streaming Standard (−14 LUFS)', description: 'Balanced and open, matched to streaming platform loudness.',
    agc: { targetDb: -20, maxGainDb: 8, speed: 1 },
    stereo: { width: 1.05, bassMonoHz: 110 },
    eq: { bassDb: 1.5, warmthDb: -0.5, presenceDb: 1, airDb: 1.5 },
    multiband: { drive: 1.5, bands: [[-20, 2.5], [-21, 2.5], [-22, 2.2], [-23, 2], [-24, 2]] },
    clipper: { driveDb: 0 }, limiter: { ceilingDb: -1, releaseMs: 90 }, outputGainDb: -3.2,
  },
  chr: {
    name: 'Hot Hits / CHR', description: 'Loud, bright and dense, the classic Top 40 sound.',
    agc: { targetDb: -18, maxGainDb: 10, speed: 1.2 },
    stereo: { width: 1.18, bassMonoHz: 120 },
    eq: { bassDb: 3, warmthDb: -1.5, presenceDb: 2, airDb: 3.5 },
    multiband: { drive: 5, bands: [[-22, 3.5], [-23, 3], [-24, 3], [-24, 3], [-25, 3.5]] },
    clipper: { driveDb: 2 }, limiter: { ceilingDb: -1, releaseMs: 60 }, outputGainDb: 0,
  },
  ac: {
    name: 'Adult Contemporary', description: 'Smooth, warm and polished, with less density.',
    agc: { targetDb: -20, maxGainDb: 9, speed: 0.8 },
    stereo: { width: 1.1, bassMonoHz: 110 },
    eq: { bassDb: 2, warmthDb: 0, presenceDb: 1, airDb: 2 },
    multiband: { drive: 3, bands: [[-21, 2.5], [-22, 2.5], [-23, 2.2], [-23, 2.2], [-24, 2.5]] },
    clipper: { driveDb: 1 }, limiter: { ceilingDb: -1, releaseMs: 90 }, outputGainDb: -1,
  },
  rock: {
    name: 'Rock / Classic Rock', description: 'Punchy mids and tight bass, guitars forward.',
    agc: { targetDb: -19, maxGainDb: 9, speed: 1 },
    stereo: { width: 1.12, bassMonoHz: 120 },
    eq: { bassDb: 2, warmthDb: 0.5, presenceDb: 2.5, airDb: 1.5 },
    multiband: { drive: 4, bands: [[-21, 3], [-22, 3], [-23, 2.5], [-24, 3], [-24, 3]] },
    clipper: { driveDb: 1.5 }, limiter: { ceilingDb: -1, releaseMs: 70 }, outputGainDb: -0.5,
  },
  urban: {
    name: 'Hip-Hop / R&B', description: 'Big, controlled low end with clean highs.',
    agc: { targetDb: -18, maxGainDb: 10, speed: 1.1 },
    stereo: { width: 1.12, bassMonoHz: 140 },
    eq: { bassDb: 4.5, warmthDb: -1.5, presenceDb: 1.5, airDb: 2.5 },
    multiband: { drive: 4.5, bands: [[-20, 3], [-22, 3], [-23, 3], [-24, 3], [-25, 3]] },
    clipper: { driveDb: 2 }, limiter: { ceilingDb: -1, releaseMs: 60 }, outputGainDb: 0,
  },
  country: {
    name: 'Country', description: 'Warm vocals and acoustic detail, with an open top end.',
    agc: { targetDb: -19, maxGainDb: 9, speed: 0.9 },
    stereo: { width: 1.1, bassMonoHz: 110 },
    eq: { bassDb: 2, warmthDb: 0.5, presenceDb: 2, airDb: 2 },
    multiband: { drive: 3.5, bands: [[-21, 2.5], [-22, 2.5], [-23, 2.5], [-23, 2.5], [-24, 2.5]] },
    clipper: { driveDb: 1 }, limiter: { ceilingDb: -1, releaseMs: 80 }, outputGainDb: -0.5,
  },
  dance: {
    name: 'Dance / EDM', description: 'Maximum punch and loudness for club tracks.',
    agc: { targetDb: -17, maxGainDb: 10, speed: 1.2 },
    stereo: { width: 1.2, bassMonoHz: 140 },
    eq: { bassDb: 4, warmthDb: -2, presenceDb: 1.5, airDb: 3.5 },
    multiband: { drive: 6, bands: [[-21, 4], [-23, 3.5], [-24, 3], [-25, 3], [-25, 3.5]] },
    clipper: { driveDb: 2.5 }, limiter: { ceilingDb: -1, releaseMs: 50 }, outputGainDb: 0,
  },
  talk: {
    name: 'News / Talk', description: 'Dense and intelligible voice, with a controlled low end.',
    agc: { targetDb: -18, maxGainDb: 12, speed: 1.4 },
    stereo: { width: 1, bassMonoHz: 200 },
    eq: { bassDb: 0, warmthDb: -2, presenceDb: 3, airDb: 1.5 },
    multiband: { drive: 5, bands: [[-22, 3], [-24, 4], [-25, 4], [-25, 3.5], [-26, 3]] },
    clipper: { driveDb: 1.5 }, limiter: { ceilingDb: -1, releaseMs: 70 }, outputGainDb: 0,
  },
  gentle: {
    name: 'Classical / Jazz', description: 'Light touch that keeps natural dynamics.',
    agc: { targetDb: -22, maxGainDb: 6, speed: 0.5 },
    stereo: { width: 1, bassMonoHz: 80 },
    eq: { bassDb: 0.5, warmthDb: 0, presenceDb: 0, airDb: 0.5 },
    multiband: { drive: 0, bands: [[-18, 1.6], [-18, 1.6], [-19, 1.5], [-20, 1.5], [-20, 1.5]] },
    clipper: { driveDb: 0 }, limiter: { ceilingDb: -1, releaseMs: 150 }, outputGainDb: -4,
  },
};

const BAND_TIMING = [ // attack ms, release ms
  [40, 450], [20, 300], [10, 200], [6, 140], [4, 110],
];

/** Full parameter set for a preset id plus optional overrides. */
export function resolveParams(presetId = 'streaming', overrides = {}) {
  const p = PRESETS[presetId] || PRESETS.streaming;
  const base = {
    preset: PRESETS[presetId] ? presetId : 'streaming',
    bypass: false,
    inputGainDb: 0,
    phaseRotator: true,
    agc: { enabled: true, targetDb: -20, maxGainDb: 9, maxCutDb: 12, speed: 1, gateDb: -46, windowDb: 1.5 },
    stereo: { width: 1.1, bassMonoHz: 120 },
    eq: { bassDb: 2, bassHz: 70, warmthDb: 0, warmthHz: 300, presenceDb: 1, presenceHz: 3200, airDb: 2, airHz: 11000 },
    multiband: {
      enabled: true, drive: 3, crossovers: [110, 420, 2000, 6200], gateDb: -48,
      bands: Array.from({ length: BANDS }, (_, i) => ({ thresholdDb: -22, ratio: 2.5, attackMs: BAND_TIMING[i][0], releaseMs: BAND_TIMING[i][1], makeupDb: 0 })),
    },
    clipper: { enabled: true, driveDb: 1 },
    limiter: { ceilingDb: -1, releaseMs: 80, lookaheadMs: 2.5 },
    outputGainDb: 0,
  };
  const merged = structuredClone(base);
  Object.assign(merged.agc, p.agc);
  Object.assign(merged.stereo, p.stereo);
  Object.assign(merged.eq, p.eq);
  merged.multiband.drive = p.multiband.drive;
  p.multiband.bands.forEach(([thr, ratio], i) => { merged.multiband.bands[i].thresholdDb = thr; merged.multiband.bands[i].ratio = ratio; });
  Object.assign(merged.clipper, p.clipper);
  Object.assign(merged.limiter, p.limiter);
  merged.outputGainDb = p.outputGainDb;
  return deepMerge(merged, overrides || {});
}

function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') deepMerge(a[k], v);
    else if (Array.isArray(v) && Array.isArray(a[k])) v.forEach((x, i) => { if (x && typeof x === 'object' && a[k][i]) deepMerge(a[k][i], x); else if (x !== undefined && x !== null) a[k][i] = x; });
    else if (v !== undefined) a[k] = v;
  }
  return a;
}

/** 4x oversampling interpolator for true-peak estimation (windowed-sinc polyphase, ITU-R BS.1770 style). */
class TruePeak {
  constructor() {
    const taps = 12; const phases = 4;
    this.taps = taps;
    this.coefs = [];
    for (let p = 1; p < phases; p++) {
      const c = new Float64Array(taps);
      for (let t = 0; t < taps; t++) {
        const x = t - taps / 2 + 1 - p / phases;
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (taps / 2 + 1));
        c[t] = sinc * w;
      }
      this.coefs.push(c);
    }
    // doubled history so the window is always contiguous (no modulo in the inner loop)
    this.h0 = new Float64Array(taps * 2); this.h1 = new Float64Array(taps * 2);
    this.pos = 0;
  }

  push(l, r) {
    const n = this.taps; const h0 = this.h0; const h1 = this.h1;
    h0[this.pos] = l; h0[this.pos + n] = l; h1[this.pos] = r; h1[this.pos + n] = r;
    this.pos = this.pos + 1 === n ? 0 : this.pos + 1;
    const base = this.pos; // oldest sample
    let peak = Math.max(Math.abs(l), Math.abs(r));
    for (let k = 0; k < this.coefs.length; k++) {
      const c = this.coefs[k];
      let a = 0; let b = 0;
      for (let t = 0; t < n; t++) { a += h0[base + t] * c[t]; b += h1[base + t] * c[t]; }
      const m = a < 0 ? -a : a; const mb = b < 0 ? -b : b;
      if (m > peak) peak = m;
      if (mb > peak) peak = mb;
    }
    return peak;
  }
}

/** BS.1770 loudness meter (momentary 400 ms, short-term 3 s, gated integrated). */
export class LoudnessMeter {
  constructor(fs) {
    this.fs = fs;
    this.kl = kWeighting(fs); this.kr = kWeighting(fs);
    this.blockLen = Math.round(fs * 0.1);
    this.acc = 0; this.n = 0;
    this.blocks = new Float64Array(30); this.bi = 0; this.bcount = 0;
    this.gated = []; // 400 ms loudness values for integration
    this.momentary = -70; this.shortTerm = -70;
  }

  push(l, r) {
    const a = this.kl[1].process(this.kl[0].process(l));
    const b = this.kr[1].process(this.kr[0].process(r));
    this.acc += a * a + b * b;
    if (++this.n >= this.blockLen) {
      this.blocks[this.bi] = this.acc / this.n;
      this.bi = (this.bi + 1) % 30; this.bcount++;
      this.acc = 0; this.n = 0;
      const ms = (k) => { let s = 0; const m = Math.min(k, this.bcount); for (let i = 1; i <= m; i++) s += this.blocks[(this.bi - i + 30) % 30]; return s / Math.max(1, m); };
      const ms4 = ms(4);
      this.momentary = -0.691 + 10 * Math.log10(ms4 + 1e-12);
      this.shortTerm = -0.691 + 10 * Math.log10(ms(30) + 1e-12);
      if (this.bcount >= 4 && this.momentary > -70) {
        this.gated.push(ms4);
        if (this.gated.length > 36000) this.gated.splice(0, 6000); // keep about an hour
      }
    }
  }

  integrated() {
    if (!this.gated.length) return -70;
    const mean = this.gated.reduce((s, v) => s + v, 0) / this.gated.length;
    const rel = mean * Math.pow(10, -1); // -10 LU
    const kept = this.gated.filter((v) => v >= rel);
    const m = kept.reduce((s, v) => s + v, 0) / Math.max(1, kept.length);
    return -0.691 + 10 * Math.log10(m + 1e-12);
  }

  reset() { this.gated = []; }
}

const THIRD_OCTAVES = [25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];

export class BroadcastProcessor {
  constructor(fs = 44100, params = resolveParams()) {
    this.fs = fs;
    this.hpL = new Biquad(); this.hpR = new Biquad(); this.hp2L = new Biquad(); this.hp2R = new Biquad();
    this.rotL = [new Biquad(), new Biquad()]; this.rotR = [new Biquad(), new Biquad()];
    this.sideLp = new Biquad();
    this.eqL = [new Biquad(), new Biquad(), new Biquad(), new Biquad()];
    this.eqR = [new Biquad(), new Biquad(), new Biquad(), new Biquad()];
    this.agcGainDb = 0; this.agcGain = 1; this.agcMs = 1e-6; this.agcAcc = 0; this.agcN = 0;
    this.bandGr = new Float64Array(BANDS); this.bandGain = new Float64Array(BANDS).fill(1); this.bandPeak = new Float64Array(BANDS);
    this.bandGainS = new Float64Array(BANDS).fill(1); // per-sample smoothed (no zipper noise)
    this.ctl = 0;
    this.limDelayL = new Float64Array(256); this.limDelayR = new Float64Array(256); this.limPos = 0;
    this.limQueueV = new Float64Array(512); this.limQueueI = new Float64Array(512); this.qHead = 0; this.qTail = 0; this.sampleIdx = 0;
    this.limGain = 1;
    this.inMeter = new LoudnessMeter(fs); this.outMeter = new LoudnessMeter(fs);
    this.tp = new TruePeak();
    this.fft = new FFT(2048); this.scope = new Float32Array(2048); this.scopePos = 0;
    this.resetInterval();
    this.setParams(params);
  }

  setParams(p) {
    this.p = p;
    const fs = this.fs;
    this.inGain = dbToLin(p.inputGainDb || 0);
    this.outGain = dbToLin(p.outputGainDb || 0);
    this.hpL.highpass(fs, 28, 0.7); this.hpR.highpass(fs, 28, 0.7); this.hp2L.highpass(fs, 28, 0.7); this.hp2R.highpass(fs, 28, 0.7);
    for (const r of [this.rotL, this.rotR]) { r[0].allpass(fs, 180, 0.6); r[1].allpass(fs, 220, 0.6); }
    this.sideLp.lowpass(fs, p.stereo.bassMonoHz || 120, Math.SQRT1_2);
    const e = p.eq;
    for (const ch of [this.eqL, this.eqR]) {
      ch[0].lowshelf(fs, e.bassHz || 70, e.bassDb || 0, 0.9);
      ch[1].peaking(fs, e.warmthHz || 300, 0.8, e.warmthDb || 0);
      ch[2].peaking(fs, e.presenceHz || 3200, 0.9, e.presenceDb || 0);
      ch[3].highshelf(fs, e.airHz || 11000, e.airDb || 0, 0.8);
    }
    const xo = p.multiband.crossovers;
    const key = xo.join(',');
    if (this.xoKey !== key) {
      this.xoKey = key;
      // Tree: split at xo[1]; low branch splits at xo[0], high branch at xo[2] then xo[3].
      // Allpass compensation keeps the band sum flat (LR4 low+high = 2nd-order allpass).
      this.ch = [0, 1].map(() => ({
        main: new LR4(fs, xo[1]),
        loApA: new Biquad().allpass(fs, xo[2]), loApB: new Biquad().allpass(fs, xo[3]),
        lo: new LR4(fs, xo[0]),
        hiAp: new Biquad().allpass(fs, xo[0]),
        hi: new LR4(fs, xo[2]),
        midAp: new Biquad().allpass(fs, xo[3]),
        top: new LR4(fs, xo[3]),
        out: new Float64Array(BANDS),
      }));
    }
    const ctlRate = 8;
    this.bandAtt = p.multiband.bands.map((b) => coef(b.attackMs / 1000, fs / ctlRate));
    this.bandRel = p.multiband.bands.map((b) => coef(b.releaseMs / 1000, fs / ctlRate));
    this.agcCoef = coef(0.45, fs / 32);
    const la = Math.max(8, Math.min(250, Math.round(((p.limiter.lookaheadMs || 2.5) / 1000) * fs)));
    if (la !== this.la) { this.la = la; this.limDelayL.fill(0); this.limDelayR.fill(0); this.qHead = this.qTail = 0; }
    this.limAtt = 1 - Math.exp(-1 / (la / 5));
    this.limRel = 1 - Math.exp(-1 / (((p.limiter.releaseMs || 80) / 1000) * fs));
    this.ceil = dbToLin(p.limiter.ceilingDb ?? -1);
    this.clipDrive = dbToLin(p.clipper.enabled ? p.clipper.driveDb || 0 : 0);
    this.mbDrive = dbToLin(p.multiband.drive || 0);
  }

  resetInterval() {
    this.iv = { inPeakL: 0, inPeakR: 0, outPeakL: 0, outPeakR: 0, tp: 0, limMin: 1, grMax: new Float64Array(BANDS), lr: 0, ll: 0, rr: 0, gonio: [], n: 0 };
  }

  /** Process interleaved stereo Float32 audio in place. */
  process(buf, frames) {
    const p = this.p; const iv = this.iv;
    const bypass = p.bypass;
    const mb = p.multiband; const agc = p.agc;
    const chL = this.ch[0]; const chR = this.ch[1];
    const width = p.stereo.width;
    const gonioStep = Math.max(1, Math.floor(frames / 96));
    for (let i = 0; i < frames; i++) {
      let l = buf[i * 2]; let r = buf[i * 2 + 1];
      const al = Math.abs(l); const ar = Math.abs(r);
      if (al > iv.inPeakL) iv.inPeakL = al;
      if (ar > iv.inPeakR) iv.inPeakR = ar;
      this.inMeter.push(l, r);

      if (!bypass) {
        const dn = (i & 1) ? 1e-18 : -1e-18; // keeps recursive filters out of denormal range in silence
        l = this.hp2L.process(this.hpL.process(l * this.inGain + dn));
        r = this.hp2R.process(this.hpR.process(r * this.inGain + dn));
        if (p.phaseRotator) {
          l = this.rotL[1].process(this.rotL[0].process(l));
          r = this.rotR[1].process(this.rotR[0].process(r));
        }

        // wideband AGC (control rate 32 samples)
        const m = (l + r) * 0.5;
        this.agcAcc += m * m;
        if (++this.agcN >= 32) {
          this.agcMs = this.agcMs * this.agcCoef + (this.agcAcc / 32) * (1 - this.agcCoef);
          this.agcAcc = 0; this.agcN = 0;
          const lvl = 10 * Math.log10(this.agcMs + 1e-12);
          this.gated = lvl < agc.gateDb;
          if (agc.enabled && !this.gated) {
            const err = agc.targetDb - (lvl + this.agcGainDb);
            if (Math.abs(err) > agc.windowDb) {
              const step = (err < 0 ? 3 : 1.2) * agc.speed * (32 / this.fs) * Math.sign(err);
              this.agcGainDb = Math.max(-agc.maxCutDb, Math.min(agc.maxGainDb, this.agcGainDb + step));
            }
          } else if (!agc.enabled) this.agcGainDb = 0;
        }
        const tg = dbToLinFast(this.agcGainDb);
        this.agcGain += (tg - this.agcGain) * 0.002;
        l *= this.agcGain; r *= this.agcGain;

        // stereo: width on mids/highs, mono bass
        if (width !== 1 || p.stereo.bassMonoHz) {
          const mid = (l + r) * 0.5; let side = (l - r) * 0.5;
          const sLow = this.sideLp.process(side);
          side = (side - sLow) * width;
          l = mid + side; r = mid - side;
        }

        // EQ
        for (let k = 0; k < 4; k++) { l = this.eqL[k].process(l); r = this.eqR[k].process(r); }

        // multiband
        if (mb.enabled) {
          this._bands(chL, l * this.mbDrive);
          this._bands(chR, r * this.mbDrive);
          for (let b = 0; b < BANDS; b++) {
            const pk = Math.max(Math.abs(chL.out[b]), Math.abs(chR.out[b]));
            if (pk > this.bandPeak[b]) this.bandPeak[b] = pk;
          }
          if (++this.ctl >= 8) {
            this.ctl = 0;
            for (let b = 0; b < BANDS; b++) {
              const band = mb.bands[b];
              const lvl = 20 * Math.log10(this.bandPeak[b] + 1e-9);
              this.bandPeak[b] = 0;
              const over = lvl - band.thresholdDb;
              const W = 6; const slope = 1 - 1 / Math.max(1, band.ratio);
              let target = 0;
              if (over >= W / 2) target = over * slope;
              else if (over > -W / 2) target = (slope * (over + W / 2) ** 2) / (2 * W);
              const cur = this.bandGr[b];
              if (target > cur) this.bandGr[b] = target + (cur - target) * this.bandAtt[b];
              else if (!this.gated) this.bandGr[b] = target + (cur - target) * this.bandRel[b];
              this.bandGain[b] = dbToLinFast(band.makeupDb - this.bandGr[b]);
              if (this.bandGr[b] > iv.grMax[b]) iv.grMax[b] = this.bandGr[b];
            }
          }
          let sl = 0; let sr = 0;
          for (let b = 0; b < BANDS; b++) {
            const g = (this.bandGainS[b] += (this.bandGain[b] - this.bandGainS[b]) * 0.2);
            sl += chL.out[b] * g; sr += chR.out[b] * g;
          }
          l = sl; r = sr;
        }

        // clipper
        if (p.clipper.enabled) {
          l = softClip(l * this.clipDrive, this.ceil * 1.05);
          r = softClip(r * this.clipDrive, this.ceil * 1.05);
        }
      }

      // look-ahead limiter (always on, also protects bypass)
      const o = this._limit(l, r);
      l = o[0] * this.outGain; r = o[1] * this.outGain;
      const c = this.ceil;
      if (l > c) l = c; else if (l < -c) l = -c;
      if (r > c) r = c; else if (r < -c) r = -c;
      buf[i * 2] = l; buf[i * 2 + 1] = r;

      // output metering
      const ol = Math.abs(l); const or = Math.abs(r);
      if (ol > iv.outPeakL) iv.outPeakL = ol;
      if (or > iv.outPeakR) iv.outPeakR = or;
      this.outMeter.push(l, r);
      const t = this.tp.push(l, r);
      if (t > iv.tp) iv.tp = t;
      iv.lr += l * r; iv.ll += l * l; iv.rr += r * r;
      this.scope[this.scopePos] = (l + r) * 0.5; this.scopePos = (this.scopePos + 1) & 2047;
      if (i % gonioStep === 0 && iv.gonio.length < 192) iv.gonio.push(l, r);
    }
    iv.n += frames;
  }

  _bands(c, x) {
    c.main.split(x);
    const lo = c.loApB.process(c.loApA.process(c.main.lo));
    c.lo.split(lo);
    c.out[0] = c.lo.lo; c.out[1] = c.lo.hi;
    const hi = c.hiAp.process(c.main.hi);
    c.hi.split(hi);
    c.out[2] = c.midAp.process(c.hi.lo);
    c.top.split(c.hi.hi);
    c.out[3] = c.top.lo; c.out[4] = c.top.hi;
  }

  _limit(l, r) {
    const la = this.la; const c = this.ceil;
    const peak = Math.max(Math.abs(l), Math.abs(r));
    const req = peak > c ? c / peak : 1;
    // sliding-window minimum of required gain (monotonic deque)
    const idx = this.sampleIdx++;
    const qv = this.limQueueV; const qi = this.limQueueI; const mask = 511;
    while (this.qTail !== this.qHead && qv[(this.qTail - 1) & mask] >= req) this.qTail = (this.qTail - 1) & mask;
    qv[this.qTail] = req; qi[this.qTail] = idx; this.qTail = (this.qTail + 1) & mask;
    while (qi[this.qHead] <= idx - la - 1) this.qHead = (this.qHead + 1) & mask;
    const target = qv[this.qHead];
    this.limGain += (target - this.limGain) * (target < this.limGain ? this.limAtt : this.limRel);
    if (this.limGain < this.iv.limMin) this.iv.limMin = this.limGain;
    // delay the audio by the look-ahead
    const pos = this.limPos;
    const dl = this.limDelayL[pos]; const dr = this.limDelayR[pos];
    this.limDelayL[pos] = l; this.limDelayR[pos] = r;
    this.limPos = (pos + 1) % la;
    this._o ||= [0, 0];
    this._o[0] = dl * this.limGain; this._o[1] = dr * this.limGain;
    return this._o;
  }

  /** Meter snapshot since the last call (for the engineering UI). */
  meters() {
    const iv = this.iv;
    const corr = iv.ll > 1e-9 && iv.rr > 1e-9 ? iv.lr / Math.sqrt(iv.ll * iv.rr) : 0;
    // 1/3-octave spectrum of the last 2048 output samples
    const ordered = new Float64Array(2048);
    for (let i = 0; i < 2048; i++) ordered[i] = this.scope[(this.scopePos + i) & 2047];
    const mags = this.fft.magnitudesDb(ordered);
    const binHz = this.fs / 2048;
    const spectrum = THIRD_OCTAVES.map((f) => {
      const lo = Math.max(1, Math.floor((f / 1.122) / binHz)); const hi = Math.max(lo, Math.ceil((f * 1.122) / binHz));
      let s = -120;
      for (let b = lo; b <= hi && b < mags.length; b++) s = Math.max(s, mags[b]);
      return Math.round(s * 10) / 10;
    });
    const r = (v) => Math.round(v * 10) / 10;
    const snap = {
      in: { peakL: r(linToDb(iv.inPeakL)), peakR: r(linToDb(iv.inPeakR)), m: r(this.inMeter.momentary), s: r(this.inMeter.shortTerm) },
      out: { peakL: r(linToDb(iv.outPeakL)), peakR: r(linToDb(iv.outPeakR)), m: r(this.outMeter.momentary), s: r(this.outMeter.shortTerm), tp: r(linToDb(iv.tp)) },
      agc: r(this.agcGainDb),
      gated: Boolean(this.gated),
      bands: Array.from(iv.grMax, (g) => r(g)),
      limiter: r(-linToDb(iv.limMin)),
      corr: Math.round(corr * 100) / 100,
      spectrum,
      gonio: iv.gonio.map((v) => Math.round(v * 1000) / 1000),
      bypass: this.p.bypass,
    };
    this.resetInterval();
    return snap;
  }

  loudness() {
    return { inI: Math.round(this.inMeter.integrated() * 10) / 10, outI: Math.round(this.outMeter.integrated() * 10) / 10 };
  }
}

function softClip(x, c) {
  const t = c * 0.82;
  const a = x < 0 ? -x : x;
  if (a <= t) return x;
  const y = t + (c - t) * Math.tanh((a - t) / (c - t));
  return x < 0 ? -y : y;
}

// dB→linear with a tiny cache-free fast path (exp is quicker than pow)
const LN10_20 = Math.LN10 / 20;
function dbToLinFast(db) { return Math.exp(db * LN10_20); }

export const THIRD_OCTAVE_BANDS = THIRD_OCTAVES;
