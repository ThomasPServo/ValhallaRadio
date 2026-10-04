/** Station-local time helpers (all scheduling is done in the station's timezone). */

export function zoned(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    dayOfMonth: Number(get('day')),
    day: days[get('weekday')],
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/** Milliseconds timestamp of the start of the station-local hour containing `date`. */
export function hourStart(date, timeZone) {
  const z = zoned(date, timeZone);
  return date.getTime() - (z.minute * 60 + z.second) * 1000 - (date.getTime() % 1000);
}

export function hourKey(date, timeZone) {
  const z = zoned(date, timeZone);
  return `${z.dateKey}T${String(z.hour).padStart(2, '0')}`;
}

export function spokenTime(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true });
  const z = zoned(date, timeZone);
  const part = z.hour < 5 ? 'overnight' : z.hour < 12 ? 'in the morning' : z.hour < 17 ? 'in the afternoon' : z.hour < 21 ? 'in the evening' : 'at night';
  return `${fmt.format(date)} (${part})`;
}

export function weekdayName(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric' }).format(date);
}

/** Short zone name at a given moment, e.g. "CDT" or "GMT+1". */
export function zoneLabel(timeZone, date = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || timeZone;
  } catch {
    return timeZone;
  }
}

/** Is this a valid IANA time zone name? */
export function validZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/**
 * Distinct time zones across the market's locations (primary location's zone first).
 * @returns {{tz: string, label: string, places: string[]}[]}
 */
export function marketZones(station, date = new Date()) {
  const zones = new Map();
  for (const l of station?.market?.locations || []) {
    if (!l.timezone) continue;
    if (!zones.has(l.timezone)) zones.set(l.timezone, { tz: l.timezone, label: zoneLabel(l.timezone, date), places: [] });
    zones.get(l.timezone).places.push(String(l.name || '').split(',')[0]);
  }
  return [...zones.values()];
}

/** In auto mode the station clock follows the primary (first) market location. Returns true if changed. */
export function applyMarketTimezone(station) {
  if (station.timezoneMode === 'manual') return false;
  const tz = station.market?.locations?.find((l) => l.timezone)?.timezone;
  if (!tz || tz === station.timezone || !validZone(tz)) return false;
  station.timezone = tz;
  return true;
}

/** UTC milliseconds offset of a zone at an instant (local wall time minus UTC). */
function zoneOffsetMs(ms, timeZone) {
  const z = zoned(new Date(ms), timeZone);
  return Date.UTC(z.year, z.month - 1, z.dayOfMonth, z.hour, z.minute, z.second) - Math.floor(ms / 1000) * 1000;
}

/** Epoch ms of a wall-clock time in a zone, e.g. a dispatch log stamped "Oct 3 2026 10:43AM" Pacific. */
export function zonedEpoch(timeZone, year, month, day, hour = 0, minute = 0, second = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = zoneOffsetMs(guess, timeZone);
  const t = guess - first;
  const second2 = zoneOffsetMs(t, timeZone);
  return second2 === first ? t : guess - second2;
}

/** Parse a zone-less ISO timestamp ("2026-10-03T17:42:00.000") as wall time in `timeZone`. */
export function parseWallTime(s, timeZone) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return zonedEpoch(timeZone, +m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0));
}

/** Zone-less local ISO string ("2026-10-03T17:42:00") for querying open-data APIs that store local time. */
export function localIso(date, timeZone) {
  const z = zoned(date, timeZone);
  const p = (n) => String(n).padStart(2, '0');
  return `${z.dateKey}T${p(z.hour)}:${p(z.minute)}:${p(z.second)}`;
}

/** "9 PM", "Sat 5:30 AM" — short local clock time for closures and forecasts. */
export function shortTime(date, timeZone, withDay = false) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', ...(withDay ? { weekday: 'short' } : {}) }).format(date);
  return s.replace(':00', '');
}
