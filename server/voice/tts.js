// Text-to-speech for the DJ and station imaging.
//  - ElevenLabs: most human-sounding; eleven_v3 understands audio tags like [laughs].
//  - OpenAI-compatible /audio/speech: OpenAI gpt-4o-mini-tts (steerable via `instructions`)
//    or any self-hosted compatible server (Kokoro-FastAPI, openedai-speech, ...).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TTS_CACHE_DIR } from '../config.js';
import { store } from '../store.js';

export function ttsAvailable() {
  const s = store.settings;
  return (s.ttsProvider === 'elevenlabs' && !!s.elevenLabsApiKey) || (s.ttsProvider === 'openai' && !!(s.openaiApiKey || !/api\.openai\.com/.test(s.openaiBaseUrl)));
}

/** Strip ElevenLabs v3 style audio tags for providers that would read them aloud. */
export function stripTags(text) {
  return text.replace(/\[[a-z][a-z \-']{1,30}\]/gi, '').replace(/\s{2,}/g, ' ').trim();
}

export function supportsAudioTags() {
  const s = store.settings;
  return s.ttsProvider === 'elevenlabs' && /v3/.test(s.elevenLabsModel || '');
}

/**
 * @param {string} text
 * @param {object} voice persona voice config { elevenLabsVoiceId, openaiVoice, instructions }
 * @returns {Promise<string>} path to an mp3 file
 */
export async function synthesize(text, voice = {}) {
  const s = store.settings;
  const provider = s.ttsProvider;
  if (!ttsAvailable()) throw new Error('No TTS provider configured (Settings → Voice).');
  const spoken = supportsAudioTags() ? text : stripTags(text);
  const id = crypto.createHash('sha1')
    .update(JSON.stringify([provider, s.elevenLabsModel, s.openaiTtsModel, voice, spoken]))
    .digest('hex');
  const file = path.join(TTS_CACHE_DIR, `${id}.mp3`);
  if (fs.existsSync(file)) return file;

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
    const body = {
      model: s.openaiTtsModel || 'gpt-4o-mini-tts',
      voice: voice.openaiVoice || 'ash',
      input: spoken,
      response_format: 'mp3',
    };
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
