// Playback sources and gain automation for the master timeline.

const FLOOR_DB = -60;

/** Automation lane: breakpoints in absolute frames, interpolated linearly, in dB, or with an S-curve. */
export class Lane {
  constructor(v = 1) { this.pts = [{ f: -Infinity, v }]; }

  value(f) {
    const p = this.pts;
    let i = p.length - 1;
    while (i > 0 && p[i].f > f) i--;
    const a = p[i]; const b = p[i + 1];
    if (!b || !Number.isFinite(a.f)) return a.v; // hold before the first ramp
    const t = (f - a.f) / (b.f - a.f);
    if (b.curve === 'db') {
      if (t >= 1) return b.v;
      const da = 20 * Math.log10(Math.max(a.v, 1e-3)); const dbb = 20 * Math.log10(Math.max(b.v, 1e-3));
      const db = Math.max(FLOOR_DB, da) + (Math.max(FLOOR_DB, dbb) - Math.max(FLOOR_DB, da)) * t;
      return db <= FLOOR_DB + 0.01 && b.v === 0 ? 0 : Math.pow(10, db / 20);
    }
    if (b.curve === 'cos') return a.v + (b.v - a.v) * (1 - Math.cos(Math.PI * t)) / 2;
    return a.v + (b.v - a.v) * t;
  }

  /** Ramp from the current value at f0 to `to` at f1; later automation is replaced. */
  ramp(f0, f1, to, curve = 'lin') {
    const v0 = this.value(f0);
    this.pts = this.pts.filter((p) => p.f < f0);
    this.pts.push({ f: f0, v: v0 }, { f: Math.max(f1, f0 + 1), v: to, curve });
  }

  /** Breakpoints after `from` (for drawing automation in the UI). */
  points(from) { return this.pts.filter((p) => p.f > from - 1e9 && Number.isFinite(p.f)); }
}

class Source {
  constructor({ item, kind, start, base = 1, markers = {}, overlay = false }) {
    this.item = item;
    this.kind = kind;
    this.start = start; // absolute frame of the first sample
    this.base = base;
    this.markers = markers;
    this.overlay = overlay;
    this.fade = new Lane(1);
    this.duck = new Lane(1);
    this.done = false;
    this.underrun = 0;
  }

  gainAt(f) { return this.base * this.fade.value(f) * this.duck.value(f); }
}

/** Fully decoded short audio (voice, imaging, spots, carts). */
export class BufferSource extends Source {
  constructor(o) {
    super(o);
    this.audio = o.audio;
    this.pos = o.audio.startFrame;
    this.end = o.audio.endFrame;
  }

  get len() { return (this.end - this.audio.startFrame) / 44100; }
  get position() { return (this.pos - this.audio.startFrame) / 44100; }

  mix(dst, off, n, g0, g1) {
    const pcm = this.audio.pcm;
    const m = Math.min(n, this.end - this.pos);
    for (let i = 0; i < m; i++) {
      const g = (g0 + ((g1 - g0) * i) / n) / 32768;
      const s = (this.pos + i) * 2; const o = (off + i) * 2;
      dst[o] += pcm[s] * g; dst[o + 1] += pcm[s + 1] * g;
    }
    this.pos += m;
    if (this.pos >= this.end) this.done = true;
    return m;
  }

  release() { this.audio = null; }
}

/** A song streaming through a StreamDecoder. */
export class StreamSource extends Source {
  constructor(o) {
    super(o);
    this.decoder = o.decoder;
    this.trimStart = o.trimStart || 0; // frames
    this.trimEnd = o.trimEnd || null; // frames (null until known)
    this.lenHint = o.lenHint || 240;
    this.decoder.skipTo(this.trimStart);
  }

  get endFrame() {
    if (this.trimEnd) return this.trimEnd;
    if (this.decoder.ended) return this.decoder.decoded;
    return this.trimStart + Math.round(this.lenHint * 44100);
  }

  get len() { return (this.endFrame - this.trimStart) / 44100; }
  get position() { return (this.decoder.readPos - this.trimStart) / 44100; }

  mix(dst, off, n, g0, g1) {
    const left = this.endFrame - this.decoder.readPos;
    const m = Math.max(0, Math.min(n, left));
    const got = m ? this.decoder.mixInto(dst, off, m, g0, g0 + ((g1 - g0) * m) / n) : 0;
    if (got < m) this.underrun += m - got; else this.underrun = 0;
    if (this.decoder.readPos >= this.endFrame && (this.decoder.ended || this.trimEnd)) this.done = true;
    if (this.decoder.error && this.decoder.aheadFrames() <= 0) this.done = true;
    return got;
  }

  release() { this.decoder.close(); }
}

/** A music bed looping from memory until its fade lane takes it out (auto-bed under DJ talk). */
export class LoopSource extends Source {
  constructor(o) {
    super(o);
    this.audio = o.audio; // { pcm, frames, name }
    this.pos = 0; // starts on the downbeat of the loop
    this.fade = new Lane(0);
    this.on = false;
    this.offAt = 0;
  }

  get len() { return this.audio.frames / 44100; }
  get position() { return this.pos / 44100; }

  mix(dst, off, n, g0, g1) {
    const pcm = this.audio.pcm; const L = this.audio.frames;
    let p = this.pos;
    for (let i = 0; i < n; i++) {
      const g = (g0 + ((g1 - g0) * i) / n) / 32768;
      const s = p * 2; const o = (off + i) * 2;
      dst[o] += pcm[s] * g; dst[o + 1] += pcm[s + 1] * g;
      if (++p >= L) p = 0;
    }
    this.pos = p;
    return n;
  }

  release() { this.audio = null; }
}
