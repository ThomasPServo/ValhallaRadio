import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.resolve(process.env.VALHALLA_DATA_DIR || path.join(ROOT, 'data'));
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const MUSIC_CACHE_DIR = path.join(CACHE_DIR, 'music');
export const TTS_CACHE_DIR = path.join(CACHE_DIR, 'tts');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const PUBLIC_DIR = path.join(ROOT, 'public');

for (const dir of [DATA_DIR, CACHE_DIR, MUSIC_CACHE_DIR, TTS_CACHE_DIR, UPLOAD_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const PORT = Number(process.env.PORT || 8080);
export const HOST = process.env.HOST || '0.0.0.0';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// Internal PCM format used by the playout engine.
export const SAMPLE_RATE = 44100;
export const CHANNELS = 2;
