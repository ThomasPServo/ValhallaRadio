// The station learns the market it serves. At setup, when the market changes and every month, it reads up on
// each town (Wikipedia and Wikivoyage, keyless) and the AI writes a local knowledge profile from that reading
// and what it reliably knows: nicknames, landmarks, roads, food, teams, events, sayings and the jokes locals
// make about their own area. The DJ, the quips and the imaging writer all use it.
import { store } from '../store.js';
import { userAgent } from '../feeds/http.js';
import { claudeAvailable, claudeJson, checkClaudeCode } from './claude.js';

const log = (...a) => console.log('[market]', ...a);
const STALE = 30 * 86400_000;
const WANTED = /culture|econom|sport|landmark|attraction|cuisine|food|eat|drink|neighbo|transport|get around|festival|event|arts|music|media|nickname|tourism|recreation|see|do\b|understand|parks|geography|climate|education|notable/i;
let running = null;

const marketKey = (st) => (st.market?.locations || []).map((l) => l.name).sort().join('|');

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent(), Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** The parts of an article worth knowing as a local: its lead, plus culture, food, sports, landmarks, getting around. */
export function pickSections(text, max = 7000) {
  const parts = String(text || '').split(/\n(?===+ [^=\n]+ =+)/);
  const lead = parts.shift() || '';
  const keep = parts.filter((p) => WANTED.test(/^=+ ([^=\n]+) =+/.exec(p)?.[1] || '')).map((p) => p.slice(0, 1200));
  return [lead.slice(0, 1800), ...keep].join('\n').replace(/\n{3,}/g, '\n\n').slice(0, max);
}

/** What open references say about a place: its Wikipedia article and its Wikivoyage travel guide. */
export async function readAbout(loc) {
  const name = String(loc.name || '').replace(/,\s*(US|USA|United States)$/i, '');
  const out = [];
  for (const site of ['en.wikipedia.org', 'en.wikivoyage.org']) {
    try {
      const s = await getJson(`https://${site}/w/api.php?action=query&list=search&format=json&srlimit=1&srsearch=${encodeURIComponent(name)}`);
      const hit = s.query?.search?.[0];
      if (!hit) continue;
      const p = await getJson(`https://${site}/w/api.php?action=query&prop=extracts&explaintext=1&format=json&redirects=1&titles=${encodeURIComponent(hit.title)}`);
      const page = Object.values(p.query?.pages || {})[0];
      if (page?.extract) out.push({ source: `${site.startsWith('en.wikivoyage') ? 'Wikivoyage' : 'Wikipedia'}: ${page.title}`, text: pickSections(page.extract) });
    } catch { /* that reference is unavailable: go on with the rest */ }
  }
  return out;
}

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['region', 'notes', 'humor'],
  properties: {
    region: { type: 'string', description: 'What locals call the area, e.g. "the SouthCoast" or "Central Texas"' },
    notes: { type: 'array', items: { type: 'string' }, description: '15-25 short facts a local would know' },
    humor: { type: 'array', items: { type: 'string' }, description: '8-15 running jokes, gripes and in-jokes locals make about their own area' },
  },
};

/**
 * Research the station's market (once a month, or when its towns change, or with `force`). Returns the profile.
 * `read` and `ai` can be replaced (tests).
 */
export async function researchMarket({ force = false, read = readAbout, ai } = {}) {
  const st = store.station;
  const locs = st.market?.locations || [];
  if (!locs.length) return null;
  const have = st.market.local;
  if (!force && have && have.key === marketKey(st) && Date.now() - have.researchedAt < STALE) return have;
  if (running) return running;
  running = (async () => {
    if (ai === undefined) { await checkClaudeCode().catch(() => {}); ai = claudeAvailable(); }
    const sources = (await Promise.all(locs.slice(0, 4).map((l) => read(l).catch(() => [])))).flat();
    const names = locs.map((l) => l.name.replace(/,\s*US$/, '')).join('; ');
    let profile;
    if (ai) {
      profile = await claudeJson({
        system: [
          'You research a radio market so the station\'s on-air AI can talk like a local. From the reference text and what you reliably know,',
          'write what people who live there know and say: what they call the area and its towns, neighborhoods, landmarks, bridges and roads',
          '(and the traffic they complain about), local food and drink and the places for them, teams and rivalries, festivals and events,',
          'history people are proud of, local sayings and pronunciations, weather habits, and the jokes and gripes locals make about their own area.',
          'Rules: only things that are true and that locals would recognize; nothing about crime, tragedies, disasters with victims, politics or',
          'religion; never a stereotype or a joke about any group of people. Humor is the affectionate kind locals use on their own town.',
          'Prefer what the reference text says. Add your own knowledge only where you are sure it is true and current (people, businesses,',
          'animals and events change); when in doubt, leave it out. An on-air mistake about someone\'s hometown is worse than a shorter list.',
        ].join(' '),
        prompt: [`Market: ${names}`, st.market?.description ? `The station's own notes: ${st.market.description}` : '', '', ...sources.map((s) => `--- ${s.source}\n${s.text}`)].filter(Boolean).join('\n'),
        maxTokens: 4000, effort: 'medium', schema: SCHEMA,
      });
    } else {
      // without an AI: the lead of each article, a sentence or two
      profile = { region: names, notes: sources.filter((s) => s.source.startsWith('Wikipedia')).map((s) => s.text.split(/(?<=\.)\s/).slice(0, 2).join(' ')), humor: [] };
    }
    st.market.local = {
      key: marketKey(st), region: String(profile.region || names).slice(0, 80),
      notes: (profile.notes || []).map(String).filter(Boolean).slice(0, 25), humor: (profile.humor || []).map(String).filter(Boolean).slice(0, 15),
      sources: sources.map((s) => s.source), researchedAt: Date.now(), by: ai ? 'ai' : 'references',
    };
    store.save();
    log(`learned ${st.market.local.notes.length} facts and ${st.market.local.humor.length} local jokes about ${st.market.local.region} (${st.market.local.sources.length} sources)`);
    return st.market.local;
  })().catch((err) => { log('research failed:', err.message); return st.market.local || null; }).finally(() => { running = null; });
  return running;
}

/** Research in progress, if any (the imaging writer waits for it). */
export const researching = () => running;

/** Re-research when the market changed or the profile is a month old (hourly check). */
export function startMarketResearch() {
  const check = () => { if (store.station.setupComplete) researchMarket().catch(() => {}); };
  setTimeout(check, 60_000).unref();
  setInterval(check, 3600_000).unref();
}

/** The market profile as prompt lines ('' when the station hasn't learned its market yet). */
export function localColorText(st = store.station) {
  const c = st.market?.local;
  if (!c || c.key !== marketKey(st) || !c.notes?.length) return '';
  return [
    `LOCAL COLOR: what locals know about ${c.region} (researched; use it in your own words):`,
    ...c.notes.map((n) => `- ${n}`),
    c.humor?.length ? 'What locals joke and gripe about:' : '',
    ...(c.humor || []).map((n) => `- ${n}`),
  ].filter(Boolean).join('\n');
}
