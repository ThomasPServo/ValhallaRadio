import './helpers.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../server/store.js';
import { Scheduler } from '../server/scheduler/logs.js';

const H = 3600_000;
const T0 = Date.UTC(2026, 9, 3, 12); // 12:00 UTC
const key = (ms) => new Date(ms).toISOString().slice(0, 13);

function item(id, type, hourMs, status = 'ready', extra = {}) {
  return { id, type, hourKey: key(hourMs), status, title: id, ...extra };
}

function sched(logs) {
  const s = new Scheduler();
  for (const [startMs, items] of logs) s.logs.set(key(startMs), { hourKey: key(startMs), startMs, items, clockId: store.data.clocks[0].id });
  return s;
}

beforeEach(() => {
  store.data.station.timezone = 'UTC';
  store.data.library = [];
  store.data.history = [];
});

test('next() returns the first ready item of the current hour', () => {
  const s = sched([[T0, [item('a', 'music', T0), item('b', 'music', T0)]]]);
  assert.equal(s.next(T0 + 10 * 60_000).item.id, 'a');
});

test('next() waits for an unprepared item, but an urgent call airs the next ready one instead', () => {
  const s = sched([[T0, [item('a', 'music', T0, 'preparing'), item('b', 'sweeper', T0)]]]);
  assert.equal(s.next(T0 + 60_000).wait.id, 'a');
  assert.equal(s.next(T0 + 60_000, { urgent: true }).item.id, 'b');
});

test('items from a finished hour are dropped; spots up to 5 minutes late still air', () => {
  const s = sched([
    [T0, [item('song', 'music', T0), item('spot', 'spot', T0)]],
    [T0 + H, [item('toh', 'toh_id', T0 + H)]],
  ]);
  const r = s.next(T0 + H + 2 * 60_000);
  assert.equal(r.item.id, 'spot');
  assert.equal(s.findItem('song').status, 'dropped');
  r.item.status = 'played';
  assert.equal(s.next(T0 + H + 2 * 60_000).item.id, 'toh');
});

test('late spots beyond 5 minutes are marked missed', () => {
  const s = sched([[T0, [item('spot', 'spot', T0)]], [T0 + H, [item('toh', 'toh_id', T0 + H)]]]);
  assert.equal(s.next(T0 + H + 6 * 60_000).item.id, 'toh');
  assert.equal(s.findItem('spot').status, 'missed');
});

test('within 40s of the top of the hour, the rest of the hour is dropped for an on-time legal ID', () => {
  const s = sched([
    [T0, [item('song', 'music', T0), item('sweep', 'sweeper', T0)]],
    [T0 + H, [item('toh', 'toh_id', T0 + H)]],
  ]);
  assert.equal(s.next(T0 + H - 20_000).item.id, 'toh');
  assert.equal(s.findItem('song').status, 'dropped');
});

test('when the hour runs dry early, filler music is scheduled from the clock categories', () => {
  store.data.library = [{ id: 't1', title: 'Filler Song', artist: 'Band', category: 'A', duration: 200 }];
  const s = sched([[T0, [item('a', 'music', T0, 'played')]], [T0 + H, [item('toh', 'toh_id', T0 + H)]]]);
  const r = s.next(T0 + 30 * 60_000);
  assert.ok(r.wait, 'filler must be prepared before airing');
  assert.equal(r.wait.trackId, 't1');
  assert.equal(r.wait.filler, true);
  // asking again doesn't create a second filler
  assert.equal(s.next(T0 + 30 * 60_000).wait.id, r.wait.id);
});

test('selectSpots honours flights, dayparts, daily caps and advertiser separation', () => {
  store.data.spots = [
    { id: 's1', advertiserId: 'adv1', title: 'Car A', text: 'x', enabled: true, maxPerDay: 2 },
    { id: 's2', advertiserId: 'adv1', title: 'Car B', text: 'x', enabled: true },
    { id: 's3', advertiserId: 'adv2', title: 'Pizza', text: 'x', enabled: true, startDate: '2026-11-01' },
    { id: 's4', advertiserId: 'adv3', title: 'Bank', text: 'x', enabled: true, dayparts: ['dp_morning'] },
    { id: 's5', advertiserId: 'adv4', title: 'Off', text: 'x', enabled: false },
    { id: 's6', advertiserId: 'adv5', title: 'Gym', file: 'gym.mp3', enabled: true },
  ];
  const s = new Scheduler();
  const picked = s.selectSpots(5, { dateKey: '2026-10-03', daypartId: 'dp_midday', counts: { s1: 2 } });
  const ids = picked.map((x) => x.id).sort();
  assert.deepEqual(ids, ['s2', 's6']);
  const morning = s.selectSpots(5, { dateKey: '2026-10-03', daypartId: 'dp_morning', counts: {} }).map((x) => x.id);
  assert.ok(morning.includes('s4'));
  assert.equal(morning.filter((id) => id === 's1' || id === 's2').length, 1, 'one spot per advertiser per break');
});

test('contextFor finds the songs around a DJ break and detects a stopset', () => {
  const s = sched([[T0, [
    item('m1', 'music', T0, 'played', { trackId: '1', artist: 'A', title: 'One' }),
    item('sp', 'spot', T0, 'played'),
    item('dj', 'dj', T0, 'scheduled'),
    item('m2', 'music', T0, 'scheduled', { trackId: '2', artist: 'B', title: 'Two' }),
  ]]]);
  const ctx = s.contextFor(s.findItem('dj'));
  assert.equal(ctx.previous.at(-1).title, 'One');
  assert.equal(ctx.next.title, 'Two');
  assert.equal(ctx.afterStopset, true);
});
