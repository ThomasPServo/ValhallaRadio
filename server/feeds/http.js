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
