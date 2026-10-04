// Traffic with no API keys, from official open data:
//  1. Live incidents (crashes, stalls, hazards, closures) from public dispatch feeds: the California
//     Highway Patrol's statewide media feed, and city open-data feeds (Austin, Dallas, Seattle,
//     San Francisco). Feeds are picked automatically from the market's locations.
//  2. Road work and lane closures from state and city DOT WZDx feeds, discovered through the USDOT
//     feed registry (only feeds that need no key), cut down to the market and to what's active now
//     or starting within the next few hours.
//  3. Local traffic headlines from news RSS, plus any custom keyless feeds added in Settings.
// The DJ prompt forbids inventing incidents, so with no data the DJ keeps traffic general.
import { store } from '../store.js';
import { getJson, placeQuery, US_STATES } from './http.js';
import { fetchFeed } from './rss.js';
import { parseWallTime, localIso } from '../util/time.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const caches = new Map(); // per-source { at, data }
const failures = new Map(); // per-source { at, error }: a dead feed is skipped for a while instead of stalling every report
let result = { at: 0, key: '', data: null };

async function cached(key, ttl, fn, failTtl = 15 * MIN) {
  const hit = caches.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const failed = failures.get(key);
  if (failed && Date.now() - failed.at < failTtl) throw failed.error;
  try {
    const data = await fn();
    caches.set(key, { at: Date.now(), data });
    failures.delete(key);
    return data;
  } catch (error) {
    failures.set(key, { at: Date.now(), error });
    if (hit) return hit.data; // keep serving the last good copy
    throw error;
  }
}

// ------------------------------------------------------------------ geometry & text helpers

const RAD = Math.PI / 180;
export function km(lat1, lon1, lat2, lon2) {
  const a = Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

/** Bounding boxes for the market (county boxes from geocoding, or a radius around a city). */
export function marketAreas(locs) {
  return locs.filter((l) => Number.isFinite(l.lat)).map((l) => {
    if (Array.isArray(l.bbox) && l.bbox.length === 4) {
      const [w, s, e, n] = l.bbox;
      return { loc: l, w: w - 0.05, s: s - 0.05, e: e + 0.05, n: n + 0.05 };
    }
    const d = l.kind === 'county' ? 0.4 : 0.25;
    return { loc: l, w: l.lon - d * 1.2, s: l.lat - d, e: l.lon + d * 1.2, n: l.lat + d };
  });
}
export const areaFor = (areas, lat, lon) => (Number.isFinite(lat) && Number.isFinite(lon) ? areas.find((a) => lat >= a.s && lat <= a.n && lon >= a.w && lon <= a.e)?.loc || null : null);
const shortName = (l) => String(l?.name || '').split(',')[0];
const stateOf = (l) => String(l.state || (/, (US|PR)$/.test(l.name || '') ? l.name.split(',').map((s) => s.trim())[1] : '') || '').toLowerCase();

const DIRW = { N: 'north', S: 'south', E: 'east', W: 'west' };
const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

/** Make dispatch/DOT road text readable: "IH 35 SVRD NB / E RUNDBERG LN" → "I-35 service road northbound at E Rundberg Ln". */
export function prettyRoad(text) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s === s.toUpperCase()) s = titleCase(s);
  return s
    .replace(/\b(?:IH|I)[- ]?(\d{1,3})\b/gi, 'I-$1')
    .replace(/\bUS[- ]?(\d{1,3})\b/gi, 'US $1')
    .replace(/\b(?:SR|SH|CA|TX)[- ]?(\d{1,3})\b/gi, 'Highway $1')
    .replace(/\bJ([NSEW])O\b/gi, (_, d) => `just ${DIRW[d.toUpperCase()]} of`)
    .replace(/\b([NSEW])b\b/gi, (_, d) => `${DIRW[d.toUpperCase()]}bound`)
    .replace(/((?:I-|US |Highway )\d+) ([NSEW])\b(?!\w)/g, (_, r, d) => `${r} ${DIRW[d]}bound`)
    .replace(/\bOfr\b/gi, 'off-ramp')
    .replace(/\bOnr\b/gi, 'on-ramp')
    .replace(/\bCon\b/gi, 'connector')
    .replace(/\bSvrd\b/gi, 'service road')
    .replace(/\bMopac\b/gi, 'MoPac')
    .replace(/\s*(?:\/|\\|&)\s*/g, ' at ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const MAJOR = /\b(I-\d+|US \d+|Highway \d+|Loop \d+|Spur \d+|SH \d+|Route \d+|Interstate|Toll(?:way)?|Turnpike|Freeway|Fwy|Expressway|Expy|Beltway|MoPac|Thruway|Skyway)\b/i;
export const isMajorRoad = (s) => MAJOR.test(String(s || '')) || /\b(Bridge|Tunnel)\s*$/i.test(String(s || ''));

/** Strip permit boilerplate, contacts and codes from a description, keep the gist. */
export function cleanText(s, max = 160) {
  const t = String(s || '')
    .replace(/\*{2,}[\s\S]*?\*{2,}/g, ' ')
    .replace(/\S+@\S+/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g, ' ')
    .replace(/\b(contact|inspector|coordinator|contractors?)\b[^.\n]*[.\n]?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : t;
}

// ------------------------------------------------------------------ incident classification

/** Map a dispatch call type to a radio-friendly incident type and severity (1 minor … 3 major), or null to ignore it. */
export function classifyIncident(raw) {
  const s = String(raw || '');
  if (/stop|violation|viol\b|cite|citation|tow\b|parking|abandon|dui|pursuit|hzrd trfc/i.test(s)) return null;
  if (/sig ?alert/i.test(s)) return { type: 'SigAlert', severity: 3 };
  if (/wrong ?way/i.test(s)) return { type: 'wrong-way driver', severity: 3 };
  if (/closure|road closed/i.test(s)) return { type: 'road closure', severity: 3 };
  if (/high water|flood/i.test(s)) return { type: 'high water', severity: 3 };
  if (/\bic[ey]\b|icy/i.test(s)) return { type: 'icy roads', severity: 2 };
  if (/hit and run|h&r|20001|20002/i.test(s)) return { type: 'hit-and-run crash', severity: 2 };
  if (/major acc|7xf?\b|maj inj|fatal|1144|1141|crash urgent|injury|inj acc|auto\/ ?ped|veh vs ped|mvi medic/i.test(s)) {
    return { type: /freeway/i.test(s) ? 'major crash on the freeway' : 'crash with injuries', severity: 3 };
  }
  if (/minor acc|crash service|no inj/i.test(s)) return { type: 'minor crash', severity: 1 };
  if (/crash|collision|collisn|accident|trfc coll|\bmvi\b/i.test(s)) return { type: /freeway/i.test(s) ? 'crash on the freeway' : 'crash', severity: 2 };
  if (/fire/i.test(s) && /car|veh|auto|cfire/i.test(s)) return { type: 'vehicle fire', severity: 2 };
  if (/freeway blockage/i.test(s)) return { type: 'freeway blockage', severity: 2 };
  if (/livestock|animal/i.test(s)) return { type: 'animals on the road', severity: 1 };
  if (/stall|disabled|breakdown|impediment|1126/i.test(s)) return { type: 'stalled vehicle', severity: 1 };
  if (/spinout/i.test(s)) return { type: 'spinout', severity: 1 };
  if (/hazard|debris|hazd|1125|blocked/i.test(s)) return { type: 'hazard in the road', severity: 1 };
  return null;
}

/** Lane impact from free-text dispatch details. */
function laneImpact(details) {
  const d = details.join(' ');
  if (/all (ln|lanes)|hard closure|full closure|all lns/i.test(d)) return 'all lanes blocked';
  if (/(blkg|blocking|blkd|blocked)\b.*\b(ln|lns|lane|lanes)|\b(ln|lns|lane|lanes)\b.*\b(blkg|blocking|blkd|blocked)/i.test(d)) return 'blocking lanes';
  return '';
}

// ------------------------------------------------------------------ live incident feeds

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

/** Parse the CHP statewide CAD media feed (XML). */
export function parseChp(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<Log ID\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/Log>/g)) {
    const b = m[2];
    const f = (name) => (b.match(new RegExp(`<${name}>\\s*"?([\\s\\S]*?)"?\\s*</${name}>`)) || [])[1]?.trim() || '';
    const logType = f('LogType');
    const kind = classifyIncident(logType);
    if (!kind) continue;
    const details = [...b.matchAll(/<IncidentDetail>\s*"?([\s\S]*?)"?\s*<\/IncidentDetail>/g)].map((x) => x[1]);
    if (/sig ?alert/i.test(details.join(' '))) kind.severity = 3;
    const ll = f('LATLON').match(/^(\d+):(\d+)$/);
    const t = f('LogTime').match(/(\w{3})\s+(\d+)\s+(\d{4})\s+(\d+):(\d+)\s*([AP])M/i);
    let at = null;
    if (t) {
      const h = (Number(t[4]) % 12) + (/p/i.test(t[6]) ? 12 : 0);
      at = parseWallTime(`${t[3]}-${String(MONTHS[t[1]] || 1).padStart(2, '0')}-${t[2].padStart(2, '0')}T${String(h).padStart(2, '0')}:${t[5]}:00`, 'America/Los_Angeles');
    }
    const where = prettyRoad(f('Location'));
    out.push({
      id: `chp:${m[1]}`,
      ...kind,
      where,
      road: (where.match(/(I-\d+|US \d+|Highway \d+)( (?:north|south|east|west)bound)?/) || [])[0] || '',
      place: titleCase(f('Area')),
      lanes: laneImpact(details),
      lat: ll ? Number(ll[1]) / 1e6 : null,
      lon: ll ? -Number(ll[2]) / 1e6 : null,
      at,
      source: 'California Highway Patrol',
    });
  }
  return out;
}

const socrata = (base, params) => `${base}?${new URLSearchParams(params)}`;

/** City and state open-data dispatch feeds, chosen by where the market is. */
export const INCIDENT_FEEDS = [
  {
    id: 'chp',
    name: 'California Highway Patrol',
    covers: (locs) => locs.some((l) => stateOf(l) === 'california'),
    async load() {
      return parseChp(await getJson('https://media.chp.ca.gov/sa_xml/sa.xml', { as: 'text', accept: 'text/xml', timeout: 15000 }));
    },
  },
  {
    id: 'austin',
    name: 'Austin-Travis County traffic reports',
    center: [30.27, -97.74], radiusKm: 60,
    async load(now) {
      const since = new Date(now - 3 * HOUR).toISOString().slice(0, 19);
      const rows = await getJson(socrata('https://data.austintexas.gov/resource/dx9v-zd7x.json', {
        $where: `traffic_report_status='ACTIVE' AND published_date > '${since}'`, $order: 'published_date DESC', $limit: '80',
      }));
      return rows.map((r) => {
        const kind = classifyIncident(r.issue_reported);
        return kind && { id: `austin:${r.traffic_report_id}`, ...kind, where: prettyRoad(r.address), lanes: '', lat: Number(r.latitude), lon: Number(r.longitude), at: Date.parse(r.published_date), source: 'Austin traffic reports' };
      }).filter(Boolean);
    },
  },
  {
    id: 'dallas',
    name: 'Dallas Police active calls',
    center: [32.78, -96.8], radiusKm: 45,
    async load() {
      const rows = await getJson(socrata('https://www.dallasopendata.com/resource/9fxf-t2tr.json', { $limit: '1000' }));
      const seen = new Set();
      return rows.map((r) => {
        if (seen.has(r.incident_number)) return null;
        seen.add(r.incident_number);
        if (!/accident|blockage|^0?7x?f?\b|^37f?\b/i.test(r.nature_of_call || '')) return null;
        const kind = classifyIncident(r.nature_of_call.replace(/^0?7XF\b/i, 'major accident freeway').replace(/^0?7X\b/i, 'major accident'));
        return kind && {
          id: `dallas:${r.incident_number}`, ...kind,
          where: `${r.block ? `${r.block} block of ` : ''}${prettyRoad(r.location)}`,
          lanes: '', place: 'Dallas', lat: null, lon: null,
          at: r.date && r.time ? parseWallTime(`${r.date.slice(0, 10)}T${r.time}`, 'America/Chicago') : null,
          source: 'Dallas Police',
        };
      }).filter(Boolean);
    },
  },
  {
    id: 'seattle',
    name: 'Seattle Fire Department 911',
    center: [47.61, -122.33], radiusKm: 35,
    async load(now) {
      const since = localIso(new Date(now - 90 * MIN), 'America/Los_Angeles');
      const rows = await getJson(socrata('https://data.seattle.gov/resource/kzjm-xkqj.json', {
        $where: `datetime > '${since}' AND (type like '%MVI%' OR type like '%Car Fire%' OR type like '%Freeway%')`, $order: 'datetime DESC', $limit: '60',
      }));
      return rows.map((r) => {
        const kind = classifyIncident(r.type);
        return kind && { id: `seattle:${r.incident_number}`, ...kind, where: prettyRoad(r.address), lanes: '', lat: Number(r.latitude), lon: Number(r.longitude), at: parseWallTime(r.datetime, 'America/Los_Angeles'), source: 'Seattle Fire' };
      }).filter(Boolean);
    },
  },
  {
    id: 'sf',
    name: 'San Francisco dispatch',
    center: [37.77, -122.43], radiusKm: 25,
    async load(now) {
      const since = localIso(new Date(now - 2 * HOUR), 'America/Los_Angeles');
      const rows = await getJson(socrata('https://data.sfgov.org/resource/gnap-fj3t.json', {
        $where: `received_datetime > '${since}' AND close_datetime IS NULL AND call_type_final_desc in ('VEH ACCIDENT','INJURY VEH ACCIDENT','H&R VEH ACCIDENT','H&R INJURY ACCIDENT','TRAFFIC HAZARD')`,
        $order: 'received_datetime DESC', $limit: '60',
      }));
      return rows.map((r) => {
        const kind = classifyIncident(r.call_type_final_desc);
        const [lon, lat] = r.intersection_point?.coordinates || [];
        return kind && { id: `sf:${r.cad_number}`, ...kind, where: prettyRoad(r.intersection_name), lanes: '', lat: lat ?? null, lon: lon ?? null, at: parseWallTime(r.received_datetime, 'America/Los_Angeles'), source: 'San Francisco dispatch' };
      }).filter(Boolean);
    },
  },
];

export function incidentFeedsFor(locs) {
  return INCIDENT_FEEDS.filter((f) => (f.covers ? f.covers(locs) : locs.some((l) => Number.isFinite(l.lat) && km(l.lat, l.lon, f.center[0], f.center[1]) <= f.radiusKm)));
}

// ------------------------------------------------------------------ road work (WZDx)

const REGISTRY = 'https://data.transportation.gov/resource/69qe-yiui.json?$limit=500';

/** Keyless, active WZDx feeds from the USDOT registry. */
export async function wzdxRegistry() {
  return cached('wzdx:registry', 24 * HOUR, async () => {
    const rows = await getJson(REGISTRY, { timeout: 15000 });
    return rows
      .filter((r) => r.active !== false && r.needapikey === false && r.url?.url && /json/i.test(r.format || '') && /^[34]/.test(String(r.version || '4')))
      .map((r) => ({
        id: r.feedname,
        name: r.issuingorganization,
        state: String(r.state || '').toLowerCase(),
        url: r.url.url,
        lat: r.geocoded_column?.coordinates?.[1] ?? null,
        lon: r.geocoded_column?.coordinates?.[0] ?? null,
        local: /\b(city|county|town|village|municipal|parish)\b/i.test(r.issuingorganization || ''),
      }));
  });
}

/** Statewide feeds match by state; city/county feeds only when they're near the market. */
export function wzdxFeedsFor(feeds, locs) {
  const states = new Set(locs.map(stateOf).filter(Boolean));
  return feeds.filter((f) => {
    if (f.local || f.state === 'n/a') return Number.isFinite(f.lat) && locs.some((l) => Number.isFinite(l.lat) && km(l.lat, l.lon, f.lat, f.lon) < 80);
    return f.state.split(/\s*,\s*/).some((s) => states.has(s));
  });
}

function samplePoints(g) {
  if (!g) return [];
  const lines = g.type === 'Point' ? [[g.coordinates]] : g.type === 'LineString' || g.type === 'MultiPoint' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
  return lines.flatMap((c) => (c.length ? [c[0], c[Math.floor(c.length / 2)], c[c.length - 1]] : []));
}

const IMPACT = {
  'all-lanes-closed': 'all lanes closed',
  'some-lanes-closed': 'lane closures',
  'some-lanes-closed-merge-left': 'lane closures, merge left',
  'some-lanes-closed-merge-right': 'lane closures, merge right',
  'some-lanes-closed-split': 'lane closures, lanes split',
  'alternating-one-way': 'one lane, alternating traffic',
  'flagging': 'flaggers directing traffic',
};

/** Road work and closures that matter to drivers in the market right now (or starting within 12 hours). */
export function parseWzdx(doc, { areas, now = Date.now(), source = '', local = false }) {
  const out = [];
  for (const f of doc?.features || []) {
    const p = f.properties || {};
    const core = p.core_details || p;
    const type = core.event_type || 'work-zone';
    if (!/work-zone|detour/.test(type)) continue;
    const start = Date.parse(p.start_date);
    const end = Date.parse(p.end_date);
    if (Number.isFinite(end) && end < now) continue;
    const upcoming = Number.isFinite(start) && start > now;
    if (upcoming && start - now > 12 * HOUR) continue;
    const impact = p.vehicle_impact || 'unknown';
    if (impact === 'all-lanes-open') continue;
    const loc = samplePoints(f.geometry).map(([lon, lat]) => areaFor(areas, lat, lon)).find(Boolean);
    if (!loc) continue;
    const road = prettyRoad((core.road_names || (core.road_name ? [core.road_name] : [])).join(' / '));
    if (!road) continue;
    const major = isMajorRoad(road);
    const full = impact === 'all-lanes-closed';
    const ageDays = Number.isFinite(start) ? (now - start) / 86400000 : 99;
    const longTerm = ageDays > 14 && (!Number.isFinite(end) || end - now > 14 * 86400000);
    // side-street permits aren't radio traffic: city feeds only for major roads, state feeds also for fresh full closures
    if (!major && (local || !(full && !longTerm))) continue;
    const b = prettyRoad(p.beginning_cross_street || '');
    const e = prettyRoad(p.ending_cross_street || '');
    out.push({
      road,
      direction: core.direction && core.direction !== 'unknown' ? core.direction : '',
      cross: b && e && b !== e ? `between ${b} and ${e}` : b ? `at ${b}` : '',
      impact: IMPACT[impact] || (type === 'detour' ? 'detour' : 'road work'),
      detail: cleanText(core.description || p.description || ''),
      from: Number.isFinite(start) ? start : null,
      until: Number.isFinite(end) ? end : null,
      upcoming,
      area: shortName(loc),
      source,
      score: (full ? 30 : impact.startsWith('some-lanes') || impact === 'alternating-one-way' ? 15 : 5) + (major ? 25 : 0) + (ageDays < 2 ? 10 : 0) + (upcoming ? 5 : 0) - (longTerm ? 20 : 0),
    });
  }
  // one entry per road segment, both directions merged
  const merged = new Map();
  for (const c of out.sort((x, y) => y.score - x.score)) {
    const k = `${c.road}|${c.cross}`.toLowerCase();
    const have = merged.get(k);
    if (!have) merged.set(k, c);
    else if (c.direction && have.direction && c.direction !== have.direction) have.direction = 'both directions';
  }
  return [...merged.values()];
}

// ------------------------------------------------------------------ headlines

const TRAFFIC_WORDS = /\b(traffic|crash|crashes|collision|wreck|rollover|pileup|closed|closure|closures|lanes?|detour|construction|road ?work|accident|jackknifed|stalled|sigalert|backup|backed up|congestion|delays?)\b/i;
const NUMBERED_ROAD = /\b(I-?\s?\d+|Interstate \d+|U\.?S\.? \d+|US-?\d+|Highway \d+|Hwy \d+|SH \d+|State Route \d+|Route \d+|Loop \d+|FM \d+|RM \d+)\b/i;

/** Keep only headlines that are actually about traffic in this market. */
export function relevantHeadline(title, places) {
  if (!TRAFFIC_WORDS.test(title)) return false;
  // a story that names another state is about somewhere else ("... in Thetford, Vermont")
  if (US_STATES.some((st) => title.includes(st) && !places.includes(st))) return false;
  if (/\b(arrest|charged|convicted|sentenced|murder|shooting|lawsuit|trial|game|nfl|nba|stream)\b|air[- ]traffic/i.test(title)) return false;
  return NUMBERED_ROAD.test(title) || places.some((p) => p && title.toLowerCase().includes(p.toLowerCase()));
}

async function headlines(locs, now) {
  const out = [];
  const places = locs.flatMap((l) => [shortName(l).replace(/ County$/i, ''), l.state || '']);
  await Promise.all(locs.slice(0, 3).map(async (l) => {
    const name = shortName(l);
    const items = await cached(`news:${name}`, 10 * MIN, () => fetchFeed(`https://news.google.com/rss/search?q=${encodeURIComponent(`${placeQuery(l)} (traffic OR crash OR "road closed" OR closure) when:12h`)}&hl=en-US&gl=US&ceid=US:en`));
    for (const i of items.slice(0, 6)) {
      if (i.published && now - i.published > 8 * HOUR) continue;
      const title = i.title.replace(/\s+-\s+[^-]+$/, ''); // drop " - Outlet Name"
      if (!relevantHeadline(title, places)) continue;
      out.push({ area: name, title, published: i.published || null });
    }
  }));
  const seen = new Set();
  return out.filter((h) => !seen.has(h.title) && seen.add(h.title)).sort((a, b) => (b.published || 0) - (a.published || 0)).slice(0, 6);
}

// ------------------------------------------------------------------ public API

/**
 * Current traffic for the market.
 * @returns {{at:number, sources:object[], incidents:object[], closures:object[], headlines:object[]}}
 */
export async function getTraffic({ fresh = false } = {}) {
  const locs = (store.station.market?.locations || []).filter((l) => Number.isFinite(l.lat));
  const custom = (store.settings.trafficFeeds || []).map((f) => (typeof f === 'string' ? { url: f } : f)).filter((f) => f?.url);
  const key = JSON.stringify([locs.map((l) => l.name), custom.map((f) => f.url)]);
  if (!fresh && result.data && result.key === key && Date.now() - result.at < 3 * MIN) return result.data;

  const now = Date.now();
  const areas = marketAreas(locs);
  const sources = [];
  const track = async (meta, fn) => {
    try {
      const items = await fn();
      sources.push({ ...meta, ok: true, count: items.length });
      return items;
    } catch (err) {
      sources.push({ ...meta, ok: false, count: 0, error: err.message });
      return [];
    }
  };

  // live incidents
  const incidentJobs = incidentFeedsFor(locs).map((feed) => track({ id: feed.id, name: feed.name, kind: 'incidents' }, async () => {
    const rows = await cached(`inc:${feed.id}`, 2 * MIN, () => feed.load(now));
    return rows
      .filter((r) => !r.at || now - r.at < 3 * HOUR)
      .map((r) => {
        const loc = areaFor(areas, r.lat, r.lon);
        if (Number.isFinite(r.lat) && !loc) return null; // outside the market
        return { ...r, area: loc ? shortName(loc) : r.place || shortName(locs[0]) };
      })
      .filter(Boolean);
  }));

  // road work: registry feeds for the market + custom WZDx feeds
  const roadworkJobs = [];
  try {
    const feeds = wzdxFeedsFor(await wzdxRegistry(), locs).slice(0, 4);
    for (const f of feeds) {
      roadworkJobs.push(track({ id: `wzdx:${f.id}`, name: f.name, kind: 'roadwork' }, async () => parseWzdx(await cached(`wzdx:${f.url}`, 10 * MIN, () => getJson(f.url, { timeout: 25000, retries: 0 })), { areas, now, source: f.name, local: f.local })));
    }
  } catch (err) {
    sources.push({ id: 'wzdx:registry', name: 'USDOT work zone registry', kind: 'roadwork', ok: false, count: 0, error: err.message });
  }

  // custom feeds: RSS → headlines, GeoJSON → WZDx road work
  const customHeadlines = [];
  for (const f of custom) {
    roadworkJobs.push(track({ id: `custom:${f.url}`, name: f.name || new URL(f.url).host, kind: 'custom' }, async () => {
      const body = await cached(`custom:${f.url}`, 5 * MIN, () => getJson(f.url, { as: 'text', accept: '*/*', timeout: 20000 }));
      if (/^\s*[[{]/.test(body)) return parseWzdx(JSON.parse(body), { areas, now, source: f.name || new URL(f.url).host });
      const { parseFeed } = await import('./rss.js');
      customHeadlines.push(...parseFeed(body).slice(0, 5).map((i) => ({ area: f.name || '', title: i.title, published: i.published || null })));
      return [];
    }));
  }

  const [incidentLists, roadworkLists, news] = await Promise.all([
    Promise.all(incidentJobs),
    Promise.all(roadworkJobs),
    track({ id: 'news', name: 'Local news', kind: 'headlines' }, () => headlines(locs, now)),
  ]);

  const incidents = incidentLists.flat()
    .sort((a, b) => (b.severity - a.severity) || (Number(isMajorRoad(b.where)) - Number(isMajorRoad(a.where))) || ((b.at || 0) - (a.at || 0)))
    .slice(0, 8);
  const closures = roadworkLists.flat().sort((a, b) => b.score - a.score).slice(0, 8);
  const data = { at: now, sources, incidents, closures, headlines: [...customHeadlines, ...news].slice(0, 8) };
  result = { at: now, key, data };
  return data;
}
