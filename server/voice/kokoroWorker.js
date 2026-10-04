// Child process running the Kokoro TTS model (installed on demand into the data folder).
// Runs at low priority so speech synthesis can never starve the real-time audio engine.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.env.KOKORO_DIR;
const cacheDir = process.env.KOKORO_MODELS;
try { os.setPriority(process.pid, 15); } catch { /* not permitted on every OS */ }

const mod = (p) => import(pathToFileURL(path.join(dir, 'node_modules', p)).href);
const { env } = await mod('@huggingface/transformers/dist/transformers.node.mjs');
env.cacheDir = cacheDir;
env.allowLocalModels = true;
const { KokoroTTS, TextSplitterStream } = await mod('kokoro-js/dist/kokoro.js');

// load once (concurrent first requests must not download the model twice into the same file)
let loading = null;
function model() {
  if (!loading) {
    loading = KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: process.env.KOKORO_DTYPE || 'q8', device: 'cpu' })
      .catch((err) => { loading = null; throw err; });
  }
  return loading;
}

function writeWav(file, samples, rate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

/** Trim a sentence's own padding (Kokoro pads every chunk) so we control the pauses between sentences. */
function trimChunk(a, rate) {
  const thr = 0.004;
  let s = 0; while (s < a.length && Math.abs(a[s]) < thr) s++;
  let e = a.length; while (e > s && Math.abs(a[e - 1]) < thr) e--;
  return a.subarray(Math.max(0, s - Math.round(rate * 0.015)), Math.min(a.length, e + Math.round(rate * 0.05)));
}

/** Natural pause after a sentence, from how it ends (a question breathes a little longer). */
function pauseAfter(chunkText, pause) {
  const t = String(chunkText || '').trim();
  if (/(\.\.\.|…|—|-)$/.test(t)) return pause * 1.35;
  if (/\?$/.test(t)) return pause * 1.15;
  if (/[,;:]$/.test(t)) return pause * 0.6;
  return pause;
}

async function speak({ id, text, voice, speed, pause = 0.3, out }, retry = true) {
  try {
    const m = await model();
    const parts = [];
    let rate = 24000;
    // sentence-by-sentence: a single generate() call truncates long text. The splitter must be
    // closed, otherwise the stream waits forever for more text after the last sentence.
    const splitter = new TextSplitterStream();
    splitter.push(text);
    splitter.close();
    for await (const chunk of m.stream(splitter, { voice: voice || 'af_heart', speed: speed || 1 })) {
      rate = chunk.audio.sampling_rate;
      parts.push(trimChunk(chunk.audio.audio, rate), new Float32Array(Math.round(rate * pauseAfter(chunk.text, pause))));
    }
    parts.pop(); // no pause after the last sentence
    const total = parts.reduce((s, p) => s + p.length, 0);
    const all = new Float32Array(total);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    writeWav(out, all, rate);
    process.send({ id, ok: true, file: out });
  } catch (err) {
    if (retry && /protobuf|load model|invalid|corrupt/i.test(err.message)) {
      // a damaged model download: wipe the cached copy and fetch it again once
      fs.rmSync(path.join(cacheDir, 'onnx-community'), { recursive: true, force: true });
      loading = null;
      return speak({ id, text, voice, speed, pause, out }, false);
    }
    process.send({ id, ok: false, error: err.message });
  }
}

// one synthesis at a time: predictable CPU use and no model races
let chain = Promise.resolve();
process.on('message', (msg) => { chain = chain.then(() => speak(msg)); });

process.send({ ready: true });
