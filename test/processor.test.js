import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BroadcastProcessor, resolveParams, LoudnessMeter, PRESETS, emphasis, invert } from '../server/audio/processor.js';

const FS = 44100;

function stereoSine(seconds, freq, amp) {
  const n = Math.floor(seconds * FS);
  const buf = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { const v = Math.sin((2 * Math.PI * freq * i) / FS) * amp; buf[i * 2] = v; buf[i * 2 + 1] = v; }
  return buf;
}
const rms = (buf, from = 0) => { let s = 0; let n = 0; for (let i = from * 2; i < buf.length; i += 2) { s += buf[i] * buf[i]; n++; } return Math.sqrt(s / n); };

test('multiband crossover tree sums flat (phase-compensated LR4) when no compression is applied', () => {
  const params = resolveParams('streaming', {
    agc: { enabled: false }, phaseRotator: true, stereo: { width: 1 },
    eq: { bassDb: 0, warmthDb: 0, presenceDb: 0, airDb: 0 },
    multiband: { drive: 0, bands: [0, 1, 2, 3, 4].map(() => ({ thresholdDb: 20, makeupDb: 0 })) },
    clipper: { enabled: false }, limiter: { ceilingDb: 0 }, outputGainDb: 0, finalDriveDb: 0, loudness: { autoTrim: false },
  });
  for (const f of [110, 250, 420, 1000, 2000, 4000, 6200, 12000, 16000]) {
    const proc = new BroadcastProcessor(FS, params);
    const buf = stereoSine(1, f, 0.25);
    const inRms = rms(buf, FS / 2);
    proc.process(buf, buf.length / 2);
    const outRms = rms(buf, FS / 2);
    const db = 20 * Math.log10(outRms / inRms);
    assert.ok(Math.abs(db) < 0.1, `${f} Hz: ${db.toFixed(2)} dB`);
  }
});

test('the only low-end loss is the 28 Hz subsonic filter (2 x 2nd-order Butterworth)', () => {
  const params = resolveParams('streaming', { agc: { enabled: false }, stereo: { width: 1 }, eq: { bassDb: 0, warmthDb: 0, presenceDb: 0, airDb: 0 }, multiband: { drive: 0, bands: [0, 1, 2, 3, 4].map(() => ({ thresholdDb: 20 })) }, clipper: { enabled: false }, limiter: { ceilingDb: 0 }, outputGainDb: 0, finalDriveDb: 0, loudness: { autoTrim: false } });
  const proc = new BroadcastProcessor(FS, params);
  const buf = stereoSine(1, 60, 0.25);
  const inRms = rms(buf, FS / 2);
  proc.process(buf, buf.length / 2);
  const db = 20 * Math.log10(rms(buf, FS / 2) / inRms);
  const ratio = 60 / 28; const butter = 20 * Math.log10(ratio ** 2 / Math.sqrt(1 + ratio ** 4));
  assert.ok(Math.abs(db - 2 * butter) < 0.1, `60 Hz ${db.toFixed(2)} vs expected ${(2 * butter).toFixed(2)}`);
});

test('limiter output never exceeds the ceiling, even for very hot input', () => {
  const proc = new BroadcastProcessor(FS, resolveParams('chr', { inputGainDb: 12 }));
  const buf = stereoSine(2, 220, 0.9);
  proc.process(buf, buf.length / 2);
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 10 ** (-1 / 20) + 1e-6, `peak ${20 * Math.log10(peak)} dBFS`);
  const m = proc.meters();
  assert.ok(m.limiter >= 0 && m.out.tp <= 0.5, JSON.stringify({ lim: m.limiter, tp: m.out.tp }));
});

test('BS.1770 meter: stereo 1 kHz sine at -20 dBFS reads -20 LUFS', () => {
  const meter = new LoudnessMeter(FS);
  const buf = stereoSine(4, 1000, 0.1);
  for (let i = 0; i < buf.length; i += 2) meter.push(buf[i], buf[i + 1]);
  assert.ok(Math.abs(meter.shortTerm + 20) < 0.15, `short-term ${meter.shortTerm}`);
  assert.ok(Math.abs(meter.integrated() + 20) < 0.15, `integrated ${meter.integrated()}`);
});

test('AGC rides a quiet programme up toward its target', () => {
  const proc = new BroadcastProcessor(FS, resolveParams('ac'));
  const buf = stereoSine(8, 440, 0.03); // about -33 dBFS RMS, well below target
  proc.process(buf, buf.length / 2);
  const m = proc.meters();
  assert.ok(m.agc > 3, `agc gain ${m.agc} dB`);
});

test('every preset processes 1 s of stereo audio comfortably faster than real time', () => {
  for (const id of Object.keys(PRESETS)) {
    const proc = new BroadcastProcessor(FS, resolveParams(id));
    const buf = stereoSine(1, 330, 0.5);
    const t0 = performance.now();
    proc.process(buf, buf.length / 2);
    const ms = performance.now() - t0;
    assert.ok(ms < 400, `${id}: ${ms.toFixed(0)} ms for 1 s`);
    for (const v of buf) assert.ok(Number.isFinite(v));
  }
});

test('meter snapshot has gain reduction and correlation; the scope has spectrum and goniometer', () => {
  const proc = new BroadcastProcessor(FS, resolveParams('chr'));
  const buf = stereoSine(1, 1000, 0.5);
  proc.process(buf, buf.length / 2);
  const sc = proc.scope();
  const m = proc.meters();
  assert.equal(sc.spectrum.length, 30);
  assert.equal(m.bands.length, 5);
  assert.ok(m.corr > 0.99, `mono signal correlation ${m.corr}`);
  const peakBand = sc.spectrum.indexOf(Math.max(...sc.spectrum));
  assert.equal([1000][0], [25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000][peakBand], 'spectrum peaks at 1 kHz');
  const g = new Int8Array(Buffer.from(sc.gonio, 'base64'));
  assert.ok(g.length > 0 && g.length <= 192 && g.length % 2 === 0, `${g.length} goniometer values`);
  for (let i = 0; i < g.length; i += 2) assert.equal(g[i], g[i + 1], 'mono: every point on the centre line');
  assert.equal(proc.scope().gonio, '', 'points are sent once');
});

test('with no meters on screen the processor skips meter-only work and the audio is identical', () => {
  const a = new BroadcastProcessor(FS, resolveParams('rock'));
  const b = new BroadcastProcessor(FS, resolveParams('rock'));
  b.setMetering(false);
  const x = programme(3); const y = x.slice();
  for (let o = 0; o < x.length / 2; o += 882) {
    const n = Math.min(882, x.length / 2 - o);
    a.process(x.subarray(o * 2, (o + n) * 2), n);
    b.process(y.subarray(o * 2, (o + n) * 2), n);
  }
  assert.ok(x.every((v, i) => v === y[i]), 'same samples either way');
  assert.equal(b.meters().in.s, -70, 'input loudness not measured while nobody watches');
  assert.ok(a.meters().in.s > -30, 'input loudness measured while watched');
  assert.equal(a.outMeter.integrated(), b.outMeter.integrated(), 'output loudness (for the auto-trim) always measured');
});

/** A music-like test programme: chords, a bass line and noisy drum hits at about -16 LUFS. */
function programme(seconds) {
  const n = Math.floor(seconds * FS);
  const buf = new Float32Array(n * 2);
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
  const chords = [[220, 277.2, 329.6], [174.6, 220, 261.6], [196, 246.9, 293.7], [164.8, 207.7, 246.9]];
  for (let i = 0; i < n; i++) {
    const t = i / FS; const beat = t % 0.5; const c = chords[Math.floor(t / 2) % 4];
    let v = 0;
    for (const f of c) v += Math.sin(2 * Math.PI * f * t) * 0.08;
    v += Math.sin(2 * Math.PI * (c[0] / 2) * t) * 0.18 * Math.exp(-beat * 3);
    v += Math.sin(2 * Math.PI * (50 + 60 * Math.exp(-beat * 30)) * beat) * 0.5 * Math.exp(-beat * 9);
    v += rnd() * 0.12 * Math.exp(-((t + 0.25) % 0.5) * 25);
    buf[i * 2] = v * 0.9 + rnd() * 0.004; buf[i * 2 + 1] = v * 0.85 + rnd() * 0.004;
  }
  const m = new LoudnessMeter(FS);
  for (let i = 0; i < n; i++) m.push(buf[i * 2], buf[i * 2 + 1]);
  const g = Math.pow(10, (-16 - m.integrated()) / 20);
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

test('presets land on their loudness target with true peaks under the ceiling', () => {
  for (const id of ['streaming', 'chr', 'dance', 'gentle']) {
    const proc = new BroadcastProcessor(FS, resolveParams(id));
    const buf = programme(16);
    let tp = -99;
    for (let o = 0; o < buf.length / 2; o += 2048) {
      proc.process(buf.subarray(o * 2, (o + 2048) * 2), Math.min(2048, buf.length / 2 - o));
      tp = Math.max(tp, proc.meters().out.tp);
    }
    const target = resolveParams(id).loudness.targetLufs;
    const I = proc.outMeter.integrated();
    assert.ok(Math.abs(I - target) < 2, `${id}: ${I.toFixed(1)} LUFS vs target ${target}`);
    assert.ok(tp <= -0.7, `${id}: true peak ${tp.toFixed(2)} dBTP`);
  }
});

test('auto-trim follows the target, and the output trim is respected', () => {
  const quiet = new BroadcastProcessor(FS, resolveParams('streaming', { loudness: { targetLufs: -18 } }));
  const loud = new BroadcastProcessor(FS, resolveParams('streaming', { loudness: { targetLufs: -12 } }));
  const trimmed = new BroadcastProcessor(FS, resolveParams('streaming', { outputGainDb: -6 }));
  for (const p of [quiet, loud, trimmed]) {
    const buf = programme(20);
    for (let o = 0; o < buf.length / 2; o += 4096) p.process(buf.subarray(o * 2, (o + 4096) * 2), Math.min(4096, buf.length / 2 - o));
  }
  assert.ok(loud.outMeter.integrated() - quiet.outMeter.integrated() > 3.5, `${quiet.outMeter.integrated().toFixed(1)} → ${loud.outMeter.integrated().toFixed(1)}`);
  assert.ok(Math.abs(trimmed.trimDb) < 3, `the loop does not fight the output trim (${trimmed.trimDb.toFixed(1)} dB)`);
});

const respDb = (c, f) => {
  const w = (2 * Math.PI * f) / FS;
  const n = Math.hypot(c.b0 + c.b1 * Math.cos(w), -c.b1 * Math.sin(w)); const d = Math.hypot(1 + c.a1 * Math.cos(w), -c.a1 * Math.sin(w));
  return 20 * Math.log10(n / d);
};

test('FM pre-emphasis follows the 75 µs and 50 µs curves to 15 kHz, and de-emphasis undoes it exactly', () => {
  for (const us of [75, 50]) {
    const pre = emphasis(FS, us * 1e-6); const de = invert(pre);
    for (const f of [500, 1000, 2122, 3183, 6000, 10000, 15000]) {
      const analog = 10 * Math.log10(1 + (2 * Math.PI * f * us * 1e-6) ** 2);
      assert.ok(Math.abs(respDb(pre, f) - analog) < 0.15, `${us} µs at ${f} Hz: ${respDb(pre, f).toFixed(2)} vs ${analog.toFixed(2)} dB`);
      assert.ok(Math.abs(respDb(pre, f) + respDb(de, f)) < 0.001);
    }
  }
});

test('FM Heavy: high frequencies are held to what pre-emphasis allows, nothing above 15 kHz, peaks at the ceiling', () => {
  const tone = (preset, f, over = {}) => {
    const proc = new BroadcastProcessor(FS, resolveParams(preset, { loudness: { autoTrim: false }, agc: { enabled: false }, ...over }));
    const buf = stereoSine(2, f, 0.7);
    proc.process(buf, buf.length / 2);
    let peak = 0; for (let i = FS * 2; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    return { rms: 20 * Math.log10(rms(buf, FS)), peak: 20 * Math.log10(peak) };
  };
  assert.equal(resolveParams('fmheavy').fm.enabled, true);
  assert.equal(resolveParams('chr').fm.enabled, false);
  // a loud 10 kHz tone is limited several dB harder than a 1 kHz tone (its pre-emphasis boost), unlike the plain chain
  const fmTilt = tone('fmheavy', 1000).rms - tone('fmheavy', 10000).rms;
  const plainTilt = tone('fmheavy', 1000, { fm: { enabled: false } }).rms - tone('fmheavy', 10000, { fm: { enabled: false } }).rms;
  assert.ok(fmTilt - plainTilt > 6, `HF held down by pre-emphasis: ${fmTilt.toFixed(1)} vs ${plainTilt.toFixed(1)} dB`);
  // 19 kHz, where the stereo pilot lives, is notched out
  const at19k = (on) => {
    const proc = new BroadcastProcessor(FS, resolveParams('fmheavy', { loudness: { autoTrim: false }, agc: { enabled: false }, fm: { enabled: on } }));
    const buf = stereoSine(1, 19000, 0.05);
    proc.process(buf, buf.length / 2);
    let re = 0; let im = 0; let n = 0;
    for (let i = FS / 2; i < buf.length / 2; i++) { re += buf[i * 2] * Math.cos((2 * Math.PI * 19000 * i) / FS); im += buf[i * 2] * Math.sin((2 * Math.PI * 19000 * i) / FS); n++; }
    return 20 * Math.log10((2 * Math.hypot(re, im)) / n + 1e-12);
  };
  assert.ok(at19k(true) < at19k(false) - 60, `19 kHz: ${at19k(true).toFixed(0)} vs ${at19k(false).toFixed(0)} dB`);
  // peaks stay at the ceiling, flat and pre-emphasized
  for (const output of ['flat', 'preemphasized']) {
    for (const f of [100, 1000, 6000, 12000]) assert.ok(tone('fmheavy', f, { fm: { output } }).peak <= -0.99, `${output} ${f} Hz`);
  }
});
