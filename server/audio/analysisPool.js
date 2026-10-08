// Tiny job queue in front of a single analysis worker thread. The worker (a whole JavaScript engine,
// ~15 MB) is started when there's work and retired after a couple of idle minutes: songs arrive a few
// an hour, so most of the time there's nothing for it to do.
import { Worker } from 'node:worker_threads';

const IDLE_MS = 120_000;
let worker = null;
let seq = 0;
let idleTimer = null;
const pending = new Map();

function retireWhenIdle() {
  clearTimeout(idleTimer);
  if (pending.size) return;
  idleTimer = setTimeout(() => { if (!pending.size && worker) { const w = worker; worker = null; w.terminate(); } }, IDLE_MS);
  idleTimer.unref?.();
}

function getWorker() {
  clearTimeout(idleTimer);
  if (worker) return worker;
  const w = new Worker(new URL('./analysisWorker.js', import.meta.url));
  worker = w;
  w.unref();
  w.on('message', ({ id, result, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error)); else p.resolve(result);
    retireWhenIdle();
  });
  w.on('error', (err) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    if (worker === w) worker = null;
  });
  return w;
}

/**
 * Run an analysis command on the PCM. The worker gets a copy, or with `{ handOver: true }` the caller's
 * own buffer (when the PCM spans all of it), which the caller must not use afterwards.
 * @param {'head'|'tail'|'loudness'|'peaks'} cmd
 * @param {Int16Array} pcm
 */
export function analyze(cmd, pcm, opts = {}, { handOver = false } = {}) {
  const whole = pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength;
  const copy = handOver && whole ? pcm : pcm.slice();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, cmd, buffer: copy.buffer, opts }, [copy.buffer]);
  });
}

/**
 * Run a heavy, input-less job (e.g. rendering a music bed) in its own short-lived worker,
 * so it never queues in front of song analysis.
 */
export function oneShot(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./analysisWorker.js', import.meta.url));
    const done = (fn) => (v) => { w.terminate(); fn(v); };
    w.once('message', ({ result, error }) => (error ? done(reject)(new Error(error)) : done(resolve)(result)));
    w.once('error', done(reject));
    const empty = new Int16Array(0);
    w.postMessage({ id: 0, cmd, buffer: empty.buffer, opts }, [empty.buffer]);
  });
}
