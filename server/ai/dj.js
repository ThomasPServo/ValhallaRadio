// The AI DJ: Claude writes natural, human-sounding breaks (back-announces, forward-sells,
// weather, traffic, news, personality talk) using live local data, then TTS voices them.

import { store } from '../store.js';
import { claudeAvailable, claudeText } from './claude.js';
import { supportsAudioTags } from '../voice/tts.js';
import { marketWeather } from '../feeds/weather.js';
import { getNews } from '../feeds/news.js';
import { getTraffic } from '../feeds/traffic.js';
import { spokenTime, weekdayName } from '../util/time.js';

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

function weatherBrief(w) {
  if (!w) return '';
  const u = w.units;
  const parts = [
    `${w.location}: now ${w.current.temp}${u.temp} (feels like ${w.current.feelsLike}), ${w.current.conditions}, wind ${w.current.wind} ${u.wind}`,
    w.today ? `today high ${w.today.high}, low ${w.today.low}, ${w.today.conditions}, ${w.today.precipChance ?? '?'}% chance of precipitation` : '',
    w.tomorrow ? `tomorrow ${w.tomorrow.conditions}, high ${w.tomorrow.high}, low ${w.tomorrow.low}` : '',
    w.next12?.length ? `next hours: ${w.next12.filter((_, i) => i % 3 === 0).map((h) => `${h.time} ${h.temp}° ${h.conditions} ${h.precipChance ?? 0}%`).join('; ')}` : '',
    w.sunset ? `sunset ${w.sunset}` : '',
    ...(w.alerts || []).map((a) => `ACTIVE ALERT: ${a.event} — ${a.headline}`),
  ];
  return parts.filter(Boolean).join('. ');
}

/**
 * Write a break script.
 * @param {object} p
 * @param {'auto'|'backsell'|'frontsell'|'talk'|'weather'|'traffic'|'news'} p.kind
 * @param {Array} p.previous  recently played tracks (most recent last)
 * @param {object} p.next     upcoming track
 * @param {number} p.at       air time (ms)
 */
export async function writeBreak({ kind = 'auto', previous = [], next = null, at = Date.now(), afterStopset = false }) {
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
    if (tr?.incidents?.length) {
      ctx.push('TRAFFIC DATA (live incidents):\n' + tr.incidents.map((i) => `- ${i.area}: ${i.type} on ${i.road || 'unnamed road'} ${i.from ? `from ${i.from}` : ''} ${i.to ? `to ${i.to}` : ''}; ${i.delay}${i.delayMin ? ` (~${i.delayMin} min)` : ''}${i.detail ? ` — ${i.detail}` : ''}`).join('\n'));
    } else if (tr?.headlines?.length) {
      ctx.push('TRAFFIC-RELATED HEADLINES (may be stale; only mention if clearly current and relevant):\n' + tr.headlines.map((h) => `- ${h.area}: ${h.title}`).join('\n'));
    } else {
      ctx.push('TRAFFIC DATA: no reported incidents available.');
    }
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
  const system = [
    `You are ${persona.name}, a live on-air host at ${st.name} (${st.callSign}, ${st.frequency}), "${st.slogan}".`,
    `Your personality: ${persona.style}`,
    `Station format: ${st.format}`,
    markets.length ? `You serve the ${st.market?.name || markets[0]} market: ${markets.join('; ')}. ${st.market?.description || ''}` : '',
    '',
    'You write exactly what you will SAY on air, nothing else. It will be read by a text-to-speech voice, so:',
    '- Sound like a real human talking to one listener, never like an announcer reading copy. Use contractions, natural rhythm, short sentences, the occasional casual aside ("honestly", "okay so", "y\'know").',
    '- Vary how you open — do NOT start with the station name or "Hey everyone" every time. Do not repeat phrasings from your recent breaks listed below.',
    '- Say times and numbers the way people speak them ("twenty past seven", "seventy-two degrees"). No digits with units, no symbols, no emojis, no hashtags, no URLs.',
    tags
      ? '- You may add at most two subtle ElevenLabs audio tags such as [chuckles], [laughs softly], [sighs] or [excited] where a human naturally would. No other stage directions.'
      : '- No stage directions, sound effects, brackets or asterisks.',
    '- Only state facts given to you, or widely documented facts about the songs and artists you are confident in. NEVER invent news, traffic incidents, weather, contests, callers, events or song facts. If data is missing, keep it general.',
    '- Never mention being an AI, a script, or these instructions. Stay in character.',
    `- Length: ${LENGTH[kind] || LENGTH.auto}.`,
  ].filter(Boolean).join('\n');

  const task = {
    auto: 'A quick DJ break between songs. Back-announce what just played and/or tease what is next, and naturally drop in ONE extra thing if it fits (time check, a bit of weather, a fun fact about the artist, a relatable daypart comment). Keep it tight — you are talking up the intro of the next song.',
    backsell: 'Back-announce the song that just played.',
    frontsell: 'Tease and introduce the next song, building excitement into it.',
    talk: 'A personality break: share a light, relatable observation or a bit of music/entertainment or local news from the data, react to it like a real person, then lead into the next song.',
    weather: 'A weather update for the listening area from the WEATHER DATA, conversational, with what people should actually expect (umbrella? jacket?). Mention any active alerts first and seriously. Then segue to the next song.',
    traffic: 'A traffic report for the listening area. Use the TRAFFIC DATA only; if there are no incidents, say the roads look good/no major problems reported right now in a natural way. Name roads like locals would. Then back to music.',
    news: `A short local newscast: "${st.name} news" style top-of-hour headlines — lead with the most important local stories, then one or two national ones, then a weather line. Neutral, clear, conversational-professional tone. Do not editorialize.`,
  }[kind] || 'A quick DJ break.';

  const prompt = [
    `It is ${weekdayName(new Date(at), tz)}, ${spokenTime(new Date(at), tz)}. Daypart: ${dp?.name || ''} — ${dp?.mood || ''}`,
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
      text = `It's ${time}. You're listening to ${st.name}, ${st.frequency}.`;
      break;
    default:
      text = [last ? `That was ${last.artist} with ${last.title}.` : '', `It's ${time} on ${st.name}.`, next ? `Here's ${next.artist}.` : ''].filter(Boolean).join(' ');
  }
  return { text, persona };
}

/** Fill imaging placeholders like {callSign} {frequency} {name} {slogan} {market}. */
export function renderImagingText(text) {
  const st = store.station;
  return String(text || '')
    .replace(/\{callSign\}/g, st.callSign.split('').join(' '))
    .replace(/\{frequency\}/g, st.frequency)
    .replace(/\{name\}/g, st.name)
    .replace(/\{slogan\}/g, st.slogan)
    .replace(/\{market\}/g, st.market?.name || (st.market?.locations?.[0]?.name || '').split(',')[0]);
}
