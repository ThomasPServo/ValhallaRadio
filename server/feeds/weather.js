// Weather with no API keys, from sources that allow broadcast use:
//  - United States (and territories): the National Weather Service, api.weather.gov — official
//    forecast wording, hourly forecast, the latest observation and active alerts. Public domain.
//  - Everywhere else: MET Norway's locationforecast, api.met.no (CC BY 4.0, "Data from MET Norway").
// Sunrise/sunset are computed locally and time zones are looked up offline, so a market setup
// needs no weather account of any kind.
import tzlookup from '@photostructure/tz-lookup';
import { store } from '../store.js';
import { getJson } from './http.js';

const NWS_COUNTRIES = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP']);
const cache = new Map(); // weather per location
const points = new Map(); // NWS gridpoint lookups (they never move)

/**
 * Geocode a city or a whole county. OpenStreetMap Nominatim handles counties/parishes and returns a
 * bounding box (used to scope traffic to the market); Photon (also OpenStreetMap) is the fallback.
 */
export async function geocode(name) {
  try {
    const [r] = await getJson(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=jsonv2&limit=1&addressdetails=1`, { timeout: 10000 });
    if (r) {
      const a = r.address || {};
      const [s, n, w, e] = (r.boundingbox || []).map(Number);
      const place = a.county && r.addresstype === 'county' ? a.county : (a.city || a.town || a.village || a.municipality || r.name);
      const lat = Number(r.lat); const lon = Number(r.lon);
      return {
        name: [place, a.state, (a.country_code || '').toUpperCase()].filter(Boolean).join(', '),
        lat, lon,
        state: a.state || '',
        countryCode: (a.country_code || '').toUpperCase(),
        bbox: r.boundingbox ? [w, s, e, n] : null,
        kind: ['county', 'state_district', 'region'].includes(r.addresstype) ? 'county' : 'city',
        timezone: timezoneFor(lat, lon),
      };
    }
  } catch (err) {
    console.warn('[geocode] nominatim failed:', err.message);
  }
  const d = await getJson(`https://photon.komoot.io/api/?q=${encodeURIComponent(name)}&limit=1&lang=en`, { timeout: 10000 });
  const f = d.features?.[0];
  if (!f) return null;
  const p = f.properties || {};
  const [lon, lat] = f.geometry.coordinates;
  const ext = p.extent; // [west, north, east, south]
  return {
    name: [p.name, p.state, (p.countrycode || '').toUpperCase()].filter(Boolean).join(', '),
    lat, lon,
    state: p.state || '',
    countryCode: (p.countrycode || '').toUpperCase(),
    bbox: ext ? [ext[0], ext[3], ext[2], ext[1]] : null,
    kind: p.osm_value === 'county' || p.type === 'county' ? 'county' : 'city',
    timezone: timezoneFor(lat, lon),
  };
}

/** IANA time zone for a point, looked up offline. */
export function timezoneFor(lat, lon) {
  try { return tzlookup(Number(lat), Number(lon)); } catch { return null; }
}

// ------------------------------------------------------------------ sun

/** Sunrise and sunset (Date objects) for the local calendar day containing `date` (NOAA sunrise equation). */
export function sunTimes(lat, lon, date = new Date(), timeZone = 'UTC') {
  const rad = Math.PI / 180;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const [y, m, d] = day.split('-').map(Number);
  const n = Math.ceil(Date.UTC(y, m - 1, d) / 86400000 + 2440587.5 - 2451545.0 + 0.0008);
  const jStar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const L = (M + C + 180 + 102.9372) % 360;
  const transit = 2451545.0 + jStar + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * L * rad);
  const sinDec = Math.sin(L * rad) * Math.sin(23.4397 * rad);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosW = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * sinDec) / (Math.cos(lat * rad) * cosDec);
  if (cosW < -1 || cosW > 1) return { sunrise: null, sunset: null }; // midnight sun / polar night
  const w = Math.acos(cosW) / rad;
  const toDate = (j) => new Date(Math.round((j - 2440587.5) * 86400000));
  return { sunrise: toDate(transit - w / 360), sunset: toDate(transit + w / 360) };
}

const clock = (date, timeZone) => (date ? new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(date) : null);

// ------------------------------------------------------------------ National Weather Service

const lc = (s) => String(s || '').toLowerCase();
const pop = (p) => p?.probabilityOfPrecipitation?.value ?? null;
const maxOf = (...v) => { const x = v.filter((n) => n !== null && n !== undefined); return x.length ? Math.max(...x) : null; };
const windNum = (s) => { const n = String(s || '').match(/\d+/g); return n ? Math.max(...n.map(Number)) : null; };

async function nwsPoint(loc) {
  const key = `${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`;
  const hit = points.get(key);
  if (hit && Date.now() - hit.at < 24 * 3600_000) return hit;
  const p = (await getJson(`https://api.weather.gov/points/${key}`, { accept: 'application/geo+json' })).properties;
  let station = null;
  try {
    const st = await getJson(`${p.observationStations}?limit=1`, { accept: 'application/geo+json' });
    station = st.features?.[0]?.properties?.stationIdentifier || null;
  } catch { /* forecast still works without an observation station */ }
  const v = { at: Date.now(), forecast: p.forecast, hourly: p.forecastHourly, station, timeZone: p.timeZone };
  points.set(key, v);
  return v;
}

async function nwsWeather(loc, imperial) {
  const pt = await nwsPoint(loc);
  const units = imperial ? 'us' : 'si';
  const [fc, hr, obs] = await Promise.all([
    getJson(`${pt.forecast}?units=${units}`, { accept: 'application/geo+json' }),
    getJson(`${pt.hourly}?units=${units}`, { accept: 'application/geo+json' }),
    pt.station ? getJson(`https://api.weather.gov/stations/${pt.station}/observations/latest`, { accept: 'application/geo+json', retries: 0 }).catch(() => null) : null,
  ]);
  const P = fc.properties?.periods || [];
  const H = hr.properties?.periods || [];
  if (!P.length || !H.length) throw new Error('NWS returned an empty forecast');
  const tz = loc.timezone || pt.timeZone || 'UTC';
  const C2 = (c) => (c === null || c === undefined ? null : Math.round(imperial ? c * 9 / 5 + 32 : c));
  const K2 = (k) => (k === null || k === undefined ? null : Math.round(imperial ? k * 0.621371 : k));

  // the latest observation, when it's fresh; otherwise the current hour of the forecast
  const o = obs?.properties;
  const fresh = o && o.temperature?.value !== null && Date.now() - Date.parse(o.timestamp) < 2 * 3600_000;
  const h0 = H[0];
  const current = fresh
    ? {
      temp: C2(o.temperature.value),
      feelsLike: C2(o.heatIndex?.value ?? o.windChill?.value ?? o.temperature.value),
      humidity: o.relativeHumidity?.value !== null ? Math.round(o.relativeHumidity?.value) : h0.relativeHumidity?.value ?? null,
      wind: K2(o.windSpeed?.value) ?? windNum(h0.windSpeed),
      gusts: K2(o.windGust?.value),
      conditions: lc(o.textDescription) || lc(h0.shortForecast),
    }
    : { temp: h0.temperature, feelsLike: h0.temperature, humidity: h0.relativeHumidity?.value ?? null, wind: windNum(h0.windSpeed), gusts: null, conditions: lc(h0.shortForecast) };

  const dayOf = (d, nNight) => (d ? { name: d.name, conditions: lc(d.shortForecast), high: d.temperature, low: nNight?.temperature ?? null, precipChance: maxOf(pop(d), pop(nNight)) } : null);
  let today; let tomorrow;
  if (P[0].isDaytime) {
    today = dayOf(P[0], P[1]);
    tomorrow = dayOf(P[2], P[3]);
  } else {
    today = { name: P[0].name, conditions: lc(P[0].shortForecast), high: null, low: P[0].temperature, precipChance: pop(P[0]) };
    tomorrow = dayOf(P[1], P[2]);
  }
  return {
    source: 'National Weather Service',
    timezone: tz,
    current,
    observedAt: fresh ? Date.parse(o.timestamp) : null,
    today, tomorrow,
    forecast: P.slice(0, 3).map((p) => ({ name: p.name, text: p.detailedForecast })),
    next12: H.slice(0, 12).map((h) => ({ time: h.startTime.slice(11, 16), temp: h.temperature, precipChance: pop(h), conditions: lc(h.shortForecast) })),
  };
}

async function nwsAlerts(loc) {
  const d = await getJson(`https://api.weather.gov/alerts/active?point=${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`, { accept: 'application/geo+json', timeout: 8000, retries: 0 });
  return (d.features || []).slice(0, 4).map((f) => ({
    event: f.properties.event,
    headline: f.properties.headline,
    severity: f.properties.severity,
    area: f.properties.areaDesc,
  }));
}

// ------------------------------------------------------------------ MET Norway

/** Plain-English conditions for a MET Norway symbol code ("lightrainshowers_day" → "light rain showers"). */
export function metConditions(code = '') {
  const night = /_night$/.test(code);
  const c = code.replace(/_(day|night|polartwilight)$/, '');
  if (c === 'clearsky') return night ? 'clear' : 'sunny';
  if (c === 'fair') return night ? 'mostly clear' : 'mostly sunny';
  if (c === 'partlycloudy') return 'partly cloudy';
  if (c === 'cloudy') return 'cloudy';
  if (c === 'fog') return 'fog';
  if (!c) return '';
  if (/thunder/.test(c)) return /snow/.test(c) ? 'thundersnow' : 'thunderstorms';
  const strength = c.startsWith('heavy') ? 'heavy ' : c.startsWith('light') ? 'light ' : '';
  const kind = /snow/.test(c) ? 'snow' : /sleet/.test(c) ? 'sleet' : 'rain';
  return /showers/.test(c) ? `${strength}${kind} showers` : `${strength}${kind}`;
}

const RANK = ['sunny', 'clear', 'mostly sunny', 'mostly clear', 'partly cloudy', 'cloudy', 'fog'];
const significance = (s) => (RANK.includes(s) ? RANK.indexOf(s) : 10 + (/heavy|thunder/.test(s) ? 5 : 0));

/** Map a MET Norway locationforecast document to the station weather shape. */
export function mapMetno(doc, { imperial, timeZone, now = Date.now() }) {
  const ts = doc.properties?.timeseries || [];
  if (!ts.length) throw new Error('MET Norway returned no data');
  const T = (c) => (c === null || c === undefined ? null : Math.round(imperial ? c * 9 / 5 + 32 : c));
  const V = (ms) => (ms === null || ms === undefined ? null : Math.round(imperial ? ms * 2.23694 : ms * 3.6));
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const local = (t) => { const s = fmt.format(new Date(t)).replace(',', ''); return { date: s.slice(0, 10), hour: Number(s.slice(11, 13)), hm: s.slice(11, 16) }; };

  const startIdx = Math.max(0, ts.findIndex((t) => Date.parse(t.time) >= now - 3600_000));
  const rows = ts.slice(startIdx).map((t) => {
    const d = t.data || {};
    const block = d.next_1_hours || d.next_6_hours || d.next_12_hours || {};
    return {
      t: Date.parse(t.time),
      ...local(t.time),
      temp: d.instant?.details?.air_temperature,
      tmax: d.next_6_hours?.details?.air_temperature_max,
      tmin: d.next_6_hours?.details?.air_temperature_min,
      hourly: Boolean(d.next_1_hours),
      conditions: metConditions(block.summary?.symbol_code),
      pop: d.next_1_hours?.details?.probability_of_precipitation ?? d.next_6_hours?.details?.probability_of_precipitation ?? null,
      precip: d.next_1_hours?.details?.precipitation_amount ?? null,
      d: d.instant?.details || {},
    };
  });
  const first = rows[0];
  const current = {
    temp: T(first.temp),
    feelsLike: T(first.d.apparent_air_temperature ?? first.temp),
    humidity: first.d.relative_humidity !== undefined ? Math.round(first.d.relative_humidity) : null,
    wind: V(first.d.wind_speed),
    gusts: V(first.d.wind_speed_of_gust),
    conditions: first.conditions,
  };

  // day = 06:00–18:00 local, night = 18:00–06:00
  const summarize = (sel, name) => {
    const r = rows.filter(sel);
    if (!r.length) return null;
    const temps = r.flatMap((x) => [x.temp, x.tmax, x.tmin]).filter((v) => v !== undefined && v !== null);
    const cond = r.map((x) => x.conditions).filter(Boolean);
    const worst = cond.reduce((a, b) => (significance(b) > significance(a) ? b : a), cond[0] || '');
    const pops = r.map((x) => x.pop).filter((v) => v !== null);
    return { name, temps, conditions: worst, precipChance: pops.length ? Math.round(Math.max(...pops)) : null, precip: r.reduce((s, x) => s + (x.precip || 0), 0) };
  };
  const today0 = local(now);
  const nextDate = (dateKey) => { const [y, m, d] = dateKey.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10); };
  const day = (dk) => summarize((x) => x.date === dk && x.hour >= 6 && x.hour < 18, 'day');
  const night = (dk) => summarize((x) => (x.date === dk && x.hour >= 18) || (x.date === nextDate(dk) && x.hour < 6), 'night');
  const pack = (name, dd, nn) => (dd || nn ? {
    name,
    conditions: (dd || nn).conditions,
    high: dd?.temps.length ? T(Math.max(...dd.temps)) : null,
    low: nn?.temps.length ? T(Math.min(...nn.temps)) : null,
    precipChance: maxOf(dd?.precipChance, nn?.precipChance),
    precipTotal: Math.round(((dd?.precip || 0) + (nn?.precip || 0)) / (imperial ? 25.4 : 1) * 100) / 100,
  } : null);
  const isEvening = today0.hour >= 17;
  const tomorrowKey = nextDate(today0.date);
  const today = isEvening ? pack('Tonight', null, night(today0.date)) : pack('Today', day(today0.date), night(today0.date));
  const tomorrow = pack('Tomorrow', day(tomorrowKey), night(tomorrowKey));
  return {
    source: 'MET Norway',
    timezone: timeZone,
    current,
    observedAt: null,
    today, tomorrow,
    forecast: [],
    next12: rows.filter((x) => x.hourly).slice(0, 12).map((x) => ({ time: x.hm, temp: T(x.temp), precipChance: x.pop, conditions: x.conditions })),
  };
}

async function metnoWeather(loc, imperial) {
  const doc = await getJson(`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${loc.lat.toFixed(4)}&lon=${loc.lon.toFixed(4)}`, { timeout: 12000 });
  return mapMetno(doc, { imperial, timeZone: loc.timezone || timezoneFor(loc.lat, loc.lon) || 'UTC' });
}

// ------------------------------------------------------------------ public API

const isNwsArea = (loc) => (loc.countryCode ? NWS_COUNTRIES.has(loc.countryCode) : /, (US|PR|GU)$/.test(loc.name || ''));

export async function getWeather(loc) {
  if (!Number.isFinite(loc?.lat) || !Number.isFinite(loc?.lon)) return null;
  const imperial = store.station.units !== 'metric';
  const key = `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)},${imperial ? 'us' : 'si'}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;

  const nws = isNwsArea(loc);
  let w = null;
  if (nws) {
    try { w = await nwsWeather(loc, imperial); } catch (err) { console.warn('[weather] NWS:', err.message, '— using MET Norway'); }
  }
  if (!w) w = await metnoWeather(loc, imperial);
  const tz = w.timezone || loc.timezone || 'UTC';
  const sun = sunTimes(loc.lat, loc.lon, new Date(), tz);
  const data = {
    location: loc.name,
    units: { temp: imperial ? '°F' : '°C', wind: imperial ? 'mph' : 'km/h' },
    ...w,
    sunrise: clock(sun.sunrise, tz),
    sunset: clock(sun.sunset, tz),
    alerts: nws ? await nwsAlerts(loc).catch(() => []) : [],
    credit: w.source === 'MET Norway' ? 'Data from MET Norway' : 'National Weather Service',
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

/** Weather for every location in the market (primary first). */
export async function marketWeather() {
  const locs = (store.station.market?.locations || []).filter((l) => Number.isFinite(l.lat));
  const out = await Promise.all(locs.slice(0, 4).map((l) => getWeather(l).catch((e) => { console.warn('[weather]', l.name, e.message); return null; })));
  return out.filter(Boolean);
}
