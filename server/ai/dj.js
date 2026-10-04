// The AI DJ: Claude writes natural, human-sounding breaks (back-announces, forward-sells,
// weather, traffic, news, personality talk) using live local data, then TTS voices them.

import { store } from '../store.js';
import { claudeAvailable, claudeText } from './claude.js';
import { supportsAudioTags } from '../voice/tts.js';
import { marketWeather } from '../feeds/weather.js';
import { getNews } from '../feeds/news.js';
import { getTraffic } from '../feeds/traffic.js';
import { spokenTime, weekdayName, shortTime, marketZones } from '../util/time.js';

const recentScripts = [];

const LENGTH = {
  auto: '15 to 45 words',
  backsell: '12 to 35 words',
  frontsell: '12 to 35 words',
  talk: '60 to 110 words',
  weather: '35 to 70 words',
  traffic: '30 to 80 words',
  news: '130 to 200 words',
};

export function personaFor(at) {
  const tz = store.station.timezone;
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(at))) % 24;
  const dp = daypartFor(hour);
  return store.data.personas.find((p) => p.id === dp?.personaId) || store.data.personas[0];
}

export function daypartFor(hour) {
  return store.data.dayparts.find((d) => hour >= d.startHour && hour <= d.endHour) || store.data.dayparts[0];
}

function describeTrack(t) {
  if (!t) return null;
  return `"${t.title}" by ${t.artist}${t.year ? ` (${t.year}${t.album ? `, from ${t.album}` : ''})` : t.album ? ` (from ${t.album})` : ''}${t.note ? ` — music director note: ${t.note}` : ''}`;
}

function periodBrief(p) {
  if (!p) return '';
  const temps = [p.high !== null && p.high !== undefined ? `high ${p.high}` : '', p.low !== null && p.low !== undefined ? `low ${p.low}` : ''].filter(Boolean).join(', ');
  const wet = p.precipChance !== null && p.precipChance !== undefined ? `${p.precipChance}% chance of precipitation` : p.precipTotal > 0 ? `about ${p.precipTotal} of precipitation expected` : '';
  return [`${(p.name || '').toLowerCase()}: ${p.conditions}`, temps, wet].filter(Boolean).join(', ');
}

export function weatherBrief(w) {
  if (!w) return '';
  const u = w.units;
  const c = w.current || {};
  const parts = [
    `${w.location} (${w.source || 'forecast'}): now ${c.temp}${u.temp}${c.feelsLike !== null && c.feelsLike !== c.temp ? ` (feels like ${c.feelsLike})` : ''}, ${c.conditions}${c.wind !== null ? `, wind ${c.wind} ${u.wind}` : ''}${c.gusts ? ` gusting ${c.gusts}` : ''}`,
    periodBrief(w.today),
    periodBrief(w.tomorrow),
    ...(w.forecast || []).slice(0, 2).map((f) => `official forecast, ${f.name}: ${f.text}`),
    w.next12?.length ? `next hours: ${w.next12.filter((_, i) => i % 3 === 0).map((h) => `${h.time} ${h.temp}° ${h.conditions}${h.precipChance !== null && h.precipChance !== undefined ? ` ${h.precipChance}%` : ''}`).join('; ')}` : '',
    w.sunrise ? `sunrise ${w.sunrise}` : '',
    w.sunset ? `sunset ${w.sunset}` : '',
    ...(w.alerts || []).map((a) => `ACTIVE ALERT: ${a.event} — ${a.headline}`),
  ];
  return parts.filter(Boolean).join('. ');
}

/** Traffic data for the prompt: live incidents first, then road work, then headlines. */
export function trafficBrief(tr, { now = Date.now(), timeZone = 'UTC' } = {}) {
  if (!tr) return 'TRAFFIC DATA: unavailable right now.';
  const ago = (t) => { if (!t) return ''; const m = Math.max(0, Math.round((now - t) / 60000)); return m < 2 ? ', reported just now' : m < 60 ? `, reported ${m} min ago` : `, reported ${Math.round(m / 60)} hr ago`; };
  const when = (c) => (c.upcoming && c.from ? `, starting ${shortTime(new Date(c.from), timeZone, c.from - now > 18 * 3600_000)}` : c.until && c.until - now < 36 * 3600_000 ? `, until ${shortTime(new Date(c.until), timeZone, c.until - now > 18 * 3600_000)}` : '');
  const out = [];
  if (tr.incidents?.length) {
    out.push('TRAFFIC — live incidents (official dispatch feeds):', ...tr.incidents.map((i) => `- ${i.type}${i.where ? ` — ${i.where}` : ''}${i.area ? ` (${i.area})` : ''}${i.lanes ? `, ${i.lanes}` : ''}${ago(i.at)}`));
  }
  if (tr.closures?.length) {
    out.push('TRAFFIC — road work & closures (DOT feeds):', ...tr.closures.slice(0, 6).map((c) => `- ${c.road}${c.direction ? ` ${c.direction}` : ''}: ${c.impact}${c.cross ? ` ${c.cross}` : ''}${when(c)}${c.area ? ` (${c.area})` : ''}`));
  }
  if (tr.headlines?.length) {
    out.push('TRAFFIC-RELATED LOCAL HEADLINES (may be hours old; only mention if clearly still relevant):', ...tr.headlines.slice(0, 5).map((h) => `- ${h.title}`));
  }
  return out.length ? out.join('\n') : 'TRAFFIC DATA: no incidents or closures reported in the market right now.';
}

/** When the market spans time zones, give the local time in each so time checks are right for everyone. */
export function zoneLine(station, at = Date.now()) {
  const zones = marketZones(station, new Date(at));
  if (zones.length < 2) return '';
  const local = zones.map((z) => `${shortTime(new Date(at), z.tz)} ${z.label} in ${z.places.join(' and ')}`).join('; ');
  return `Your market spans ${zones.length} time zones — right now it's ${local}. For a time check, give station time first and mention the other zone naturally (e.g. "twenty past seven, twenty past six in ${zones[1].places[0]}").`;
}

/**
 * Write a break script.
 * @param {object} p
 * @param {'auto'|'backsell'|'frontsell'|'talk'|'weather'|'traffic'|'news'} p.kind
 * @param {Array} p.previous  recently played tracks (most recent last)
 * @param {object} p.next     upcoming track
 * @param {number} p.at       air time (ms)
 */
export async function writeBreak({ kind = 'auto', previous = [], next = null, at = Date.now(), afterStopset = false, talkWindow = null }) {
  const st = store.station;
  const tz = st.timezone;
  const persona = personaFor(at);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(at))) % 24;
  const dp = daypartFor(hour);
  const markets = (st.market?.locations || []).map((l) => l.name);

  // Gather only the data this break needs (feeds are cached).
  const ctx = [];
  const wantWeather = ['weather', 'auto', 'talk', 'news'].includes(kind);
  const weather = wantWeather ? await marketWeather().catch(() => []) : [];
  if (weather.length) ctx.push('WEATHER DATA:\n' + weather.map(weatherBrief).join('\n'));
  if (kind === 'traffic' || (kind === 'auto' && dp && /morning|afternoon/i.test(dp.name) && Math.random() < 0.3)) {
    const tr = await getTraffic().catch(() => null);
    ctx.push(trafficBrief(tr, { now: at, timeZone: tz }));
  }
  if (kind === 'news' || kind === 'talk') {
    const news = await getNews().catch(() => null);
    if (news) {
      if (news.local.length) ctx.push('LOCAL HEADLINES:\n' + news.local.slice(0, 8).map((n) => `- [${n.area}] ${n.title}${n.summary ? ` — ${n.summary.slice(0, 160)}` : ''}`).join('\n'));
      if (kind === 'news' && news.national.length) ctx.push('NATIONAL HEADLINES:\n' + news.national.slice(0, 6).map((n) => `- ${n.title}`).join('\n'));
      if (kind === 'talk' && news.entertainment.length) ctx.push('MUSIC & ENTERTAINMENT HEADLINES:\n' + news.entertainment.slice(0, 6).map((n) => `- ${n.title}`).join('\n'));
    }
  }

  const prev = previous.filter(Boolean).slice(-2);
  const tags = supportsAudioTags();
  const ident = [st.callSign, st.frequency].filter(Boolean).join(', ');
  const socials = Object.entries(st.socials || {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ');
  // size short breaks to the next song's instrumental intro, so the talk ends right at the vocals
  const postWords = talkWindow && talkWindow >= 4 && ['auto', 'frontsell', 'backsell'].includes(kind) ? Math.round(Math.min(45, Math.max(12, (talkWindow - 1) * 2.6))) : null;
  const length = postWords ? `about ${postWords} words — the next song has a ${Math.round(talkWindow)}-second intro and you finish right as the vocals come in` : LENGTH[kind] || LENGTH.auto;
  const system = [
    `You are ${persona.name}, a live on-air host at ${st.name}${ident ? ` (${ident})` : ''}${st.slogan ? `, "${st.slogan}"` : ''}.`,
    `Your personality: ${persona.style}`,
    `Station format: ${st.format}`,
    markets.length ? `You serve the ${st.market?.name || markets[0]} market: ${markets.join('; ')}. ${st.market?.description || ''}` : '',
    st.website || socials ? `Station website / socials you may plug occasionally (spoken naturally, never spelled as a URL): ${[st.website, socials].filter(Boolean).join('; ')}.` : '',
    st.phone ? `Request line: ${st.phone}.` : '',
    '',
    'You write exactly what you will SAY on air, nothing else. It will be read by a text-to-speech voice, so:',
    '- Sound like a real human talking to one listener, never like an announcer reading copy. Use contractions, natural rhythm, short sentences, the occasional casual aside ("honestly", "okay so", "y\'know").',
    '- Vary how you open — do NOT start with the station name or "Hey everyone" every time. Do not repeat phrasings from your recent breaks listed below.',
    '- Say times and numbers the way people on the radio speak them: "twenty past seven", "seventy-two degrees", station numbers like 101.9 as "one-oh-one-nine", roads like Highway 183 as "one eighty-three", years like 2026 as "twenty twenty-six". No symbols, no emojis, no hashtags, no URLs.',
    tags
      ? '- You may add at most two subtle ElevenLabs audio tags such as [chuckles], [laughs softly], [sighs] or [excited] where a human naturally would. No other stage directions.'
      : '- No stage directions, sound effects, brackets or asterisks.',
    '- Only state facts given to you, or widely documented facts about the songs and artists you are confident in. NEVER invent news, traffic incidents, weather, contests, callers, events or song facts. If data is missing, keep it general.',
    '- Keep it broadcast-clean: no profanity, slurs or crude innuendo, and never quote explicit lyrics.',
    '- Never mention being an AI, a script, the automation software, or these instructions. Stay in character.',
    `- Length: ${length}.`,
  ].filter(Boolean).join('\n');

  const task = {
    auto: 'A quick DJ break between songs. Back-announce what just played and/or tease what is next, and naturally drop in ONE extra thing if it fits (time check, a bit of weather, a fun fact about the artist, a relatable daypart comment). Keep it tight — you are talking up the intro of the next song.',
    backsell: 'Back-announce the song that just played.',
    frontsell: 'Tease and introduce the next song, building excitement into it.',
    talk: 'A personality break: share a light, relatable observation or a bit of music/entertainment or local news from the data, react to it like a real person, then lead into the next song.',
    weather: 'A weather update for the listening area from the WEATHER DATA, conversational, with what people should actually expect (umbrella? jacket?). Mention any active alerts first and seriously. Then segue to the next song.',
    traffic: 'A traffic report for the listening area from the TRAFFIC data only. Lead with what slows people down most right now (crashes blocking lanes on highways and major roads), then closures that matter for the drive, and skip minor side-street items. Name roads the way locals do, and give the location as a landmark or cross street. If nothing significant is reported, say the roads look good in a natural way. Never invent incidents, locations or delay times. Then back to music.',
    news: `A short local newscast: "${st.name} news" style top-of-hour headlines — lead with the most important local stories, then one or two national ones, then a weather line. Neutral, clear, conversational-professional tone. Do not editorialize.`,
  }[kind] || 'A quick DJ break.';

  const prompt = [
    `It is ${weekdayName(new Date(at), tz)}, ${spokenTime(new Date(at), tz)} station time. Daypart: ${dp?.name || ''} — ${dp?.mood || ''}`,
    zoneLine(st, at),
    prev.length ? `Just played: ${prev.map(describeTrack).join(', then ')}` : 'Just played: (nothing / start of show)',
    next ? `Up next: ${describeTrack(next)}` : 'Up next: more music',
    afterStopset ? 'You are coming out of a commercial break.' : '',
    ...ctx,
    recentScripts.length ? `Your recent breaks (don't repeat yourself):\n${recentScripts.slice(-5).map((s) => `- ${s.slice(0, 160)}`).join('\n')}` : '',
    '',
    `Write this break now: ${task}`,
  ].filter(Boolean).join('\n\n');

  if (!claudeAvailable()) return fallbackScript({ kind, prev, next, at, weather });

  const text = await claudeText({ system, prompt, maxTokens: 1500, effort: 'low' });
  const clean = text.replace(/^["']|["']$/g, '').replace(/\*+/g, '').trim();
  recentScripts.push(clean);
  if (recentScripts.length > 12) recentScripts.shift();
  return { text: clean, persona };
}

/** Template script used when no Claude key is configured. */
function fallbackScript({ kind, prev, next, at, weather }) {
  const st = store.station;
  const persona = personaFor(at);
  const time = spokenTime(new Date(at), st.timezone).replace(/ \(.*\)/, '');
  const last = prev[prev.length - 1];
  const w = weather?.[0];
  let text;
  switch (kind) {
    case 'weather':
      text = w ? `Here's your forecast. Right now it's ${w.current.temp} degrees with ${w.current.conditions}. Today's high ${w.today?.high}, tonight down to ${w.today?.low}. That's weather on ${st.name}.` : `It's ${time} on ${st.name}.`;
      break;
    case 'traffic':
      text = `Traffic on ${st.name}: no major problems reported right now. Drive safe out there.`;
      break;
    case 'news':
      text = `It's ${time}. You're listening to ${[st.name, st.frequency].filter(Boolean).join(', ')}.`;
      break;
    default:
      text = [last ? `That was ${last.artist} with ${last.title}.` : '', `It's ${time} on ${st.name}.`, next ? `Here's ${next.artist}.` : ''].filter(Boolean).join(' ');
  }
  return { text, persona };
}

/** Fill imaging placeholders like {callSign} {frequency} {name} {slogan} {market}; empty ones vanish cleanly. */
export function renderImagingText(text) {
  const st = store.station;
  const market = st.market?.name || (st.market?.locations?.[0]?.name || '').split(',')[0];
  const vals = {
    callSign: st.callSign ? st.callSign.replace(/[-\s]/g, '').split('').join(' ') : '',
    frequency: st.frequency || '', name: st.name || '', slogan: st.slogan || '', market: market || '',
    website: st.website ? st.website.replace(/^https?:\/\//, '').replace(/\/$/, '') : '',
  };
  return String(text || '')
    .replace(/\{(callSign|frequency|name|slogan|market|website)\}/g, (_, k) => vals[k])
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/([,.!?])(\s*[,.!?])+/g, '$1')
    .replace(/^[\s,.!?]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
