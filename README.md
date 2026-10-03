# Valhalla Radio

Web-based radio automation for the AI era. Valhalla runs a 24/7 station on its own:

- **Music from [monochrome](https://github.com/monochrome-music/monochrome).** Lossless audio comes from the `tracks.monochrome.st` API: search, artists, albums and streams.
- **Claude as music director.** Claude picks every song for every hour inside your rotation rules, and finds new music when a category runs low.
- **An AI DJ that sounds human.** Claude writes natural breaks: back-sells, forward-sells, weather, traffic, local news and personality talk. ElevenLabs or OpenAI TTS voices them.
- **Professional automation.** Format clocks, a weekly grid, dayparts, top-of-hour legal IDs, sweepers, liners, promos, hot carts, commercials with flights and caps, affidavits, live assist and voice-tracked live reads.
- **Broadcast output.** A built-in MP3 stream with ICY metadata, an optional Icecast relay, in-browser monitoring and a public listener page.

---

## Quick start

Requirements: **Node.js 22.9+** and **ffmpeg** with libmp3lame (`apt install ffmpeg` / `brew install ffmpeg`).

```bash
npm install
cp .env.example .env      # add your keys here or later in the UI
npm start
```

Open the studio at **http://localhost:8080**.

1. **Station & Market:** set your name, call sign and format. Add the cities or whole counties you cover (for example `Travis County, Texas`). The first location sets the station clock.
2. **Settings:** add an Anthropic API key, then choose a voice provider (ElevenLabs gives the most human sound).
3. **AI Programmer** (optional): describe the station you want. Claude designs the categories, clocks, grid, dayparts, DJ personas and imaging.
4. **Music Library:** search monochrome to add songs, import an artist's top 10 or a whole album, or let Claude discover music for you.
5. **On Air:** press **Go on air**, then **🎧 Listen** to monitor the station in the browser.

Listeners tune in at `http://your-host:8080/stream.mp3` or on the player page at `/listen`.

### Docker

```bash
docker build -t valhalla-radio .
docker run -d -p 8080:8080 -v valhalla-data:/data \
  -e ANTHROPIC_API_KEY=... -e ELEVENLABS_API_KEY=... -e ADMIN_PASSWORD=... -e AUTOSTART=1 \
  valhalla-radio
```

---

## How it works

```
             ┌────────────── Studio UI (browser) ──────────────┐
             │ On Air · Log · Library · Clocks · DJs · Imaging │
             │ Commercials · Market · Streaming · AI · Settings│
             └───────────────▲──────────────┬──────────────────┘
                     WebSocket (state, VU)  │ REST
┌────────────────────────────┴──────────────▼───────────────────────────┐
│ Scheduler: clocks + grid → hourly logs, spots, imaging, TOH sync       │
│   └─ Claude music director (picks + reasons)  ← rotation rules guard   │
│ Playout engine (real-time PCM mixer)                                   │
│   prepares items ahead: monochrome FLAC download │ Claude DJ script →  │
│   TTS │ imaging/spot audio  → decode → loudness level → trim silence   │
│   mixes: crossfades · talk-ups over intros · ducking · limiter         │
│ Streamer: ffmpeg MP3 encoder → /stream.mp3 (ICY) + Icecast relay       │
│ Feeds: Open-Meteo + NWS alerts · Google News RSS · TomTom traffic      │
└────────────────────────────────────────────────────────────────────────┘
```

### Scheduling

- **Categories** (A Power Current, B Current, C Recurrent, G Gold, N Discovery, or your own) each have a minimum rest time.
- **Clocks** are hour templates. Their elements: legal ID, music by category, DJ break (auto, back-sell, forward-sell or talk), weather, traffic, news, sweeper, station ID, liner, promo, and stopset with N spots.
- **The weekly grid** assigns a clock to every hour of the week. **Dayparts** give the music director and DJs mood guidance and choose which DJ persona is on air.
- About an hour ahead, the scheduler builds each hour's log. Claude gets the eligible candidates for every music slot, plus the daypart, the time and what played recently. It returns an ordered set of picks, each with a reason (visible in the Program Log). Every pick must still pass artist separation, title separation, category rest and the hourly artist cap; otherwise the most-due eligible song replaces it. With no Claude key, the rule-based rotation does all the picking.
- **Top of hour:** when an hour overruns, its remaining items are dropped so the legal ID airs within about 40 seconds of :00. Spots are kept, and run up to 5 minutes late or get flagged as missed. When an hour runs short, filler music from the clock's categories plays until the top of the hour.
- **Commercials:** stopsets are filled automatically. The scheduler respects flight dates, daypart restrictions and daily caps, never airs two spots from the same advertiser in one break, and rotates the most under-delivered spots first. Each stopset is wrapped with a liner going in and a station ID coming out. The affidavit report shows proof of play.

### The AI DJ

Each break is written a few items before it airs, so the context is current:

- the last songs played and the next one (title, artist, year, album, and the music director's notes);
- the station-local time and the daypart mood;
- **live weather** for every market location (current conditions, today, tomorrow and the next hours), with **NWS alerts** read first;
- **traffic:** TomTom incidents across each city or county bounding box, or local traffic headlines when there's no TomTom key;
- **local news** from Google News for each location (plus any RSS feeds you add), national headlines for newscasts, and music/entertainment news for talk breaks;
- the DJ's own recent breaks, so it doesn't repeat itself.

The prompt tells Claude to talk like a real person to one listener: contractions, varied openings, numbers said the way people say them. It also forbids inventing news, traffic, weather or song facts. With ElevenLabs **v3**, the DJ may also use subtle audio tags such as `[chuckles]`.

The voice starts while the outgoing song fades. The next song's intro then runs underneath the end of the talk (the talk-up), with the music ducked until the voice finishes.

### Playout engine

The engine renders 44.1 kHz stereo PCM in real time:

- equal-power **crossfades** between songs;
- **talk-ups**, with the talk-over capped so a short break is never buried;
- **ducking** under voice and imaging;
- tight **segues** between spots;
- **leading/trailing silence trimming** and **loudness levelling** (gated RMS, BS.1770-style gating);
- a **peak limiter** on the output.

Upcoming items are prepared ahead of time. Songs are downloaded from monochrome with resumable HTTP range requests and cached on disk with LRU eviction. If a song can't be fetched, another song from the same category replaces it. If the next item isn't ready when air time comes, the next prepared item airs instead. If nothing is ready, **emergency audio** from the cache prevents dead air.

### Live assist

From the On Air page you can:

- skip the current item;
- reorder or remove upcoming items;
- play any library song next;
- insert a DJ, weather, traffic or news break;
- type a **live read** for the DJ to voice next;
- fire **hot carts** (any imaging item) over the program.

---

## Configuration reference

| Setting | Where | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | env / Settings | Default model is `claude-opus-5-5`. Sonnet 5.5, Haiku 4.5 and Fable 5.1 are also available. |
| `ELEVENLABS_API_KEY` | env / Settings | Most realistic voice. Choose `eleven_v3` for audio tags. Voice IDs are set per persona. |
| `OPENAI_API_KEY` | env / Settings | `gpt-4o-mini-tts` takes per-persona voice direction. The base URL can point to any OpenAI-compatible TTS server (Kokoro-FastAPI and similar). |
| `TOMTOM_API_KEY` | env / Settings | Live traffic incidents. Without it, traffic breaks fall back to local traffic headlines. |
| `ADMIN_PASSWORD` | env | Puts the studio and API behind HTTP Basic auth (any username). The stream, `/listen` and `/api/nowplaying` stay public. |
| `AUTOSTART=1` | env | Goes on air when the server boots. |
| `VALHALLA_DATA_DIR` | env | Holds the database (`db.json`), the music cache, TTS cache and uploads. |
| Crossfade, talk-over, ducking, loudness, look-ahead | Settings | Audio behaviour. |
| Icecast host, mount and credentials | Streaming | Relays the program to Icecast/Shoutcast-compatible servers, with metadata updates. |

### Public endpoints

| Endpoint | |
|---|---|
| `GET /stream.mp3` | The live MP3 stream. Send `Icy-MetaData: 1` to get in-band titles. |
| `GET /listen` | Listener web player. |
| `GET /api/nowplaying` | Now playing and recently played, as JSON (CORS enabled), for websites and apps. |

---

## Development

```bash
npm run dev     # restart on change
npm test        # mixer, rotation, scheduler, engine and programmer tests
```

The code layout:

```
server/
  index.js               HTTP API, WebSocket, static UI
  store.js               JSON persistence + defaults
  sources/monochrome.js  monochrome API client + resumable downloader/cache
  ai/claude.js           Claude client (structured outputs, refusal fallbacks)
  ai/musicDirector.js    per-hour music selection + discovery
  ai/dj.js               DJ break writer (persona, live data, anti-fabrication rules)
  ai/programmer.js       station design from a plain-English brief
  voice/tts.js           ElevenLabs / OpenAI-compatible TTS with caching
  feeds/                 weather (Open-Meteo, NWS), news (RSS), traffic (TomTom)
  scheduler/             rotation rules, library, hourly logs + TOH sync + spots
  engine/                mixer DSP, ffmpeg decoding, real-time playout, streaming
public/                  studio SPA (no build step) and listener page
```

## A note on licensing

Valhalla is a tool. Broadcasting or publicly streaming commercial recordings generally needs performance and sound-recording licenses: ASCAP, BMI and SESAC, plus SoundExchange or the equivalents in your country. Securing them is the operator's responsibility. The same goes for any third-party API's terms of service.
