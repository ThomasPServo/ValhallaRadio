import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import './helpers.js';
import { store } from '../server/store.js';
import { MUSIC_CACHE_DIR, TTS_CACHE_DIR, UPLOAD_DIR, FFMPEG } from '../server/config.js';
import { PEAKS_DIR, computePeaks, ensurePeaks, readPeaks } from '../server/audio/peakFile.js';
import { cleanUp, forgetSong, ttsRule } from '../server/scheduler/janitor.js';
import { isCached, cacheBytes, pruneCache } from '../server/sources/monochrome.js';

const HOUR = 3600_000;
function file(dir, name, ageMs, bytes = 1000) {
  const p = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
  return p;
}

test('voice cache: one-off breaks go quickly, imaging stays while used', () => {
  assert.equal(ttsRule('dj_abc.wav', 7 * HOUR), true);
  assert.equal(ttsRule('dj_abc.wav', 1 * HOUR), false);
  assert.equal(ttsRule('info_abc.wav', 7 * HOUR), true);
  assert.equal(ttsRule(`${'a'.repeat(40)}.wav`, 3 * 24 * HOUR), true, 'raw speech after 2 days');
  assert.equal(ttsRule(`${'a'.repeat(40)}.mp3`, 24 * HOUR), false);
  assert.equal(ttsRule('img_abc.wav', 10 * 24 * HOUR), false, 'imaging kept');
  assert.equal(ttsRule('img_abc.wav', 31 * 24 * HOUR), true, 'unless unused for a month');
  assert.equal(ttsRule('bed_warm_v2.wav', 5 * 24 * HOUR), false);
});

test('clean-up removes what nothing needs, and only that', () => {
  store.data.library = [{ id: 'keep1', title: 'A', artist: 'B' }];
  store.data.imaging = { voice: {}, items: [{ id: 'i1', type: 'sweeper', file: 'used.wav' }] };
  store.data.spots = [{ id: 's1', file: 'spot.mp3' }];
  store.data.station.logo = 'logo.png';
  const DAY = 24 * HOUR;
  const keep = [
    file(MUSIC_CACHE_DIR, 'keep1.audio', 5 * DAY),
    file(MUSIC_CACHE_DIR, 'inlog.audio', 5 * DAY), // scheduled, not in the library (yet)
    file(MUSIC_CACHE_DIR, 'preview.audio', 2 * HOUR), // just previewed: a day's grace
    file(PEAKS_DIR, 'keep1.i8', 5 * DAY),
    file(TTS_CACHE_DIR, 'img_x.wav', 3 * DAY),
    file(TTS_CACHE_DIR, 'dj_new.wav', HOUR),
    file(UPLOAD_DIR, 'used.wav', 5 * DAY), file(UPLOAD_DIR, 'spot.mp3', 5 * DAY), file(UPLOAD_DIR, 'logo.png', 5 * DAY),
    file(UPLOAD_DIR, 'fresh.wav', HOUR), // uploaded, not saved yet
  ];
  const gone = [
    file(MUSIC_CACHE_DIR, 'removed.audio', 2 * DAY, 5_000_000),
    file(MUSIC_CACHE_DIR, 'stale.audio.part', 2 * DAY), file(MUSIC_CACHE_DIR, 'stale.audio.part.json', 2 * DAY),
    file(PEAKS_DIR, 'removed.i8', 2 * DAY),
    file(TTS_CACHE_DIR, 'dj_old.wav', 8 * HOUR), file(TTS_CACHE_DIR, 'dj_old.wav.json', 8 * HOUR),
    file(UPLOAD_DIR, 'orphan.wav', 2 * DAY),
  ];
  const r = cleanUp([{ trackId: 'inlog' }]);
  for (const p of keep) assert.ok(fs.existsSync(p), `kept ${path.basename(p)}`);
  for (const p of gone) assert.ok(!fs.existsSync(p), `removed ${path.basename(p)}`);
  assert.ok(r.freedBytes >= 5_000_000 && r.removed === gone.length);
});

test('removing a song from the library deletes its audio and waveform at once', () => {
  const a = file(MUSIC_CACHE_DIR, 'bye.audio', 0); const p = file(PEAKS_DIR, 'bye.i8', 0);
  forgetSong('bye', []);
  assert.ok(!fs.existsSync(a) && !fs.existsSync(p));
  const b = file(MUSIC_CACHE_DIR, 'soon.audio', 0);
  forgetSong('soon', [{ trackId: 'soon' }]);
  assert.ok(fs.existsSync(b), 'still scheduled: kept until it airs');
});

test('a whole song\'s waveform in one pass, matching the 50 ms overview format', async () => {
  const wav = path.join(TTS_CACHE_DIR, 'tone_test.wav');
  // 3 s: one second of silence, then a loud tone
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=1', '-f', 'lavfi', '-i', 'sine=f=440:d=2:r=44100', '-filter_complex', '[1]volume=0.8,aformat=channel_layouts=stereo[t];[0][t]concat=n=2:v=0:a=1', wav]);
  const pk = await computePeaks(wav);
  assert.ok(Math.abs(pk.length / 2 - 60) <= 1, `about 60 points for 3 s (got ${pk.length / 2})`);
  assert.ok(Math.max(...pk.slice(0, 36).map(Math.abs)) <= 1, 'silence is flat');
  // ffmpeg's sine source plays at 1/8 full scale (about 12 of 127 here): well clear of the silence
  assert.ok(pk[50 * 2 + 1] >= 8 && pk[50 * 2] <= -8, `the tone shows (${pk[100]}, ${pk[101]})`);
  assert.equal(await ensurePeaks('tone', wav), true);
  assert.equal(readPeaks('tone').length, pk.length);
});

test('the cache index follows what the janitor and the size limit remove, without rescanning', () => {
  for (const f of fs.readdirSync(MUSIC_CACHE_DIR)) fs.rmSync(path.join(MUSIC_CACHE_DIR, f), { force: true });
  const DAY = 24 * HOUR;
  store.data.library = [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }];
  file(MUSIC_CACHE_DIR, 'a1.audio', 3 * DAY, 400_000);
  file(MUSIC_CACHE_DIR, 'a2.audio', 2 * DAY, 400_000);
  file(MUSIC_CACHE_DIR, 'a3.audio', 1 * DAY, 400_000);
  file(MUSIC_CACHE_DIR, 'tiny.audio', 0, 100); // an error page, not a song
  assert.ok(isCached('a1') && isCached('a3') && !isCached('tiny') && !isCached('nope'));
  const before = cacheBytes();
  assert.equal(before, 1_200_100);
  forgetSong('gone', []); // nothing there: no change
  file(MUSIC_CACHE_DIR, 'old.audio', 3 * DAY, 300_000);
  assert.equal(isCached('old'), false, 'a file written behind its back is seen at the next rescan, not before');
  store.data.library = [{ id: 'a1' }, { id: 'a3' }, { id: 'old' }];
  forgetSong('a2', []); // gone from the library
  assert.equal(isCached('a2'), false);
  assert.equal(cacheBytes(), before - 400_000);
  store.data.settings.musicCacheMaxMb = 0.6; // 629 KB: evict least recently used
  try { pruneCache(); } finally { delete store.data.settings.musicCacheMaxMb; }
  assert.equal(isCached('a1'), false, 'oldest evicted');
  assert.equal(fs.existsSync(path.join(MUSIC_CACHE_DIR, 'old.audio')), false, 'found by the full look prune takes when over the limit');
  assert.ok(isCached('a3'));
  assert.ok(cacheBytes() <= 0.6 * 1048576);
});
