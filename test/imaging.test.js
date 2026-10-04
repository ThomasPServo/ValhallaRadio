import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './helpers.js';
import { sine } from './helpers.js';
import { vetPiece, planMix, seasonContext, templatePieces } from '../server/ai/imagingWriter.js';
import { retireOld } from '../server/audio/imagingCreator.js';
import { renderTemplate, firstSyllable, FX_STYLES, readWav, writeWav } from '../server/audio/productionDsp.js';
import { renderBedLoop, makeLoop, arrangement, BED_STYLES } from '../server/audio/bedSynth.js';

const station = { name: 'Mix 101.9', frequency: '101.9', callSign: 'KMXV', slogan: 'Feel good music', website: '', market: { name: 'Austin', locations: [] } };
const vet = (p, o = {}) => vetPiece({ name: 'x', fx: 'punch', theme: 'positioning', expires: '', ...p }, { station, today: '2026-10-04', ...o });

test('imaging vetting: placeholders, station mention and legal ID rules', () => {
  assert.ok(vet({ type: 'sweeper', text: 'All the hits, all day. {name}.' }).ok);
  assert.equal(vet({ type: 'sweeper', text: 'All the hits, all day. Mix 101.9.' }).piece.text, 'All the hits, all day. {name}.', 'typed-out name becomes a placeholder');
  assert.equal(vet({ type: 'sweeper', text: 'Great songs all day long, every day.' }).why, 'never says the station');
  assert.match(vet({ type: 'sweeper', text: 'Find us at {website}. {name}.' }).why, /no website/);
  assert.match(vet({ type: 'sweeper', text: 'The {station} sound. {name}.' }).why, /unknown placeholder/);
  assert.ok(vet({ type: 'toh_id', text: '{callSign}, {market}. {name}.' }).ok);
  assert.match(vet({ type: 'toh_id', text: '{name}. {frequency}.' }).why, /legal ID/);
  assert.equal(vet({ type: 'sweeper', text: '{call_sign} plays the hits. {Name}.' }).piece.text, '{callSign} plays the hits. {name}.');
  assert.match(vet({ type: 'toh_id', text: '{callSign}, {market}. {frequency}, {name}.' }).why, /frequency twice/);
  assert.ok(vetPiece({ type: 'id', text: '{frequency}. {name}.' }, { station: { ...station, name: 'The Breeze' } }).ok);
  assert.match(vetPiece({ type: 'id', text: '{frequency}. {name}.' }, { station: { ...station, name: 'Lone Star 98.7', frequency: '98.7 FM' } }).why, /frequency twice/);
});

test('imaging vetting: no ratings claims, contests, unverifiable promises or language', () => {
  for (const text of [
    "Austin's number one station. {name}.", "The #1 hit music station. {name}.", 'Win tickets every hour on {name}.',
    'Commercial-free hours on {name}.', 'Less talk, more music. {name}.', 'Damn good music. {name}.', 'Visit mix1019.com. {name}.',
  ]) assert.equal(vet({ type: 'sweeper', text }).ok, false, text);
});

test('imaging vetting: lengths, caps, duplicates and expiry', () => {
  assert.match(vet({ type: 'id', text: 'This is the one and only station you will ever need to hear. {name}.' }).why, /words/);
  assert.equal(vet({ type: 'sweeper', text: 'ALL the hits. {name}.' }).piece.text, 'All the hits. {name}.');
  assert.equal(vet({ type: 'sweeper', text: 'Only on {callSign}. KMXV rocks.' }).piece.text, 'Only on {callSign}. KMXV rocks.', 'call letters stay capitalised');
  assert.equal(vet({ type: 'sweeper', text: 'All the hits! {name}' }, { existing: ['All the hits. {name}.'] }).why, 'duplicate');
  assert.ok(vet({ type: 'id', text: '{callSign}, {market}. {name}.' }, { existing: ['{name}. {slogan}.'] }).ok, 'different placeholders are not duplicates');
  assert.equal(vet({ type: 'sweeper', text: 'Your Halloween soundtrack. {name}.', expires: '2026-11-01' }).piece.expires, '2026-11-01');
  assert.equal(vet({ type: 'sweeper', text: 'Your fall soundtrack. {name}.', expires: '2027-06-01' }).piece.expires, '', 'too far out');
  assert.equal(vet({ type: 'sweeper', text: 'Your fall soundtrack. {name}.', fx: 'laser' }).piece.fx, null);
});

test('imaging mix plan', () => {
  assert.deepEqual(planMix(6, station), { sweeper: 3, liner: 1, id: 1, toh_id: 1 });
  assert.deepEqual(planMix(6, { ...station, callSign: '' }), { sweeper: 4, liner: 1, id: 1, toh_id: 0 });
  assert.equal(Object.values(planMix(11, station)).reduce((a, b) => a + b), 11);
});

test('season and upcoming holidays', () => {
  const oct = seasonContext(new Date('2026-10-20T15:00:00Z'), 'America/Chicago');
  assert.equal(oct.season, 'fall');
  assert.deepEqual(oct.upcoming.map((h) => [h.name, h.date]), [['Halloween', '2026-10-31']]);
  const nov = seasonContext(new Date('2026-11-10T15:00:00Z'), 'America/Chicago');
  assert.deepEqual(nov.upcoming.map((h) => h.date), ['2026-11-26']); // Thanksgiving 2026
  assert.equal(seasonContext(new Date('2026-07-01T00:00:00Z'), 'Australia/Sydney', { lat: -33.9, us: false }).season, 'winter');
  assert.equal(seasonContext(new Date('2026-12-28T12:00:00Z'), 'UTC').upcoming.map((h) => h.name).join(), "New Year's Eve,New Year's Day");
});

test('template writer produces vetted pieces with roll-calls from rotation', () => {
  const ctx = { station, market: 'Austin', artists: ['Dua Lipa', 'Teddy Swims', 'Benson Boone', 'Sabrina Carpenter'], when: { season: 'fall', today: '2026-10-04' } };
  const raw = templatePieces(ctx, planMix(6, station));
  const ok = raw.map((p) => vetPiece(p, { station, today: '2026-10-04' })).filter((v) => v.ok);
  assert.ok(ok.length >= 6);
  assert.ok(ok.some((v) => v.piece.theme === 'roll-call' && v.piece.text.includes('Dua Lipa')));
  assert.ok(ok.some((v) => v.piece.type === 'toh_id'));
});

test('retiring old auto imaging keeps the newest, pinned and hand-made pieces', () => {
  const items = [
    { id: 'manual', auto: false },
    { id: 'a1', auto: true, createdAt: 1 }, { id: 'a2', auto: true, createdAt: 2 }, { id: 'a3', auto: true, createdAt: 3 },
    { id: 'pin', auto: true, createdAt: 0, pinned: true },
  ];
  assert.deepEqual(retireOld(items, 2).sort(), ['a1']);
  assert.deepEqual(items.map((i) => i.id), ['manual', 'a2', 'a3', 'pin']);
});

// ------------------------------------------------------------------ production styles

function syllables() {
  // "voice": two 200 ms bursts with a 60 ms gap, then a longer phrase
  const a = sine(0.2, { freq: 300, amp: 0.5 }); const gap = new Int16Array(Math.round(0.06 * 44100) * 2); const b = sine(1.2, { freq: 260, amp: 0.5 });
  const out = new Int16Array(a.length + gap.length + b.length); out.set(a); out.set(gap, a.length); out.set(b, a.length + gap.length);
  return out;
}

test('every imaging FX style renders with sane markers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valhalla-fx-'));
  const bedFile = path.join(dir, 'bed.wav');
  writeWav(bedFile, { l: new Float32Array(44100 * 4).map((_, i) => Math.sin(i / 20) * 0.3), r: new Float32Array(44100 * 4).map((_, i) => Math.sin(i / 20) * 0.3) });
  for (const fx of FX_STYLES) {
    const out = path.join(dir, `${fx}.wav`);
    const m = renderTemplate({ template: 'imaging', pcm: syllables(), type: 'sweeper', fx, bedFile, out });
    const audio = readWav(out);
    const len = audio.l.length / 44100;
    assert.ok(m.voiceStart >= 0 && m.voiceEnd > m.voiceStart && m.post >= m.voiceEnd - 0.1 && m.tailStart >= m.voiceEnd - 0.01 && m.tailStart <= len + 0.01, `${fx}: ${JSON.stringify(m)} (len ${len})`);
    let peak = 0; for (let i = 0; i < audio.l.length; i++) peak = Math.max(peak, Math.abs(audio.l[i]));
    assert.ok(peak > 0.8 && peak <= 0.9, `${fx} normalized (${peak})`);
  }
  // stutter repeats the first syllable before the line
  const stutter = renderTemplate({ template: 'imaging', pcm: syllables(), type: 'sweeper', fx: 'stutter', out: path.join(dir, 's2.wav') });
  const dry = renderTemplate({ template: 'imaging', pcm: syllables(), type: 'sweeper', fx: 'dry', out: path.join(dir, 'd2.wav') });
  assert.ok(stutter.voiceEnd - stutter.voiceStart > dry.voiceEnd - dry.voiceStart + 0.2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('first syllable detection finds the gap after the first word', () => {
  const pcm = syllables();
  const b = { l: new Float32Array(pcm.length / 2), r: new Float32Array(pcm.length / 2) };
  for (let i = 0; i < b.l.length; i++) { b.l[i] = pcm[i * 2] / 32768; b.r[i] = pcm[i * 2 + 1] / 32768; }
  const s = firstSyllable(b);
  assert.ok(s >= 0.19 && s <= 0.26, `syllable ends at ${s}`);
});

// ------------------------------------------------------------------ beds

test('bed arrangements are 16 bars and identical every pass', () => {
  for (const id of Object.keys(BED_STYLES)) {
    const a = arrangement(id); const b = arrangement(id);
    assert.equal(a.beats, 64);
    assert.deepEqual(a.events, b.events, `${id} is deterministic`);
    assert.ok(a.events.every((e) => e.at > -0.05 && e.at < 64), `${id} events inside the loop`);
    assert.ok(a.events.some((e) => e.inst === 'kick') && a.events.some((e) => e.inst === 'bass'));
  }
});

test('synthesized bed loops seamlessly at broadcast level', () => {
  const b = renderBedLoop('chill');
  const n = b.l.length;
  assert.ok(Math.abs(b.seconds - (64 * 60) / 84) < 0.01);
  let peak = 0; let sum = 0; let maxStep = 0;
  for (let i = 0; i < n; i++) {
    peak = Math.max(peak, Math.abs(b.l[i]), Math.abs(b.r[i])); sum += b.l[i] ** 2;
    if (i) maxStep = Math.max(maxStep, Math.abs(b.l[i] - b.l[i - 1]));
  }
  assert.ok(peak <= 0.9 && peak > 0.85);
  assert.ok(Math.sqrt(sum / n) > 0.05, 'not silent');
  assert.ok(Math.abs(b.l[0] - b.l[n - 1]) <= maxStep, 'no click at the loop point');
});

test('uploaded beds loop by crossfading their tail into their head', () => {
  const pcm = sine(3, { freq: 200, amp: 0.4 });
  const loop = makeLoop(pcm, 0.5);
  assert.equal(loop.length / 2, pcm.length / 2 - 22050);
  // the sample after the loop end is the input's continuation, so the wrap is continuous
  assert.equal(loop[0], pcm[(pcm.length / 2 - 22050) * 2]);
});
