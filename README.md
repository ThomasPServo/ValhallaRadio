# Valhalla Radio

Radio automation for the AI era: a complete station in a box. Name your station, pick a format and a market, and Valhalla builds the library, programs every hour, writes and voices a DJ who sounds like a person, produces its own imaging, processes the air chain like a broadcast rack and streams it 24/7.

"Valhalla" is just the software. Everything on air and on the listener page is your station's name, logo, slogan and socials.

**No API keys required.**

| | How Valhalla does it |
|---|---|
| AI | A subscription you already have: **Claude Code** (`claude`, Claude Sonnet 5.5 by default) or **ChatGPT via Codex** (`codex`). Or fully offline on a local model in **LM Studio**. Anthropic and OpenAI API keys are optional. |
| Voice | A free **local neural voice** (Kokoro), installed on demand from the studio. ElevenLabs/OpenAI are optional. |
| Music | **[monochrome](https://github.com/monochrome-music/monochrome)** (`tracks.monochrome.st`), streamed losslessly. Songs are downloaded only when streaming fails. |
| Weather | **National Weather Service** (US, public domain) and **MET Norway** (worldwide). Sunrise and sunset are computed locally. |
| Traffic | **State DOT work-zone feeds** (USDOT WZDx registry), **CHP** and **city dispatch** open data, and local headlines. |
| News | Local and national **RSS**. |

---

## Quick start

Requirements: **Node.js 22.9+** and **ffmpeg** (`apt install ffmpeg` / `brew install ffmpeg`). For AI, use any one of these:

- **Claude Code:** install [Claude Code](https://claude.com/claude-code) and sign in once by running `claude`.
- **ChatGPT:** install [Codex](https://github.com/openai/codex) (`npm i -g @openai/codex`) and run `codex login`.
- **Local model:** start [LM Studio](https://lmstudio.ai)'s server with a model loaded.

```bash
npm install
npm start
```

Open **http://localhost:8080**. The setup wizard walks you through five steps:

1. **Your station:** name, slogan, call letters and frequency.
2. **Format:** Top 40, Hot AC, AC, Classic Hits, Classic Rock, Alternative, Country, Hip-Hop & R&B, or Dance.
3. **Market:** one or more cities or whole counties, units, and *clean versions only*.
4. **AI & voice:** shows which AI is connected and installs the local voice with one click.
5. **Launch:** builds a starter library of about 100 songs, asks Claude for fresh picks, renders your imaging and music bed, and goes on air.

Listeners tune in at `/stream.mp3` or on your branded player at `/listen`.

### Running on a server or in Docker

On a headless machine, sign in one of these ways:

- **Claude Code:** run `claude setup-token` once and pass the token as `CLAUDE_CODE_OAUTH_TOKEN`.
- **Codex:** run `codex login --device-auth`, or copy `~/.codex/auth.json` and mount it at `/root/.codex`.
- **LM Studio:** point `LMSTUDIO_URL` at the server, e.g. `http://gpu-box:1234/v1`.

```bash
docker build -t valhalla-radio .
docker run -d -p 8080:8080 -v valhalla-data:/data \
  -e CLAUDE_CODE_OAUTH_TOKEN=... -e ADMIN_PASSWORD=... -e AUTOSTART=1 \
  valhalla-radio
```

The image includes ffmpeg and the Claude Code CLI (add `--build-arg INSTALL_CODEX=1` for Codex). The local voice is installed into `/data` from the studio.

### Choosing the AI

**Settings → AI → AI provider:**

- **Auto** uses the first ready provider in this order: Claude Code, Claude API, ChatGPT (Codex), OpenAI API, LM Studio.
- Pick one to pin it. If it fails or hits a usage limit, the next ready provider takes over (you can turn that off).
- **Claude:** defaults to **Claude Sonnet 5.5**. Opus, Haiku and Fable are selectable.
- **Codex:** uses its default model unless you name one.
- **LM Studio:** uses the first model it has loaded. Structured output uses JSON Schema, with a prompt-based fallback for servers that don't support it, and `<think>` blocks from reasoning models are stripped.

---

## What's on air

### Music direction

Claude picks every song for every hour from the eligible candidates in each clock slot, taking into account the daypart mood, what just played and the song's intro length (long intros after DJ breaks, for talk-ups). Each pick comes with a reason, shown in the log. Every pick must also pass artist and title separation, category rest and hourly artist caps; otherwise the rotation engine substitutes the most-due eligible song.

**Song facts, so any AI can program music it has never heard of.** Valhalla doesn't rely on a model's memory. In the background it looks up every library song in keyless open music data:

| Fact | Source |
|---|---|
| Original release year | MusicBrainz, matched by ISRC (fixes compilation and reissue years) |
| Genres | MusicBrainz and Deezer, with iTunes as a fallback |
| Vocal type (male, female, group, duet) | MusicBrainz and Deezer |
| Popularity (0–100) | Deezer |
| Tempo | Deezer, or Valhalla's own analysis |

Valhalla also estimates energy from tempo, loudness and genre. The AI sees each candidate as a fact line, for example `2003, alternative rock/indie rock, group vocal, 148 bpm uptempo, energy 5 (est), popularity 80, intro 8s, cold end, last 5h ago`, and is told to judge songs only by those facts.

**Without any AI,** a flow-aware picker uses the same facts. It plays the most-due song, but:

- never the same artist twice in a row;
- varies vocals and genres;
- avoids big energy jumps;
- after the DJ, prefers songs with an intro to talk over;
- after breaks, opens with familiar, high-energy songs.

**Finding new music** (Settings → AI → *How new music is found*) when a category runs thin:

- **AI suggestions:** the AI suggests songs, and each one is checked against the monochrome catalog.
- **Catalog only:** Valhalla finds artists related to the ones the category already plays (from Deezer's listener graph), pulls their real catalog songs and keeps only songs in the category's era. An AI, if one is connected, then ranks those candidates; without one, Valhalla ranks them by popularity. Either way, the AI never has to recall a song from memory.
- **Auto** (the default) uses AI suggestions with Claude or ChatGPT, catalog only with a local LM Studio model, and tops up from the catalog when suggestions come up short.

**Clean versions only** (on by default): explicit songs are swapped for their clean radio edits. Songs that have no clean version are skipped and never air.

### The DJ

Breaks are written a few elements before air time, so they're current. Each break draws on:

- what just played and what's next;
- the local time (when a market spans time zones, every zone, as in "twenty past seven, twenty past six in El Paso");
- live **weather** (official forecast wording from the NWS) with alerts first;
- **traffic** incidents and closures;
- local **headlines**;
- the DJ's own recent breaks, so it never repeats itself.

Claude writes in the persona's voice and is never allowed to invent facts. Numbers are read the way radio people say them: *one oh one point nine*, *US one eighty-three*, *seven oh five*, *twenty twenty-six*.

### Transitions that sound like a real board op

- **Analysis as songs stream:** loudness (BS.1770), tempo and first beat, intro ramp, ending type (cold or fade), and the mix-out point. Vocal in/out times come from synced lyrics (LRCLIB). Hand-set markers override them in the waveform editor.
- **Segues** start at each song's mix-out point, beat-aligned when tempos are known, with shaped crossfades instead of linear fades.
- **The DJ never talks over vocals.** Talk starts only after the outgoing vocals end. Talk-ups size the break to the next song's intro so the vocals hit right after the last word ("hitting the post"). With unknown vocal timing, Valhalla waits instead of guessing.
- **Auto-bed:** when there's nothing to talk over (after a stopset, a cold ending, or back-to-back reports), a music bed comes up under the DJ and hands over to the next intro. Beds are synthesized loops (Pulse, Warm, Drive and Chill, matched to your format) or your own uploads, crossfaded into seamless loops.
- Spots butt tightly, and imaging overlaps song intros up to the post.

### Imaging

- **Produced automatically from copy**, with sound design rendered in a worker thread: whooshes, risers, sub-drop impacts, reverb and an echo throw on the last word. Six styles: *punch*, *riser*, *smooth*, *stutter*, *voiced over the music bed*, and *dry*.
- News, weather and traffic get their own sounder and bed.
- **Sweeper creator:** Claude writes fresh imaging weekly (artist roll-calls from your rotation, positioning lines, local and seasonal flavor), and every piece is produced and ready to air. Every line passes a broadcast check first: no ratings or "number one" claims, contests, unverifiable promises, profanity or web addresses, and legal IDs must carry the call letters and city. Seasonal pieces retire themselves, and older auto pieces rotate out. Pinned and hand-made pieces stay.

### Air chain

A broadcast processor, metered to ITU-R BS.1770:

- input HPF and phase rotator
- wideband AGC
- stereo width and bass mono
- 4-band EQ
- 5-band compressor on a phase-compensated Linkwitz-Riley crossover
- soft clipper and a look-ahead true-peak limiter

Presets per format (Streaming −14 LUFS, CHR, AC, Rock, Hip-Hop/R&B, Country, Dance, Talk, Classical/Jazz) each set a loudness target. A calibrated final drive plus a slow, gated auto-trim holds that target, with peaks at −1 dBTP.

### Station-in-a-box

- Format presets bring categories, hour clocks, a weekly grid, dayparts, two DJ personas, imaging, a music bed and the processing sound.
- **Time zones** follow the market: the station clock uses the primary location, and you can switch it to a fixed zone.
- Commercials have flights, daypart restrictions, daily caps and advertiser separation. Stopsets are wrapped with a liner going in and an ID coming out, and the affidavit report shows proof of play.
- Top-of-hour sync keeps the legal ID within seconds of :00. Overrunning hours drop music, not spots, and short hours get filler.
- Dead-air protection falls back to emergency audio.

---

## The studio

| Page | What's there |
|---|---|
| **Studio** | Deck with countdowns (to vocals, talk left, remaining), a live waveform with vocal and mix markers, the multitrack segue timeline with gain automation, a back-timed drag-and-drop log, hour clock, hot carts, insert break, live read, program meters with gain reduction |
| **Log** | Every hour with the music director's reasons; regenerate any hour |
| **Library** | Search/filter, explicit and clean badges, intro, ending and BPM, the waveform marker editor, monochrome import (songs, albums, artist top tracks), song facts (genre, vocal, popularity), AI and catalog discovery, categories and rotation rules |
| **Clocks** | Hour-clock editor with a pie view and the paintable weekly grid |
| **Engineering** | Presets, live processor controls, bypass, LUFS readouts and history, true peak, phase correlation, ⅓-octave spectrum, goniometer, per-band gain reduction, streaming deck buffers |
| **DJs** | Dayparts and personas (style, voice, speed), with a sample break written and voiced on demand |
| **Imaging** | Sweeper creator, imaging voice, music beds and auto-bed, and the imaging library (FX style, pin, auto badge, upload) |
| **Spots** | Advertisers, spots, flights and affidavits |
| **Station** | Name, logo, slogan, call letters, socials, market locations, time zones, and a live test of the keyless feeds |
| **Stream / AI / Settings** | Stream links and Icecast relay; status of every AI provider, connection test and the AI programmer; voice, broadcast standards, transitions, production and sources |

The top bar shows the station clock with its zone, the top-of-hour countdown, the ON AIR tally, a program meter, and the AI, voice, bed and listener status. The layout works on phones.

---

## Configuration

Everything is set in the studio. Environment variables are optional:

| Variable | Purpose |
|---|---|
| `PORT` | Default `8080`. |
| `ADMIN_PASSWORD` | Puts the studio and API behind HTTP Basic auth. The stream, `/listen` and `/api/nowplaying` stay public. |
| `AUTOSTART=1` | Goes on air when the server boots. |
| `VALHALLA_DATA_DIR` | Location of the database, caches, uploads and the local voice. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code login for servers (from `claude setup-token`). |
| `ANTHROPIC_API_KEY` | Optional Claude API key. |
| `OPENAI_API_KEY` | Optional OpenAI key (for the OpenAI API provider and OpenAI voices). |
| `LMSTUDIO_URL` | LM Studio server, default `http://localhost:1234/v1`. |
| `ELEVENLABS_API_KEY`, `OPENAI_API_KEY` | Optional premium voices. |
| `FFMPEG_PATH` | If ffmpeg isn't on the PATH. |

### Public endpoints

| Endpoint | |
|---|---|
| `GET /stream.mp3` | Live MP3. Send `Icy-MetaData: 1` for in-band titles. |
| `GET /listen` | Branded listener player. |
| `GET /api/nowplaying` | Now playing and recent songs as JSON (CORS enabled). |

---

## Development

```bash
npm run dev     # restart on change
npm test        # 117 tests: AI providers, DSP and loudness, planner (property tests), engine, auto-bed, imaging, feeds, speech, rotation
```

```
server/
  index.js                 HTTP API, WebSocket, static UI
  store.js                 JSON persistence and defaults
  ai/                      Claude (Code CLI + API), music director, DJ writer, imaging writer, programmer
  audio/                   DSP, broadcast processor, stream decoder, analysis worker, production,
                           bed synthesizer, imaging creator, lyrics timing
  engine/                  frame-accurate playout, transition planner, sources/automation, streamer
  feeds/                   NWS / MET Norway weather, WZDx / dispatch traffic, RSS news
  scheduler/               library, rotation rules, hourly logs, top-of-hour sync, spots
  setup/                   format presets and station-in-a-box setup
  voice/                   local Kokoro voice, ElevenLabs/OpenAI, radio number reading
public/                    studio (ES modules, no build step) and the listener page
```

## Licensing note

Valhalla is a tool. Broadcasting or publicly streaming commercial recordings generally needs performance and sound-recording licenses (ASCAP, BMI and SESAC, plus SoundExchange or your country's equivalents), and the operator is responsible for them. Respect third-party terms as well. Weather from MET Norway is CC BY 4.0, and the NWS and US DOT data are public.
