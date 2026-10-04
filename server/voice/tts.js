// Text-to-speech for the DJ and station imaging.
//  - kokoro (default when installed): free local neural voice, no API key.
//  - elevenlabs: the most human-sounding; eleven_v3 understands audio tags like [laughs].
//  - openai: OpenAI gpt-4o-mini-tts (steerable via `instructions`) or any compatible server.
// 'auto' picks ElevenLabs if a key is set, otherwise the local Kokoro voice, otherwise OpenAI.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TTS_CACHE_DIR } from '../config.js';
import { store } from '../store.js';
import { kokoroInstalled, kokoroSpeak } from './kokoro.js';
import { speakable } from './speech.js';

const touch = (f) => { try { const now = new Date(); fs.utimesSync(f, now, now); } catch { /* fine */ } };

export function activeProvider() {
  const s = store.settings;
  const p = s.ttsProvider || 'auto';
  if (p !== 'auto') return p;
  if (s.elevenLabsApiKey) return 'elevenlabs';
  if (kokoroInstalled()) return 'kokoro';
  if (s.openaiApiKey) return 'openai';
  return 'none';
}

export function ttsAvailable() {
  const s = store.settings;
  switch (activeProvider()) {
    case 'elevenlabs': return Boolean(s.elevenLabsApiKey);
    case 'kokoro': return kokoroInstalled();
    case 'openai': return Boolean(s.openaiApiKey || !/api\.openai\.com/.test(s.openaiBaseUrl || 'api.openai.com'));
    default: return false;
  }
}

/** Strip ElevenLabs v3 style audio tags for providers that would read them aloud. */
export function stripTags(text) {
  return text.replace(/\[[a-z][a-z \-']{1,30}\]/gi, '').replace(/\s{2,}/g, ' ').trim();
}

export function supportsAudioTags() {
  return activeProvider() === 'elevenlabs' && /v3/.test(store.settings.elevenLabsModel || '');
}

/**
 * @param {string} text
 * @param {object} voice { kokoroVoice, elevenLabsVoiceId, openaiVoice, instructions }
 * @returns {Promise<string>} path to an audio file
 */
export async function synthesize(text, voice = {}) {
  const s = store.settings;
  const provider = activeProvider();
  if (!ttsAvailable()) throw new Error('No voice engine configured (Settings → Voice).');
  // numbers the radio way (one oh one point nine, US one eighty-three, seven oh five)
  const spoken = speakable(supportsAudioTags() ? text : stripTags(text), store.station);
  const id = crypto.createHash('sha1')
    .update(JSON.stringify([provider, provider === 'elevenlabs' ? s.elevenLabsModel : provider === 'openai' ? s.openaiTtsModel : 'kokoro-v2', voice, spoken]))
    .digest('hex');
  const ext = provider === 'kokoro' ? 'wav' : 'mp3';
  const file = path.join(TTS_CACHE_DIR, `${id}.${ext}`);
  if (fs.existsSync(file)) { touch(file); return file; } // reuse keeps it from the janitor

  if (provider === 'kokoro') {
    await kokoroSpeak(spoken, { voice: voice.kokoroVoice || 'af_heart', speed: voice.speed || 1, pause: voice.pause ?? 0.3, out: file });
    return file;
  }
  let buf;
  if (provider === 'elevenlabs') {
    const voiceId = voice.elevenLabsVoiceId || 'pNInz6obpgDQGcFmaJgB';
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': s.elevenLabsApiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: spoken,
        model_id: s.elevenLabsModel || 'eleven_multilingual_v2',
        voice_settings: { stability: voice.stability ?? 0.4, similarity_boost: 0.8, style: voice.style ?? 0.35, use_speaker_boost: true },
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    const baseUrl = (s.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const body = { model: s.openaiTtsModel || 'gpt-4o-mini-tts', voice: voice.openaiVoice || 'ash', input: spoken, response_format: 'mp3' };
    if (voice.instructions && /gpt-4o/.test(body.model)) body.instructions = voice.instructions;
    const res = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.openaiApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    buf = Buffer.from(await res.arrayBuffer());
  }
  fs.writeFileSync(file, buf);
  return file;
}
