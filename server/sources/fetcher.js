// Chunked, parallel, resumable fetching for slow or throttled audio origins.
//
// The monochrome stream origin sends roughly 10-20 KB/s per connection and cuts every connection after
// about 30 seconds (some servers see only ~260 KB per connection), while lossless FLAC needs ~100-140
// KB/s to play in real time. One long-lived connection can never keep up. Instead, every song is
// fetched as small Range chunks (each finishes well inside the cut-off) over a shared pool of parallel
// connections into the music cache:
//  - the pool adapts: it adds connections while the origin keeps up and halves them on 429 / 5xx
//    (bursts of 16+ connections get refused), and a cut connection resumes from its last byte;
//  - the song needed soonest gets the connections first; songs further down the log prefetch behind it;
//  - playback can start from the first contiguous bytes while the rest arrives (`read()`);
//  - progress is kept beside the partial file, so a restart resumes instead of starting over.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { EventEmitter, once } from 'node:events';
import { store } from '../store.js';

// The origin relays files in 128 KB blocks at ~9-20 KB/s per connection and resets each connection at ~30 s:
// a one-block request finishes well inside that, where a two-block one is often cut at the end.
export const CHUNK = Math.max(16, Number(process.env.VALHALLA_FETCH_CHUNK_KB) || 128) * 1024;
export const BACKGROUND = 5000; // priorities from here up are cache warming: never dropped, always last
const UA = 'ValhallaRadio/0.2 (+radio automation)';
const STALL_MS = 6 * 60_000; // no progress at all for this long: give up on the song
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ the shared connection pool

export const pool = {
  limit: 3,
  active: 0,
  cooldownUntil: 0,
  bytes: 0,
  errors: 0,
  max() { return Math.max(1, Math.min(12, Number(store.settings.monochromeConnections) || 6)); },
  ok() { this.limit = Math.min(this.max(), this.limit + 1); },
  /** 429: the origin is rate-limiting us, so halve. A 52x is the origin hiccuping: ease off by one. */
  backoff(status) {
    this.errors++;
    if (status === 429) {
      this.limit = Math.max(1, Math.floor(this.limit / 2));
      this.cooldownUntil = Date.now() + 3000;
    } else {
      this.limit = Math.max(1, this.limit - 1);
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + 1000);
    }
  },
};
const fetches = new Map(); // key -> TrackFetch
let timer = null;

function schedule() {
  clearTimeout(timer);
  const wait = pool.cooldownUntil - Date.now();
  if (wait > 0) { timer = setTimeout(schedule, wait + 10); return; }
  const live = [...fetches.values()].filter((f) => !f.finished).sort((a, b) => a.priority - b.priority);
  for (const f of live) {
    while (pool.active < Math.floor(pool.limit)) {
      const c = f.nextChunk();
      if (!c) break;
      runChunk(f, c);
    }
    if (pool.active >= Math.floor(pool.limit)) break;
  }
}

// a byte-rate tracker over the last ~20 seconds
function rateTracker() {
  const pts = [];
  return {
    add(n) { const t = Date.now(); pts.push([t, n]); while (pts.length && t - pts[0][0] > 20_000) pts.shift(); },
    perSec() {
      if (pts.length < 2) return 0;
      const span = Math.max(2000, Date.now() - pts[0][0]);
      return (pts.reduce((s, p) => s + p[1], 0) * 1000) / span;
    },
  };
}
const poolRate = rateTracker();

// ------------------------------------------------------------------ one song

export class TrackFetch extends EventEmitter {
  constructor(key, url, file, { priority = 1000 } = {}) {
    super();
    this.setMaxListeners(50);
    this.key = key; this.url = url; this.file = file;
    this.part = `${file}.part`; this.metaFile = `${file}.part.json`;
    this.priority = priority;
    this.total = null; this.chunks = null;
    this.finished = false; this.error = null;
    this.lastProgress = Date.now();
    this.rate = rateTracker();
    this.fh = null;
    this.readers = 0;
    this.wanted = false; // someone awaits the whole file (download): never dropped
    this.restore();
    this.done = new Promise((resolve, reject) => { this._resolve = resolve; this._reject = reject; });
    this.done.catch(() => {});
  }

  restore() {
    try {
      const m = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
      if (m.total && m.chunk > 0 && fs.existsSync(this.part) && fs.statSync(this.part).size === m.total) {
        this.initChunks(m.total);
        // progress saved with any chunk size: each saved chunk is a filled prefix [start, start + got)
        for (const [i, got] of m.got.entries()) {
          const start = i * m.chunk; const filled = start + got;
          for (const c of this.chunks) if (c.start >= start && c.start < filled) c.got = Math.min(c.end - c.start + 1, filled - c.start);
        }
      }
    } catch { /* fresh start */ }
  }

  initChunks(total) {
    this.total = total;
    const n = Math.ceil(total / CHUNK);
    this.chunks = Array.from({ length: n }, (_, i) => ({ start: i * CHUNK, end: Math.min(total, (i + 1) * CHUNK) - 1, got: 0, busy: false }));
  }

  /** Lowest missing chunk not already in flight (in order, so playback can start early). Before the size is known, only one probe. */
  nextChunk() {
    if (this.finished) return null;
    if (!this.chunks) return this.probing ? null : (this.probing = { start: 0, end: CHUNK - 1, got: 0, busy: false, probe: true });
    return this.chunks.find((c) => !c.busy && c.got < c.end - c.start + 1) || null;
  }

  /** Bytes available from the start of the file with no gaps. */
  contiguous() {
    if (this.finished && !this.error) return this.total;
    if (!this.chunks) return this.probing?.got || 0;
    let n = 0;
    for (const c of this.chunks) {
      n += c.got;
      if (c.got < c.end - c.start + 1) break;
    }
    return n;
  }

  received() { return this.chunks ? this.chunks.reduce((s, c) => s + c.got, 0) : (this.probing?.got || 0); }

  /** Seconds until the whole file is here at the current rate (Infinity when stalled). */
  eta() {
    if (this.finished) return 0;
    if (!this.total) return Infinity;
    const r = Math.max(this.rate.perSec(), 1);
    return (this.total - this.received()) / r;
  }

  async handle() {
    if (!this.fh) {
      this.fh = await fsp.open(this.part, fs.existsSync(this.part) ? 'r+' : 'w+');
      if (this.total) await this.fh.truncate(this.total);
    }
    return this.fh;
  }

  saveMeta(force = false) {
    if (!this.chunks || this.finished) return;
    const now = Date.now();
    if (!force && now - (this._savedAt || 0) < 2000) return;
    this._savedAt = now;
    fs.writeFile(this.metaFile, JSON.stringify({ total: this.total, chunk: CHUNK, got: this.chunks.map((c) => c.got) }), () => {});
  }

  async finalize() {
    if (this.finished) return;
    this.finished = true;
    try {
      await this.fh?.close();
      this.fh = null;
      await fsp.rename(this.part, this.file);
      await fsp.rm(this.metaFile, { force: true });
      fetches.delete(this.key);
      this.emit('progress');
      this._resolve(this.file);
      this.emit('done', this.file);
    } catch (err) { this.fail(err); }
  }

  fail(err) {
    if (this.error) return;
    this.error = err;
    this.finished = true;
    fetches.delete(this.key);
    this.fh?.close().catch(() => {});
    this.fh = null;
    this.saveMetaSync();
    this._reject(err);
    this.emit('fail', err);
    this.emit('progress');
  }

  saveMetaSync() {
    if (!this.chunks) return;
    try { fs.writeFileSync(this.metaFile, JSON.stringify({ total: this.total, chunk: CHUNK, got: this.chunks.map((c) => c.got) })); } catch { /* best effort */ }
  }

  /**
   * The file's bytes from `from` on, as they arrive (playback while fetching).
   * @returns {AsyncGenerator<Buffer>}
   */
  async *read(from = 0) {
    let fh = null;
    this.readers++;
    try {
      for (;;) {
        const avail = this.contiguous();
        if (from < avail) {
          if (!fh) fh = await fsp.open(this.finished && !this.error ? this.file : this.part, 'r');
          const n = Math.min(avail - from, CHUNK);
          const buf = Buffer.allocUnsafe(n);
          const { bytesRead } = await fh.read(buf, 0, n, from);
          if (!bytesRead) throw new Error('cache file shrank');
          from += bytesRead;
          yield buf.subarray(0, bytesRead);
          continue;
        }
        if (this.error) throw this.error;
        if (this.finished && this.total != null && from >= this.total) return;
        await Promise.race([once(this, 'progress'), sleep(1000)]);
      }
    } finally {
      this.readers--;
      await fh?.close().catch(() => {});
    }
  }

  stats() {
    return { key: this.key, priority: this.priority, total: this.total, received: this.received(), contiguous: this.contiguous(), rate: Math.round(this.rate.perSec()), eta: Number.isFinite(this.eta()) ? Math.round(this.eta()) : null };
  }
}

async function runChunk(f, c) {
  c.busy = true;
  pool.active++;
  const from = c.start + c.got;
  let progressed = false;
  try {
    const res = await fetch(f.url, { headers: { 'User-Agent': UA, Range: `bytes=${from}-${c.end}` }, signal: AbortSignal.timeout(60_000) });
    if (res.status === 429 || res.status >= 500) { res.body?.cancel().catch(() => {}); throw Object.assign(new Error(`HTTP ${res.status}`), { throttle: true, status: res.status }); }
    if (res.status === 404 || res.status === 410 || res.status === 403) throw Object.assign(new Error(`HTTP ${res.status}: not available`), { fatal: true });
    if (res.status !== 206 && !(res.status === 200 && from === 0)) throw new Error(`HTTP ${res.status}`);
    if ((res.headers.get('content-type') || '').startsWith('text/')) throw Object.assign(new Error('the origin sent an error page'), { throttle: true });
    const range = res.headers.get('content-range');
    const total = range && /\/(\d+)$/.test(range) ? Number(range.match(/\/(\d+)$/)[1]) : res.status === 200 ? Number(res.headers.get('content-length')) || null : null;
    if (c.probe) {
      if (!total) throw Object.assign(new Error('the origin did not say how big the file is'), { fatal: true });
      if (f.total && f.total !== total) throw Object.assign(new Error('the file changed upstream'), { fatal: true });
      if (!f.chunks) f.initChunks(total);
      c = Object.assign(f.chunks[0], { busy: true }); // the probe fills the first chunk
      f.probing = null;
    }
    const fh = await f.handle();
    const len = c.end - c.start + 1;
    for await (const buf of res.body) {
      const take = Math.min(buf.length, len - c.got);
      if (take <= 0) break;
      await fh.write(buf, 0, take, c.start + c.got);
      c.got += take;
      progressed = true;
      f.lastProgress = Date.now();
      f.rate.add(take); poolRate.add(take); pool.bytes += take;
      f.emit('progress');
      if (c.got >= len) break;
    }
    pool.ok();
  } catch (err) {
    if (err.fatal) f.fail(err);
    else if (err.throttle) pool.backoff(err.status);
    else if (!progressed) pool.limit = Math.max(1, pool.limit - 0.5); // dropped before any byte: ease off a little
    // a connection cut mid-chunk (the origin's ~30 s limit) just resumes from c.got next time
  } finally {
    c.busy = false;
    if (c.probe) f.probing = null;
    pool.active--;
    if (!f.finished) {
      f.saveMeta();
      if (f.chunks && f.chunks.every((x) => x.got >= x.end - x.start + 1)) await f.finalize();
      else if (Date.now() - f.lastProgress > STALL_MS) f.fail(new Error('the origin stopped sending this song'));
    }
    setImmediate(schedule);
  }
}

// ------------------------------------------------------------------ registry

/**
 * Start (or join) fetching `url` into `file`. A lower priority number is fetched first.
 * @returns {TrackFetch}
 */
export function getFetch(key, url, file, { priority = 1000 } = {}) {
  let f = fetches.get(key);
  if (!f) {
    f = new TrackFetch(key, url, file, { priority });
    fetches.set(key, f);
  } else f.priority = Math.min(f.priority, priority);
  setImmediate(schedule);
  return f;
}

export function setPriority(key, priority) {
  const f = fetches.get(key);
  if (f) f.priority = priority;
}

export function activeFetch(key) { return fetches.get(key) || null; }

/** Stop fetching songs that are no longer wanted (their progress is kept for later). */
export function dropFetches(keep) {
  for (const [key, f] of fetches) {
    if (keep.has(key) || f.readers > 0 || f.wanted || f.priority >= BACKGROUND) continue; // in use, awaited, or warming the cache
    f.priority = 1e9; // in-flight chunks finish (their bytes are kept), nothing new starts
    if ((f.chunks || []).some((c) => c.busy) || f.probing) continue;
    f.finished = true;
    f.saveMetaSync();
    f.fh?.close().catch(() => {});
    fetches.delete(key);
  }
}

export function fetcherStatus() {
  return {
    connections: pool.active, limit: Math.floor(pool.limit), max: pool.max(), rate: Math.round(poolRate.perSec()), throttled: pool.errors,
    songs: [...fetches.values()].sort((a, b) => a.priority - b.priority).map((f) => f.stats()),
  };
}
