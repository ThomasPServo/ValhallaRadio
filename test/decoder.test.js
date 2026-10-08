import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import './helpers.js';
import { FFMPEG } from '../server/config.js';
import { StreamDecoder, SR } from '../server/audio/stream.js';
import { analyze } from '../server/audio/analysisPool.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let file; let ref;

before(async () => {
  // 40 s of noise as an MP3: any sample out of place after a restart would show
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'valhalla-dec-')), 'song.mp3');
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=40:c=pink:r=44100:a=0.3', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k', file]);
  const d = new StreamDecoder({ file, maxAheadSec: 1e6 }).start();
  await once(d, 'end');
  ref = d.range(0, d.decoded);
  ref.loudness = d.loudness();
  ref.peaks = Array.from(d.peaksArray());
  d.close();
});

/** Play a decoder from `from` to the end the way the engine does, in 256-frame blocks. */
async function play(d, from) {
  d.skipTo(from);
  const out = [];
  const buf = new Float32Array(512);
  while (!(d.ended && d.readPos >= d.decoded)) {
    if (d.aheadFrames() < 256 && !d.ended && !d.error) { await sleep(2); continue; } // the test waits; air would not need to
    if (d.error && d.aheadFrames() <= 0) break;
    buf.fill(0);
    const got = d.mixInto(buf, 0, 256, 1, 1);
    for (let i = 0; i < got * 2; i++) out.push(buf[i]);
    if (!got) break;
  }
  return out;
}

test('a prepared song lets ffmpeg go while it waits, and plays on sample-exact after the restart', async () => {
  const d = new StreamDecoder({ file, maxAheadSec: 5, keepBehindSec: 1, analyse: false, releaseWhenIdle: true }).start();
  while (!d.released) await sleep(5);
  const held = d.decoded;
  assert.equal(d.proc, null, 'no ffmpeg while waiting for air');
  assert.ok(held >= 5 * SR && held < 7 * SR, `holds ${held / SR}s`);
  await sleep(100);
  assert.equal(d.decoded, held, 'nothing decoded while released');
  const from = Math.round(0.3 * SR);
  const got = await play(d, from);
  const want = Array.from(ref.subarray(from * 2), (v) => Math.fround(v / 32768));
  assert.equal(got.length, want.length, 'same length');
  let bad = -1;
  for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) { bad = i; break; }
  assert.equal(bad, -1, `first difference at frame ${bad >> 1}`);
  assert.equal(d.peaksArray().length, 0, 'no waveform pass when it was not asked for');
  d.close();
});

test('analysis decoding holds only the head and the tail, with loudness and waveform of the whole song', async () => {
  const d = new StreamDecoder({ file, retain: { headSec: 5, tailSec: 8 } }).start();
  let most = 0;
  d.on('progress', () => { most = Math.max(most, d.chunks.reduce((s, c) => s + c.data.length / 2, 0)); });
  await once(d, 'end');
  const end = d.decoded;
  assert.equal(end * 2, ref.length);
  assert.ok(most < 16 * SR, `at most ${(most / SR).toFixed(1)}s held`);
  assert.deepEqual(Array.from(d.range(0, 5 * SR)), Array.from(ref.subarray(0, 5 * SR * 2)), 'head intact');
  const from = end - 8 * SR;
  assert.deepEqual(Array.from(d.range(from, end)), Array.from(ref.subarray(from * 2)), 'tail intact');
  assert.equal(d.loudness(), ref.loudness);
  assert.deepEqual(Array.from(d.peaksArray()), ref.peaks);
  d.close();
});

test('a released song whose file has gone reports an error instead of quietly ending early', async () => {
  const copy = path.join(path.dirname(file), 'gone.mp3');
  fs.copyFileSync(file, copy);
  const d = new StreamDecoder({ file: copy, maxAheadSec: 5, keepBehindSec: 1, analyse: false, releaseWhenIdle: true }).start();
  while (!d.released) await sleep(5);
  fs.rmSync(copy);
  let ended = false; let error = null;
  d.on('end', () => { ended = true; }); d.on('error', (e) => { error = e; });
  await play(d, 0);
  assert.ok(error && /restart failed/.test(error.message), `error: ${error?.message}`);
  assert.equal(ended, false);
  d.close();
});

test('analysis can take over a fresh buffer instead of copying it', async () => {
  const head = ref.slice(0, 20 * SR * 2);
  const copied = await analyze('head', head.subarray(0, 10 * SR * 2), {}, { handOver: true }); // part of a buffer: copied
  assert.equal(head.length, 20 * SR * 2, 'a partial view is copied, the caller keeps its buffer');
  const own = head.slice(0, 10 * SR * 2);
  const taken = await analyze('head', own, {}, { handOver: true });
  assert.equal(own.length, 0, 'handed over: the caller no longer has it');
  assert.deepEqual(taken, copied, 'same result either way');
});
