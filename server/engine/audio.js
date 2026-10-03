import { spawn } from 'node:child_process';
import { FFMPEG, SAMPLE_RATE, CHANNELS } from '../config.js';
import { analyze, normalizeGain } from './mixer.js';

/** Decode any audio file/URL to interleaved s16le stereo PCM. */
export function decodeToPcm(input, { maxSeconds = 1200 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input, '-vn', '-t', String(maxSeconds),
      '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), 'pipe:1'];
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    p.stdout.on('data', (c) => chunks.push(c));
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', reject);
    p.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (code !== 0 && buf.length < SAMPLE_RATE * 4) return reject(new Error(`ffmpeg decode failed (${code}): ${err.slice(0, 300)}`));
      const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
      resolve(pcm);
    });
  });
}

/**
 * Decode + analyse an item so the engine can play it.
 * @returns {Promise<{pcm, startFrame, endFrame, gain, durationSec}>}
 */
export async function loadAudio(input, { normalize = true, targetDb = -17 } = {}) {
  const pcm = await decodeToPcm(input);
  const a = analyze(pcm, SAMPLE_RATE);
  if (a.endFrame - a.startFrame < SAMPLE_RATE * 0.3) throw new Error('audio is silent or too short');
  // keep a hair of the natural attack/decay
  const startFrame = Math.max(0, a.startFrame - Math.floor(SAMPLE_RATE * 0.01));
  const endFrame = Math.min(pcm.length / 2, a.endFrame + Math.floor(SAMPLE_RATE * 0.05));
  const gain = normalize ? normalizeGain(a.loudnessDb, targetDb) : 1;
  return { pcm, startFrame, endFrame, gain, loudnessDb: a.loudnessDb, durationSec: (endFrame - startFrame) / SAMPLE_RATE };
}

export function probeFfmpeg() {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 ? out.split('\n')[0] : null));
  });
}
