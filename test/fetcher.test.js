import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import './helpers.js';
import { store } from '../server/store.js';
import { getFetch, fetcherStatus, pool, CHUNK } from '../server/sources/fetcher.js';

// A stand-in for the monochrome origin at its worst: every connection is cut after `cut` bytes, some
// requests fail with Cloudflare 521, and more than `maxConns` connections at once get a 429.
const SIZE = 3 * CHUNK + 12345;
const file = crypto.randomBytes(SIZE);
const origin = { cut: 40_000, failEvery: 7, maxConns: 5, active: 0, peak: 0, requests: 0, refused: 0 };
let server; let base;
before(async () => {
  server = http.createServer((req, res) => {
    origin.requests++;
    if (req.url.startsWith('/missing')) { res.statusCode = 404; return res.end('not found'); }
    if (origin.active >= origin.maxConns) { origin.refused++; res.statusCode = 429; return res.end('slow down'); }
    if (origin.requests % origin.failEvery === 0) { res.writeHead(521, { 'content-type': 'text/plain' }); return res.end('error code: 521'); }
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const from = m ? Number(m[1]) : 0;
    const to = m && m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
    origin.active++; origin.peak = Math.max(origin.peak, origin.active);
    res.writeHead(m ? 206 : 200, { 'content-type': 'application/octet-stream', 'content-length': to - from + 1, ...(m ? { 'content-range': `bytes ${from}-${to}/${SIZE}` } : {}) });
    const end = Math.min(to + 1, from + origin.cut);
    let pos = from;
    const pump = () => {
      if (pos >= end) { origin.active--; if (end <= to) res.destroy(); else res.end(); return; } // cut mid-transfer, like the real origin
      const next = Math.min(end, pos + 8192);
      res.write(file.subarray(pos, next));
      pos = next;
      setTimeout(pump, 2);
    };
    pump();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valhalla-fetch-'));

test('a song arrives intact through cut connections, 521s and refused bursts', async () => {
  store.data.settings.monochromeConnections = 12;
  pool.limit = 12; // a burst well past what the origin allows: it refuses, and the pool has to back off
  origin.maxConns = 2;
  const target = path.join(dir, 'a.audio');
  const f = getFetch('a', `${base}/track/a`, target, { priority: 0 });
  // play from the first bytes while the rest is still arriving
  const parts = [];
  for await (const chunk of f.read(0)) parts.push(chunk);
  const played = Buffer.concat(parts);
  assert.equal(played.length, SIZE);
  assert.ok(played.equals(file), 'bytes read while fetching match the original');
  assert.equal(await f.done, target);
  assert.ok(fs.readFileSync(target).equals(file), 'cached file matches the original');
  assert.ok(!fs.existsSync(`${target}.part`) && !fs.existsSync(`${target}.part.json`), 'partial files cleaned up');
  assert.ok(origin.refused > 0 && pool.errors > 0, 'the origin refused a burst and the pool noticed');
  assert.ok(pool.limit < 12, 'eased off after being refused');
  origin.maxConns = 5;
});

test('a fetch interrupted by a restart resumes where it left off', async () => {
  const target = path.join(dir, 'b.audio');
  // what a previous run left behind: the first two chunks done, the third half done
  const got = [CHUNK, CHUNK, 1000, 0];
  const part = Buffer.alloc(SIZE);
  file.copy(part, 0, 0, 2 * CHUNK + 1000);
  fs.writeFileSync(`${target}.part`, part);
  fs.writeFileSync(`${target}.part.json`, JSON.stringify({ total: SIZE, chunk: CHUNK, got }));
  const before = origin.requests;
  const f = getFetch('b', `${base}/track/b`, target);
  assert.equal(f.contiguous(), 2 * CHUNK + 1000, 'progress restored');
  await f.done;
  assert.ok(fs.readFileSync(target).equals(file));
  assert.ok(origin.requests - before < 40, 'only the missing bytes were fetched');
});

test('a song the origin does not have fails cleanly', async () => {
  const f = getFetch('m', `${base}/missing/m`, path.join(dir, 'm.audio'));
  await assert.rejects(f.done, /404/);
  assert.equal(fetcherStatus().songs.some((s) => s.key === 'm'), false);
});

test('the song needed soonest gets the connections first', async () => {
  origin.cut = 1_000_000; origin.failEvery = 1e9; // a healthy origin, to compare progress fairly
  store.data.settings.monochromeConnections = 2;
  pool.limit = 2;
  const late = getFetch('late', `${base}/track/late`, path.join(dir, 'late.audio'), { priority: 50 });
  const soon = getFetch('soon', `${base}/track/soon`, path.join(dir, 'soon.audio'), { priority: 0 });
  await soon.done;
  assert.ok(late.received() < SIZE, 'the later song was still waiting when the urgent one finished');
  await late.done;
});
