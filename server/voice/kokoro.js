// Kokoro: a free, local, open-weight neural voice (Apache-2.0). No API key, no per-use cost.
// Installed on demand into <data>/engines/kokoro (pruned to this platform) so the base install
// stays small; the model (~90 MB) downloads from Hugging Face on first use and is cached.

import fs from 'node:fs';
import path from 'node:path';
import { fork, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { DATA_DIR } from '../config.js';

const DIR = path.join(DATA_DIR, 'engines', 'kokoro');
const MODELS = path.join(DATA_DIR, 'models');
const VERSION = '1.2.1';

export const KOKORO_VOICES = {
  af_heart: 'Heart (US, female) — best', af_bella: 'Bella (US, female)', af_nicole: 'Nicole (US, female, soft)',
  af_sarah: 'Sarah (US, female)', af_kore: 'Kore (US, female)', af_aoede: 'Aoede (US, female)',
  am_michael: 'Michael (US, male)', am_fenrir: 'Fenrir (US, male)', am_puck: 'Puck (US, male, upbeat)',
  bf_emma: 'Emma (UK, female)', bf_isabella: 'Isabella (UK, female)', bm_george: 'George (UK, male)', bm_fable: 'Fable (UK, male)',
};

export const installEvents = new EventEmitter();
let installing = null;
let worker = null;
let ready = null;
let seq = 0;
const pending = new Map();

export function kokoroInstalled() {
  return fs.existsSync(path.join(DIR, 'node_modules', 'kokoro-js', 'package.json'));
}

export function kokoroStatus() {
  return { installed: kokoroInstalled(), installing: Boolean(installing), modelCached: fs.existsSync(MODELS) && fs.readdirSync(MODELS).length > 0, dir: DIR };
}

/** npm-install kokoro-js into the data folder, then prune binaries for other platforms / GPUs. */
export function installKokoro() {
  if (kokoroInstalled()) return Promise.resolve(kokoroStatus());
  if (installing) return installing;
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(path.join(DIR, 'package.json'))) fs.writeFileSync(path.join(DIR, 'package.json'), JSON.stringify({ name: 'valhalla-kokoro', private: true }));
  installing = new Promise((resolve, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const p = spawn(npm, ['install', '--no-audit', '--no-fund', '--omit=dev', `kokoro-js@${VERSION}`], { cwd: DIR, env: process.env });
    const say = (d) => installEvents.emit('progress', String(d).trim().split('\n').pop());
    p.stdout.on('data', say);
    p.stderr.on('data', say);
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`npm install failed (${code})`));
      prune();
      resolve(kokoroStatus());
    });
  }).finally(() => { installing = null; });
  return installing;
}

function prune() {
  const bin = path.join(DIR, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3');
  if (!fs.existsSync(bin)) return;
  for (const plat of fs.readdirSync(bin)) {
    for (const arch of fs.readdirSync(path.join(bin, plat))) {
      const keep = plat === process.platform && arch === process.arch;
      const p = path.join(bin, plat, arch);
      if (!keep) { fs.rmSync(p, { recursive: true, force: true }); continue; }
      for (const f of fs.readdirSync(p)) if (/cuda|tensorrt/i.test(f)) fs.rmSync(path.join(p, f), { force: true }); // CPU-only
    }
  }
}

function startWorker() {
  if (ready) return ready;
  fs.mkdirSync(MODELS, { recursive: true });
  ready = new Promise((resolve, reject) => {
    worker = fork(new URL('./kokoroWorker.js', import.meta.url), [], {
      env: { ...process.env, KOKORO_DIR: DIR, KOKORO_MODELS: MODELS },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    worker.on('message', (m) => {
      if (m.ready) return resolve(worker);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.file); else p.reject(new Error(m.error));
    });
    worker.on('exit', (code) => {
      for (const p of pending.values()) p.reject(new Error(`voice engine exited (${code})`));
      pending.clear();
      worker = null; ready = null;
      reject(new Error(`voice engine exited (${code})`));
    });
  });
  return ready;
}

/** Synthesize to a WAV file (24 kHz mono). Requests run one at a time in the worker. */
export async function kokoroSpeak(text, { voice = 'af_heart', speed = 1, pause = 0.3, out }) {
  if (!kokoroInstalled()) throw new Error('The local voice engine is not installed yet (Settings → Voice).');
  const w = await startWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    // generous: the first request may include the one-time model download
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('voice engine timed out')); }, 240_000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    w.send({ id, text, voice, speed, pause, out });
  });
}

export function stopKokoro() { worker?.kill(); }
