// Small, allocation-free DSP building blocks used by the processor, analysis and production.

export const dbToLin = (db) => Math.pow(10, db / 20);
export const linToDb = (g) => 20 * Math.log10(Math.max(g, 1e-12));

/** Transposed direct form II biquad with RBJ-cookbook designs. */
export class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.z1 = 0; this.z2 = 0;
  }

  set(b0, b1, b2, a0, a1, a2) {
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }

  lowpass(fs, f, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * f) / fs; const c = Math.cos(w); const a = Math.sin(w) / (2 * q);
    return this.set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + a, -2 * c, 1 - a);
  }

  highpass(fs, f, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * f) / fs; const c = Math.cos(w); const a = Math.sin(w) / (2 * q);
    return this.set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + a, -2 * c, 1 - a);
  }

  bandpass(fs, f, q = 1) {
    const w = (2 * Math.PI * f) / fs; const c = Math.cos(w); const a = Math.sin(w) / (2 * q);
    return this.set(a, 0, -a, 1 + a, -2 * c, 1 - a);
  }

  allpass(fs, f, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * f) / fs; const c = Math.cos(w); const a = Math.sin(w) / (2 * q);
    return this.set(1 - a, -2 * c, 1 + a, 1 + a, -2 * c, 1 - a);
  }

  /** First-order allpass expressed as a biquad (used by the phase rotator). */
  allpass1(fs, f) {
    const t = Math.tan((Math.PI * f) / fs);
    const k = (t - 1) / (t + 1);
    return this.set(k, 1, 0, 1, k, 0);
  }

  peaking(fs, f, q, gainDb) {
    const A = Math.pow(10, gainDb / 40); const w = (2 * Math.PI * f) / fs; const c = Math.cos(w); const a = Math.sin(w) / (2 * q);
    return this.set(1 + a * A, -2 * c, 1 - a * A, 1 + a / A, -2 * c, 1 - a / A);
  }

  lowshelf(fs, f, gainDb, s = 0.8) {
    const A = Math.pow(10, gainDb / 40); const w = (2 * Math.PI * f) / fs; const c = Math.cos(w);
    const a = (Math.sin(w) / 2) * Math.sqrt((A + 1 / A) * (1 / s - 1) + 2); const sq = 2 * Math.sqrt(A) * a;
    return this.set(A * ((A + 1) - (A - 1) * c + sq), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sq),
      (A + 1) + (A - 1) * c + sq, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sq);
  }

  highshelf(fs, f, gainDb, s = 0.8) {
    const A = Math.pow(10, gainDb / 40); const w = (2 * Math.PI * f) / fs; const c = Math.cos(w);
    const a = (Math.sin(w) / 2) * Math.sqrt((A + 1 / A) * (1 / s - 1) + 2); const sq = 2 * Math.sqrt(A) * a;
    return this.set(A * ((A + 1) + (A - 1) * c + sq), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sq),
      (A + 1) - (A - 1) * c + sq, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sq);
  }

  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  reset() { this.z1 = 0; this.z2 = 0; }
}

/** Linkwitz-Riley 4th-order crossover: low + high sum to a 2nd-order allpass at f. */
export class LR4 {
  constructor(fs, f) {
    this.lp = [new Biquad().lowpass(fs, f), new Biquad().lowpass(fs, f)];
    this.hp = [new Biquad().highpass(fs, f), new Biquad().highpass(fs, f)];
    this.lo = 0;
    this.hi = 0;
  }

  /** Splits x into this.lo / this.hi. */
  split(x) {
    this.lo = this.lp[1].process(this.lp[0].process(x));
    this.hi = this.hp[1].process(this.hp[0].process(x));
  }
}

/** ITU-R BS.1770 K-weighting (pre-filter shelf + RLB high-pass) for any sample rate (libebur128 design). */
export function kWeighting(fs) {
  let f0 = 1681.974450955533; const G = 3.999843853973347; let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20); const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = new Biquad().set((Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const hp = new Biquad().set(1, -2, 1, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
  return [shelf, hp];
}

/** In-place iterative radix-2 complex FFT. */
export class FFT {
  constructor(n) {
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / n); this.sin[i] = -Math.sin((2 * Math.PI * i) / n); }
    this.window = new Float64Array(n);
    for (let i = 0; i < n; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); // Hann
  }

  transform(re, im) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1; const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const tr = re[i + j + half] * this.cos[k] - im[i + j + half] * this.sin[k];
          const ti = re[i + j + half] * this.sin[k] + im[i + j + half] * this.cos[k];
          re[i + j + half] = re[i + j] - tr; im[i + j + half] = im[i + j] - ti;
          re[i + j] += tr; im[i + j] += ti;
        }
      }
    }
  }

  /** Magnitude spectrum (dBFS-ish) of a real signal using a Hann window. */
  magnitudesDb(signal, out = new Float32Array(this.n / 2)) {
    const n = this.n; const re = this._re ||= new Float64Array(n); const im = this._im ||= new Float64Array(n);
    for (let i = 0; i < n; i++) { re[i] = (signal[i] || 0) * this.window[i]; im[i] = 0; }
    this.transform(re, im);
    const norm = 2 / (n * 0.5);
    for (let i = 0; i < n / 2; i++) out[i] = 20 * Math.log10(Math.hypot(re[i], im[i]) * norm + 1e-12);
    return out;
  }
}

/** One-pole smoothing coefficient for a time constant in seconds. */
export const coef = (seconds, fs) => (seconds <= 0 ? 0 : Math.exp(-1 / (seconds * fs)));

/** Simple stereo Freeverb-style reverb for offline production (not real-time critical). */
export class Reverb {
  constructor(fs, { room = 0.82, damp = 0.35, wet = 0.3, width = 1 } = {}) {
    const scale = fs / 44100;
    const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((n) => Math.round(n * scale));
    const aps = [556, 441, 341, 225].map((n) => Math.round(n * scale));
    const spread = Math.round(23 * scale);
    this.l = { c: combs.map((n) => ({ buf: new Float32Array(n), i: 0, store: 0 })), a: aps.map((n) => ({ buf: new Float32Array(n), i: 0 })) };
    this.r = { c: combs.map((n) => ({ buf: new Float32Array(n + spread), i: 0, store: 0 })), a: aps.map((n) => ({ buf: new Float32Array(n + spread), i: 0 })) };
    this.room = room; this.damp = damp; this.wet = wet; this.width = width;
  }

  _ch(ch, x) {
    let out = 0;
    for (const c of ch.c) {
      const y = c.buf[c.i];
      c.store = y * (1 - this.damp) + c.store * this.damp;
      c.buf[c.i] = x + c.store * this.room;
      if (++c.i >= c.buf.length) c.i = 0;
      out += y;
    }
    for (const a of ch.a) {
      const b = a.buf[a.i];
      const y = -out + b;
      a.buf[a.i] = out + b * 0.5;
      if (++a.i >= a.buf.length) a.i = 0;
      out = y;
    }
    return out;
  }

  /** Returns [wetL, wetR] for a stereo input sample. */
  process(l, r) {
    const input = (l + r) * 0.015;
    const wl = this._ch(this.l, input);
    const wr = this._ch(this.r, input);
    const w1 = this.wet * (this.width / 2 + 0.5);
    const w2 = this.wet * ((1 - this.width) / 2);
    return [wl * w1 + wr * w2, wr * w1 + wl * w2];
  }
}
