// Shared HTTP helper for the keyless public data feeds (weather, traffic, news).
import { store } from '../store.js';

/** Identify ourselves the way NWS, MET Norway and the open-data portals ask (app name plus a way to reach the operator). */
export function userAgent() {
  const site = String(store.station.website || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return `ValhallaRadio/0.2 (${site || 'github.com/thomaspservo/valhallaradio'})`;
}

/** GET with a timeout and one retry on 5xx/429/network errors. `as: 'text'` returns the body as text. */
export async function getJson(url, { timeout = 10000, accept = 'application/json', retries = 1, as = 'json', maxBytes = 60e6 } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': userAgent(), Accept: accept }, signal: AbortSignal.timeout(timeout) });
      if (res.ok) {
        if (Number(res.headers.get('content-length') || 0) > maxBytes) throw Object.assign(new Error(`${new URL(url).host}: response too large`), { fatal: true });
        return as === 'text' ? await res.text() : await res.json();
      }
      last = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      last = err;
      if (err.fatal) break;
    }
  }
  throw last;
}

const US_STATES = ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming'];
export { US_STATES };

/**
 * A news search for one market location, pinned to its state or region so a common name finds the right
 * place: "Dartmouth" alone means the college in New Hampshire; "Dartmouth" "Massachusetts" means the town.
 */
export function placeQuery(loc) {
  const parts = String(loc?.name || '').split(',').map((s) => s.trim()).filter(Boolean);
  const name = parts[0] || '';
  const region = loc?.state || (parts.length >= 3 ? parts[1] : '');
  return region && region !== name ? `"${name}" "${region}"` : `"${name}"`;
}
