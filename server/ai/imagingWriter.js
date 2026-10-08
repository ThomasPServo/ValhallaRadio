// Imaging writer: Claude writes fresh station imaging the way an imaging director would — sweepers,
// artist roll-calls, liners, station IDs and legal IDs — tuned to the format, the market, the season
// and what's actually in rotation. Every piece is vetted for broadcast safety before it's produced,
// and a template writer covers stations running without Claude.

import { store } from '../store.js';
import { claudeAvailable, claudeJson, checkClaudeCode } from './claude.js';
import { zoned } from '../util/time.js';
import { FORMATS } from '../setup/formats.js';

export const FX_CHOICES = ['punch', 'riser', 'smooth', 'stutter', 'music', 'dry'];
export const PLACEHOLDERS = ['name', 'frequency', 'callSign', 'market', 'slogan', 'website'];
const WORDS = { sweeper: [3, 14], liner: [4, 18], id: [2, 9], toh_id: [3, 16] };
const THEMES = ['positioning', 'roll-call', 'seasonal', 'holiday', 'daypart', 'music', 'local', 'identity', 'legal'];

/** Lines a station must never air unless it can prove them. */
const BANNED = [
  [/#\s?1\b|number[- ]one\s+(station|for|in)|most[- ]listened|highest[- ]rated|top[- ]rated|best station|ratings|award[- ]winning/i, 'ratings or award claim'],
  [/\b(win|wins|winner|winning|contest|giveaway|give away|prize|prizes|tickets?|sweepstakes|enter to|text to|call now|qualify)\b/i, 'contest or call to action'],
  [/commercial[- ]free|no commercials|fewer commercials|less talk|no talk|without interruption|uninterrupted/i, 'unverifiable programming claim'],
  [/\b(fuck\w*|shit\w*|damn|bitch\w*|ass|asses|sexy?|hell)\b/i, 'language'],
  [/https?:|www\.|\.(com|net|org|fm)\b|@\w/i, 'spelled-out web address'],
];

const marketName = (st) => st.market?.name || (st.market?.locations?.[0]?.name || '').split(',')[0];
const norm = (x) => String(x || '').toLowerCase().replace(/\{(\w+)\}/g, ' $1 ').replace(/[^a-z0-9]+/g, ' ').trim();
const cleanArtist = (s) => String(s || '').split(/,|&| feat\.?| ft\.?| featuring | x | with /i)[0].trim();

// ------------------------------------------------------------------ context

const nthWeekday = (y, m, wd, n) => { const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); return 1 + ((wd - first + 7) % 7) + (n - 1) * 7; };
const lastWeekday = (y, m, wd) => { const last = new Date(Date.UTC(y, m, 0)); return last.getUTCDate() - ((last.getUTCDay() - wd + 7) % 7); };

/** Season (hemisphere-aware) and US holidays coming up in the next three weeks. */
export function seasonContext(date = new Date(), timeZone = 'UTC', { lat = 40, us = true } = {}) {
  const z = zoned(date, timeZone);
  const north = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'fall', 'fall', 'fall', 'winter'][z.month - 1];
  const season = lat < 0 ? { winter: 'summer', summer: 'winter', spring: 'fall', fall: 'spring' }[north] : north;
  const today = Date.UTC(z.year, z.month - 1, z.dayOfMonth);
  const upcoming = [];
  if (us) {
    for (const y of [z.year, z.year + 1]) {
      const list = [
        ["New Year's Day", 1, 1], ["Valentine's Day", 2, 14], ["St. Patrick's Day", 3, 17], ["Mother's Day", 5, nthWeekday(y, 5, 0, 2)],
        ['Memorial Day', 5, lastWeekday(y, 5, 1)], ["Father's Day", 6, nthWeekday(y, 6, 0, 3)], ['the Fourth of July', 7, 4],
        ['Labor Day', 9, nthWeekday(y, 9, 1, 1)], ['Halloween', 10, 31], ['Thanksgiving', 11, nthWeekday(y, 11, 4, 4)],
        ['Christmas', 12, 25], ["New Year's Eve", 12, 31],
      ];
      for (const [name, m, d] of list) {
        const t = Date.UTC(y, m - 1, d);
        const days = Math.round((t - today) / 86400000);
        if (days >= 0 && days <= 21) upcoming.push({ name, date: new Date(t).toISOString().slice(0, 10), inDays: days });
      }
    }
  }
  const month = new Intl.DateTimeFormat('en-US', { timeZone, month: 'long' }).format(date);
  return { season, month, today: z.dateKey, upcoming };
}

/** Artists the station actually plays most, for roll-call sweepers. */
export function rotationArtists(limit = 12) {
  const score = new Map();
  for (const t of store.data.library) {
    if (t.disabled) continue;
    const a = cleanArtist(t.artist);
    if (!a) continue;
    const w = ({ A: 3, B: 2, N: 1.5 }[t.category] || 1) + (t.plays || 0) * 0.2;
    score.set(a, (score.get(a) || 0) + w);
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([a]) => a);
}

/** How many of each type to write for `count` pieces. */
export function planMix(count, station = store.station) {
  const mix = { sweeper: 0, liner: 0, id: 0, toh_id: 0 };
  const order = ['sweeper', 'sweeper', 'id', 'sweeper', 'liner', station.callSign ? 'toh_id' : 'sweeper', 'sweeper', 'id', 'sweeper', 'liner'];
  for (let i = 0; i < count; i++) mix[order[i % order.length]]++;
  return mix;
}

// ------------------------------------------------------------------ vetting

/**
 * Check one piece for broadcast safety and fit. Returns { ok, piece } or { ok: false, why }.
 * @param {object} p  { type, name, text, fx, theme, expires }
 */
export function vetPiece(p, { station = store.station, existing = [], today = '' } = {}) {
  const type = p?.type;
  if (!WORDS[type]) return { ok: false, why: 'unknown type' };
  let text = String(p.text || '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  text = text
    .replace(/\{\s*call[ _]?sign\s*\}/gi, '{callSign}').replace(/\{\s*(station[ _]?)?name\s*\}/gi, '{name}')
    .replace(/\{\s*freq(uency)?\s*\}/gi, '{frequency}').replace(/\{\s*(market|city)\s*\}/gi, '{market}');
  if (station.name && station.name.length > 2) text = text.split(station.name).join('{name}'); // typed out → placeholder
  const used = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const unknown = used.find((u) => !PLACEHOLDERS.includes(u));
  if (unknown) return { ok: false, why: `unknown placeholder {${unknown}}` };
  const values = { name: station.name, frequency: station.frequency, callSign: station.callSign, market: marketName(station), slogan: station.slogan, website: station.website };
  const empty = used.find((u) => !values[u]);
  if (empty) return { ok: false, why: `the station has no ${empty}` };
  if (!used.some((u) => ['name', 'frequency', 'callSign'].includes(u))) return { ok: false, why: 'never says the station' };
  if (type === 'toh_id' && !(used.includes('callSign') && used.includes('market'))) return { ok: false, why: 'a legal ID needs the call letters and the city' };
  const dial = String(station.frequency || '').replace(/\s*(FM|AM)$/i, '').trim();
  if (used.includes('frequency') && used.includes('name') && dial && String(station.name).includes(dial)) return { ok: false, why: 'says the frequency twice (it is in the name)' };
  const plain = text.replace(/\{\w+\}/g, ' ');
  for (const [re, why] of BANNED) if (re.test(plain)) return { ok: false, why };
  // shouting caps read badly on TTS ("ALL" → "A L L"); keep the call sign's letters only
  text = text.replace(/\b[A-Z]{3,}\b/g, (w) => (station.callSign && w === station.callSign.toUpperCase() ? w : w[0] + w.slice(1).toLowerCase()));
  const words = text.replace(/\{\w+\}/g, 'X').split(/\s+/).filter(Boolean).length;
  const [lo, hi] = FORMATS[station.formatId]?.imagingWords?.[type] || WORDS[type]; // a joke takes a few more words
  if (words < lo || words > hi) return { ok: false, why: `${words} words (a ${type} is ${lo}-${hi})` };
  if (existing.some((e) => norm(e) === norm(text))) return { ok: false, why: 'duplicate' };
  let expires = /^\d{4}-\d{2}-\d{2}$/.test(p.expires || '') ? p.expires : '';
  if (expires && today && (expires < today || Date.parse(expires) - Date.parse(today) > 60 * 86400000)) expires = '';
  return {
    ok: true,
    piece: {
      type,
      name: String(p.name || '').replace(/\s+/g, ' ').trim().slice(0, 60) || `${{ sweeper: 'Sweeper', liner: 'Liner', id: 'Station ID', toh_id: 'Legal ID' }[type]}`,
      text,
      fx: FX_CHOICES.includes(p.fx) ? p.fx : null,
      theme: THEMES.includes(p.theme) ? p.theme : 'positioning',
      expires,
    },
  };
}

// ------------------------------------------------------------------ writers

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pieces'],
  properties: {
    pieces: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'name', 'text', 'fx', 'theme', 'expires'],
        properties: {
          type: { type: 'string', enum: Object.keys(WORDS) },
          name: { type: 'string', description: 'Short label for the imaging library, e.g. "Roll call: Dua Lipa / Teddy Swims"' },
          text: { type: 'string', description: 'Exactly what the imaging voice says, with placeholders' },
          fx: { type: 'string', enum: FX_CHOICES },
          theme: { type: 'string', enum: THEMES },
          expires: { type: 'string', description: 'YYYY-MM-DD after which a seasonal/holiday piece should stop airing, else empty' },
        },
      },
    },
  },
};

function context() {
  const st = store.station;
  const loc = st.market?.locations?.[0];
  const us = !loc?.countryCode || loc.countryCode === 'US';
  return {
    station: st,
    market: marketName(st),
    when: seasonContext(new Date(), st.timezone, { lat: loc?.lat ?? 40, us }),
    artists: rotationArtists(12),
    existing: (store.data.imaging?.items || []).filter((i) => i.text).map((i) => i.text),
    dayparts: (store.data.dayparts || []).map((d) => {
      const p = store.data.personas.find((x) => x.id === d.personaId);
      return `${d.name} (${d.startHour}:00-${d.endHour + 1}:00)${p ? ` with ${p.name}` : ''}`;
    }),
  };
}

async function claudePieces(ctx, mix, guidance) {
  const st = ctx.station;
  const fxGuide = {
    punch: 'whoosh in, the line, a hit on the last word with an echo throw — the default for sweepers',
    riser: 'a big build into a hit — legal IDs and big statements',
    smooth: 'soft swell, lush reverb, a light chime — liners, softer formats',
    stutter: 'the first syllable stutters ("M- M- Mix") — high-energy name hits (CHR, dance, urban)',
    music: 'voiced over a few bars of the station music bed, ending on a button — positioning lines',
    dry: 'voice only — heritage/talk-leaning stations',
  };
  const want = Object.entries(mix).filter(([, n]) => n).map(([t, n]) => `${n} × ${t}`).join(', ');
  const out = await claudeJson({
    system: [
      'You are the imaging director for a commercial radio station. You write the short produced pieces between songs —',
      'sweepers, liners, station IDs and legal IDs — the way top imaging writers do: confident, rhythmic, conversational, instantly',
      'recognizable, written for the ear. Short sentences and fragments; periods for punch. They will be voiced by a TTS imaging voice.',
      '',
      'Rules:',
      '- Refer to the station ONLY through placeholders: {name} (station name), {frequency}, {callSign}, {market}, {slogan}, {website}. Every piece says {name}, {frequency} or {callSign}. Never use a placeholder the station does not have.',
      '- Legal IDs (toh_id) must contain {callSign} followed by {market} (the city of license), e.g. "{callSign}, {market}. {name}."',
      '- Word counts: sweeper 3-12, liner 5-16, id 2-8, toh_id 4-14.',
      '- Broadcast-safe and truthful: no ratings or "number one" claims, no awards, no contests, prizes, giveaways or calls to action, no "commercial-free"/"less talk" promises, no competitors, no profanity, no web addresses, no events the station has not announced.',
      '- Artist roll-calls name 2-4 artists ONLY from the "In rotation" list, then the station.',
      '- Seasonal or holiday pieces set "expires" to the day after the holiday (or the end of the season); everything else leaves it empty. At most one seasonal/holiday piece per batch.',
      '- No symbols, no ALL-CAPS words, no emojis, no stage directions. Numbers only through {frequency}.',
      '- Do not repeat or lightly paraphrase the existing pieces. Vary structures: fragments, rhythmic triplets, a statement, an occasional question.',
      '- Pick an fx style per piece:',
      ...Object.entries(fxGuide).map(([k, v]) => `    ${k}: ${v}`),
    ].join('\n'),
    prompt: [
      `Station: ${st.name}${st.slogan ? ` — "${st.slogan}"` : ''}.${st.frequency && st.name.includes(String(st.frequency).replace(/\s*(FM|AM)$/i, '').trim()) ? ' The name already contains the frequency, so never use {name} and {frequency} in the same piece.' : ''} Placeholders available: ${PLACEHOLDERS.filter((k) => ({ name: st.name, frequency: st.frequency, callSign: st.callSign, market: ctx.market, slogan: st.slogan, website: st.website })[k]).map((k) => `{${k}}`).join(' ')}`,
      `Format: ${st.format}`,
      FORMATS[st.formatId]?.imagingTone ? `Station voice: ${FORMATS[st.formatId].imagingTone}` : '',
      ctx.market ? `Market: ${ctx.market}${st.market?.description ? ` — ${st.market.description}` : ''}` : '',
      `It is ${ctx.when.month} (${ctx.when.season}).${ctx.when.upcoming.length ? ` Coming up: ${ctx.when.upcoming.map((h) => `${h.name} on ${h.date}`).join(', ')}.` : ''}`,
      ctx.dayparts.length ? `Dayparts: ${ctx.dayparts.join('; ')}` : '',
      ctx.artists.length ? `In rotation (most played first): ${ctx.artists.join(', ')}` : 'In rotation: (library still building — skip roll-calls)',
      ctx.existing.length ? `Existing pieces (don't repeat):\n${ctx.existing.slice(-30).map((t) => `- ${t}`).join('\n')}` : '',
      guidance ? `Program director's notes: ${guidance}` : '',
      '',
      `Write ${want} — plus a couple of spares. Mix the themes: positioning, artist roll-calls, the music, the market, the season.`,
    ].filter(Boolean).join('\n'),
    maxTokens: 6000,
    effort: 'medium',
    schema: SCHEMA,
  });
  return out?.pieces || [];
}

/** Template writer for stations without Claude: varied, safe, built from the station's own details. */
export function templatePieces(ctx, mix) {
  const A = ctx.artists;
  const roll = (i) => (A.length >= 3 ? { type: 'sweeper', name: `Roll call: ${A[i % A.length]}`, text: `${A[i % A.length]}, ${A[(i + 1) % A.length]}, ${A[(i + 2) % A.length]}. All on {name}.`, fx: 'punch', theme: 'roll-call' } : null);
  const sweepers = [
    roll(0),
    { type: 'sweeper', name: 'Season', text: `Your ${ctx.when.season} soundtrack. {name}.`, fx: 'music', theme: 'seasonal' },
    { type: 'sweeper', name: 'The music', text: 'More of the music you love. Right here. {name}.', fx: 'punch', theme: 'music' },
    ctx.station.slogan ? { type: 'sweeper', name: 'Slogan', text: '{slogan}. This is {name}.', fx: 'riser', theme: 'positioning' } : null,
    roll(3),
    ctx.market ? { type: 'sweeper', name: 'Market', text: "{market}'s home for the music. {name}.", fx: 'music', theme: 'local' } : null,
    { type: 'sweeper', name: 'Turn it up', text: '{name}. Turn it up.', fx: 'stutter', theme: 'identity' },
    roll(6),
  ].filter(Boolean);
  const liners = [
    { type: 'liner', name: 'Thanks', text: 'Thanks for spending part of your day with {name}.', fx: 'smooth', theme: 'positioning' },
    { type: 'liner', name: 'Keep it here', text: 'Keep it right here. More music next on {name}.', fx: 'smooth', theme: 'music' },
  ];
  const ids = [
    ctx.station.frequency ? { type: 'id', name: 'Frequency ID', text: '{frequency}. {name}.', fx: 'punch', theme: 'identity' } : { type: 'id', name: 'Name ID', text: 'This is {name}.', fx: 'punch', theme: 'identity' },
    { type: 'id', name: 'Name ID', text: "You're listening to {name}.", fx: 'smooth', theme: 'identity' },
  ];
  const legal = [{ type: 'toh_id', name: 'Legal ID', text: '{callSign}, {market}. {name}.', fx: 'riser', theme: 'legal' }];
  const pools = { sweeper: sweepers, liner: liners, id: ids, toh_id: legal };
  const out = [];
  for (const [type, n] of Object.entries(mix)) out.push(...pools[type].slice(0, n + 1));
  return out;
}

/**
 * Write `count` new imaging pieces (vetted). Uses Claude when available, templates otherwise.
 * @returns {Promise<{pieces: object[], rejected: {text:string, why:string}[], source: 'claude'|'templates'}>}
 */
export async function writeImaging({ count = 6, guidance = '' } = {}) {
  const ctx = context();
  const mix = planMix(count, ctx.station);
  let raw = [];
  let source = 'templates';
  await checkClaudeCode().catch(() => {});
  if (claudeAvailable()) {
    try { raw = await claudePieces(ctx, mix, guidance); source = 'claude'; } catch (err) { console.warn('[imaging] Claude writer failed, using templates:', err.message); }
  }
  if (!raw.length) raw = templatePieces(ctx, mix);
  const vetted = []; const rejected = [];
  const existing = [...ctx.existing];
  for (const p of raw) {
    const v = vetPiece(p, { station: ctx.station, existing, today: ctx.when.today });
    if (!v.ok) { rejected.push({ text: p?.text, why: v.why }); continue; }
    vetted.push(v.piece);
    existing.push(v.piece.text);
  }
  // the planned mix first, then spares (sweepers first) for anything that didn't pass
  const pieces = []; const left = { ...mix };
  for (const p of vetted) if (left[p.type] > 0) { left[p.type]--; pieces.push(p); }
  const spares = vetted.filter((p) => !pieces.includes(p)).sort((a, b) => Number(b.type === 'sweeper') - Number(a.type === 'sweeper'));
  for (const p of spares) if (pieces.length < count) pieces.push(p);
  return { pieces, rejected, source };
}
