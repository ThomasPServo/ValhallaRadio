// Traffic: TomTom Incident Details (with an API key) for every market location;
// otherwise falls back to recent local traffic headlines. The DJ prompt forbids
// inventing incidents, so with no data the DJ simply keeps traffic general.
import { store } from '../store.js';
import { fetchFeed } from './rss.js';

let cache = { at: 0, key: '', data: null };

const ICON = {
  0: 'unknown issue', 1: 'crash', 2: 'fog', 3: 'dangerous conditions', 4: 'rain', 5: 'ice', 6: 'traffic jam',
  7: 'lane closed', 8: 'road closed', 9: 'road works', 10: 'wind', 11: 'flooding', 14: 'broken-down vehicle',
};
const DELAY = { 0: 'unknown delay', 1: 'minor delays', 2: 'moderate delays', 3: 'major delays', 4: 'road closed' };

function bbox(loc, kind) {
  // TomTom limits the bbox to 10,000 km²; clamp large counties around their centre
  if (loc.bbox) {
    const [w, s, e, n] = loc.bbox;
    if ((e - w) * (n - s) < 0.8) return [w, s, e, n].map((x) => x.toFixed(4)).join(',');
  }
  const d = kind === 'county' ? 0.4 : 0.18;
  return [loc.lon - d, loc.lat - d, loc.lon + d, loc.lat + d].map((n) => n.toFixed(4)).join(',');
}

async function tomtom(loc, key) {
  const fields = '{incidents{properties{iconCategory,magnitudeOfDelay,events{description},from,to,roadNumbers,delay,length}}}';
  const url = `https://api.tomtom.com/traffic/services/5/incidentDetails?key=${encodeURIComponent(key)}&bbox=${bbox(loc, loc.kind)}` +
    `&fields=${encodeURIComponent(fields)}&language=en-US&timeValidityFilter=present`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`TomTom HTTP ${res.status}`);
  const d = await res.json();
  return (d.incidents || [])
    .map((i) => i.properties)
    .filter((p) => p.magnitudeOfDelay >= 2 || [1, 8, 11].includes(p.iconCategory))
    .sort((a, b) => (b.magnitudeOfDelay - a.magnitudeOfDelay) || ((b.delay || 0) - (a.delay || 0)))
    .slice(0, 6)
    .map((p) => ({
      area: loc.name,
      type: ICON[p.iconCategory] || 'incident',
      road: (p.roadNumbers || []).join('/') || '',
      from: p.from || '',
      to: p.to || '',
      detail: (p.events || []).map((e) => e.description).join('; '),
      delay: DELAY[p.magnitudeOfDelay] || '',
      delayMin: p.delay ? Math.round(p.delay / 60) : null,
    }));
}

export async function getTraffic() {
  const locs = (store.station.market?.locations || []).filter((l) => l.lat);
  const key = store.settings.tomtomApiKey;
  const cacheKey = JSON.stringify([locs.map((l) => l.name), Boolean(key)]);
  if (cache.data && cache.key === cacheKey && Date.now() - cache.at < 5 * 60_000) return cache.data;

  const data = { source: key ? 'tomtom' : 'headlines', incidents: [], headlines: [] };
  if (key) {
    for (const l of locs.slice(0, 5)) {
      try { data.incidents.push(...(await tomtom(l, key))); } catch (e) { console.warn('[traffic]', e.message); }
    }
  } else {
    for (const l of locs.slice(0, 3)) {
      try {
        const name = l.name.split(',')[0];
        const items = await fetchFeed(`https://news.google.com/rss/search?q=${encodeURIComponent(`"${name}" (traffic OR crash OR "road closed" OR closure) when:12h`)}&hl=en-US&gl=US&ceid=US:en`);
        data.headlines.push(...items.slice(0, 4).map((i) => ({ area: name, title: i.title.replace(/\s+-\s+[^-]+$/, '') })));
      } catch (e) { console.warn('[traffic]', e.message); }
    }
  }
  cache = { at: Date.now(), key: cacheKey, data };
  return data;
}
