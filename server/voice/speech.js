// Radio speech normalizer: rewrites text so every voice engine reads numbers the way people on the
// radio actually say them. Applied to all TTS input (DJ breaks, imaging, spots, news).
//
//   101.9 FM        → one oh one point nine F M        (not "one hundred one point nine")
//   Mix 101 · Z100  → Mix one oh one · Z one hundred
//   US 183 · I-35   → U S one eighty-three · I thirty-five
//   FM 1825         → F M eighteen twenty-five
//   1080 AM         → ten eighty A M
//   7:05 · 7:00 pm  → seven oh five · seven o'clock P M
//   2026 · 2005     → twenty twenty-six · two thousand five
//   (512) 555-0199  → five one two, five five five, zero one nine nine
//   72° · 40%       → seventy-two degrees · forty percent
//   KMXV            → K M X V   (the station's call letters)
//
// Quantities stay natural ("a hundred and five degrees", "three hundred people").

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0-99 in words ("forty-two"). */
export function under100(n) {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10); const o = n % 10;
  return o ? `${TENS[t]}-${ONES[o]}` : TENS[t];
}

/** A natural quantity in words (up to 9999): 105 → "a hundred and five". */
export function quantity(n) {
  if (n < 100) return under100(n);
  if (n < 1000) {
    const h = Math.floor(n / 100); const r = n % 100;
    const head = h === 1 ? 'a hundred' : `${ONES[h]} hundred`;
    return r ? `${head} and ${under100(r)}` : head;
  }
  const th = Math.floor(n / 1000); const r = n % 1000;
  const head = th === 1 ? 'a thousand' : `${ONES[th]} thousand`;
  if (!r) return head;
  return r < 100 ? `${head} and ${under100(r)}` : `${head} ${quantity(r).replace(/^a /, 'one ')}`;
}

/**
 * Identifier style, as used for station numbers, roads, rooms and channels:
 * 101 → "one oh one", 138 → "one thirty-eight", 100 → "one hundred",
 * 1825 → "eighteen twenty-five", 1080 → "ten eighty", 1905 → "nineteen oh five", 2005 → "two thousand five".
 */
export function identifier(n) {
  if (n < 100) return under100(n);
  if (n < 1000) {
    const h = Math.floor(n / 100); const r = n % 100;
    if (r === 0) return `${ONES[h]} hundred`;
    return r < 10 ? `${ONES[h]} oh ${ONES[r]}` : `${ONES[h]} ${under100(r)}`;
  }
  if (n < 10000) {
    if (n % 1000 === 0) return `${ONES[n / 1000]} thousand`;
    const a = Math.floor(n / 100); const b = n % 100;
    if (a % 10 === 0 && b < 10) return `${under100(a / 10)} thousand ${ONES[b]}`; // 2005, 3009
    if (b === 0) return `${under100(a)} hundred`;
    return b < 10 ? `${under100(a)} oh ${ONES[b]}` : `${under100(a)} ${under100(b)}`;
  }
  return String(n).split('').map((d) => (d === '0' ? 'oh' : ONES[Number(d)])).join(' ');
}

/** Years: 2026 → "twenty twenty-six", 2005 → "two thousand five", 1999 → "nineteen ninety-nine". */
export function year(n) {
  if (n >= 2000 && n < 2010) return n === 2000 ? 'two thousand' : `two thousand ${ONES[n - 2000]}`;
  return identifier(n);
}

const digits = (s) => String(s).split('').map((d) => ONES[Number(d)]).join(' ');
const ohDigits = (s) => String(s).split('').map((d) => (d === '0' ? 'oh' : ONES[Number(d)])).join(' ');
const spell = (s) => String(s).toUpperCase().split('').join(' ');

const ROAD = 'I|IH|US|SH|FM|RM|CR|SR|TX|Route|Rte|Highway|Hwy|Interstate|Loop|Spur|Exit|Mile Marker|Channel|Room|Studio|Gate|Terminal|Pier|Platform|Flight|Track|Station|Suite';
const UNIT_AFTER = /^\s*(?:degrees?|°|percent|%|people|persons|miles?|mph|km|kilometers?|feet|foot|ft|inches|minutes?|seconds?|hours?|days?|weeks?|months?|years?|dollars?|bucks|points?|pounds?|lbs|times|cars?|homes?|houses?|jobs|students|fans|tickets|calls|votes|cases|deaths|injuries|acres|units|games?|runs|yards|songs|tracks|spots)\b/i;

/**
 * Make text speakable the radio way.
 * @param {string} text
 * @param {{callSign?: string}} station
 */
export function speakable(text, station = {}) {
  let s = String(text || '');

  // the station's own call letters, letter by letter
  if (station.callSign && /^[A-Z]{3,5}(?:-[A-Z]{2})?$/i.test(station.callSign.replace(/\s/g, ''))) {
    const cs = station.callSign.replace(/[\s-]/g, '');
    s = s.replace(new RegExp(`\\b${cs}(?:-(FM|AM|HD\\d?))?\\b`, 'gi'), (_, band) => `${spell(cs)}${band ? ` ${spell(band)}` : ''}`);
  }

  // phone numbers: (512) 555-0199 / 512-555-0199 / 1-800-555-0199
  s = s.replace(/(?<!\w)(?:1[-.\s])?\(?(\d{3})\)?[-.\s](\d{3})[-.\s](\d{4})\b/g, (_, a, b, c) => `${digits(a)}, ${digits(b)}, ${digits(c)}`);

  // websites with digits: mix1019.com → mix one oh one nine dot com
  s = s.replace(/\b([a-z][a-z0-9-]*?)(\d+)([a-z0-9-]*)\.(com|net|org|fm|radio|co|us|io|live)\b/gi, (_, a, n, b, tld) => `${a} ${ohDigits(n)}${b ? ` ${b}` : ''} dot ${tld}`);

  // clock times: 7:05 pm → seven oh five P M
  s = s.replace(/\b(\d{1,2}):(\d{2})(?:\s?([ap])\.?\s?m\.?\b)?/gi, (_, h, m, ap) => {
    const hh = Number(h); const mm = Number(m);
    const words = mm === 0 ? `${under100(hh)} o'clock` : mm < 10 ? `${under100(hh)} oh ${ONES[mm]}` : `${under100(hh)} ${under100(mm)}`;
    return ap ? `${words} ${ap.toUpperCase()} M` : words;
  });

  // roads and named numbers: US 183, I-35, Highway 290, FM 1825, Room 101
  s = s.replace(/\b(Rte|Hwy|Rt)\.\s?(?=\d)/g, (_, r) => `${r} `); // "Rte. 24" reads like "Route 24"
  s = s.replace(/\bRte\b(?=\s\d)/g, 'Route').replace(/\bRt\b(?=\s\d)/g, 'Route').replace(/\bHwy\b(?=\s\d)/g, 'Highway');
  s = s.replace(new RegExp(`\\b(${ROAD})([\\s-]?)(\\d{1,4})\\b`, 'g'), (_, road, sep, n) => {
    const r = /^(I|IH|US|SH|FM|RM|CR|SR|TX)$/.test(road) ? spell(road) : road;
    return `${r} ${identifier(Number(n))}`;
  });

  // frequencies: 101.9 FM → one oh one point nine F M; 98.7 → ninety-eight point seven
  s = s.replace(/\b(\d{2,3})\.(\d)\b(\s?(?:FM|AM)\b)?/g, (_, whole, dec, band) => {
    const n = Number(whole);
    if (n < 87 || n > 108) return _;
    return `${identifier(n)} point ${ONES[Number(dec)]}${band ? ` ${spell(band.trim())}` : ''}`;
  });
  // AM frequencies: 1080 AM → ten eighty A M
  s = s.replace(/\b(\d{3,4})\s?AM\b/g, (_, n) => `${identifier(Number(n))} A M`);
  s = s.replace(/\b(FM|AM)\b(?=[\s,.!?]|$)/g, (b) => spell(b));

  // brand numbers glued to letters or after a capitalised word: Z100, Q102, Mix 101, Hot 97
  s = s.replace(/\b([A-Z])(\d{2,4})\b/g, (_, l, n) => `${l} ${identifier(Number(n))}`);
  s = s.replace(/\b([A-Z][a-z]+) (\d{3,4})\b(?![.,]\d)/g, (m, word, n, offset, whole) => {
    const v = Number(n);
    if (UNIT_AFTER.test(whole.slice(offset + m.length))) return m;
    if (/^(January|February|March|April|May|June|July|August|September|October|November|December|In|Since|From|Until|By|Back|Summer|Winter|Spring|Fall|Autumn|Christmas|Class)$/.test(word) && v >= 1900 && v < 2100) return `${word} ${year(v)}`;
    return `${word} ${identifier(v)}`;
  });

  // years standing alone
  s = s.replace(/\b(19[5-9]\d|20[0-3]\d)\b(?!\s*(?:%|percent|degrees|people|dollars))/g, (_, y) => year(Number(y)));

  // symbols
  s = s.replace(/(\d)\s?°(?:\s?[FC]\b)?/g, '$1 degrees').replace(/(\d)\s?%/g, '$1 percent');

  // any remaining 3-4 digit quantity → natural words ("a hundred and five degrees")
  s = s.replace(/\b(\d{3,4})\b(?![.,]\d)/g, (_, n) => quantity(Number(n)));

  return s.replace(/\s{2,}/g, ' ').trim();
}
