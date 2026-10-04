// Tiny job queue in front of a single analysis worker thread.
import { Worker } from 'node:worker_threads';

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./analysisWorker.js', import.meta.url));
  worker.unref();
  worker.on('message', ({ id, result, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error)); else p.resolve(result);
  });
  worker.on('error', (err) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker = null;
  });
  return worker;
}

/**
 * Run an analysis command on a copy of the PCM (the copy's buffer is transferred, not cloned).
 * @param {'head'|'tail'|'loudness'|'peaks'} cmd
 * @param {Int16Array} pcm
 */
export function analyze(cmd, pcm, opts = {}) {
  const copy = pcm.slice();
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
