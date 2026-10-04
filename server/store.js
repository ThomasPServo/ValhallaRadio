import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const DB_FILE = path.join(DATA_DIR, 'db.json');

export const uid = (prefix = '') => prefix + crypto.randomBytes(6).toString('hex');

/** Default station, used on first launch and to back-fill keys added in newer versions. */
export function defaultDb() {
  return {
    version: 1,
    station: {
      // "Valhalla" is the software; the station is yours. setupComplete=false opens the setup wizard.
      setupComplete: false,
      formatId: '',
      name: 'My Station',
      callSign: '',
      frequency: '',
      slogan: '',
      format: 'Hot Adult Contemporary: upbeat pop and pop-rock hits from the 2000s to today, with a few 80s and 90s gold tracks.',
      language: 'English',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      timezoneMode: 'auto', // 'auto' follows the primary market location; 'manual' keeps the chosen zone
      units: 'imperial',
      logo: '',
      website: '',
      email: '',
      phone: '',
      socials: { instagram: '', x: '', tiktok: '', facebook: '', youtube: '' },
      market: {
        name: '',
        description: '',
        locations: [], // { name, lat, lon, kind: 'city'|'county', bbox, timezone }
      },
    },
    settings: {
      // AI: 'auto' | 'claude-code' | 'api' (Anthropic key) | 'codex' (ChatGPT login) | 'openai' (key) | 'lmstudio' (local)
      claudeProvider: 'auto',
      claudeCliPath: '',
      anthropicApiKey: '',
      claudeModel: 'claude-sonnet-5-5',
      aiFallback: true, // when the chosen AI fails or hits a limit, use the next one that's ready
      // ChatGPT via the Codex CLI (signed in with a ChatGPT account); blank model = Codex's default
      codexCliPath: '',
      codexModel: '',
      // OpenAI API (uses openaiApiKey below) and local LM Studio server
      openaiModel: '',
      lmstudioUrl: 'http://localhost:1234/v1',
      lmstudioModel: '', // blank = the first model LM Studio has loaded
      useClaudeForMusic: true,
      cleanOnly: true, // broadcast-safe: explicit songs are swapped for clean radio edits or never aired
      allowDiscovery: true, // let Claude pull new music from monochrome when the library runs thin
      monochromeBase: 'https://tracks.monochrome.st',
      // Voice: 'auto' = ElevenLabs if keyed, else the free local Kokoro voice, else OpenAI
      ttsProvider: 'auto',
      elevenLabsApiKey: '',
      elevenLabsModel: 'eleven_multilingual_v2',
      openaiApiKey: '',
      openaiBaseUrl: 'https://api.openai.com/v1',
      openaiTtsModel: 'gpt-4o-mini-tts',
      newsFeeds: [], // extra RSS urls
      trafficFeeds: [], // extra keyless traffic feeds: RSS or WZDx GeoJSON urls
      // Transitions
      duckDb: -12, // music under the DJ
      postGap: 0.5, // vocals hit this long after the talk ends
      talkOverOutroMax: 6,
      beatMatch: true,
      musicLoudness: -16, // per-song level before processing (LUFS)
      normalize: true,
      lookaheadItems: 3,
      // Production
      production: { imagingFx: true, infoBeds: true },
      // Auto-bed: a music bed under DJ talk whenever there's no song intro or outro to talk over
      autoBed: { enabled: true, levelDb: -12, bed: 'auto' }, // bed: 'auto' | 'synth:<style>' | uploaded bed id
      // Auto-sweeper creator: fresh imaging written and produced every `everyDays`, newest `keep` stay in rotation
      autoImaging: { enabled: true, everyDays: 7, perRun: 6, keep: 18, lastRun: 0 },
      // Audio sourcing: stream songs; download only when streaming fails
      downloadFallback: true,
      musicCacheMaxMb: 2048,
    },
    stream: {
      bitrate: 128,
      icecast: { enabled: false, host: '', port: 8000, mount: '/live', username: 'source', password: '', public: false },
    },
    categories: [
      { id: 'A', name: 'Power Current', color: '#ef4444', minRestHours: 2.5 },
      { id: 'B', name: 'Current', color: '#f97316', minRestHours: 4 },
      { id: 'C', name: 'Recurrent', color: '#eab308', minRestHours: 8 },
      { id: 'G', name: 'Gold', color: '#22c55e', minRestHours: 24 },
      { id: 'N', name: 'New / Discovery', color: '#3b82f6', minRestHours: 6 },
    ],
    rotation: {
      artistSeparationMin: 60,
      titleSeparationMin: 180,
      maxSameArtistPerHour: 1,
    },
    clocks: [
      {
        id: 'clk_standard',
        name: 'Standard Hour',
        color: '#6366f1',
        items: [
          { type: 'toh_id' },
          { type: 'music', category: 'A' },
          { type: 'music', category: 'C' },
          { type: 'dj', mode: 'auto' },
          { type: 'music', category: 'B' },
          { type: 'music', category: 'G' },
          { type: 'sweeper' },
          { type: 'music', category: 'A' },
          { type: 'stopset', spots: 3 },
          { type: 'weather' },
          { type: 'music', category: 'N' },
          { type: 'music', category: 'B' },
          { type: 'sweeper' },
          { type: 'music', category: 'C' },
          { type: 'music', category: 'A' },
          { type: 'dj', mode: 'auto' },
          { type: 'music', category: 'G' },
          { type: 'music', category: 'B' },
          { type: 'stopset', spots: 3 },
          { type: 'traffic' },
          { type: 'music', category: 'A' },
          { type: 'sweeper' },
          { type: 'music', category: 'C' },
          { type: 'music', category: 'B' },
        ],
      },
      {
        id: 'clk_news',
        name: 'News-Led Morning Hour',
        color: '#0ea5e9',
        items: [
          { type: 'toh_id' },
          { type: 'news' },
          { type: 'weather' },
          { type: 'traffic' },
          { type: 'music', category: 'A' },
          { type: 'dj', mode: 'auto' },
          { type: 'music', category: 'C' },
          { type: 'music', category: 'B' },
          { type: 'stopset', spots: 4 },
          { type: 'music', category: 'G' },
          { type: 'sweeper' },
          { type: 'music', category: 'A' },
          { type: 'traffic' },
          { type: 'music', category: 'B' },
          { type: 'dj', mode: 'talk' },
          { type: 'music', category: 'N' },
          { type: 'stopset', spots: 4 },
          { type: 'weather' },
          { type: 'music', category: 'A' },
          { type: 'music', category: 'C' },
          { type: 'sweeper' },
          { type: 'music', category: 'B' },
        ],
      },
    ],
    // grid[day][hour] -> clockId. day 0 = Sunday.
    grid: Array.from({ length: 7 }, (_, d) =>
      Array.from({ length: 24 }, (_, h) => (d >= 1 && d <= 5 && h >= 6 && h <= 9 ? 'clk_news' : 'clk_standard')),
    ),
    dayparts: [
      { id: 'dp_overnight', name: 'Overnight', startHour: 0, endHour: 5, mood: 'Laid back, smoother and mellower picks, fewer big bangers. Intimate late-night tone.', personaId: 'dj_nova' },
      { id: 'dp_morning', name: 'Morning Drive', startHour: 6, endHour: 9, mood: 'High energy, familiar hits to wake people up. Info-heavy: time, weather, traffic often.', personaId: 'dj_max' },
      { id: 'dp_midday', name: 'Midday', startHour: 10, endHour: 14, mood: 'Steady at-work listening, lots of music, positive and familiar.', personaId: 'dj_max' },
      { id: 'dp_afternoon', name: 'Afternoon Drive', startHour: 15, endHour: 18, mood: 'Building energy for the drive home, upbeat, fun.', personaId: 'dj_nova' },
      { id: 'dp_evening', name: 'Evening', startHour: 19, endHour: 23, mood: 'Party-leaning, newer music and discovery, more dance tempo early, easing off late.', personaId: 'dj_nova' },
    ],
    personas: [
      {
        id: 'dj_max',
        name: 'Max',
        style: 'Warm, quick-witted morning-show host in his 30s. Conversational, a little self-deprecating, loves music trivia. Never cheesy "radio voice". Talks like a real person to one listener.',
        voice: { kokoroVoice: 'am_michael', elevenLabsVoiceId: 'pNInz6obpgDQGcFmaJgB', openaiVoice: 'ash', instructions: 'Upbeat, warm, conversational radio host. Natural pacing with a smile in the voice.' },
      },
      {
        id: 'dj_nova',
        name: 'Nova',
        style: 'Smooth, confident, friendly host in her late 20s. Genuine enthusiasm about the music, a bit playful, relaxed delivery. Talks to the listener like a friend riding along.',
        voice: { kokoroVoice: 'af_heart', elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL', openaiVoice: 'coral', instructions: 'Relaxed, friendly, slightly playful radio host. Smooth, intimate delivery.' },
      },
    ],
    imaging: {
      voice: { kokoroVoice: 'am_michael', elevenLabsVoiceId: 'onwK4e9ZLuTAKqWW03F9', openaiVoice: 'onyx', instructions: 'Deep, powerful, polished radio station imaging voice. Punchy and dramatic.' },
      items: [
        { id: 'img_toh1', type: 'toh_id', name: 'Legal ID 1', text: '{callSign}, {frequency}. {slogan}. {market}.', file: '', enabled: true },
        { id: 'img_id1', type: 'id', name: 'Station ID 1', text: '{name}. {slogan}.', file: '', enabled: true },
        { id: 'img_sw1', type: 'sweeper', name: 'Sweeper - More Music', text: 'More music. Less talk. {name}.', file: '', enabled: true },
        { id: 'img_sw2', type: 'sweeper', name: 'Sweeper - Hits', text: 'The biggest hits, all day long. {frequency}, {name}.', file: '', enabled: true },
        { id: 'img_sw3', type: 'sweeper', name: 'Sweeper - Feel Good', text: 'Feel good radio. This is {name}.', file: '', enabled: true },
        { id: 'img_liner1', type: 'liner', name: 'Into Stopset', text: '{name} will be right back.', file: '', enabled: true },
      ],
    },
    processing: { preset: 'streaming', overrides: {} },
    advertisers: [],
    spots: [], // { id, advertiserId, title, text, file, durationSec, startDate, endDate, maxPerDay, dayparts:[], enabled }
    library: [], // tracks
    history: [], // { at, type, title, artist, trackId, spotId }
    spotLog: {}, // { 'YYYY-MM-DD': { spotId: count } }
  };
}

class Store {
  constructor() {
    this.data = defaultDb();
    this._timer = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const defaults = defaultDb();
        this.data = { ...defaults, ...parsed };
        // back-fill nested objects that may gain keys over time
        for (const key of ['station', 'settings', 'stream', 'rotation', 'imaging', 'processing']) {
          this.data[key] = { ...defaults[key], ...(parsed[key] || {}) };
        }
        this.data.station.market = { ...defaults.station.market, ...(parsed.station?.market || {}) };
        this.data.station.socials = { ...defaults.station.socials, ...(parsed.station?.socials || {}) };
        this.data.settings.production = { ...defaults.settings.production, ...(parsed.settings?.production || {}) };
        this.data.settings.autoBed = { ...defaults.settings.autoBed, ...(parsed.settings?.autoBed || {}) };
        this.data.settings.autoImaging = { ...defaults.settings.autoImaging, ...(parsed.settings?.autoImaging || {}) };
        this.data.stream.icecast = { ...defaults.stream.icecast, ...(parsed.stream?.icecast || {}) };
      }
    } catch (err) {
      console.error('[store] failed to load db, using defaults:', err.message);
    }
    // Environment variables seed secrets without having to type them into the UI.
    const s = this.data.settings;
    if (!s.anthropicApiKey && process.env.ANTHROPIC_API_KEY) s.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    if (process.env.LMSTUDIO_URL) s.lmstudioUrl = process.env.LMSTUDIO_URL;
    // Sonnet is the default Claude model now; stations still on the old default move over once
    if (!s.aiDefaultsV2) { if (s.claudeModel === 'claude-opus-5-5') s.claudeModel = 'claude-sonnet-5-5'; s.aiDefaultsV2 = true; }
    if (!s.elevenLabsApiKey && process.env.ELEVENLABS_API_KEY) s.elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
    if (!s.openaiApiKey && process.env.OPENAI_API_KEY) s.openaiApiKey = process.env.OPENAI_API_KEY;
    delete s.tomtomApiKey; // traffic is keyless now
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    clearTimeout(this._timer);
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }

  get station() { return this.data.station; }
  get settings() { return this.data.settings; }

  /** Settings safe to send to the browser (secrets masked). */
  publicSettings() {
    const s = { ...this.data.settings };
    for (const k of ['anthropicApiKey', 'elevenLabsApiKey', 'openaiApiKey']) {
      s[k] = s[k] ? '••••' + String(s[k]).slice(-4) : '';
    }
    return s;
  }

  updateSettings(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (typeof v === 'string' && v.startsWith('••••')) continue; // unchanged masked secret
      this.data.settings[k] = v;
    }
    this.save();
  }

  addHistory(entry) {
    this.data.history.push({ at: Date.now(), ...entry });
    if (this.data.history.length > 2000) this.data.history.splice(0, this.data.history.length - 2000);
    this.save();
  }
}

export const store = new Store();
