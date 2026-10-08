# Valhalla Radio

Radio automation for the AI era: a complete station in a box. Name your station, pick a format and a market, and Valhalla builds the library, programs every hour, writes and voices a DJ who sounds like a person, produces its own imaging, processes the air chain like a broadcast rack and streams it 24/7.

"Valhalla" is just the software. Everything on air and on the listener page is your station's name, logo, slogan and socials.

**No API keys required.**

| | How Valhalla does it |
|---|---|
| AI | A subscription you already have: **Claude Code** (`claude`, Claude Sonnet 5.5 by default) or **ChatGPT via Codex** (`codex`). Or fully offline on a local model in **LM Studio**. Anthropic and OpenAI API keys are optional. |
| Voice | A free **local neural voice** (Kokoro), installed on demand from the studio. ElevenLabs/OpenAI are optional. |
| Music | **arcod** (`player.arcod.xyz`, the Qobuz catalogue) by default: 320 kbps MP3 or FLAC, a whole song in seconds, no account. **[monochrome](https://github.com/monochrome-music/monochrome)** (`tracks.monochrome.st`, TIDAL, lossless) is the alternative. Songs are fetched into a local cache ahead of air. |
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
| Chart position and peak | This station's charts (below) |

Valhalla also estimates energy from tempo, loudness and genre. The AI sees each candidate as a fact line, for example `2003, alternative rock/indie rock, group vocal, 148 bpm uptempo, energy 5 (est), popularity 80, intro 8s, cold end, #4 Hot 100, up from #6, 12 wks, last 5h ago`, and is told to judge songs only by those facts.

**A lookup tool for every AI.** When the music director isn't sure about a song, whether it's picking an hour or suggesting new music, it can ask for a lookup before answering. Valhalla returns the song's facts, chart run and story, and the AI answers from those. This works the same on Claude, ChatGPT and local LM Studio models, because it's built on structured output rather than native tool calling. Every song in the library also has an ℹ panel with the same facts, its chart position and what Wikipedia says about it.

**Charts** (keyless), so the station knows this week's hits even when the AI doesn't:

- **Billboard Hot 100:** this week, plus every week back to 1958 from a public archive. Gold formats use the history to find an era's real hits.
- **Apple Music Top Songs, and iTunes top songs** overall and for pop, country, rock, alternative, hip-hop, R&B, dance, Christian and Latin, for the station's country.

Each format follows its own charts (country follows iTunes Country and the Hot 100, for example), or you can pick charts in Settings. Every 6 hours, Valhalla marks library songs with their chart position and best peak, and the AI-suggestion prompt includes this week's charts. With **chart rotation** (current formats, on by default):

- top-15 songs move to power rotation;
- other charting songs move to current;
- hits that drop off move to recurrent.

**Library → Charts** shows any chart, or any past Hot 100 week. It marks which songs you have, and you can add the ones you don't.

**Without any AI,** a flow-aware picker uses the same facts. It plays the most-due song, but:

- never the same artist twice in a row;
- varies vocals and genres;
- avoids big energy jumps;
- after the DJ, prefers songs with an intro to talk over;
- after breaks, opens with familiar, high-energy songs.

**Finding new music** (Settings → AI → *How new music is found*) when a category runs thin:

- **Charts:** chart hits the library doesn't have yet. For current categories that means this week's charts: top 15 for power, top 50 for current, the newest arrivals for new music. For gold and recurrent categories it means Hot 100 hits from the category's era. When a chart mixes styles, an AI (or, without one, each song's iTunes genre) keeps only the songs that fit the format.
- **AI suggestions:** the AI suggests songs, and each one is checked against the catalog.
- **Catalog only:** Valhalla finds artists related to the ones the category already plays (from Deezer's listener graph), pulls their real catalog songs and keeps only songs in the category's era. An AI, if one is connected, then ranks those candidates; without one, Valhalla ranks them by popularity. Either way, the AI never has to recall a song from memory.
- **Auto** (the default) tries charts first, then AI suggestions (with Claude or ChatGPT, not local models), then related artists, until the category is full.

**Clean versions only** (on by default): explicit songs are swapped for their clean radio edits. Songs that have no clean version are skipped and never air.

### The DJ

Breaks are written a few elements before air time, so they're current. Each break draws on:

- what just played and what's next;
- the local time (when a market spans time zones, every zone, as in "twenty past seven, twenty past six in El Paso");
- live **weather** (official forecast wording from the NWS) with alerts first;
- **traffic** incidents and closures;
- local **headlines**;
- **song facts** for the songs around the break: chart position, and the song's story from Wikipedia (who wrote it, the album, the history), so even a model that doesn't know a brand-new song can give a real talk-up;
- the DJ's own recent breaks, so it never repeats itself.

Claude writes in the persona's voice and is never allowed to invent facts. Numbers are read the way radio people say them: *one oh one point nine*, *US one eighty-three*, *seven oh five*, *twenty twenty-six*.

### Transitions that sound like a real board op

- **Analysis as songs stream:** loudness (BS.1770), tempo and first beat, intro ramp, ending type (cold or fade), and the mix-out point. Vocal in/out times come from synced lyrics (LRCLIB). Hand-set markers override them in the waveform editor.
- **Segues** start at each song's mix-out point, beat-aligned when tempos are known, with shaped crossfades instead of linear fades.
- **The DJ never talks over vocals.** Talk starts only after the outgoing vocals end. Talk-ups size the break to the next song's intro so the vocals hit right after the last word ("hitting the post"). With unknown vocal timing, Valhalla waits instead of guessing.
- **Auto-bed:** when there's nothing to talk over (after a stopset, a cold ending, or back-to-back reports), a music bed comes up under the DJ and hands over to the next intro. Beds are synthesized loops (Pulse, Warm, Drive and Chill, matched to your format) or your own uploads, crossfaded into seamless loops.
- Spots butt tightly, and imaging overlaps song intros up to the post.

### Getting songs

**arcod (default).** Music comes from arcod, a free front end to the Qobuz catalogue that needs no account. Its signed play URLs deliver a whole song in one request, at several megabytes per second; in testing a 10 MB song arrived in 1.5 seconds and five more in 3 seconds. Because it's that fast, every song in the log (this hour and the next) is fetched as soon as it's scheduled, so songs air from local files, and the library warms into the cache within minutes. *Settings → Sources* picks the quality: MP3 320 kbps by default (about 10 MB a song), or FLAC at CD or hi-res quality. The station broadcasts 128–192 kbps MP3, so MP3 320 sounds the same on air and fits about four times as many songs in the cache. Valhalla keeps to two connections to arcod, waits when it asks (429), and gets a fresh signed URL when one expires. Songs already in your library from monochrome are fetched from arcod too, matched by ISRC (never an explicit version for a clean one), and fall back to monochrome if arcod doesn't have them.

**monochrome.** monochrome's stream origin is slow per connection (about 10–20 KB/s) and cuts every connection after about 30 seconds, which on some servers is only 260 KB of a 30 MB lossless file. Lossless FLAC needs 100–140 KB/s to play in real time, so one connection can never keep up. Valhalla fetches songs like a download manager:

- **Small chunks:** every song comes in 256 KB Range chunks over a shared pool of parallel connections. Each chunk finishes well inside the 30-second cut-off, and a cut chunk resumes from its last byte.
- **Adaptive connection count:** the pool adds connections while the origin keeps up, halves them on a 429 and eases off by one on a 52x (bursts of 16 or more get refused). In testing, 6 connections sustained about 80–100 KB/s. The default is 6, and you can change it in *Settings → Sources*.
- **Songs are fetched ahead of air:** the next 10 songs in the log are fetched in airplay order, with the soonest first, often an hour before they air.
- **Playback while fetching:** a song can start from its first bytes while the rest arrives. It's only marked ready once the rest will arrive in time. A song that can't make it is swapped for another due song, preferably one already in the cache.
- **Resume across restarts:** progress is saved next to the partial file, and partials nobody needs are cleared after two days.
- **Cache warming:** when nothing urgent is fetching, the rest of the library is fetched in the background, power rotation first, until the cache is 90% full.
- **Cache size:** the cache defaults to 8 GB, about 250 lossless songs. Every cached song airs without touching the origin, so a cache that holds your whole rotation means steady state needs almost no network. *Engineering → Decks* shows the fetch queue, speed and connections live.

### Segues on fade-outs

When a song's file arrives, a background pass works out how it ends. The pass covers the last 75 seconds, so long fades are seen from where they start.

- **Fade-outs:** the next song comes in a few seconds into the fade, about 9 dB down, typically 10–15 seconds before the music would end. It plays over the rest of the fade instead of waiting for silence.
- **Cold endings:** the segue is tight, letting the final hit ring out.

Because this is known before the song airs, the segue is planned on the real fade point from the start. If a song airs before its analysis finishes, the plan is redone the moment it does. A mix-out point you set by hand in the waveform editor always wins.

### Waveforms, previews and disk space

- **Whole waveforms at once.** As soon as a song's file arrives, one quick pass computes its entire waveform, so the studio shows the whole song the moment it's scheduled instead of filling it in as it plays.
- **Scrubbable previews.** Anything you preview (songs, imaging, spots, beds, voice tests) plays in a player bar showing its whole waveform. Click or drag to jump, use ← and → to skip 5 seconds, space to play or pause, and Esc to close. Song previews from arcod are sent as complete files, so you can seek anywhere.
- **Nothing piles up.** An hourly clean-up deletes files nothing needs:
  - cached songs no longer in the library or the log (previews get a day's grace), on top of the cache size limit;
  - waveforms of songs that are gone, and abandoned partial downloads after a day;
  - one-off DJ, weather, traffic and news renders after 6 hours, and raw speech after 2 days;
  - imaging, spot and bed renders after 30 days unused (every reuse resets the clock);
  - uploads that no imaging piece, spot, bed or logo uses, after a day.

  Removing a song from the library deletes its audio and waveform straight away.

### Imaging

- **Produced automatically from copy**, with sound design rendered in a worker thread: whooshes, risers, sub-drop impacts, reverb and an echo throw on the last word. Six styles: *punch*, *riser*, *smooth*, *stutter*, *voiced over the music bed*, and *dry*.
- News, weather and traffic get their own sounder and bed.
- **Import your own produced imaging:** in Imaging → *Import*, pick files, pick a whole folder, or drag and drop. MP3, WAV, AIFF, FLAC and M4A all work. Each file is checked, and its type is read from file and folder names (`TOH`, `Legal ID`, `Station ID`, `Jingle`, `Sweeper`, `Stinger`, `Liner`, `Promo`, `Bed`), with the length as a fallback; you can change it after import. By default, imported pieces replace voiced copy of the same type on air. Types you haven't imported still use voiced copy, and you can choose to mix the two instead.
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

### Light on the machine

Valhalla runs a station around the clock, so it does as little as it can:

- **Audio chain.** The processor's meter-only work (input loudness, true-peak readout, spectrum, goniometer, correlation) runs only while a screen shows the meters. The audio is bit-identical either way. True-peak oversampling is skipped whenever the samples prove no inter-sample peak can come near the limit.
- **Songs in memory.** A song from the cache whose ending is already known holds 15 seconds of decoded audio and no decoder process while it waits for air. It picks up sample-exact when it starts. Background analysis keeps only a song's opening and its last 75 seconds in memory, and each song is decoded once for both its analysis and its waveform. Songs in the log are analysed ahead of the rest of the library.
- **Scheduling.** Recent plays are indexed once, so building a log from a library of thousands takes milliseconds.
- **Disk.** Saves are compact and written at most once a second, in the background; changes are flushed on shutdown. The music cache is tracked in memory instead of being scanned every few seconds.
- **Network.**
  - Library listings are slim and gzipped.
  - The studio's own files are served compressed once, with cache validation.
  - Listeners get the stream in 100 ms batches.
  - Live feeds (meters, spectrum, timeline, decoder status, levels) go only to screens that show them; a tab in the background gets none.
- **Browser.**
  - Waveforms, timeline strips and the clock face are drawn once and reused.
  - Text and bars change only when their values do.
  - Meters redraw at 30 fps, and the gain-reduction bars and the ON AIR glow animate without repainting the page.
  - The library renders 150 rows at a time as you scroll.

Measured on a 4-core machine running the same station, against the earlier version:

| | Earlier version | Now |
|---|---|---|
| CPU on air, no screens open, 2 listeners | 10.9% of a core | 5.6% |
| CPU on air with the studio open | 10.2% | 7.7% |
| CPU with 50 listeners | 13.5% | 7.0% |
| Memory on air (server and ffmpeg) | 259 MB | 166 MB |
| Live data to an open studio page | 40 KB/s | 11 KB/s |
| Building 2 hours of log from 3,000 songs | 8.6 s | 32 ms |
| Library listing of 3,000 songs | 3.7 MB | 61 KB |
| Browser work per second on the studio page | 254 ms | 107 ms |

---

## The studio

| Page | What's there |
|---|---|
| **Studio** | Deck with countdowns (to vocals, talk left, remaining), a live waveform with vocal and mix markers, the multitrack segue timeline with gain automation, a back-timed drag-and-drop log, hour clock, hot carts, insert break, live read, program meters with gain reduction |
| **Log** | Every hour with the music director's reasons; regenerate any hour |
| **Library** | Search/filter, explicit and clean badges, chart positions, intro, ending and BPM, the waveform marker editor, song info (facts, charts, story), catalogue import (songs, albums, artist top tracks), charts (any chart, or any Hot 100 week since 1958, with one-click adds), discovery from charts, the AI and related artists, categories and rotation rules |
| **Clocks** | Hour-clock editor with a pie view and the paintable weekly grid |
| **Engineering** | Presets, live processor controls, bypass, LUFS readouts and history, true peak, phase correlation, ⅓-octave spectrum, goniometer, per-band gain reduction, streaming deck buffers |
| **DJs** | Dayparts and personas (style, voice, speed), with a sample break written and voiced on demand |
| **Imaging** | Sweeper creator, imaging voice, music beds and auto-bed, bulk import of produced imaging (files, folders, drag and drop), and the imaging library (FX style, pin, auto and imported badges, upload) |
| **Spots** | Advertisers, spots, flights and affidavits |
| **Station** | Name, logo, slogan, call letters, socials, market locations, time zones, and a live test of the keyless feeds |
| **Stream / AI / Settings** | Stream links and Icecast relay; status of every AI provider, connection test and the AI programmer; voice, broadcast standards, transitions, production and sources |

The top bar shows the station clock with its zone, the top-of-hour countdown, the ON AIR tally, a program meter, and the AI, voice, bed and listener status.

**On phones and tablets** the studio is fully usable:

- a bottom tab bar (Studio, Log, Library, Imaging), with every other page one tap away under *More*;
- editable tables become cards;
- inputs are sized for touch and don't zoom on iOS;
- dialogs open full screen.

It installs to the home screen as an app named after your station. The listener page puts the now-playing song on the lock screen.

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
