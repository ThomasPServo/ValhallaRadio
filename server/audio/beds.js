// Music beds for auto-bed: synthesized styles (rendered once in a worker, cached as WAV) and
// beds the station uploads (imaging items of type "bed", crossfaded into seamless loops).
import fs from 'node:fs';
import path from 'node:path';
import { TTS_CACHE_DIR, UPLOAD_DIR, SAMPLE_RATE as SR } from '../config.js';
import { store } from '../store.js';
import { BED_STYLES, makeLoop } from './bedSynth.js';
import { oneShot } from './analysisPool.js';
import { loadAudio } from '../engine/audio.js';

const BED_VERSION = 1;

/** Default bed style for each station format. */
export const FORMAT_BEDS = {
  chr: 'pulse', hotac: 'pulse', dance: 'pulse',
  ac: 'warm', country: 'warm',
  classichits: 'drive', classicrock: 'drive', alternative: 'drive', adulthits: 'drive',
  urban: 'chill',
};

export function bedList() {
  const synth = Object.values(BED_STYLES).map((s) => ({ id: `synth:${s.id}`, name: s.name, description: s.description, bpm: s.bpm, synth: true }));
  const uploaded = (store.data.imaging?.items || [])
    .filter((i) => i.type === 'bed' && i.file)
    .map((i) => ({ id: i.id, name: i.name, description: 'Uploaded bed', synth: false, enabled: i.enabled !== false }));
  return [...synth, ...uploaded];
}

/** The bed auto-bed should use: the chosen one, else the station's own uploaded bed, else the format's style. */
export function chosenBedId() {
  const want = store.settings.autoBed?.bed || 'auto';
  const list = bedList();
  if (want !== 'auto' && list.some((b) => b.id === want)) return want;
  const own = list.find((b) => !b.synth && b.enabled);
  return own ? own.id : `synth:${FORMAT_BEDS[store.station.formatId] || 'warm'}`;
}

const rendering = new Map();

/** Path of a bed's audio, rendering a synthesized style the first time it's needed. */
export async function bedFile(id) {
  if (id.startsWith('synth:')) {
    const style = id.slice(6);
    if (!BED_STYLES[style]) throw new Error(`unknown bed style "${style}"`);
    const file = path.join(TTS_CACHE_DIR, `bed_${style}_v${BED_VERSION}.wav`);
    if (fs.existsSync(file)) {
      try { const now = new Date(); fs.utimesSync(file, now, now); } catch { /* fine */ } // reuse keeps it from the janitor
      return file;
    }
    if (!rendering.has(file)) {
      const tmp = `${file}.${process.pid}.tmp.wav`;
      rendering.set(file, oneShot('bed', { style, out: tmp })
        .then(() => fs.renameSync(tmp, file))
        .finally(() => rendering.delete(file)));
    }
    await rendering.get(file);
    return file;
  }
  const im = (store.data.imaging?.items || []).find((i) => i.id === id && i.type === 'bed');
  if (!im?.file) throw new Error('bed not found');
  return path.join(UPLOAD_DIR, im.file);
}

/** Public URL for previewing a bed in the browser. */
export async function bedUrl(id) {
  const file = await bedFile(id);
  return file.startsWith(UPLOAD_DIR) ? `/uploads/${path.basename(file)}` : `/tts/${path.basename(file)}`;
}

/**
 * Decode a bed into a loop buffer for the engine, level-matched to the music.
 * @returns {Promise<{id:string, name:string, pcm:Int16Array, frames:number, gain:number, seconds:number}>}
 */
export async function loadBed(id) {
  const file = await bedFile(id);
  const a = await loadAudio(file, { normalize: true, targetDb: store.settings.musicLoudness ?? -16 });
  // synthesized loops are already seamless; uploaded beds get their tail crossfaded into their head
  const pcm = id.startsWith('synth:') ? a.pcm : makeLoop(a.pcm.subarray(a.startFrame * 2, a.endFrame * 2));
  const name = bedList().find((b) => b.id === id)?.name || 'Bed';
  return { id, name, pcm, frames: pcm.length / 2, gain: a.gain, seconds: pcm.length / 2 / SR };
}
