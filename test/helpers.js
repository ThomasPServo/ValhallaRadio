import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the JSON store for tests. Must be imported before any server module.
process.env.VALHALLA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'valhalla-test-'));

/** Stereo Int16 PCM of a sine wave. */
export function sine(seconds, { freq = 440, amp = 0.5, sampleRate = 44100, padStart = 0, padEnd = 0 } = {}) {
  const n = Math.floor(seconds * sampleRate);
  const a = Math.floor(padStart * sampleRate);
  const z = Math.floor(padEnd * sampleRate);
  const pcm = new Int16Array((a + n + z) * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp * 32767);
    pcm[(a + i) * 2] = v;
    pcm[(a + i) * 2 + 1] = v;
  }
  return pcm;
}
