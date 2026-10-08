import './helpers.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../server/store.js';
import { Scheduler, estDuration } from '../server/scheduler/logs.js';

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

test('filler near the top of the hour takes a song that ends near the top, not one that runs minutes past it', () => {
  store.data.library = [
    { id: 'long', title: 'Long Live Take', artist: 'Band A', category: 'A', duration: 471 }, // the most due
    { id: 'fits', title: 'Short Song', artist: 'Band B', category: 'A', duration: 170, lastPlayed: T0 - 10 * H },
  ];
  const s = sched([[T0, [item('a', 'music', T0, 'played')]], [T0 + H, [item('toh', 'toh_id', T0 + H)]]]);
  assert.equal(s.next(T0 + H - 3 * 60_000).wait.trackId, 'fits'); // three minutes left
});

test('when no due song fits before the top of the hour, filler takes the shortest', () => {
  store.data.library = [
    { id: 'long', title: 'Long', artist: 'Band A', category: 'A', duration: 471 }, // the most due
    { id: 'shorter', title: 'Shorter', artist: 'Band B', category: 'A', duration: 230, lastPlayed: T0 - 10 * H },
  ];
  const s = sched([[T0, [item('a', 'music', T0, 'played')]], [T0 + H, [item('toh', 'toh_id', T0 + H)]]]);
  assert.equal(s.next(T0 + H - 100_000).wait.trackId, 'shorter');
});

test('a song airs first while an ID is still being voiced (a new station signing on), and the ID follows', () => {
  store.data.library = [{ id: 't1', title: 'Song', artist: 'Band', category: 'A', duration: 200 }];
  const s = sched([[T0, [item('id', 'id', T0, 'preparing'), item('sweep', 'sweeper', T0, 'scheduled')]]]);
  assert.equal(s.next(T0 + 50 * 60_000).wait.id, 'id', 'not urgent: nothing added');
  assert.equal(s.logs.get(key(T0)).items.length, 2);
  assert.equal(s.next(T0 + 50 * 60_000, { urgent: true }).wait.id, 'id');
  const items = s.logs.get(key(T0)).items;
  assert.deepEqual(items.map((i) => i.trackId || i.id), ['id', 't1', 'sweep'], 'the song goes right after the ID');
  s.next(T0 + 50 * 60_000, { urgent: true });
  assert.equal(items.length, 3, 'one song, however often the engine asks');
  items[1].status = 'ready';
  assert.equal(s.next(T0 + 50 * 60_000, { urgent: true }).item.trackId, 't1', 'the song airs first');
  items[1].status = 'played'; items[0].status = 'ready';
  assert.equal(s.next(T0 + 54 * 60_000).item.id, 'id');
});

const songs = (len, n = 12) => ['A', 'B', 'C', 'G', 'N'].flatMap((c) => Array.from({ length: n }, (_, i) => ({ id: `${c}${i}`, title: `Song ${c}${i}`, artist: `Artist ${c}${i}`, category: c, duration: len })));
const endOf = (s, now, l) => {
  let t = now;
  for (const i of s.allItems()) if (i.status === 'playing') t = Math.max(t, i.airedAt + estDuration(i) * 1000);
  for (const i of l.items) if (['scheduled', 'preparing', 'ready', 'cued'].includes(i.status)) t += estDuration(i) * 1000;
  return (t - l.startMs) / 1000;
};

test("an hour is planned full to the top, however short its clock runs at today's song lengths", async () => {
  const saved = [store.settings.useClaudeForMusic, store.settings.allowDiscovery];
  Object.assign(store.settings, { useClaudeForMusic: false, allowDiscovery: false });
  try {
    for (const len of [150, 184, 260]) {
      store.data.library = songs(len);
      const s = new Scheduler();
      const l = await s.generateHour(T0);
      const airtime = l.items.filter((i) => i.status !== 'failed').reduce((sum, i) => sum + estDuration(i), 0);
      assert.ok(airtime >= 3600 - 90 && airtime <= 3600 + 90, `${len}s songs: the hour ends near the top (${airtime}s)`);
      const positions = s.clockFor(T0).items.filter((i) => i.type === 'music').length;
      if (len < 200) assert.ok(l.items.filter((i) => i.type === 'music').length > positions, 'more songs than the clock has positions');
      assert.ok(l.items.every((i) => i.type !== 'music' || i.trackId), 'every song position has a song');
    }
  } finally { [store.settings.useClaudeForMusic, store.settings.allowDiscovery] = saved; }
});

test('the hour on air is topped up ahead of time when what is left of it would end early', () => {
  store.data.library = songs(204);
  const now = T0 + 40 * 60_000;
  const l = { hourKey: key(T0), startMs: T0, clockId: store.data.clocks[0].id,
    items: [item('p', 'music', T0, 'playing', { trackId: 'A0', duration: 214, airedAt: now - 60_000 }), item('a', 'music', T0, 'scheduled', { trackId: 'B0', duration: 204 }), item('dj', 'dj', T0, 'skipped')] };
  const s = new Scheduler();
  s.logs.set(l.hourKey, l);
  assert.ok(endOf(s, now, l) < 3000, 'a skipped break and short songs: the hour would end ten minutes early');
  const added = s.topUp(now);
  assert.ok(added.length >= 3 && added.every((i) => i.status === 'scheduled' && i.trackId));
  const end = endOf(s, now, l);
  assert.ok(end >= 3600 - 90 && end <= 3600 + 90, `ends near the top (${end}s)`);
  assert.equal(s.topUp(now).length, 0, 'full: nothing more');
  const ids = l.items.filter((i) => i.trackId).map((i) => i.trackId);
  assert.equal(new Set(ids).size, ids.length, 'no song twice');
});

test('an hour that would run a song past the top drops its last song while it is still unprepared', () => {
  store.data.library = songs(204);
  const now = T0 + 45 * 60_000;
  const l = { hourKey: key(T0), startMs: T0, clockId: store.data.clocks[0].id,
    items: [item('p', 'music', T0, 'playing', { trackId: 'A0', duration: 214, airedAt: now - 10_000 }),
      ...['B0', 'C0', 'G0', 'N0', 'A1'].map((id) => item(`s${id}`, 'music', T0, 'scheduled', { trackId: id, duration: 204 }))] };
  const s = new Scheduler();
  s.logs.set(l.hourKey, l);
  assert.ok(endOf(s, now, l) > 3600 + 90);
  s.topUp(now);
  assert.equal(l.items.at(-1).status, 'dropped');
  s.topUp(now);
  assert.equal(l.items.filter((i) => i.status === 'dropped').length, 1, 'one song was enough');
  const end = endOf(s, now, l);
  assert.ok(end >= 3600 - 90 && end <= 3600 + 90, `ends near the top (${end}s)`);
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

/** A scheduler whose hour plans come from `plan(startMs)`, held back until `open(key)` for the keys in `slow`. */
function slowPlanner(plan, slow = []) {
  const s = new Scheduler();
  const gates = new Map(slow.map((k) => { let open; const p = new Promise((r) => { open = r; }); return [k, { p, open }]; }));
  const seen = [];
  s.generateHour = async (startMs, opts = {}) => {
    const k = key(startMs);
    seen.push({ key: k, planned: s.allItems().filter((i) => i.trackId).map((i) => i.trackId) });
    if (gates.has(k)) await gates.get(k).p;
    return { hourKey: k, startMs, clockName: 'Music Hour', items: plan(startMs, opts) };
  };
  return { s, open: (k) => gates.get(k).open(), seen };
}
const song = (id, hourMs, trackId) => item(id, 'music', hourMs, 'scheduled', { trackId, artist: trackId });

test('a stopgap airs while the hour is still being planned; the plan keeps what aired and does not repeat it', async () => {
  store.data.library = [{ id: 'f1', title: 'Filler', artist: 'Band', category: 'A', duration: 200 }];
  const { s, open, seen } = slowPlanner((start) => (start === T0
    ? [song('p1', T0, 'f1'), song('p2', T0, 'x2'), song('p3', T0, 'x3')]
    : [song('n1', T0 + H, 'x4')]), [key(T0)]);
  const now = T0 + 20 * 60_000;
  const first = s.ensure(now); // planning the hour takes a while (an AI music director)
  const r = s.next(now); // meanwhile the station needs audio
  assert.equal(r.wait.trackId, 'f1', 'filler music from the library');
  assert.equal(s.logs.get(key(T0)).stopgap, true);
  r.wait.status = 'playing';
  const second = s.ensure(now + 30_000); // the next check must not take the stopgap for the planned hour
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(seen.map((x) => x.key), [key(T0)], 'the next hour waits for this one');
  open(key(T0));
  await Promise.all([first, second]);
  const l = s.logs.get(key(T0));
  assert.equal(l.stopgap, undefined, 'the real plan replaced the stopgap');
  assert.deepEqual(l.items.map((i) => i.id), [r.wait.id, 'p2', 'p3'], 'the song on air stays first and is not played again');
  assert.deepEqual(seen.find((x) => x.key === key(T0 + H)).planned.sort(), ['f1', 'x2', 'x3'], "the next hour's rotation saw this hour's picks");
});

test('planning an hour again keeps what aired, is on air or is cued, and drops the rest of the old plan', async () => {
  const { s } = slowPlanner(() => [song('n1', T0, 'b'), song('n2', T0, 'x'), song('n3', T0, 'y')]);
  s.logs.set(key(T0), { hourKey: key(T0), startMs: T0, clockName: 'Music Hour', items: [
    song('o1', T0, 'a'), song('o2', T0, 'b'), song('o3', T0, 'c'), song('o4', T0, 'd'),
  ] });
  const [o1, o2, o3] = s.logs.get(key(T0)).items;
  o1.status = 'played'; o2.status = 'playing'; o3.status = 'cued';
  await s.regenerate(key(T0));
  assert.deepEqual(s.logs.get(key(T0)).items.map((i) => i.id), ['o1', 'o2', 'o3', 'n2', 'n3'], "'b' is on air, so the new plan's 'b' goes");
});

test('a plan made while a stopgap aired swaps its songs by the artist on air for others due', async () => {
  store.data.library = [{ id: 'f1', title: 'Filler', artist: 'Big Star', category: 'A', duration: 200 }];
  const { s, open } = slowPlanner(() => [song('p1', T0, 'b2'), song('p2', T0, 'x9')].map((i) => ({ ...i, artist: i.trackId === 'b2' ? 'Big Star' : 'Nobody', category: 'A' })), [key(T0)]);
  const now = T0 + 20 * 60_000;
  const first = s.ensure(now);
  const r = s.next(now);
  assert.equal(r.wait.trackId, 'f1');
  r.wait.status = 'playing';
  store.data.history.push({ at: now, type: 'music', trackId: 'f1', title: 'Filler', artist: 'Big Star' }); // what the engine records on air
  store.data.library.push( // the library grows while the hour is being planned
    { id: 'b2', title: 'Other One', artist: 'Big Star', category: 'A', duration: 200 },
    { id: 'c3', title: 'Someone Else', artist: 'Calm Band', category: 'A', duration: 200 },
  );
  open(key(T0));
  await first;
  const titles = s.logs.get(key(T0)).items.map((i) => `${i.artist}: ${i.trackId}`);
  assert.deepEqual(titles, ['Big Star: f1', 'Calm Band: c3', 'Nobody: x9'], 'no second Big Star song right after the first');
});

test('after setup, only the coming hour is planned again; the current hour keeps its prepared items', async () => {
  let round = 0;
  const { s } = slowPlanner((start) => [song(`h${start === T0 ? 0 : 1}r${round}`, start, `t${start}-${round}`)]);
  await s.ensure(T0 + 40 * 60_000); // plans this hour and the next
  const before = s.logs.get(key(T0)).items.map((i) => i.id);
  round = 1;
  await s.replanNext(T0 + 41 * 60_000);
  assert.deepEqual(s.logs.get(key(T0)).items.map((i) => i.id), before, 'current hour untouched');
  assert.deepEqual(s.logs.get(key(T0 + H)).items.map((i) => i.id), ['h1r1'], 'next hour planned again');
});
