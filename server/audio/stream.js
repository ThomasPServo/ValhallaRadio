// Streaming decoder for songs.
//
// Audio comes from a local file, from a chunked fetch that is still filling the music cache (`source`:
// playback starts on the first bytes while parallel connections fetch the rest), or from a single
// resumable HTTP fetch (`url`). It is piped into ffmpeg, which decodes to 44.1 kHz stereo s16 PCM.
// Decoding runs a bounded distance ahead of the playhead; when the buffer is full ffmpeg's stdout is
// paused and backpressure propagates back to the reader.
//
// While decoding we also build the waveform overview (peaks) and measure K-weighted loudness, so
// analysis needs no extra network traffic (songs whose analysis and waveform are known skip this).
//
// A song from a local file that is prepared but not yet on air can let its ffmpeg go once its read-ahead
// is full (`releaseWhenIdle`): it holds a few seconds of audio and no process. When playback needs more,
// ffmpeg starts again from the top and skips what is already decoded (decoding is deterministic, so the
// join is sample-exact).

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { FFMPEG } from '../config.js';
import { kWeighting } from './dsp.js';
import { gatedLoudness } from './analysis.js';

export const SR = 44100;
const BYTES_PER_FRAME = 4;
const PEAK_RES = 0.05; // seconds per waveform point
const UA = 'Valhalla Radio Automation/0.2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class StreamDecoder extends EventEmitter {
  /**
   * @param {{url?: string, file?: string, source?: import('../sources/fetcher.js').TrackFetch, label?: string, maxAheadSec?: number,
   *   keepBehindSec?: number, durationHint?: number, analyse?: boolean, releaseWhenIdle?: boolean, retain?: {headSec: number, tailSec: number}}} o
   *   analyse: build peaks and loudness while decoding (default true).
   *   retain: decode everything without pausing but hold only the head and the tail (for analysis).
   */
  constructor(o) {
    super();
    this.url = o.url;
    this.source = o.source || null;
    this.file = o.file;
    this.label = o.label || o.url || o.file;
    this.maxAhead = o.retain ? Infinity : Math.round((o.maxAheadSec ?? 75) * SR);
    this.keepBehind = Math.round((o.keepBehindSec ?? 35) * SR);
    this.analyseOn = o.analyse !== false;
    this.retain = o.retain ? { head: Math.round(o.retain.headSec * SR), tail: Math.round(o.retain.tailSec * SR) } : null;
    this.releaseWhenIdle = Boolean(o.releaseWhenIdle && o.file);
    this.released = false; // ffmpeg let go while waiting for air
    this.touched = false; // playback has begun
    this._skip = 0; // bytes to drop after a restart (already decoded)
    this.chunks = []; // { start: frame, data: Int16Array }
    this.decoded = 0;
    this.readPos = 0;
    this.ended = false;
    this.error = null;
    this.closed = false;
    this.paused = false;
    this.bytes = 0;
    this.totalBytes = null;
    this.retries = 0;
    this.startedAt = Date.now();
    this.firstAudioAt = null;
    this._rem = null;
    // waveform + loudness accumulators
    const hint = Math.max(60, o.durationHint || 300);
    this.peaks = new Int8Array(this.analyseOn ? Math.ceil((hint + 30) / PEAK_RES) * 2 : 0);
    this.peakCount = 0;
    this._pk = { lo: 0, hi: 0, n: 0, step: Math.round(SR * PEAK_RES) };
    this._kl = kWeighting(SR); this._kr = kWeighting(SR);
    this._ms = { acc: 0, n: 0, hop: Math.round(SR * 0.1), blocks: [] };
  }

  start() {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    args.push('-i', this.file || 'pipe:0', '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '2', '-ar', String(SR), 'pipe:1');
    if (!this.file) args.splice(args.indexOf('-nostdin'), 1);
    this.proc = spawn(FFMPEG, args, { stdio: [this.file ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let err = '';
    this.proc.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-2000); });
    this.proc.stdout.on('data', (c) => this._onPcm(c));
    this.proc.on('error', (e) => this._fail(e));
    const from = this.decoded; // more than this means this run delivered audio
    this.proc.on('close', (code) => {
      if (this.closed) return;
      if (code !== 0 && from > 0 && this.decoded <= from) this._fail(new Error(`decoder restart failed (${code}): ${err.trim().split('\n').pop() || 'no audio'}`));
      else if (code === 0 || this.decoded > SR * 5) {
        this._finish();
      } else this._fail(new Error(`decoder exited (${code}): ${err.trim().split('\n').pop() || 'no audio'}`));
    });
    if (!this.file) {
      this.proc.stdin.on('error', () => {});
      if (this.source) this._pumpSource(); else this._pump();
    }
    return this;
  }

  /** Wait until ffmpeg's stdin can take more (or ffmpeg is gone), leaving no listeners behind. */
  _drained() {
    return new Promise((resolve) => {
      const done = () => { this.proc.stdin.off('drain', done); this.proc.off('close', done); resolve(); };
      this.proc.stdin.once('drain', done);
      this.proc.once('close', done);
    });
  }

  /** Feed ffmpeg from a chunked fetch as its bytes arrive. */
  async _pumpSource() {
    try {
      for await (const chunk of this.source.read(0)) {
        if (this.closed) return;
        this.totalBytes = this.source.total;
        this.bytes += chunk.length;
        if (!this.proc.stdin.write(chunk)) await this._drained();
      }
      if (!this.closed) this.proc.stdin.end();
    } catch (err) {
      if (!this.closed) this._fail(new Error(`stream failed: ${err.message}`));
    }
  }

  async _pump() {
    let attempt = 0;
    let skip = 0;
    while (!this.closed) {
      this.abort = new AbortController();
      let lastByte = Date.now();
      let waiting = false;
      const watchdog = setInterval(() => { if (!waiting && Date.now() - lastByte > 25000) this.abort.abort(); }, 5000);
      try {
        const headers = { 'User-Agent': UA };
        if (this.bytes > 0) headers.Range = `bytes=${this.bytes}-`;
        const res = await fetch(this.url, { headers, signal: this.abort.signal });
        if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status}`);
        const type = res.headers.get('content-type') || '';
        if (type.startsWith('text/')) throw new Error(`unexpected ${type}`);
        const range = res.headers.get('content-range');
        if (range && /\/(\d+)$/.test(range)) this.totalBytes = Number(range.match(/\/(\d+)$/)[1]);
        else if (res.status === 200) this.totalBytes = Number(res.headers.get('content-length')) || null;
        skip = res.status === 200 ? this.bytes : 0; // server ignored our Range: drop what we already have
        for await (let chunk of res.body) {
          if (this.closed) return;
          lastByte = Date.now();
          if (skip) {
            if (chunk.length <= skip) { skip -= chunk.length; continue; }
            chunk = chunk.subarray(skip); skip = 0;
          }
          this.bytes += chunk.length;
          attempt = 0;
          if (!this.proc.stdin.write(chunk)) {
            waiting = true;
            await this._drained();
            waiting = false;
            lastByte = Date.now();
          }
        }
        if (this.totalBytes && this.bytes < this.totalBytes) throw new Error('connection closed early');
        this.proc.stdin.end();
        return;
      } catch (err) {
        if (this.closed) return;
        attempt++;
        this.retries++;
        this.emit('retry', { attempt, error: err.message, bytes: this.bytes });
        if (attempt > 8) { this._fail(new Error(`stream failed: ${err.message}`)); return; }
        await sleep(Math.min(8000, 300 * 2 ** attempt));
      } finally {
        clearInterval(watchdog);
      }
    }
  }

  _onPcm(buf) {
    if (this._skip) { // restarted from the top: these bytes were decoded before
      if (buf.length <= this._skip) { this._skip -= buf.length; return; }
      buf = buf.subarray(this._skip); this._skip = 0;
    }
    if (this._rem) { buf = Buffer.concat([this._rem, buf]); this._rem = null; }
    const usable = buf.length - (buf.length % BYTES_PER_FRAME);
    if (usable < buf.length) this._rem = Buffer.from(buf.subarray(usable));
    if (!usable) return;
    // copy into an aligned Int16Array (Buffer offsets aren't guaranteed to be 2-byte aligned)
    const data = new Int16Array(usable / 2);
    Buffer.from(data.buffer).set(buf.subarray(0, usable));
    const frames = data.length / 2;
    this.chunks.push({ start: this.decoded, data });
    if (this.analyseOn) this._analyse(data);
    this.decoded += frames;
    if (this.retain) this._dropMiddle();
    if (!this.firstAudioAt) this.firstAudioAt = Date.now();
    if (!this.paused && this.decoded - this.readPos > this.maxAhead) {
      if (this.releaseWhenIdle && !this.touched) this._release();
      else { this.paused = true; this.proc.stdout.pause(); }
    }
    this.emit('progress');
  }

  /** Analysis keeps the head and the last `tail` frames; the middle is only needed for loudness and peaks. */
  _dropMiddle() {
    const cs = this.chunks; const keepFrom = this.decoded - this.retain.tail;
    let i = 0;
    while (i < cs.length && cs[i].start < this.retain.head) i++;
    let j = i;
    while (j < cs.length - 1 && cs[j].start + cs[j].data.length / 2 <= keepFrom) j++;
    if (j > i) cs.splice(i, j - i);
  }

  /** Let ffmpeg go, keeping what's decoded (a prepared song waiting for air). */
  _release() {
    const p = this.proc;
    if (!p || this.released || this.closed) return;
    this.released = true;
    this.proc = null;
    p.removeAllListeners('close');
    p.stdout.removeAllListeners('data');
    p.on('error', () => {});
    try { p.kill('SIGKILL'); } catch { /* already gone */ }
    this._rem = null; // a partial frame past `decoded`: decoded again after the restart
  }

  /** Start ffmpeg again from the top, dropping the frames already held. */
  _restart() {
    this.released = false;
    this._skip = this.decoded * BYTES_PER_FRAME;
    this.start();
  }

  _analyse(data) {
    const pk = this._pk; const ms = this._ms;
    const [a1, a2] = this._kl; const [b1, b2] = this._kr;
    for (let i = 0; i < data.length; i += 2) {
      const l = data[i]; const r = data[i + 1];
      const m = (l + r) / 2;
      if (m < pk.lo) pk.lo = m; if (m > pk.hi) pk.hi = m;
      if (++pk.n >= pk.step) {
        if (this.peakCount * 2 + 2 > this.peaks.length) {
          const grown = new Int8Array(this.peaks.length * 2); grown.set(this.peaks); this.peaks = grown;
        }
        this.peaks[this.peakCount * 2] = Math.round((pk.lo / 32768) * 127);
        this.peaks[this.peakCount * 2 + 1] = Math.round((pk.hi / 32768) * 127);
        this.peakCount++;
        pk.lo = 0; pk.hi = 0; pk.n = 0;
      }
      const kl = a2.process(a1.process(l / 32768));
      const kr = b2.process(b1.process(r / 32768));
      ms.acc += kl * kl + kr * kr;
      if (++ms.n >= ms.hop) { ms.blocks.push(ms.acc / ms.n); ms.acc = 0; ms.n = 0; }
    }
  }

  _finish() {
    if (this.ended) return;
    this.ended = true;
    this.emit('end', { frames: this.decoded });
  }

  _fail(err) {
    if (this.error || this.closed) return;
    this.error = err;
    this.emit('error', err);
  }

  /** Integrated (gated) loudness of everything decoded so far. */
  loudness() {
    const b = this._ms.blocks; const ms = [];
    for (let i = 3; i < b.length; i++) {
      const v = (b[i] + b[i - 1] + b[i - 2] + b[i - 3]) / 4;
      if (-0.691 + 10 * Math.log10(v + 1e-12) > -70) ms.push(v);
    }
    return gatedLoudness(ms);
  }

  aheadFrames() { return this.decoded - this.readPos; }
  aheadSeconds() { return this.aheadFrames() / SR; }

  /** Seconds of audio available from the current read position (Infinity once fully decoded). */
  get totalFrames() { return this.ended ? this.decoded : null; }

  skipTo(frame) {
    this.touched = true;
    this.readPos = Math.max(0, frame);
    this._maintain();
  }

  /**
   * Mix `frames` frames (from the read position) into a Float32 interleaved buffer with a linear
   * gain ramp g0→g1. Returns the number of frames that were actually available (underrun if less).
   */
  mixInto(dst, dstOffset, frames, g0, g1) {
    this.touched = true;
    let done = 0;
    const want = Math.min(frames, this.decoded - this.readPos);
    let ci = this._findChunk(this.readPos);
    while (done < want && ci < this.chunks.length) {
      const c = this.chunks[ci];
      const from = this.readPos + done - c.start;
      const n = Math.min(want - done, c.data.length / 2 - from);
      const d = c.data;
      for (let i = 0; i < n; i++) {
        const g = (g0 + ((g1 - g0) * (done + i)) / frames) / 32768;
        const o = (dstOffset + done + i) * 2; const s = (from + i) * 2;
        dst[o] += d[s] * g; dst[o + 1] += d[s + 1] * g;
      }
      done += n;
      ci++;
    }
    this.readPos += frames; // the timeline advances even on underrun
    this._maintain();
    return done;
  }

  _findChunk(frame) {
    const cs = this.chunks;
    let lo = 0; let hi = cs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cs[mid].start <= frame) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  _maintain() {
    // drop audio far behind the playhead
    const keepFrom = this.readPos - this.keepBehind;
    while (this.chunks.length > 1 && this.chunks[0].start + this.chunks[0].data.length / 2 < keepFrom) this.chunks.shift();
    if (this.decoded - this.readPos < this.maxAhead * 0.8) {
      if (this.released) this._restart();
      else if (this.paused) { this.paused = false; this.proc?.stdout.resume(); }
    }
  }

  /** Copy of decoded PCM between two frames, if still held in memory. */
  range(from, to) {
    from = Math.max(from, this.chunks[0]?.start ?? 0);
    to = Math.min(to, this.decoded);
    if (to <= from) return null;
    const out = new Int16Array((to - from) * 2);
    let o = 0;
    for (let ci = this._findChunk(from); ci < this.chunks.length && from + o / 2 < to; ci++) {
      const c = this.chunks[ci];
      const s = Math.max(0, from + o / 2 - c.start);
      const n = Math.min(c.data.length / 2 - s, to - (from + o / 2));
      if (n <= 0) continue;
      out.set(c.data.subarray(s * 2, (s + n) * 2), o);
      o += n * 2;
    }
    return out.subarray(0, o);
  }

  peaksArray() { return this.peaks.subarray(0, this.peakCount * 2); }

  stats() {
    return {
      label: this.label,
      decodedSec: Math.round((this.decoded / SR) * 10) / 10,
      aheadSec: Math.round(this.aheadSeconds() * 10) / 10,
      ended: this.ended,
      mb: Math.round((this.bytes / 1048576) * 10) / 10,
      totalMb: this.totalBytes ? Math.round((this.totalBytes / 1048576) * 10) / 10 : null,
      retries: this.retries,
      source: this.file ? 'local' : this.source ? 'chunked' : 'stream',
      released: this.released,
      memMb: Math.round((this.chunks.reduce((s, c) => s + c.data.byteLength, 0) / 1048576) * 10) / 10,
    };
  }

  close() {
    this.closed = true;
    this.abort?.abort();
    try { this.proc?.kill('SIGKILL'); } catch { /* already gone */ }
    this.chunks = [];
    this.removeAllListeners();
  }
}

export const PEAK_SECONDS = PEAK_RES;
