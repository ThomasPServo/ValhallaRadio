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
