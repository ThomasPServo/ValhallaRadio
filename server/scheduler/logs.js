// Builds hourly program logs from clocks + the weekly grid, schedules commercials and
// imaging, and serves items to the playout engine with top-of-hour synchronisation.

import { store, uid } from '../store.js';
import { zoned, hourStart, hourKey } from '../util/time.js';
import { selectForHour } from '../ai/musicDirector.js';
import { daypartFor } from '../ai/dj.js';
import { candidatesFor, artistKeys } from './rotation.js';
import * as library from './library.js';

const log = (...a) => console.log('[scheduler]', ...a);

export const KIND = {
  music: 'music',
  dj: 'voice', weather: 'voice', traffic: 'voice', news: 'voice', say: 'voice',
  toh_id: 'imaging', id: 'imaging', sweeper: 'imaging', liner: 'imaging', promo: 'imaging',
  spot: 'spot',
};

const EST = { dj: 15, talk: 35, weather: 25, traffic: 25, news: 75, say: 15, toh_id: 8, id: 5, sweeper: 5, liner: 5, promo: 30, spot: 30 };
const PENDING = new Set(['scheduled', 'preparing', 'ready', 'cued']);
const IMAGING_FALLBACK = { toh_id: ['toh_id', 'id', 'sweeper'], id: ['id', 'toh_id', 'sweeper'], sweeper: ['sweeper', 'id'], liner: ['liner', 'sweeper', 'id'], promo: ['promo'] };

export function estDuration(item) {
  if (item.type === 'music') {
    // airtime is up to the mix-out point, not the full file
    const a = item.trackId ? library.findTrack(item.trackId)?.analysis : null;
    if (a?.mixOut) return Math.max(30, a.mixOut - (a.startSec || 0));
    return Math.max(30, (item.duration || 214) - 4);
  }
  if (item.type === 'spot') return item.duration || 30;
  if (item.type === 'dj') return item.mode === 'talk' ? EST.talk : EST.dj;
  return EST[item.type] || 10;
}

let lastStamp = 0;
export function pickImaging(type) {
  for (const t of IMAGING_FALLBACK[type] || [type]) {
    const today = zoned(new Date(), store.station.timezone).dateKey;
    let pool = store.data.imaging.items.filter((i) => i.enabled && i.type === t && (i.text || i.file) && !(i.expires && i.expires < today)); // seasonal pieces retire themselves
    // produced imaging the station imported plays instead of voiced copy of the same type (unless set to mix)
    if (store.settings.importedImaging !== 'mix' && pool.some((i) => i.file)) pool = pool.filter((i) => i.file);
    if (pool.length) {
      pool.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
      const pick = pool[0];
      lastStamp = Math.max(Date.now(), lastStamp + 1);
      pick.lastUsed = lastStamp; // reserve so the next pick rotates (strictly increasing: least recently used goes next)
      return pick;
    }
  }
  return null;
}

export class Scheduler {
  constructor() {
    this.logs = new Map(); // hourKey -> { hourKey, startMs, clockId, clockName, daypart, items }
    this.generating = new Map();
    this.onChange = () => {};
  }

  tz() { return store.station.timezone; }

  sortedLogs() {
    return [...this.logs.values()].sort((a, b) => a.startMs - b.startMs);
  }

  allItems() {
    return this.sortedLogs().flatMap((l) => l.items);
  }

  pendingItems() {
    return this.allItems().filter((i) => PENDING.has(i.status));
  }

  upcoming(n = 5) {
    return this.pendingItems().slice(0, n);
  }

  findItem(id) {
    return this.allItems().find((i) => i.id === id);
  }

  /** Make sure the current and next hours have logs. */
  async ensure(now = Date.now()) {
    const tz = this.tz();
    const cur = hourStart(new Date(now), tz);
    // sequential, so the next hour's rotation sees this hour's picks
    await this.ensureHour(cur, { fromMs: now });
    if (now - cur > 30 * 60_000 || this.pendingItems().length < 6) await this.ensureHour(cur + 3600_000);
    // forget old logs (keep previous hour for display)
    for (const [k, l] of this.logs) if (l.startMs < cur - 3600_000) this.logs.delete(k);
  }

  /**
   * The hour's log, planning it if needed. An hour being planned is waited for (so the next hour's rotation
   * sees its picks), and a stopgap of filler music counts as not planned. `replace` plans the hour again.
   */
  ensureHour(startMs, opts = {}) {
    const key = hourKey(new Date(startMs), this.tz());
    if (this.generating.has(key)) return this.generating.get(key);
    const have = this.logs.get(key);
    if (have && !have.stopgap && !opts.replace) return Promise.resolve(have);
    const job = this.generateHour(startMs, opts)
      .then((l) => {
        // what has aired, is on air or is committed from the version being replaced stays, and isn't repeated
        const prev = this.logs.get(key);
        let clash = [];
        if (prev) {
          const keep = prev.items.filter((i) => ['playing', 'played', 'cued'].includes(i.status));
          const kept = new Set(keep.filter((i) => i.trackId).map((i) => String(i.trackId)));
          const keptArtists = new Set(keep.filter((i) => i.type === 'music').flatMap((i) => artistKeys(i)));
          l.items = [...keep, ...l.items.filter((i) => !(i.trackId && kept.has(String(i.trackId))))];
          // the plan was made without knowing what aired meanwhile: its songs by those artists make way for others
          clash = l.items.filter((i) => i.type === 'music' && i.status === 'scheduled' && !keep.includes(i) && artistKeys(i).some((k) => keptArtists.has(k)));
        }
        this.logs.set(key, l);
        for (const it of clash) this.replaceMusic(it);
        this.onChange(); return l;
      })
      .catch((err) => { log('generate failed', key, err); throw err; })
      .finally(() => this.generating.delete(key));
    this.generating.set(key, job);
    return job;
  }

  /** Plan an hour again (what has aired or is committed stays; the old plan keeps airing until the new one is ready). */
  async regenerate(key) {
    const l = this.logs.get(key);
    if (!l) return null;
    const now = Date.now();
    return this.ensureHour(l.startMs, { fromMs: now > l.startMs ? now : undefined, replace: true });
  }

  /**
   * Plan the coming hour again, e.g. once the library has grown a lot since it was planned. (The current hour
   * keeps its plan: what's next in it is already prepared, DJ breaks included.)
   */
  async replanNext(now = Date.now()) {
    const start = hourStart(new Date(now), this.tz()) + 3600_000;
    const key = hourKey(new Date(start), this.tz());
    if (this.generating.has(key)) await this.generating.get(key).catch(() => {});
    if (this.logs.has(key)) await this.ensureHour(start, { replace: true });
  }

  async generateHour(startMs, opts = {}) {
    const { fromMs } = opts;
    const tz = this.tz();
    const z = zoned(new Date(startMs), tz);
    const key = hourKey(new Date(startMs), tz);
    const clockId = store.data.grid?.[z.day]?.[z.hour];
    const clock = store.data.clocks.find((c) => c.id === clockId) || store.data.clocks[0];
    const daypart = daypartFor(z.hour);
    log(`building log ${key} with clock "${clock?.name}"`);

    const items = [];
    const base = { hourKey: key, status: 'scheduled' };
    const pendingSpotCounts = this.pendingSpotCounts(z.dateKey);

    for (const ci of clock?.items || []) {
      if (ci.type === 'music') {
        items.push({ ...base, id: uid('it_'), type: 'music', category: ci.category });
      } else if (ci.type === 'stopset') {
        const spots = this.selectSpots(ci.spots || 3, { startMs, dateKey: z.dateKey, daypartId: daypart?.id, counts: pendingSpotCounts });
        if (!spots.length) continue;
        const liner = pickImaging('liner');
        if (liner) items.push(this.imagingItem(liner, base, 'liner'));
        for (const s of spots) {
          pendingSpotCounts[s.id] = (pendingSpotCounts[s.id] || 0) + 1;
          const adv = store.data.advertisers.find((a) => a.id === s.advertiserId);
          items.push({ ...base, id: uid('it_'), type: 'spot', spotId: s.id, title: s.title, artist: adv?.name || 'Commercial', duration: s.durationSec || 30, stopset: true });
        }
        const back = pickImaging('id');
        if (back) items.push(this.imagingItem(back, base, 'id'));
      } else if (KIND[ci.type] === 'imaging') {
        const im = pickImaging(ci.type);
        if (im) items.push(this.imagingItem(im, base, ci.type));
      } else if (KIND[ci.type] === 'voice') {
        items.push({ ...base, id: uid('it_'), type: ci.type, mode: ci.mode || (ci.type === 'dj' ? 'auto' : ''), title: labelFor(ci) });
      }
    }

    // estimate start times then let the music director fill the music slots
    let offset = 0;
    const slots = [];
    items.forEach((it, idx) => {
      it.estOffset = offset;
      if (it.type === 'music') {
        const prev = items.slice(0, idx).reverse().find((x) => x.type !== 'music');
        slots.push({ slot: idx, category: it.category, estAt: startMs + offset * 1000, after: prev && idx > 0 && items[idx - 1].type !== 'music' ? items[idx - 1].type : null });
      }
      offset += estDuration(it);
    });

    // when starting mid-hour, skip what would already have aired
    let skipBefore = -1;
    if (fromMs && fromMs > startMs) {
      const elapsed = (fromMs - startMs) / 1000;
      skipBefore = items.findIndex((it) => it.estOffset >= elapsed);
      if (skipBefore < 0) skipBefore = items.length;
    }
    const liveSlots = slots.filter((s) => s.slot >= skipBefore);
    // songs already planned in other hours count as plays for the rotation rules
    const planned = this.allItems()
      .filter((i) => i.type === 'music' && i.trackId && ['scheduled', 'preparing', 'ready', 'playing'].includes(i.status))
      .map((i) => ({ at: (this.logs.get(i.hourKey)?.startMs || startMs) + (i.estOffset || 0) * 1000, trackId: i.trackId, title: i.title, artist: i.artist }));
    const picks = await selectForHour({ at: startMs, slots: liveSlots, daypart, planned });
    for (const s of liveSlots) {
      const pick = picks.get(s.slot);
      const it = items[s.slot];
      if (pick) Object.assign(it, trackFields(pick.track), { why: pick.why });
      else it.status = 'failed', it.error = 'no music available in library';
    }
    if (skipBefore > 0) {
      items.splice(0, skipBefore);
      const id = opts.replace ? null : pickImaging('id'); // joining the hour mid-way opens with an ID (a re-plan doesn't)
      if (id) items.unshift(this.imagingItem(id, base, 'id'));
    }
    // recompute estimates with real durations
    offset = fromMs && fromMs > startMs ? (fromMs - startMs) / 1000 : 0;
    for (const it of items) { it.estOffset = offset; offset += estDuration(it); }

    return { hourKey: key, startMs, clockId: clock?.id, clockName: clock?.name, daypart: daypart?.name, items };
  }

  imagingItem(im, base, type) {
    return { ...base, id: uid('it_'), type, imagingId: im.id, title: im.name, artist: 'Imaging' };
  }

  pendingSpotCounts(dateKey) {
    const counts = { ...(store.data.spotLog[dateKey] || {}) };
    for (const it of this.allItems()) {
      if (it.type === 'spot' && PENDING.has(it.status) && it.hourKey.startsWith(dateKey)) counts[it.spotId] = (counts[it.spotId] || 0) + 1;
    }
    return counts;
  }

  /** Commercial traffic: pick spots for a stopset honouring flights, dayparts, daily caps and advertiser separation. */
  selectSpots(n, { dateKey, daypartId, counts }) {
    const eligible = store.data.spots.filter((s) => {
      if (!s.enabled) return false;
      if (s.startDate && dateKey < s.startDate) return false;
      if (s.endDate && dateKey > s.endDate) return false;
      if (s.dayparts?.length && !s.dayparts.includes(daypartId)) return false;
      if (s.maxPerDay && (counts[s.id] || 0) >= s.maxPerDay) return false;
      return Boolean(s.text || s.file);
    });
    // most under-delivered first
    eligible.sort((a, b) => {
      const ra = (counts[a.id] || 0) / (a.maxPerDay || 24);
      const rb = (counts[b.id] || 0) / (b.maxPerDay || 24);
      return ra - rb || Math.random() - 0.5;
    });
    const out = [];
    const advertisers = new Set();
    for (const s of eligible) {
      if (out.length >= n) break;
      if (advertisers.has(s.advertiserId)) continue;
      advertisers.add(s.advertiserId);
      out.push(s);
    }
    return out;
  }

  /** Called by the engine to get the next item to air. Handles top-of-hour sync. */
  next(now = Date.now(), { urgent = false } = {}) {
    const tz = this.tz();
    const curKey = hourKey(new Date(now), tz);
    const topMs = hourStart(new Date(now), tz) + 3600_000;
    const secsToTop = (topMs - now) / 1000;

    const ready = (it) => {
      if (it.status === 'ready') return { item: it };
      if (urgent) {
        // the timeline is about to go silent: air the next prepared item instead and keep this one for later
        const alt = this.pendingItems().slice(0, 5).find((x) => x.status === 'ready' && x.hourKey <= it.hourKey && x.type !== 'spot');
        if (alt) return { item: alt };
      }
      return { wait: it };
    };
    for (const it of this.pendingItems()) {
      if (it.hourKey < curKey) {
        // the hour is over: late spots may still run for a few minutes, everything else is dropped
        const lateMin = (now - (topMs - 3600_000)) / 60_000;
        if (it.type === 'spot' && lateMin < 5) return ready(it);
        this.drop(it, it.type === 'spot' ? 'missed' : 'dropped');
        continue;
      }
      if (it.hourKey === curKey) {
        if (secsToTop < 40 && it.type !== 'spot' && this.nextHourReady(curKey)) {
          // jump to the top of the hour slightly early instead of overrunning it
          for (const rest of this.pendingItems()) if (rest.hourKey === curKey && rest.type !== 'spot') this.drop(rest, 'dropped');
          return this.next(now, { urgent });
        }
        return ready(it);
      }
      // the current hour has run dry well before the top of the hour: fill with music
      if (secsToTop > 50) {
        const f = this.filler(curKey, now);
        if (f) return { wait: f };
      }
      return ready(it);
    }
    const f = this.filler(curKey, now);
    return f ? { wait: f } : {};
  }

  nextHourReady(curKey) {
    return this.pendingItems().some((i) => i.hourKey > curKey && i.status === 'ready');
  }

  drop(it, status) {
    it.status = status;
    if (status === 'missed') log(`spot ${it.title} missed (make-good needed)`);
  }

  /** Emergency/filler music from the current clock categories (rule-based, synchronous). */
  filler(curKey, now) {
    const l = this.logs.get(curKey);
    const cats = store.data.categories;
    const clock = store.data.clocks.find((c) => c.id === l?.clockId) || store.data.clocks[0];
    const musicCats = (clock?.items || []).filter((i) => i.type === 'music').map((i) => i.category);
    const plays = library.musicPlays();
    const usedIds = new Set(this.allItems().filter((i) => i.trackId && i.status !== 'failed').map((i) => i.trackId));
    for (const catId of [...new Set(musicCats.length ? musicCats : cats.map((c) => c.id))].sort(() => Math.random() - 0.5)) {
      const category = cats.find((c) => c.id === catId) || { id: catId };
      const t = candidatesFor(library.playable(), { at: now, plays, rotation: store.data.rotation, category }, 10).find((x) => !usedIds.has(x.id));
      if (t) {
        const it = { id: uid('it_'), hourKey: curKey, status: 'scheduled', type: 'music', category: catId, ...trackFields(t), why: 'filler', filler: true };
        // with no plan for the hour yet (it's still being made), a stopgap log airs until it arrives
        if (l) l.items.push(it); else this.logs.set(curKey, { hourKey: curKey, startMs: hourStart(new Date(now), this.tz()), clockName: 'Filler', stopgap: true, items: [it] });
        this.onChange();
        return it;
      }
    }
    return null;
  }

  /** Replace a music item whose audio failed with another track from the same category. */
  /** Swap a song that can't air for another due one from its category (`prefer`: e.g. already cached first). */
  replaceMusic(it, prefer = null) {
    const failed = new Set([...(it.failedIds || []), it.trackId]);
    const category = store.data.categories.find((c) => c.id === it.category) || { id: it.category };
    const usedIds = new Set(this.allItems().filter((i) => i.trackId).map((i) => i.trackId));
    const cands = candidatesFor(library.playable(), { at: Date.now(), plays: library.musicPlays(), rotation: store.data.rotation, category }, 20)
      .filter((x) => !failed.has(x.id) && !usedIds.has(x.id));
    const t = (prefer && cands.find(prefer)) || cands[0];
    it.failedIds = [...failed];
    if (!t || it.failedIds.length > 3) {
      it.status = 'failed';
      return false;
    }
    Object.assign(it, trackFields(t), { status: 'scheduled', why: 'replacement', error: undefined });
    return true;
  }

  /** Previous/next songs around an item (for DJ back/forward-sells). */
  contextFor(item) {
    const seq = this.allItems().filter((i) => !['dropped', 'skipped', 'failed', 'missed'].includes(i.status));
    const idx = seq.findIndex((i) => i.id === item.id);
    const before = seq.slice(0, Math.max(0, idx));
    let previous = before.filter((i) => i.type === 'music').slice(-2).map((i) => library.findTrack(i.trackId) || i);
    if (!previous.length) {
      previous = store.data.history.filter((h) => h.type === 'music').slice(-2).map((h) => library.findTrack(h.trackId) || h);
    }
    const nextIt = seq.slice(idx + 1).find((i) => i.type === 'music');
    const lastNonImaging = before.reverse().find((i) => KIND[i.type] !== 'imaging');
    return {
      previous,
      next: nextIt ? library.findTrack(nextIt.trackId) || nextIt : null,
      nextItem: nextIt || null,
      afterStopset: lastNonImaging?.type === 'spot',
    };
  }

  /** Live assist: insert an item to air next. */
  insertNext(partial) {
    const nextIt = this.pendingItems()[0];
    const key = nextIt?.hourKey || hourKey(new Date(), this.tz());
    const l = this.logs.get(key);
    const it = { id: uid('it_'), hourKey: key, status: 'scheduled', inserted: true, ...partial };
    if (!l) return null;
    const idx = nextIt ? l.items.indexOf(nextIt) : l.items.length;
    l.items.splice(Math.max(0, idx), 0, it);
    this.onChange();
    return it;
  }

  remove(id) {
    const it = this.findItem(id);
    if (it && PENDING.has(it.status)) it.status = 'skipped';
    this.onChange();
    return it;
  }

  /** Move a pending item one position up/down within its hour. */
  move(id, dir) {
    for (const l of this.logs.values()) {
      const i = l.items.findIndex((x) => x.id === id);
      if (i < 0) continue;
      const j = i + (dir < 0 ? -1 : 1);
      if (j < 0 || j >= l.items.length || !PENDING.has(l.items[j].status)) return false;
      [l.items[i], l.items[j]] = [l.items[j], l.items[i]];
      this.onChange();
      return true;
    }
    return false;
  }

  /** Drag-and-drop: move a pending item so it sits right before `beforeId` (any hour). */
  moveTo(id, beforeId) {
    const it = this.findItem(id);
    if (!it || !PENDING.has(it.status) || id === beforeId) return false;
    const target = beforeId ? this.findItem(beforeId) : null;
    if (target && !PENDING.has(target.status)) return false;
    for (const l of this.logs.values()) { const i = l.items.indexOf(it); if (i >= 0) l.items.splice(i, 1); }
    const destLog = this.logs.get(target ? target.hourKey : it.hourKey);
    if (!destLog) return false;
    it.hourKey = destLog.hourKey;
    const at = target ? destLog.items.indexOf(target) : destLog.items.length;
    destLog.items.splice(at, 0, it);
    this.onChange();
    return true;
  }

  snapshot() {
    return this.sortedLogs().map((l) => ({
      hourKey: l.hourKey, startMs: l.startMs, clockName: l.clockName, daypart: l.daypart,
      items: l.items.map((i) => ({
        id: i.id, type: i.type, kind: KIND[i.type], status: i.status, title: i.title, artist: i.artist, artwork: i.artwork,
        duration: i.audioDuration || estDuration(i), category: i.category, why: i.why, script: i.script, error: i.error,
        trackId: i.trackId, estOffset: i.estOffset, airedAt: i.airedAt, mode: i.mode, filler: i.filler, inserted: i.inserted,
        markers: i.markers || null, transition: i.transition || null, persona: i.persona,
      })),
    }));
  }
}

function trackFields(t) {
  return { trackId: t.id, title: t.title, artist: t.artist, artwork: t.artwork, duration: t.duration, album: t.album, year: t.year };
}

function labelFor(ci) {
  return {
    dj: ci.mode === 'talk' ? 'DJ Talk Break' : 'DJ Break',
    weather: 'Weather', traffic: 'Traffic', news: 'Newscast',
  }[ci.type] || ci.type;
}
