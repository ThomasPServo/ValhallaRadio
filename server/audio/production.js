// Production: turns scripts and copy into broadcast-ready elements.
//
//  - DJ voice through a broadcast mic chain (HPF, de-mud, presence, air, compression, de-ess).
//  - Imaging (legal IDs, sweepers, liners, promos) produced with synthesized sound design:
//    whooshes, risers, sub-drop impacts, reverb and an echo throw on the last word.
//  - News / weather / traffic open with a sounder and sit on a ticking bed.
//  - Every element reports markers (voiceStart, voiceEnd, post, tailStart) in seconds so the
//    transition planner can keep voices off vocals and land songs on the post.
//
// Rendering happens in the worker thread (productionDsp.js) and is cached as WAV, so a produced
// element costs nothing after the first render and needs no sample libraries or extra API keys.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TTS_CACHE_DIR, UPLOAD_DIR } from '../config.js';
import { store } from '../store.js';
import { synthesize, ttsAvailable } from '../voice/tts.js';
import { decodeToPcm } from '../engine/audio.js';
import { renderImagingText } from '../ai/dj.js';
import { analyze } from './analysisPool.js';
import { bedFile, chosenBedId, FORMAT_BEDS } from './beds.js';

const PROD_VERSION = 4;
const key = (...parts) => crypto.createHash('sha1').update(JSON.stringify([PROD_VERSION, ...parts])).digest('hex').slice(0, 20);

/** Imaging voiced over music uses the station's synthesized bed (uploaded beds may be any format). */
function imagingBedId() {
  const id = chosenBedId();
  return id.startsWith('synth:') ? id : `synth:${FORMAT_BEDS[store.station.formatId] || 'warm'}`;
}

const rendering = new Map(); // name -> the render writing it

/** Render (or reuse) a produced element from a TTS voice file. */
async function render(name, voiceFile, opts) {
  const file = path.join(TTS_CACHE_DIR, `${name}.wav`);
  const meta = `${file}.json`;
  if (fs.existsSync(file) && fs.existsSync(meta)) {
    const now = new Date();
    try { fs.utimesSync(file, now, now); fs.utimesSync(meta, now, now); } catch { /* fine */ } // in use: the janitor keeps it
    return { file, markers: JSON.parse(fs.readFileSync(meta, 'utf8')) };
  }
  // asked for again while rendering (made ahead of time, then wanted on air): one render, its own markers each
  if (!rendering.has(name)) {
    rendering.set(name, (async () => {
      const pcm = await decodeToPcm(voiceFile);
      const markers = await analyze('produce', pcm, { ...opts, out: file });
      fs.writeFileSync(meta, JSON.stringify(markers));
      return markers;
    })().finally(() => rendering.delete(name)));
  }
  const markers = await rendering.get(name);
  return { file, markers: { ...markers } };
}

/**
 * Voice and produce the station's IDs ahead of time (at setup), in the order they'll be picked, so a
 * new station's first ID is ready when it goes on air instead of rendering while the air is silent.
 */
export async function prerenderIds() {
  if (!ttsAvailable()) return;
  const due = (type) => store.data.imaging.items.filter((i) => i.enabled && i.type === type && i.text && !i.file).sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
  const ids = due('id'); const tohs = due('toh_id');
  for (const im of [...ids.slice(0, 2), ...tohs.slice(0, 1), ...ids.slice(2), ...tohs.slice(1)]) {
    try { await produceElement({ type: im.type, imagingId: im.id }); } catch (err) { console.warn('[imaging] voicing ahead:', im.name, err.message); return; }
  }
}

/**
 * Render any non-music log element to a WAV file with transition markers.
 * @returns {Promise<{file:string, markers:{voiceStart,voiceEnd,post,tailStart}|null}>}
 */
export async function produceElement(item) {
  const prod = store.settings.production || {};
  const fx = prod.imagingFx !== false;
  if (item.type === 'spot') {
    const spot = store.data.spots.find((s) => s.id === item.spotId);
    if (!spot) throw new Error('spot deleted');
    if (spot.file) return { file: path.join(UPLOAD_DIR, spot.file), markers: null };
    if (!ttsAvailable()) throw new Error('spot has no audio and no voice engine is configured');
    const voice = spot.voice?.elevenLabsVoiceId || spot.voice?.openaiVoice || spot.voice?.kokoroVoice ? spot.voice : store.data.imaging.voice;
    const vf = await synthesize(spot.text, voice);
    return render(`spot_${key(vf)}`, vf, { template: 'spot' });
  }
  if (item.type === 'bed') return { file: await bedFile(item.imagingId), markers: null }; // fired as a cart
  if (['toh_id', 'id', 'sweeper', 'liner', 'promo'].includes(item.type)) {
    const im = store.data.imaging.items.find((i) => i.id === item.imagingId);
    if (!im) throw new Error('imaging item deleted');
    if (im.file) return { file: path.join(UPLOAD_DIR, im.file), markers: im.markers || null };
    if (!ttsAvailable()) throw new Error('imaging has no audio file and no voice engine is configured');
    const vf = await synthesize(renderImagingText(im.text), { pause: 0.16, ...store.data.imaging.voice }); // imaging reads tighter than talk
    const style = fx ? im.fx || true : false; // per-piece FX style, unless imaging FX are off station-wide
    const bed = style === 'music' ? await bedFile(imagingBedId()) : null;
    return render(`img_${key(vf, im.type, style, bed && path.basename(bed))}`, vf, { template: 'imaging', type: im.type, fx: style, bedFile: bed });
  }
  // voice: DJ breaks, live reads, news / weather / traffic
  if (!ttsAvailable()) throw new Error('no voice engine configured — script written but not voiced');
  const persona = store.data.personas.find((p) => p.name === item.persona) || store.data.personas[0];
  const vf = await synthesize(item.script, persona?.voice || {});
  if (['news', 'weather', 'traffic'].includes(item.type)) {
    const useBed = prod.infoBeds !== false;
    return render(`info_${key(vf, item.type, useBed)}`, vf, { template: 'info', type: item.type, bed: useBed });
  }
  return render(`dj_${key(vf)}`, vf, { template: 'dj' });
}
