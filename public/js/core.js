// Shared client state, API/WebSocket plumbing and small UI helpers.

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtDur = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const fmtTenths = (s) => {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60); const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
};

export const KIND = { music: 'music', dj: 'voice', weather: 'voice', traffic: 'voice', news: 'voice', say: 'voice', toh_id: 'imaging', id: 'imaging', sweeper: 'imaging', liner: 'imaging', promo: 'imaging', spot: 'spot' };
export const ICON = { music: '🎵', voice: '🎙️', imaging: '✨', spot: '💵' };
export const TYPE_LABEL = { toh_id: 'Legal ID', id: 'Station ID', sweeper: 'Sweeper', liner: 'Liner', promo: 'Promo', music: 'Music', dj: 'DJ Break', weather: 'Weather', traffic: 'Traffic', news: 'News', stopset: 'Stopset', say: 'Live Read', spot: 'Spot' };
export const KIND_COLOR = { music: '#3ea6ff', voice: '#ffb020', imaging: '#b18cff', spot: '#22d36b', bed: '#2ed3d3' };
export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Live client state. Times received from the server are anchored with performance.now(). */
export const state = {
  B: null, // bootstrap/config
  S: { running: false }, S_at: 0,
  LOG: [],
  TL: { items: [] }, TL_at: 0,
  level: { l: 0, r: 0 },
  meters: null,
  scope: null,
  D: { decks: [], fetcher: null }, // decoders and downloads (engineering)
  peaks: new Map(), // id -> { res, data: Int8Array, complete, at }
  setup: null,
};

const listeners = new Map();
export const bus = {
  on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); },
  emit(type, data) { for (const fn of listeners.get(type) || []) fn(data); },
};

export async function api(method, url, body, raw) {
  const opts = { method, headers: {} };
  if (raw) { opts.body = raw; if (raw.type) opts.headers['Content-Type'] = raw.type; } else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, opts);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || data || res.statusText);
  return data;
}

export function toast(msg, err = false) {
  const d = document.createElement('div');
  d.className = err ? 'err' : '';
  d.textContent = msg;
  $('#toast').append(d);
  setTimeout(() => d.remove(), err ? 7000 : 3500);
}

export async function run(btn, fn, okMsg) {
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spin"></span> ${label}`; }
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
    return undefined;
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = label; }
  }
}

// ------------------------------------------------------------------ websocket
let ws = null;
let topics = [];
export function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { sendTopics(); bus.emit('connected'); };
  ws.onmessage = (e) => {
    const { type, data } = JSON.parse(e.data);
    if (type === 'state') { state.S = data; state.S_at = performance.now(); }
    else if (type === 'timeline') { state.TL = data; state.TL_at = performance.now(); requestPeaks(data.items); }
    else if (type === 'log') state.LOG = data;
    else if (type === 'level') state.level = data;
    else if (type === 'meters') state.meters = data;
    else if (type === 'decks') state.D = data;
    else if (type === 'scope') {
      // goniometer points arrive as base64 signed bytes (full scale = 127)
      const bin = atob(data.gonio);
      const g = new Float32Array(bin.length);
      for (let i = 0; i < bin.length; i++) { const b = bin.charCodeAt(i); g[i] = (b > 127 ? b - 256 : b) / 127; }
      state.scope = { spectrum: data.spectrum, gonio: g };
    }
    else if (type === 'setup') state.setup = data;
    else if (type === 'peaks') {
      const bin = atob(data.data);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      state.peaks.set(data.id, { res: data.res, data: new Int8Array(u.buffer), complete: data.complete, at: performance.now() });
    }
    bus.emit(type, data);
  };
  ws.onclose = () => setTimeout(connect, 1500);
}
export function send(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }
// Live feeds: the top bar's level on every page, plus what the open view asks for. A tab in the background
// takes none of them (the server then doesn't compute them either).
function sendTopics() { send({ type: 'sub', topics: document.hidden ? [] : ['level', ...topics] }); }
export function subscribe(list) { topics = list; sendTopics(); }
document.addEventListener('visibilitychange', sendTopics);

/** Ask for waveforms of timeline items we don't have yet (or that are still decoding). */
export function requestPeaks(items) {
  const now = performance.now();
  for (const it of items || []) {
    if (it.kind === 'music' || it.kind === 'voice' || it.kind === 'imaging' || it.kind === 'spot') {
      const p = state.peaks.get(it.id);
      if (!p || (!p.complete && now - p.at > 3000)) {
        if (p) p.at = now; else state.peaks.set(it.id, { res: 0.05, data: new Int8Array(0), complete: false, at: now });
        send({ type: 'peaks', id: it.id });
      }
    }
  }
}

// Writing the same text or style again still makes the browser recalculate the page; animation loops
// use these so only real changes reach the DOM.
export function setText(el, s) { if (el && el._text !== s) { el._text = s; el.textContent = s; } }
export function setHtml(el, s) { if (el && el._html !== s) { el._html = s; el.innerHTML = s; } }
export function setStyle(el, prop, v) { if (!el) return; const c = (el._style ||= {}); if (c[prop] !== v) { c[prop] = v; el.style[prop] = v; } }
/** querySelector, remembered while the element stays in the page. */
const found = new Map();
export function q(sel) { let e = found.get(sel); if (!e || !e.isConnected) { e = document.querySelector(sel); if (e) found.set(sel, e); } return e; }

/** Seconds of the anchored server value now (interpolated between updates). */
export const sinceState = () => (state.S.running ? (performance.now() - state.S_at) / 1000 : 0);
export const sinceTimeline = () => (performance.now() - state.TL_at) / 1000;

// ------------------------------------------------------------------ station time
// Building an Intl.DateTimeFormat is slow (and these run every animation frame and for every log row),
// so formatters are made once per time zone, and the zone's UTC offset is looked up once a minute.
const formatters = new Map();
function formatter(kind, tz) {
  const key = `${kind}|${tz}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(kind === 'parts' ? 'en-US' : [], { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', ...(kind === 'parts' ? { year: 'numeric', month: 'numeric', day: 'numeric' } : {}) });
    formatters.set(key, f);
  }
  return f;
}
const zoneOffset = { tz: null, minute: -1, ms: 0 };
/** Milliseconds to add to UTC for the station's wall clock at `ms` (offsets only change on a minute). */
function offsetAt(tz, ms) {
  const p = formatter('parts', tz).formatToParts(ms);
  const g = (t) => Number(p.find((x) => x.type === t)?.value || 0);
  const wall = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
  return wall - (ms - (ms % 1000));
}
export function stationParts(date = new Date()) {
  const tz = state.B?.station?.timezone || 'UTC';
  const ms = date.getTime();
  const minute = Math.floor(ms / 60000);
  let off;
  if (Math.abs(ms - Date.now()) < 60000) { // the clock: one lookup a minute
    if (zoneOffset.tz !== tz || zoneOffset.minute !== minute) Object.assign(zoneOffset, { tz, minute, ms: offsetAt(tz, ms) });
    off = zoneOffset.ms;
  } else off = offsetAt(tz, ms);
  const d = new Date(ms + off);
  return { h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() };
}
export const stationTime = (ms) => formatter('time', state.B?.station?.timezone || 'UTC').format(ms);

// ------------------------------------------------------------------ form helpers
export const catColor = (id) => state.B?.categories.find((c) => c.id === id)?.color || '#64748b';
export const catChip = (id) => (id ? `<span class="cat" style="background:${catColor(id)}">${esc(id)}</span>` : '');
export const catOptions = (sel) => state.B.categories.map((c) => `<option value="${esc(c.id)}" ${c.id === sel ? 'selected' : ''}>${esc(c.id)} — ${esc(c.name)}</option>`).join('');
export const opt = (v, label, sel) => `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(label)}</option>`;
export const input = (k, label, v, type = 'text', extra = '') => `<div><label>${esc(label)}</label><input data-k="${k}" type="${type}" value="${esc(v ?? '')}" ${extra}></div>`;
export const check = (k, label, v) => `<label class="row nowrap" style="color:var(--text);font-size:14px;margin:0"><input data-k="${k}" type="checkbox" ${v ? 'checked' : ''}> ${esc(label)}</label>`;
export const select = (k, label, v, options) => `<div><label>${esc(label)}</label><select data-k="${k}">${options.map(([val, l]) => opt(val, l, v)).join('')}</select></div>`;

/** Read every [data-k] input inside `root` into an object (dotted keys nest). */
export function collect(root) {
  const out = {};
  for (const el of $$('[data-k]', root)) {
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number' || el.type === 'range') v = el.value === '' ? null : Number(el.value);
    if (el.dataset.list) v = String(v).split('\n').map((x) => x.trim()).filter(Boolean);
    const path = el.dataset.k.split('.');
    let o = out;
    while (path.length > 1) { const p = path.shift(); o = o[p] ||= {}; }
    o[path[0]] = v;
  }
  return out;
}

export function rowsToObjects(tbody) {
  return $$('tr', $(tbody)).map((tr) => {
    const o = tr.dataset.id ? { id: tr.dataset.id } : {};
    for (const el of $$('[data-f]', tr)) {
      let v = el.type === 'checkbox' ? el.checked : el.multiple ? [...el.selectedOptions].map((x) => x.value) : el.value;
      if (el.type === 'number') v = Number(el.value);
      o[el.dataset.f] = v;
    }
    return o;
  });
}

export async function save(section, body, msg = 'Saved') {
  state.B = await api('PUT', `/api/${section}`, body);
  bus.emit('bootstrap', state.B);
  toast(msg);
}

/** Preview a file in the player bar (player.js): play/pause, time, and a scrubbable waveform. */
export function play(src, { title = '' } = {}) {
  bus.emit('preview', { src, title });
}

export function uploadFile(accept = 'audio/*') {
  return new Promise((resolve) => {
    const f = document.createElement('input');
    f.type = 'file';
    f.accept = accept;
    f.onchange = () => resolve(f.files[0] || null);
    f.click();
  });
}

/** Pick several files, or a whole folder (`directory`): each keeps its folder path in `relPath`. */
export function uploadFiles(accept = 'audio/*', { directory = false } = {}) {
  return new Promise((resolve) => {
    const f = document.createElement('input');
    f.type = 'file';
    f.accept = accept;
    f.multiple = true;
    if (directory) f.webkitdirectory = true;
    f.onchange = () => resolve([...f.files].map((x) => Object.assign(x, { relPath: x.webkitRelativePath || x.name })));
    f.click();
  });
}

export function modal(html, { cls = '' } = {}) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal ${cls}"><div class="box">${html}</div></div>`;
  const el = root.firstElementChild;
  el.addEventListener('mousedown', (e) => { if (e.target === el && !cls.includes('wizard')) closeModal(); });
  return el;
}
export function closeModal() { $('#modalRoot').innerHTML = ''; }
