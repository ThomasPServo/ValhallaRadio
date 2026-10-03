// Weather from Open-Meteo (no key needed) plus active NWS alerts for US locations.
import { store } from '../store.js';

const UA = 'ValhallaRadio/0.1 (radio automation; contact: station operator)';
const cache = new Map();

const WMO = {
  0: 'clear skies', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'rain showers', 81: 'rain showers',
  82: 'violent rain showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorms',
  96: 'thunderstorms with hail', 99: 'severe thunderstorms with hail',
};

/**
 * Geocode a city or a whole county. OpenStreetMap Nominatim handles counties/parishes
 * and returns a bounding box (used for area-wide traffic); Open-Meteo's geocoder is the fallback.
 */
export async function geocode(name) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=jsonv2&limit=1&addressdetails=1`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const [r] = await res.json();
      if (r) {
        const a = r.address || {};
        const [s, n, w, e] = (r.boundingbox || []).map(Number);
        const place = a.county && r.addresstype === 'county' ? a.county : (a.city || a.town || a.village || a.municipality || r.name);
        return {
          name: [place, a.state, (a.country_code || '').toUpperCase()].filter(Boolean).join(', '),
          lat: Number(r.lat),
          lon: Number(r.lon),
          countryCode: (a.country_code || '').toUpperCase(),
          bbox: r.boundingbox ? [w, s, e, n] : null,
          kind: ['county', 'state_district', 'region'].includes(r.addresstype) ? 'county' : 'city',
          timezone: await timezoneFor(Number(r.lat), Number(r.lon)),
        };
      }
    }
  } catch (err) {
    console.warn('[geocode] nominatim failed:', err.message);
  }
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name.split(',')[0].trim())}&count=10&language=en&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`geocode HTTP ${res.status}`);
  const data = await res.json();
  const results = data.results || [];
  if (!results.length) return null;
  // If the user typed "City, State", prefer the result whose admin area matches.
  const hint = name.split(',').slice(1).join(',').trim().toLowerCase();
  const best = (hint && results.find((r) => [r.admin1, r.admin2, r.country, r.country_code].some((x) => x && (x.toLowerCase() === hint || x.toLowerCase().startsWith(hint))))) || results[0];
  return {
    name: [best.name, best.admin1, best.country_code].filter(Boolean).join(', '),
    lat: best.latitude,
    lon: best.longitude,
    countryCode: best.country_code,
    bbox: null,
    kind: 'city',
    timezone: best.timezone || null,
  };
}

async function timezoneFor(lat, lon) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&timezone=auto&forecast_days=1&daily=sunrise`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) return (await res.json()).timezone || null;
    } catch { /* retry */ }
  }
  return null;
}

export async function getWeather(loc) {
  if (!loc?.lat) return null;
  const key = `${loc.lat},${loc.lon}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
  const imperial = store.station.units !== 'metric';
  const params = new URLSearchParams({
    latitude: loc.lat, longitude: loc.lon,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m,precipitation',
    hourly: 'precipitation_probability,weather_code,temperature_2m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
    forecast_days: '3', forecast_hours: '12', timezone: 'auto',
    temperature_unit: imperial ? 'fahrenheit' : 'celsius',
    wind_speed_unit: imperial ? 'mph' : 'kmh',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`weather HTTP ${res.status}`);
  const d = await res.json();
  const T = imperial ? '°F' : '°C';
  const W = imperial ? 'mph' : 'km/h';
  const c = d.current || {};
  const days = (d.daily?.time || []).map((t, i) => ({
    date: t,
    conditions: WMO[d.daily.weather_code[i]] || 'mixed conditions',
    high: Math.round(d.daily.temperature_2m_max[i]),
    low: Math.round(d.daily.temperature_2m_min[i]),
    precipChance: d.daily.precipitation_probability_max?.[i] ?? null,
  }));
  const next12 = (d.hourly?.time || []).map((t, i) => ({
    time: t.slice(11, 16),
    temp: Math.round(d.hourly.temperature_2m[i]),
    precipChance: d.hourly.precipitation_probability?.[i] ?? null,
    conditions: WMO[d.hourly.weather_code[i]] || '',
  }));
  const data = {
    location: loc.name,
    units: { temp: T, wind: W },
    current: {
      temp: Math.round(c.temperature_2m),
      feelsLike: Math.round(c.apparent_temperature),
      humidity: c.relative_humidity_2m,
      wind: Math.round(c.wind_speed_10m),
      gusts: Math.round(c.wind_gusts_10m),
      conditions: WMO[c.weather_code] || 'mixed conditions',
    },
    today: days[0], tomorrow: days[1], next12,
    sunrise: d.daily?.sunrise?.[0]?.slice(11), sunset: d.daily?.sunset?.[0]?.slice(11),
    alerts: loc.countryCode === 'US' || !loc.countryCode ? await nwsAlerts(loc).catch(() => []) : [],
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

async function nwsAlerts(loc) {
  const res = await fetch(`https://api.weather.gov/alerts/active?point=${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`, {
    headers: { 'User-Agent': UA, Accept: 'application/geo+json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const d = await res.json();
  return (d.features || []).slice(0, 4).map((f) => ({
    event: f.properties.event,
    headline: f.properties.headline,
    severity: f.properties.severity,
    area: f.properties.areaDesc,
  }));
}

/** Weather for every location in the market (primary first). */
export async function marketWeather() {
  const locs = (store.station.market?.locations || []).filter((l) => l.lat);
  const out = [];
  for (const l of locs.slice(0, 4)) {
    try { out.push(await getWeather(l)); } catch (e) { console.warn('[weather]', l.name, e.message); }
  }
  return out.filter(Boolean);
}
