// Auto-sweeper creator: writes fresh imaging (Claude or templates), produces every piece right away
// so it's ready to air, keeps the newest pieces in rotation and retires the oldest. Runs on demand
// from the Imaging page and on its own schedule (weekly by default).

import { EventEmitter } from 'node:events';
import { store, uid } from '../store.js';
import { writeImaging } from '../ai/imagingWriter.js';
import { produceElement } from './production.js';
import { ttsAvailable } from '../voice/tts.js';

export const imagingEvents = new EventEmitter();
let job = null;
const log = (...a) => console.log('[imaging]', ...a);

export function imagingJobStatus() {
  return job ? { ...job, running: !job.done } : { running: false, done: true };
}

/** Keep the newest `keep` auto-created pieces (pinned ones always stay); returns the removed ids. */
export function retireOld(items, keep) {
  const autos = items.filter((i) => i.auto && !i.pinned).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const drop = new Set(autos.slice(Math.max(0, keep)).map((i) => i.id));
  for (let k = items.length - 1; k >= 0; k--) if (drop.has(items[k].id)) items.splice(k, 1);
  return [...drop];
}

/**
 * Write and produce new imaging.
 * @param {{count?: number, guidance?: string, produce?: boolean, scheduled?: boolean}} o
 */
export async function createImaging({ count = 6, guidance = '', produce = true, scheduled = false } = {}) {
  if (job && !job.done) throw Object.assign(new Error('the imaging creator is already running'), { status: 409 });
  job = { startedAt: Date.now(), done: false, phase: 'writing', count, created: [], produced: 0, rejected: [], errors: [], scheduled };
  const emit = () => imagingEvents.emit('progress', imagingJobStatus());
  emit();
  try {
    const { pieces, rejected, source } = await writeImaging({ count, guidance });
    job.rejected = rejected;
    job.source = source;
    const now = Date.now();
    const items = pieces.map((p, i) => ({ id: uid('img_'), ...p, file: '', enabled: true, auto: true, createdAt: now + i }));
    store.data.imaging.items.push(...items);
    const cfg = store.settings.autoImaging || {};
    if (scheduled && cfg.keep) job.retired = retireOld(store.data.imaging.items, cfg.keep);
    store.settings.autoImaging = { ...cfg, lastRun: now };
    store.save();
    job.created = items.map((i) => ({ id: i.id, type: i.type, name: i.name, text: i.text, fx: i.fx }));
    log(`wrote ${items.length} pieces (${source}); ${rejected.length} rejected`);
    if (produce && ttsAvailable()) {
      job.phase = 'producing';
      emit();
      for (const it of items) {
        try {
          await produceElement({ type: it.type, imagingId: it.id });
          it.producedAt = Date.now();
          job.produced++;
        } catch (err) {
          job.errors.push(`${it.name}: ${err.message}`);
        }
        emit();
      }
      store.save();
    }
  } catch (err) {
    job.errors.push(err.message);
    log('failed:', err.message);
  } finally {
    job.phase = 'done';
    job.done = true;
    emit();
  }
  return imagingJobStatus();
}

/** Fresh imaging on a schedule (and the first batch once a new station's library is built). */
export function startAutoImaging() {
  const check = () => {
    const cfg = store.settings.autoImaging || {};
    if (!cfg.enabled || !store.station.setupComplete || (job && !job.done)) return;
    if (store.data.library.length < 20 || !ttsAvailable()) return; // roll-calls need a library; production needs a voice
    if (Date.now() - (cfg.lastRun || 0) < (cfg.everyDays || 7) * 86400_000) return;
    createImaging({ count: cfg.perRun || 6, scheduled: true }).catch((err) => log('scheduled run failed:', err.message));
  };
  setTimeout(check, 90_000).unref();
  setInterval(check, 3600_000).unref();
  return check;
}
