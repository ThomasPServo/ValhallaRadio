// Valhalla Radio Studio — single-page operator console (no build step).

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDur = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const ICON = { music: '🎵', voice: '🎙️', imaging: '✨', spot: '💵' };
const KIND = { music: 'music', dj: 'voice', weather: 'voice', traffic: 'voice', news: 'voice', say: 'voice', toh_id: 'imaging', id: 'imaging', sweeper: 'imaging', liner: 'imaging', promo: 'imaging', spot: 'spot' };
const TYPE_LABEL = { toh_id: 'Legal ID (TOH)', id: 'Station ID', sweeper: 'Sweeper', liner: 'Liner', promo: 'Promo', music: 'Music', dj: 'DJ Break', weather: 'Weather', traffic: 'Traffic', news: 'News', stopset: 'Stopset', say: 'Live Read', spot: 'Spot' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let B = null; // bootstrap config
let S = { running: false }; // engine state
let S_at = Date.now();
let LOG = [];
let current = 'onair';
const ui = { libTab: 'library', clockId: null, paintClock: null, libFilter: { q: '', category: '' }, design: null, results: null };

async function api(method, url, body, raw) {
  const opts = { method, headers: {} };
  if (raw) { opts.body = raw; } else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, opts);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || data || res.statusText);
  return data;
}

function toast(msg, err = false) {
  const d = document.createElement('div');
  d.className = err ? 'err' : '';
  d.textContent = msg;
  $('#toast').append(d);
  setTimeout(() => d.remove(), err ? 7000 : 3500);
}

async function run(btn, fn, okMsg) {
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span> ' + label; }
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = label; }
  }
}

const catColor = (id) => B?.categories.find((c) => c.id === id)?.color || '#64748b';
const catChip = (id) => (id ? `<span class="cat" style="background:${catColor(id)}">${esc(id)}</span>` : '');
const catOptions = (sel) => B.categories.map((c) => `<option value="${esc(c.id)}" ${c.id === sel ? 'selected' : ''}>${esc(c.id)} — ${esc(c.name)}</option>`).join('');
const opt = (v, label, sel) => `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(label)}</option>`;
const stationTime = (ms) => new Intl.DateTimeFormat([], { timeZone: B.station.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(ms);

/** Read every [data-k] input inside `root` into an object (supports dotted keys). */
function collect(root) {
  const out = {};
  for (const el of $$('[data-k]', root)) {
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number') v = el.value === '' ? null : Number(el.value);
    if (el.dataset.list) v = String(v).split('\n').map((x) => x.trim()).filter(Boolean);
    const path = el.dataset.k.split('.');
    let o = out;
    while (path.length > 1) { const p = path.shift(); o = o[p] ||= {}; }
    o[path[0]] = v;
  }
  return out;
}
const input = (k, label, v, type = 'text', extra = '') => `<div><label>${esc(label)}</label><input data-k="${k}" type="${type}" value="${esc(v ?? '')}" ${extra}></div>`;
const check = (k, label, v) => `<label class="row nowrap" style="color:var(--text);font-size:14px"><input data-k="${k}" type="checkbox" ${v ? 'checked' : ''}> ${esc(label)}</label>`;
const select = (k, label, v, options) => `<div><label>${esc(label)}</label><select data-k="${k}">${options.map(([val, l]) => opt(val, l, v)).join('')}</select></div>`;

// ------------------------------------------------------------------ boot & routing
async function boot() {
  B = await api('GET', '/api/bootstrap');
  brand();
  connectWs();
  window.addEventListener('hashchange', route);
  route();
  setInterval(tickProgress, 250);
}

function brand() {
  $('#brandName').textContent = B.station.name;
  $('#brandSub').textContent = `${B.station.callSign} · ${B.station.frequency}`;
  document.title = `${B.station.name} Studio`;
}

function route() {
  current = (location.hash || '#onair').slice(1);
  if (!VIEWS[current]) current = 'onair';
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === current));
  render();
}

function render() {
  $('#view').innerHTML = VIEWS[current]();
  AFTER[current]?.();
}

function connectWs() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (e) => {
    const { type, data } = JSON.parse(e.data);
    if (type === 'state') { S = data; S_at = Date.now(); updateLive(); }
    if (type === 'level') { S.level = data; updateMeters(); }
    if (type === 'log') { LOG = data; if (current === 'log') renderLogList(); if (current === 'onair') renderQueue(); }
    if (type === 'nowPlaying' && current === 'onair') updateLive();
  };
  ws.onclose = () => setTimeout(connectWs, 2000);
}

function updateLive() {
  const pill = $('#onairPill');
  pill.textContent = S.running ? (S.deadAir ? 'DEAD AIR' : 'ON AIR') : 'OFF AIR';
  pill.classList.toggle('live', S.running && !S.deadAir);
  if (current !== 'onair') return;
  const n = S.now;
  $('#npTitle').textContent = n ? n.title || TYPE_LABEL[n.type] : S.running ? 'Waiting for audio…' : 'Station is off air';
  $('#npArtist').textContent = n ? n.artist || '' : S.running ? 'Preparing the next item' : 'Press “Go on air” to start automation';
  $('#npBadge').innerHTML = n ? `<span class="badge ${KIND[n.type]}">${esc(TYPE_LABEL[n.type] || n.type)}</span> ${catChip(n.category)} ${n.year ? `<span class="muted small">${n.year}</span>` : ''}` : '';
  const art = $('#npArt');
  art.style.backgroundImage = n?.artwork ? `url("${n.artwork}")` : '';
  art.textContent = n?.artwork ? '' : ICON[KIND[n?.type]] || '📻';
  $('#npScript').style.display = n?.script ? '' : 'none';
  $('#npScript').textContent = n?.script ? `“${n.script}”` : '';
  $('#goBtn').style.display = S.running ? 'none' : '';
  $('#stopBtn').style.display = S.running ? '' : 'none';
  $('#statusList').innerHTML = statusHtml();
  $('#overlays').innerHTML = (S.overlays || []).map((o) => `<div class="small muted">↳ ${esc(o.title)} (${fmtDur(o.remaining)})</div>`).join('');
  tickProgress();
}

function tickProgress() {
  if (current !== 'onair' || !S.now) return;
  const pos = Math.min(S.now.length, S.now.position + (S.running ? (Date.now() - S_at) / 1000 : 0));
  const bar = $('#npBar');
  if (!bar) return;
  bar.style.width = `${(pos / (S.now.length || 1)) * 100}%`;
  $('#npTime').textContent = `${fmtDur(pos)} / ${fmtDur(S.now.length)}  ·  −${fmtDur(S.now.length - pos)}`;
}

function updateMeters() {
  if (current !== 'onair') return;
  const l = $('#meterL'); const r = $('#meterR');
  if (!l) return;
  const pct = (v) => { const db = 20 * Math.log10(Math.max(v, 1e-5)); return Math.max(0, Math.min(100, ((db + 48) / 48) * 100)); };
  l.style.clipPath = `inset(${100 - pct(S.level?.l || 0)}% 0 0 0)`;
  r.style.clipPath = `inset(${100 - pct(S.level?.r || 0)}% 0 0 0)`;
}

function statusHtml() {
  const c = B.capabilities;
  const rows = [
    [S.running, S.running ? 'Automation running' : 'Automation stopped'],
    [!!c.ffmpeg, c.ffmpeg ? 'ffmpeg ready' : 'ffmpeg missing (required)'],
    [c.claude, c.claude ? 'Claude connected' : 'Claude not configured'],
    [c.tts, c.tts ? `Voice: ${B.settings.ttsProvider}` : 'No TTS voice configured'],
    [c.traffic, c.traffic ? 'Live traffic (TomTom)' : 'Traffic: headlines only'],
    [true, `${S.listeners || 0} listener(s) on built-in stream`],
    [S.icecast && S.icecast.startsWith('connected'), `Icecast: ${S.icecast || 'off'}`],
  ];
  return rows.map(([ok, t]) => `<div class="cap"><span class="dot ${ok ? 'ok' : ''}"></span>${esc(t)}</div>`).join('') +
    (S.lastError ? `<div class="hint" style="color:#fca5a5">Last error: ${esc(S.lastError)}</div>` : '');
}

// ------------------------------------------------------------------ views
const VIEWS = {};
const AFTER = {};

VIEWS.onair = () => `
  <h1>On Air</h1>
  <p class="sub">Live automation console — ${esc(B.station.name)} · ${esc(B.station.frequency)}</p>
  <div class="grid cols-3">
    <div class="card span-2">
      <div class="now">
        <div class="art" id="npArt">📻</div>
        <div style="min-width:0">
          <div id="npBadge"></div>
          <div class="title" id="npTitle"></div>
          <div class="artist" id="npArtist"></div>
          <div class="progress"><div id="npBar"></div></div>
          <div class="mono small muted" id="npTime"></div>
          <div id="overlays"></div>
        </div>
      </div>
      <div class="script" id="npScript" style="display:none"></div>
      <div class="row" style="margin-top:14px">
        <button class="primary big" id="goBtn" data-action="engineStart">▶ Go on air</button>
        <button class="big danger" id="stopBtn" data-action="engineStop" style="display:none">■ Stop</button>
        <button class="big" data-action="skip">⏭ Skip</button>
        <button class="big" id="monBtn" data-action="monitor">🎧 Listen</button>
        <input type="range" min="0" max="1" step="0.01" value="0.8" id="vol" style="width:110px" title="Monitor volume">
      </div>
    </div>
    <div class="card">
      <div class="row nowrap" style="align-items:flex-start;gap:16px">
        <div class="meters"><div class="meter"><div id="meterL"></div></div><div class="meter"><div id="meterR"></div></div></div>
        <div class="stack" id="statusList" style="min-width:0"></div>
      </div>
    </div>
    <div class="card span-2">
      <div class="row"><h2>Up next</h2><span class="spacer"></span><a href="#log" class="small">Full log →</a></div>
      <div class="queue" id="queue"></div>
    </div>
    <div class="card">
      <h2>Hot carts</h2>
      <div class="carts">${B.imaging.items.filter((i) => i.enabled).map((i) => `<button class="cart ${i.type}" data-action="fireCart" data-id="${i.id}">${esc(i.name)}</button>`).join('') || '<div class="muted small">No imaging yet.</div>'}</div>
      <h2 style="margin-top:18px">Insert next</h2>
      <div class="row">
        <button data-action="insertType" data-type="dj">🎙️ DJ break</button>
        <button data-action="insertType" data-type="weather">🌦 Weather</button>
        <button data-action="insertType" data-type="traffic">🚗 Traffic</button>
        <button data-action="insertType" data-type="news">📰 News</button>
      </div>
      <h2 style="margin-top:18px">Live read</h2>
      <textarea id="sayText" placeholder="Type something for the DJ to say next, in their voice…"></textarea>
      <div class="row" style="margin-top:8px"><button data-action="say">Queue live read</button></div>
    </div>
  </div>`;
AFTER.onair = () => {
  updateLive();
  renderQueue();
  const mon = $('#monitor');
  $('#vol').value = mon.volume;
  $('#vol').oninput = (e) => { mon.volume = Number(e.target.value); };
  $('#monBtn').textContent = mon.paused ? '🎧 Listen' : '🔇 Stop listening';
  if (!LOG.length) api('GET', '/api/log').then((l) => { LOG = l; renderQueue(); });
};

function pendingItems() {
  return LOG.flatMap((l) => l.items.map((i) => ({ ...i, startMs: l.startMs }))).filter((i) => ['playing', 'ready', 'preparing', 'scheduled'].includes(i.status));
}

function itemRow(i, { actions = true, time = '' } = {}) {
  const kind = i.kind || KIND[i.type];
  const thumb = i.artwork ? `<div class="thumb" style="background-image:url('${esc(i.artwork)}')"></div>` : `<div class="thumb">${ICON[kind] || '•'}</div>`;
  const pending = ['ready', 'preparing', 'scheduled'].includes(i.status);
  return `<div class="item ${i.status}">
    <div class="time">${time}</div>
    ${thumb}
    <div style="min-width:0">
      <div class="t">${catChip(i.category)} ${esc(i.title || TYPE_LABEL[i.type] || i.type)}</div>
      <div class="a"><span class="badge ${kind}">${esc(TYPE_LABEL[i.type] || i.type)}</span> ${esc(i.artist || '')} · ${fmtDur(i.duration)} ${i.why && i.type === 'music' ? `<span class="why">— ${esc(i.why)}</span>` : ''}</div>
      ${i.script ? `<details><summary class="small">script</summary><div class="script">${esc(i.script)}</div></details>` : ''}
      ${i.error ? `<div class="small" style="color:#fca5a5">${esc(i.error)}</div>` : ''}
    </div>
    <div class="row nowrap"><span class="status ${i.status}">${i.status}</span>
      ${actions && pending ? `<button class="icon" title="Move up" data-action="move" data-id="${i.id}" data-dir="-1">↑</button><button class="icon" title="Move down" data-action="move" data-id="${i.id}" data-dir="1">↓</button><button class="icon danger" title="Remove" data-action="removeItem" data-id="${i.id}">✕</button>` : ''}
    </div>
  </div>`;
}

function renderQueue() {
  const q = $('#queue');
  if (!q) return;
  const items = pendingItems().slice(0, 10);
  q.innerHTML = items.length ? items.map((i) => itemRow(i, { time: i.estOffset != null ? stationTime(i.startMs + i.estOffset * 1000).slice(0, 5) : '' })).join('') : '<div class="empty">No log yet. Go on air, or build the log from the Program Log tab.</div>';
}

// ---- program log
VIEWS.log = () => `
  <div class="row"><div><h1>Program Log</h1><p class="sub">Hour-by-hour log generated from your clocks, with Claude's music picks and reasons.</p></div>
  <span class="spacer"></span><button data-action="buildLog" class="primary">Build / refresh log</button></div>
  <div id="logList"></div>`;
AFTER.log = () => { renderLogList(); api('GET', '/api/log').then((l) => { LOG = l; renderLogList(); }); };
function renderLogList() {
  const el = $('#logList');
  if (!el) return;
  el.innerHTML = LOG.length ? LOG.map((l) => `
    <div class="card log" style="margin-bottom:16px;padding:0">
      <div class="row" style="padding:12px 14px;border-bottom:1px solid var(--line)">
        <h2 style="margin:0">${esc(l.hourKey.replace('T', ' ')) }:00</h2>
        <span class="badge">${esc(l.clockName || '')}</span><span class="badge">${esc(l.daypart || '')}</span>
        <span class="spacer"></span>
        <span class="small muted">${l.items.filter((i) => i.type === 'music').length} songs · ${l.items.filter((i) => i.type === 'spot').length} spots</span>
        <button data-action="regen" data-key="${l.hourKey}">↻ Regenerate</button>
      </div>
      ${l.items.map((i) => itemRow(i, { time: i.airedAt ? stationTime(i.airedAt) : i.estOffset != null ? '~' + stationTime(l.startMs + i.estOffset * 1000) : '' })).join('')}
    </div>`).join('') : '<div class="card empty">No logs yet — click “Build / refresh log”.</div>';
}

// ---- library
VIEWS.library = () => `
  <h1>Music Library</h1>
  <p class="sub">${B.libraryCount} songs. Music is sourced from monochrome.st in lossless quality and cached locally for playout.</p>
  <div class="tabs">
    ${[['library', '📚 Library'], ['search', '🔎 Add from monochrome'], ['discover', '🤖 Discover with Claude'], ['rules', '⚖️ Categories & rotation']].map(([k, l]) => `<button class="${ui.libTab === k ? 'active' : ''}" data-action="libTab" data-tab="${k}">${l}</button>`).join('')}
  </div>
  <div id="libBody">${LIBTABS[ui.libTab]()}</div>`;
const LIBTABS = {
  library: () => `
    <div class="card">
      <div class="row" style="margin-bottom:10px">
        <input id="libQ" placeholder="Filter by artist, title or album" value="${esc(ui.libFilter.q)}" style="max-width:320px">
        <select id="libCat" style="max-width:220px"><option value="">All categories</option>${catOptions(ui.libFilter.category)}</select>
      </div>
      <div class="table-wrap"><table><thead><tr><th></th><th>Song</th><th>Album / Year</th><th>Category</th><th>Energy</th><th>Plays</th><th>Last played</th><th></th></tr></thead><tbody id="libRows"><tr><td colspan="8" class="empty"><span class="spin"></span></td></tr></tbody></table></div>
    </div>`,
  search: () => `
    <div class="card">
      <div class="row" style="margin-bottom:12px">
        <input id="monoQ" placeholder="Search monochrome: artist, song or album" style="max-width:420px">
        <button class="primary" data-action="monoSearch">Search</button>
        <span class="spacer"></span>
        <label style="margin:0">Add to</label><select id="addCat" style="max-width:220px">${catOptions('N')}</select>
      </div>
      <div id="monoResults" class="grid cols-3"><div class="muted">Search the monochrome catalogue to add songs, import an artist's top tracks or a whole album.</div></div>
    </div>`,
  discover: () => `
    <div class="card stack" style="max-width:720px">
      <p class="muted">Claude suggests songs that fit your format and market, then each suggestion is matched on monochrome and added to the library. This also happens automatically when a category runs thin (Settings → AI).</p>
      <div class="grid cols-3">
        <div><label>Category</label><select id="discCat">${catOptions('N')}</select></div>
        <div><label>How many</label><input id="discCount" type="number" value="12" min="1" max="40"></div>
      </div>
      <div><label>Extra direction (optional)</label><input id="discGuide" placeholder="e.g. 90s alternative hits, female vocalists, songs for a summer weekend"></div>
      <div class="row"><button class="primary" data-action="discover" ${B.capabilities.claude ? '' : 'disabled'}>Discover music</button>${B.capabilities.claude ? '' : '<span class="small muted">Add an Anthropic API key in Settings first.</span>'}</div>
      <div id="discResults"></div>
    </div>`,
  rules: () => `
    <div class="grid cols-2">
      <div class="card">
        <h2>Categories</h2>
        <div class="table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Color</th><th>Min rest (h)</th><th></th></tr></thead><tbody id="catRows">
        ${B.categories.map((c, i) => `<tr data-i="${i}"><td><input data-f="id" value="${esc(c.id)}" style="width:50px"></td><td><input data-f="name" value="${esc(c.name)}"></td><td><input data-f="color" type="color" value="${esc(c.color)}" style="width:44px;padding:2px"></td><td><input data-f="minRestHours" type="number" step="0.5" value="${c.minRestHours}" style="width:80px"></td><td><button class="icon danger" data-action="delRow" data-table="catRows">✕</button></td></tr>`).join('')}
        </tbody></table></div>
        <div class="row" style="margin-top:10px"><button data-action="addCat">+ Category</button><span class="spacer"></span><button class="primary" data-action="saveCats">Save categories</button></div>
      </div>
      <div class="card stack" id="rotForm">
        <h2>Rotation rules</h2>
        ${input('artistSeparationMin', 'Artist separation (minutes)', B.rotation.artistSeparationMin, 'number')}
        ${input('titleSeparationMin', 'Title separation (minutes)', B.rotation.titleSeparationMin, 'number')}
        ${input('maxSameArtistPerHour', 'Max plays per artist per hour', B.rotation.maxSameArtistPerHour, 'number')}
        <p class="hint">Claude chooses the songs, but every pick must pass these rules; otherwise the rotation engine substitutes the most-due eligible song.</p>
        <div><button class="primary" data-action="saveRotation">Save rules</button></div>
      </div>
    </div>`,
};
AFTER.library = () => {
  if (ui.libTab === 'library') {
    loadLibrary();
    $('#libQ').oninput = (e) => { ui.libFilter.q = e.target.value; clearTimeout(ui.libT); ui.libT = setTimeout(loadLibrary, 250); };
    $('#libCat').onchange = (e) => { ui.libFilter.category = e.target.value; loadLibrary(); };
  }
  if (ui.libTab === 'search') {
    $('#monoQ').onkeydown = (e) => { if (e.key === 'Enter') ACTIONS.monoSearch($('[data-action=monoSearch]')); };
    if (ui.results) $('#monoResults').innerHTML = ui.results;
  }
};
async function loadLibrary() {
  const p = new URLSearchParams(ui.libFilter);
  const items = await api('GET', '/api/library?' + p);
  ui.lib = items;
  $('#libRows').innerHTML = items.length ? items.map((t) => `<tr data-id="${t.id}" style="${t.disabled ? 'opacity:.45' : ''}">
    <td><button class="icon" data-action="preview" data-id="${t.id}" title="Preview">▶</button></td>
    <td><div style="display:flex;gap:8px;align-items:center"><div class="thumb" style="background-image:url('${esc(t.artwork)}')"></div><div><b>${esc(t.title)}</b><div class="muted small">${esc(t.artist)}</div></div></div></td>
    <td class="small">${esc(t.album)}<div class="muted">${t.year || ''}</div></td>
    <td><select data-action-change="trackCat">${catOptions(t.category)}</select></td>
    <td><select data-action-change="trackEnergy" style="width:64px">${opt('', '–', t.energy ?? '')}${[1, 2, 3, 4, 5].map((n) => opt(n, n, t.energy)).join('')}</select></td>
    <td class="small">${t.plays || 0}</td>
    <td class="small muted">${t.lastPlayed ? new Date(t.lastPlayed).toLocaleString() : 'never'}</td>
    <td class="row nowrap"><button class="icon" title="Play next" data-action="playNext" data-id="${t.id}">⏩</button><button class="icon" title="${t.disabled ? 'Enable' : 'Disable'}" data-action="toggleTrack" data-id="${t.id}">${t.disabled ? '◻' : '⏸'}</button><button class="icon danger" data-action="delTrack" data-id="${t.id}">✕</button></td>
  </tr>`).join('') : '<tr><td colspan="8" class="empty">No songs yet — add some from monochrome or let Claude discover music.</td></tr>';
}
function resultTrack(t) {
  return `<div class="result-row"><img src="${esc(t.artwork)}" alt="" loading="lazy">
    <div style="min-width:0"><b>${esc(t.title)}</b><div class="small muted">${esc(t.artist)} · ${fmtDur(t.duration)}</div></div>
    <div class="row nowrap"><button class="icon" data-action="preview" data-id="${t.id}">▶</button><button class="icon" data-action="addTrack" data-track='${esc(JSON.stringify(t))}'>＋</button></div></div>`;
}

// ---- clocks & grid
VIEWS.clocks = () => {
  const clock = B.clocks.find((c) => c.id === ui.clockId) || B.clocks[0];
  ui.clockId = clock?.id;
  ui.paintClock ||= clock?.id;
  return `
  <h1>Clocks &amp; Grid</h1>
  <p class="sub">Hour templates (format clocks) and the weekly schedule grid. Every hour's log is generated from its clock.</p>
  <div class="grid cols-3">
    <div class="card">
      <h2>Clocks</h2>
      ${B.clocks.map((c) => `<div class="row" style="margin-bottom:6px"><button style="flex:1;text-align:left;${c.id === clock?.id ? 'border-color:var(--accent)' : ''}" data-action="pickClock" data-id="${c.id}"><span class="cat" style="background:${c.color}">&nbsp;</span> ${esc(c.name)} <span class="muted small">(${c.items.length})</span></button></div>`).join('')}
      <div class="row" style="margin-top:10px"><button data-action="newClock">+ New clock</button>${clock ? '<button data-action="dupClock">Duplicate</button>' : ''}</div>
      ${clock ? `<svg class="clockviz" viewBox="-110 -110 220 220" style="margin-top:14px">${clockSvg(clock)}</svg>` : ''}
    </div>
    <div class="card span-2" id="clockEditor">${clock ? clockEditor(clock) : ''}</div>
  </div>
  <div class="card" style="margin-top:16px">
    <div class="row"><h2>Weekly grid</h2><span class="spacer"></span><label style="margin:0">Paint with</label>
      <select id="paintClock" style="max-width:240px">${B.clocks.map((c) => opt(c.id, c.name, ui.paintClock)).join('')}</select>
      <button class="primary" data-action="saveGrid">Save grid</button></div>
    <p class="hint">Click or drag across cells to assign the selected clock to those hours.</p>
    <div class="table-wrap"><table class="gridtable" id="gridTable"><thead><tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${B.grid.map((row, d) => `<tr><th>${DAYS[d]}</th>${row.map((cid, h) => { const c = B.clocks.find((x) => x.id === cid); return `<td data-d="${d}" data-h="${h}" title="${esc(c?.name || '')}" style="background:${c?.color || '#333'}"></td>`; }).join('')}</tr>`).join('')}</tbody></table></div>
  </div>`;
};
function clockEditor(c) {
  const types = ['toh_id', 'music', 'sweeper', 'id', 'liner', 'promo', 'dj', 'weather', 'traffic', 'news', 'stopset'];
  return `
    <div class="row"><div style="flex:1">${input('name', 'Clock name', c.name)}</div><div style="width:90px"><label>Color</label><input data-k="color" type="color" value="${esc(c.color)}" style="padding:2px;height:36px"></div></div>
    <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>#</th><th>Element</th><th>Options</th><th></th></tr></thead><tbody id="clockRows">
    ${c.items.map((it, i) => `<tr data-i="${i}"><td class="muted">${i + 1}</td>
      <td><select data-f="type">${types.map((t) => opt(t, TYPE_LABEL[t], it.type)).join('')}</select></td>
      <td>${it.type === 'music' ? `<select data-f="category">${catOptions(it.category)}</select>`
        : it.type === 'dj' ? `<select data-f="mode">${[['auto', 'Auto (back/forward-sell)'], ['backsell', 'Back-sell'], ['frontsell', 'Forward-sell'], ['talk', 'Personality talk']].map(([v, l]) => opt(v, l, it.mode)).join('')}</select>`
        : it.type === 'stopset' ? `<input data-f="spots" type="number" min="1" max="10" value="${it.spots || 3}" style="width:80px"> <span class="small muted">spots</span>` : ''}</td>
      <td class="row nowrap"><button class="icon" data-action="clockMove" data-i="${i}" data-dir="-1">↑</button><button class="icon" data-action="clockMove" data-i="${i}" data-dir="1">↓</button><button class="icon danger" data-action="clockDel" data-i="${i}">✕</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="row" style="margin-top:10px">
      <select id="addType" style="max-width:200px">${types.map((t) => opt(t, TYPE_LABEL[t], 'music')).join('')}</select><button data-action="clockAdd">+ Add element</button>
      <span class="spacer"></span><button class="danger" data-action="delClock">Delete clock</button><button class="primary" data-action="saveClock">Save clock</button>
    </div>
    <p class="hint">Estimated length: ${fmtDur(c.items.reduce((s, it) => s + estLen(it), 0))} (an hour is 60:00 — over-filled clocks are trimmed at the top of the hour, under-filled ones get filler music).</p>`;
}
const estLen = (it) => ({ music: 215, stopset: (it.spots || 3) * 30 + 10, dj: it.mode === 'talk' ? 35 : 15, weather: 25, traffic: 25, news: 75, toh_id: 8, id: 5, sweeper: 5, liner: 5, promo: 30 }[it.type] || 10);
function clockSvg(c) {
  const total = Math.max(3600, c.items.reduce((s, it) => s + estLen(it), 0));
  let a = -Math.PI / 2;
  const colors = { music: null, stopset: '#22c55e', dj: '#eab308', weather: '#eab308', traffic: '#eab308', news: '#eab308', toh_id: '#a855f7', id: '#a855f7', sweeper: '#8b5cf6', liner: '#8b5cf6', promo: '#8b5cf6' };
  return c.items.map((it) => {
    const span = (estLen(it) / total) * Math.PI * 2;
    const x1 = Math.cos(a) * 100; const y1 = Math.sin(a) * 100;
    a += span;
    const x2 = Math.cos(a) * 100; const y2 = Math.sin(a) * 100;
    const col = it.type === 'music' ? catColor(it.category) : colors[it.type] || '#64748b';
    return `<path d="M0 0 L${x1} ${y1} A100 100 0 ${span > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z" fill="${col}" stroke="#0b0d12" stroke-width="1"><title>${TYPE_LABEL[it.type]} ${it.category || ''}</title></path>`;
  }).join('') + '<circle r="45" fill="#12151d"/><text text-anchor="middle" dy="5" fill="#8b93a7" font-size="14">:00</text>';
}
AFTER.clocks = () => {
  $('#paintClock').onchange = (e) => { ui.paintClock = e.target.value; };
  let painting = false;
  const paint = (td) => {
    if (!td?.dataset.d) return;
    B.grid[td.dataset.d][td.dataset.h] = ui.paintClock;
    const c = B.clocks.find((x) => x.id === ui.paintClock);
    td.style.background = c?.color;
    td.title = c?.name;
  };
  const t = $('#gridTable');
  t.onmousedown = (e) => { painting = true; paint(e.target.closest('td')); e.preventDefault(); };
  t.onmouseover = (e) => { if (painting) paint(e.target.closest('td')); };
  window.onmouseup = () => { painting = false; };
  $('#clockRows')?.addEventListener('change', (e) => {
    if (e.target.dataset.f === 'type') { syncClock(); render(); }
  });
};
function syncClock() {
  const c = B.clocks.find((x) => x.id === ui.clockId);
  if (!c) return;
  const ed = $('#clockEditor');
  Object.assign(c, collect(ed));
  c.items = $$('#clockRows tr').map((tr) => {
    const it = { type: $('[data-f=type]', tr).value };
    if (it.type === 'music') it.category = $('[data-f=category]', tr)?.value || B.categories[0]?.id;
    if (it.type === 'dj') it.mode = $('[data-f=mode]', tr)?.value || 'auto';
    if (it.type === 'stopset') it.spots = Number($('[data-f=spots]', tr)?.value || 3);
    return it;
  });
}

// ---- dayparts & DJs
VIEWS.programming = () => `
  <h1>Dayparts &amp; DJs</h1>
  <p class="sub">Dayparts tell the music director and the DJs what each part of the day should feel like. Personas are your AI air talent.</p>
  <div class="card">
    <h2>Dayparts</h2>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>From</th><th>To</th><th>Mood / programming direction</th><th>Host</th><th></th></tr></thead><tbody id="dpRows">
    ${B.dayparts.map((d) => `<tr data-id="${d.id}"><td><input data-f="name" value="${esc(d.name)}"></td><td><input data-f="startHour" type="number" min="0" max="23" value="${d.startHour}" style="width:64px"></td><td><input data-f="endHour" type="number" min="0" max="23" value="${d.endHour}" style="width:64px"></td><td><textarea data-f="mood" rows="2" style="min-height:40px">${esc(d.mood)}</textarea></td><td><select data-f="personaId">${B.personas.map((p) => opt(p.id, p.name, d.personaId)).join('')}</select></td><td><button class="icon danger" data-action="delRow" data-table="dpRows">✕</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="row" style="margin-top:10px"><button data-action="addDaypart">+ Daypart</button><span class="spacer"></span><button class="primary" data-action="saveDayparts">Save dayparts</button></div>
  </div>
  <div class="row" style="margin:22px 0 10px"><h2 style="margin:0">DJ personas</h2><span class="spacer"></span><button data-action="addPersona">+ Persona</button><button class="primary" data-action="savePersonas">Save personas</button></div>
  <div class="grid cols-2" id="personaCards">
    ${B.personas.map((p) => `<div class="card stack" data-id="${p.id}">
      ${input('name', 'On-air name', p.name)}
      <div><label>Personality &amp; style</label><textarea data-k="style" rows="3">${esc(p.style)}</textarea></div>
      <div class="grid cols-2">${input('voice.elevenLabsVoiceId', 'ElevenLabs voice ID', p.voice?.elevenLabsVoiceId)}${input('voice.openaiVoice', 'OpenAI voice (alloy, ash, ballad, coral, echo, sage, shimmer, verse…)', p.voice?.openaiVoice)}</div>
      <div><label>Voice direction (OpenAI gpt-4o-mini-tts)</label><input data-k="voice.instructions" value="${esc(p.voice?.instructions || '')}"></div>
      <div class="row"><select data-role="kind" style="max-width:200px">${['auto', 'backsell', 'frontsell', 'talk', 'weather', 'traffic', 'news'].map((k) => opt(k, k, 'auto')).join('')}</select>
        <button data-action="previewBreak" data-id="${p.id}">🎙️ Write &amp; voice a sample break</button>
        <button class="icon danger" data-action="delPersona" data-id="${p.id}">✕</button></div>
      <div data-role="out"></div>
    </div>`).join('')}
  </div>`;

// ---- imaging
VIEWS.imaging = () => `
  <h1>Imaging &amp; Carts</h1>
  <p class="sub">Legal IDs, station IDs, sweepers, liners and promos. Upload produced audio, or write copy and it's voiced by the imaging voice. Placeholders: {name} {callSign} {frequency} {slogan} {market}.</p>
  <div class="card stack" id="imgVoice">
    <h2>Imaging voice</h2>
    <div class="grid cols-3">${input('elevenLabsVoiceId', 'ElevenLabs voice ID', B.imaging.voice.elevenLabsVoiceId)}${input('openaiVoice', 'OpenAI voice', B.imaging.voice.openaiVoice)}${input('instructions', 'Voice direction', B.imaging.voice.instructions)}</div>
  </div>
  <div class="card" style="margin-top:16px">
    <div class="table-wrap"><table><thead><tr><th>Type</th><th>Name</th><th>Copy (voiced if no file)</th><th>Audio file</th><th>On</th><th></th></tr></thead><tbody id="imgRows">
    ${B.imaging.items.map((i) => imgRow(i)).join('')}
    </tbody></table></div>
    <div class="row" style="margin-top:10px"><button data-action="addImaging">+ Imaging item</button><span class="spacer"></span><button class="primary" data-action="saveImaging">Save imaging</button></div>
  </div>`;
function imgRow(i) {
  return `<tr data-id="${i.id}">
    <td><select data-f="type">${['toh_id', 'id', 'sweeper', 'liner', 'promo'].map((t) => opt(t, TYPE_LABEL[t], i.type)).join('')}</select></td>
    <td><input data-f="name" value="${esc(i.name)}"></td>
    <td><input data-f="text" value="${esc(i.text)}"></td>
    <td class="row nowrap"><input data-f="file" type="hidden" value="${esc(i.file || '')}"><span class="small muted" data-role="fname">${esc(i.file || '—')}</span>
      <button class="icon" data-action="upload" title="Upload audio">⤒</button>${i.file ? '<button class="icon" data-action="clearFile">✕</button>' : ''}</td>
    <td><input data-f="enabled" type="checkbox" ${i.enabled ? 'checked' : ''}></td>
    <td class="row nowrap"><button class="icon" data-action="previewImaging" title="Preview">▶</button><button class="icon" data-action="fireCart" data-id="${i.id}" title="Fire on air">🔥</button><button class="icon danger" data-action="delRow" data-table="imgRows">✕</button></td>
  </tr>`;
}

// ---- commercials
VIEWS.commercials = () => `
  <h1>Commercials</h1>
  <p class="sub">Advertisers, spots and flights. Stopsets in your clocks are filled automatically, honouring flight dates, dayparts, daily caps and advertiser separation.</p>
  <div class="grid cols-3">
    <div class="card">
      <h2>Advertisers</h2>
      <table><tbody id="advRows">${B.advertisers.map((a) => `<tr data-id="${a.id}"><td><input data-f="name" value="${esc(a.name)}"></td><td><input data-f="category" placeholder="Category (e.g. auto)" value="${esc(a.category || '')}"></td><td><button class="icon danger" data-action="delRow" data-table="advRows">✕</button></td></tr>`).join('')}</tbody></table>
      <div class="row" style="margin-top:10px"><button data-action="addAdvertiser">+ Advertiser</button><span class="spacer"></span><button class="primary" data-action="saveAdvertisers">Save</button></div>
    </div>
    <div class="card span-2">
      <div class="row"><h2>Affidavit</h2><span class="spacer"></span><input type="date" id="affDate" style="max-width:170px"><button data-action="loadAffidavit">Load</button></div>
      <div id="affOut" class="small muted">Proof-of-play report for a given day.</div>
    </div>
  </div>
  <div class="card" style="margin-top:16px">
    <h2>Spots</h2>
    <div class="table-wrap"><table><thead><tr><th>Advertiser</th><th>Title</th><th>Script (voiced if no file)</th><th>Audio</th><th>Len (s)</th><th>Start</th><th>End</th><th>Max/day</th><th>Dayparts</th><th>On</th><th></th></tr></thead><tbody id="spotRows">
    ${B.spots.map(spotRow).join('')}
    </tbody></table></div>
    <div class="row" style="margin-top:10px"><button data-action="addSpot" ${B.advertisers.length ? '' : 'disabled'}>+ Spot</button>${B.advertisers.length ? '' : '<span class="small muted">Add an advertiser first.</span>'}<span class="spacer"></span><button class="primary" data-action="saveSpots">Save spots</button></div>
  </div>`;
function spotRow(s) {
  return `<tr data-id="${s.id}">
    <td><select data-f="advertiserId">${B.advertisers.map((a) => opt(a.id, a.name, s.advertiserId)).join('')}</select></td>
    <td><input data-f="title" value="${esc(s.title)}"></td>
    <td><textarea data-f="text" rows="2" style="min-height:40px;min-width:220px">${esc(s.text || '')}</textarea></td>
    <td class="row nowrap"><input data-f="file" type="hidden" value="${esc(s.file || '')}"><span class="small muted" data-role="fname">${esc(s.file || '—')}</span><button class="icon" data-action="upload">⤒</button></td>
    <td><input data-f="durationSec" type="number" value="${s.durationSec || 30}" style="width:64px"></td>
    <td><input data-f="startDate" type="date" value="${esc(s.startDate || '')}"></td>
    <td><input data-f="endDate" type="date" value="${esc(s.endDate || '')}"></td>
    <td><input data-f="maxPerDay" type="number" value="${s.maxPerDay || 0}" style="width:64px" title="0 = unlimited"></td>
    <td><select data-f="dayparts" multiple size="2" style="min-width:120px">${B.dayparts.map((d) => `<option value="${d.id}" ${(s.dayparts || []).includes(d.id) ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></td>
    <td><input data-f="enabled" type="checkbox" ${s.enabled !== false ? 'checked' : ''}></td>
    <td class="row nowrap"><button class="icon" data-action="previewSpot" title="Preview">▶</button><button class="icon danger" data-action="delRow" data-table="spotRows">✕</button></td>
  </tr>`;
}

// ---- station & market
VIEWS.market = () => {
  const st = B.station;
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* old browser */ }
  return `
  <h1>Station &amp; Market</h1>
  <p class="sub">Identity, format and the area your DJs cover with local weather, traffic and news.</p>
  <div class="grid cols-2">
    <div class="card stack" id="stationForm">
      <h2>Station</h2>
      <div class="grid cols-2">${input('name', 'Station name', st.name)}${input('callSign', 'Call sign', st.callSign)}${input('frequency', 'Frequency / brand', st.frequency)}${input('slogan', 'Slogan', st.slogan)}</div>
      <div><label>Format (guides Claude's music and DJ choices)</label><textarea data-k="format" rows="3">${esc(st.format)}</textarea></div>
      <div class="grid cols-3">
        <div><label>Timezone</label><input data-k="timezone" list="tzList" value="${esc(st.timezone)}"><datalist id="tzList">${zones.map((z) => `<option value="${z}">`).join('')}</datalist></div>
        ${select('units', 'Units', st.units, [['imperial', 'Imperial (°F, mph)'], ['metric', 'Metric (°C, km/h)']])}
        ${input('language', 'Language', st.language)}
      </div>
      ${input('market.name', 'Market name (e.g. "Greater Austin", "Polk County")', st.market.name)}
      <div><label>Market notes for the DJs (local landmarks, roads, teams, slang…)</label><textarea data-k="market.description" rows="3">${esc(st.market.description || '')}</textarea></div>
      <div><button class="primary" data-action="saveStation">Save station</button></div>
    </div>
    <div class="card stack">
      <h2>Coverage area</h2>
      <p class="muted small">Add cities or entire counties. Weather is pulled for each (Open-Meteo + NWS alerts), news is searched per location, and traffic incidents are checked across the area.</p>
      <div class="row nowrap"><input id="locName" placeholder="e.g. Austin, Texas  or  Travis County, Texas"><button data-action="addLocation">Add</button></div>
      <div>${st.market.locations.map((l, i) => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>${l.kind === 'county' ? '🗺️' : '📍'} ${esc(l.name)}</span><span class="small muted mono">${l.lat.toFixed(3)}, ${l.lon.toFixed(3)}</span><span class="spacer"></span><button class="icon danger" data-action="delLocation" data-i="${i}">✕</button></div>`).join('') || '<div class="muted small">No locations yet.</div>'}</div>
      <h2 style="margin-top:12px">Live feeds</h2>
      <div class="row"><button data-action="feed" data-feed="weather">🌦 Weather</button><button data-action="feed" data-feed="news">📰 News</button><button data-action="feed" data-feed="traffic">🚗 Traffic</button></div>
      <div id="feedOut"></div>
    </div>
  </div>`;
};

// ---- streaming
VIEWS.streaming = () => {
  const ic = B.stream.icecast;
  const url = `${location.origin}/stream.mp3`;
  return `
  <h1>Streaming</h1>
  <p class="sub">Built-in MP3 stream with ICY metadata, plus optional relay to an Icecast/Shoutcast-compatible server.</p>
  <div class="grid cols-2">
    <div class="card stack">
      <h2>Built-in stream</h2>
      <div><label>Stream URL</label><input readonly value="${esc(url)}" onclick="this.select()"></div>
      <div><label>Public listener page</label><input readonly value="${esc(location.origin)}/listen" onclick="this.select()"></div>
      <div><label>Now-playing JSON (for websites/apps)</label><input readonly value="${esc(location.origin)}/api/nowplaying" onclick="this.select()"></div>
      <div><label>Embed on your website</label><textarea readonly rows="2" onclick="this.select()">&lt;audio controls src="${esc(url)}"&gt;&lt;/audio&gt;</textarea></div>
      <div id="streamForm">${select('bitrate', 'Bitrate', B.stream.bitrate, [[64, '64 kbps'], [96, '96 kbps'], [128, '128 kbps'], [192, '192 kbps'], [256, '256 kbps'], [320, '320 kbps']])}</div>
      <p class="hint">Bitrate changes apply the next time the station goes on air.</p>
    </div>
    <div class="card stack" id="icecastForm">
      <h2>Icecast relay</h2>
      ${check('enabled', 'Push the stream to an Icecast server', ic.enabled)}
      <div class="grid cols-2">${input('host', 'Host', ic.host)}${input('port', 'Port', ic.port, 'number')}${input('mount', 'Mount', ic.mount)}${input('username', 'Source user', ic.username)}${input('password', 'Source password', ic.password, 'password')}</div>
      ${check('public', 'List in public directories', ic.public)}
      <div><button class="primary" data-action="saveStream">Save streaming</button></div>
      <div class="cap"><span class="dot ${S.icecast?.startsWith('connected') ? 'ok' : ''}"></span>Status: ${esc(S.icecast || 'off')}</div>
    </div>
  </div>`;
};

// ---- AI programmer
VIEWS.ai = () => `
  <h1>AI Programmer</h1>
  <p class="sub">Describe the station you want. Claude designs categories, hour clocks, the weekly grid, dayparts, DJ personas and imaging copy.</p>
  <div class="card stack">
    <textarea id="brief" rows="5" placeholder="e.g. A classic rock station for Tulsa aimed at 35-54 men. Morning show with news, weather and traffic every 20 minutes. Fewer ads at night. Weekends are 'Deep Cuts' with more album tracks. Two hosts: a gravelly veteran and a younger sidekick.">${esc(ui.brief || '')}</textarea>
    <div class="row"><button class="primary" data-action="design" ${B.capabilities.claude ? '' : 'disabled'}>Design my station</button>${B.capabilities.claude ? '' : '<span class="small muted">Requires an Anthropic API key (Settings).</span>'}</div>
  </div>
  <div id="designOut" style="margin-top:16px">${ui.design ? designHtml(ui.design) : ''}</div>`;
function designHtml(d) {
  return `<div class="card stack">
    <div class="row"><h2 style="margin:0">Proposal</h2><span class="spacer"></span><button class="primary" data-action="applyDesign">Apply to station</button></div>
    <p>${esc(d.summary)}</p>
    <p><b>Format:</b> ${esc(d.format)}<br><b>Slogan:</b> ${esc(d.slogan)}</p>
    <div class="grid cols-2">
      <div><h3>Categories</h3>${d.categories.map((c) => `<div class="small"><b>${esc(c.id)}</b> ${esc(c.name)} — rest ${c.minRestHours}h <span class="muted">(${esc(c.searchSeeds)})</span></div>`).join('')}</div>
      <div><h3>Dayparts</h3>${d.dayparts.map((p) => `<div class="small"><b>${p.startHour}–${p.endHour}h ${esc(p.name)}</b> (${esc(p.personaKey)}): ${esc(p.mood)}</div>`).join('')}</div>
      <div><h3>Personas</h3>${d.personas.map((p) => `<div class="small"><b>${esc(p.name)}</b>: ${esc(p.style)}</div>`).join('')}</div>
      <div><h3>Imaging</h3>${d.imaging.map((i) => `<div class="small"><b>${esc(TYPE_LABEL[i.type])}</b>: ${esc(i.text)}</div>`).join('')}</div>
    </div>
    <h3>Clocks</h3>${d.clocks.map((c) => `<div class="small" style="margin-bottom:6px"><b>${esc(c.name)}</b>: ${c.items.map((i) => i.type === 'music' ? i.category : TYPE_LABEL[i.type]).join(' → ')}</div>`).join('')}
    <p class="hint">Applying replaces categories, clocks, grid, dayparts, personas and imaging. Your music library is kept (songs in removed categories move to the last category).</p>
  </div>`;
}

// ---- settings
VIEWS.settings = () => {
  const s = B.settings;
  const c = B.capabilities;
  return `
  <h1>Settings</h1>
  <p class="sub">API keys are stored on the server only (data/db.json) and never sent back to the browser.</p>
  <div class="grid cols-2" id="settingsForm">
    <div class="card stack">
      <h2>🤖 Claude (music director, DJ writer, programmer)</h2>
      ${input('anthropicApiKey', 'Anthropic API key', s.anthropicApiKey, 'password', 'autocomplete="off"')}
      ${select('claudeModel', 'Model', s.claudeModel, [['claude-opus-5-5', 'Claude Opus 5.5 (default)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (faster, cheaper)'], ['claude-haiku-4-5', 'Claude Haiku 4.5 (cheapest)'], ['claude-fable-5-1', 'Claude Fable 5.1 (most capable)']])}
      ${check('useClaudeForMusic', 'Claude picks the music for each hour', s.useClaudeForMusic)}
      ${check('allowDiscovery', 'Let Claude discover new music on monochrome when a category runs thin', s.allowDiscovery)}
    </div>
    <div class="card stack">
      <h2>🎙️ Voice (text-to-speech)</h2>
      ${select('ttsProvider', 'Provider', s.ttsProvider, [['none', 'None (scripts only)'], ['elevenlabs', 'ElevenLabs (most realistic)'], ['openai', 'OpenAI / OpenAI-compatible']])}
      ${input('elevenLabsApiKey', 'ElevenLabs API key', s.elevenLabsApiKey, 'password', 'autocomplete="off"')}
      ${select('elevenLabsModel', 'ElevenLabs model', s.elevenLabsModel, [['eleven_multilingual_v2', 'Multilingual v2 (natural, stable)'], ['eleven_v3', 'v3 (most expressive, audio tags)'], ['eleven_turbo_v2_5', 'Turbo v2.5 (fast)'], ['eleven_flash_v2_5', 'Flash v2.5 (fastest)']])}
      ${input('openaiApiKey', 'OpenAI API key', s.openaiApiKey, 'password', 'autocomplete="off"')}
      <div class="grid cols-2">${input('openaiBaseUrl', 'Base URL (or self-hosted, e.g. Kokoro)', s.openaiBaseUrl)}${input('openaiTtsModel', 'TTS model', s.openaiTtsModel)}</div>
      <div class="row"><input id="ttsTest" value="Hey, it's twenty past seven and you're listening to ${esc(B.station.name)}." ><button data-action="ttsTest">Test voice</button></div>
    </div>
    <div class="card stack">
      <h2>🎚️ Audio &amp; playout</h2>
      <div class="grid cols-2">
        ${input('crossfadeSec', 'Song crossfade (s)', s.crossfadeSec, 'number', 'step="0.5"')}
        ${input('talkOverSec', 'DJ talk-over into song intro (s)', s.talkOverSec, 'number', 'step="0.5"')}
        ${input('duckDb', 'Music ducking under voice (dB)', s.duckDb, 'number')}
        ${input('lookaheadItems', 'Items prepared ahead', s.lookaheadItems, 'number')}
      </div>
      ${check('normalize', 'Loudness-level all audio', s.normalize)}
    </div>
    <div class="card stack">
      <h2>📡 Sources &amp; data</h2>
      ${input('monochromeBase', 'monochrome API base', s.monochromeBase)}
      ${input('musicCacheMaxMb', 'Music cache limit (MB)', s.musicCacheMaxMb, 'number')}
      ${input('tomtomApiKey', 'TomTom API key (live traffic incidents)', s.tomtomApiKey, 'password', 'autocomplete="off"')}
      <div><label>Extra news RSS feeds (one per line)</label><textarea data-k="newsFeeds" data-list="1" rows="3">${esc((s.newsFeeds || []).join('\n'))}</textarea></div>
    </div>
  </div>
  <div class="row" style="margin-top:16px"><button class="primary big" data-action="saveSettings">Save settings</button>
    <span class="cap"><span class="dot ${c.ffmpeg ? 'ok' : ''}"></span>${esc(c.ffmpeg || 'ffmpeg not found')}</span></div>`;
};

// ------------------------------------------------------------------ actions
const rowsToObjects = (tbody) => $$('tr', $(tbody)).map((tr) => {
  const o = tr.dataset.id ? { id: tr.dataset.id } : {};
  for (const el of $$('[data-f]', tr)) {
    let v = el.type === 'checkbox' ? el.checked : el.multiple ? [...el.selectedOptions].map((x) => x.value) : el.value;
    if (el.type === 'number') v = Number(el.value);
    o[el.dataset.f] = v;
  }
  return o;
});
const save = async (section, body, msg = 'Saved') => { B = await api('PUT', `/api/${section}`, body); brand(); toast(msg); };

function uploadFile() {
  return new Promise((resolve) => {
    const f = document.createElement('input');
    f.type = 'file';
    f.accept = 'audio/*';
    f.onchange = async () => {
      const file = f.files[0];
      if (!file) return resolve(null);
      try {
        resolve(await api('POST', `/api/upload?name=${encodeURIComponent(file.name)}`, undefined, file));
      } catch (e) { toast(e.message, true); resolve(null); }
    };
    f.click();
  });
}
function play(src) {
  const a = $('#preview');
  if (a.dataset.src === src && !a.paused) { a.pause(); return; }
  a.dataset.src = src;
  a.src = src;
  a.play().catch((e) => toast(e.message, true));
}

const ACTIONS = {
  engineStart: (b) => run(b, () => api('POST', '/api/engine/start'), 'Station is on air'),
  engineStop: (b) => { if (confirm('Take the station off air?')) run(b, () => api('POST', '/api/engine/stop')); },
  skip: () => api('POST', '/api/engine/skip').catch((e) => toast(e.message, true)),
  monitor: (b) => {
    const m = $('#monitor');
    if (m.paused) { m.src = `/stream.mp3?t=${Date.now()}`; m.play().catch((e) => toast(e.message, true)); b.textContent = '🔇 Stop listening'; } else { m.pause(); m.removeAttribute('src'); m.load(); b.textContent = '🎧 Listen'; }
  },
  fireCart: (b) => run(null, () => api('POST', `/api/carts/${b.dataset.id}/fire`)),
  insertType: (b) => run(b, () => api('POST', '/api/log/insert', { type: b.dataset.type }), `${TYPE_LABEL[b.dataset.type]} queued next`),
  say: (b) => {
    const t = $('#sayText').value.trim();
    if (!t) return;
    run(b, () => api('POST', '/api/log/insert', { script: t }), 'Live read queued next').then(() => { $('#sayText').value = ''; });
  },
  move: (b) => api('POST', `/api/log/${b.dataset.id}/move`, { dir: Number(b.dataset.dir) }),
  removeItem: (b) => api('POST', `/api/log/${b.dataset.id}/remove`),
  buildLog: (b) => run(b, async () => { LOG = await api('POST', '/api/log/build'); renderLogList(); }),
  regen: (b) => run(b, async () => { LOG = await api('POST', '/api/log/regenerate', { hourKey: b.dataset.key }); renderLogList(); }, 'Hour regenerated'),

  libTab: (b) => { ui.libTab = b.dataset.tab; render(); },
  preview: (b) => play(`/api/monochrome/stream/${b.dataset.id}`),
  playNext: (b) => run(b, () => api('POST', '/api/log/insert', { trackId: b.dataset.id }), 'Song will play next'),
  toggleTrack: async (b) => { const t = ui.lib.find((x) => x.id === b.dataset.id); await api('PATCH', `/api/library/${t.id}`, { disabled: !t.disabled }); loadLibrary(); },
  delTrack: async (b) => { if (!confirm('Remove this song from the library?')) return; await api('DELETE', `/api/library/${b.dataset.id}`); B.libraryCount--; loadLibrary(); },
  monoSearch: (b) => run(b, async () => {
    const q = $('#monoQ').value.trim();
    if (!q) return;
    const r = await api('GET', `/api/monochrome/search?q=${encodeURIComponent(q)}`);
    ui.results = `
      <div><h3>Songs</h3>${r.tracks.slice(0, 20).map(resultTrack).join('') || '<div class="muted small">No songs</div>'}
        ${r.tracks.length ? `<button style="margin-top:8px" data-action="addAll" data-tracks='${esc(JSON.stringify(r.tracks.slice(0, 20)))}'>Add all songs</button>` : ''}</div>
      <div><h3>Albums</h3>${r.releases.slice(0, 12).map((a) => `<div class="result-row"><img src="${esc(a.artwork)}" alt="" loading="lazy"><div><b>${esc(a.title)}</b><div class="small muted">${esc(a.artist)} · ${a.year || ''} ${esc(a.type)}</div></div><div class="row nowrap"><button class="icon" data-action="openRelease" data-id="${a.id}" title="Show tracks">☰</button><button class="icon" data-action="importRelease" data-id="${a.id}" title="Import album">＋</button></div></div>`).join('') || '<div class="muted small">No albums</div>'}</div>
      <div><h3>Artists</h3>${r.artists.slice(0, 12).map((a) => `<div class="result-row"><img src="${esc(a.avatar)}" alt="" loading="lazy"><div><b>${esc(a.name)}</b></div><button data-action="importArtist" data-id="${a.id}" title="Import top tracks">＋ Top 10</button></div>`).join('') || '<div class="muted small">No artists</div>'}</div>`;
    $('#monoResults').innerHTML = ui.results;
  }),
  addTrack: (b) => run(b, async () => { await api('POST', '/api/library', { track: JSON.parse(b.dataset.track), category: $('#addCat').value }); B.libraryCount++; }, 'Added to library'),
  addAll: (b) => run(b, async () => { const r = await api('POST', '/api/library', { tracks: JSON.parse(b.dataset.tracks), category: $('#addCat').value }); B.libraryCount += r.length; }, 'Songs added'),
  importArtist: (b) => run(b, async () => { const r = await api('POST', '/api/library/import', { kind: 'artist', id: b.dataset.id, category: $('#addCat').value, limit: 10 }); B.libraryCount += r.length; toast(`Imported ${r.length} songs`); }),
  importRelease: (b) => run(b, async () => { const r = await api('POST', '/api/library/import', { kind: 'release', id: b.dataset.id, category: $('#addCat').value, limit: 40 }); B.libraryCount += r.length; toast(`Imported ${r.length} songs`); }),
  openRelease: (b) => run(b, async () => {
    const r = await api('GET', `/api/monochrome/release/${b.dataset.id}`);
    b.closest('.result-row').insertAdjacentHTML('afterend', `<div style="padding-left:20px">${r.tracks.map(resultTrack).join('')}</div>`);
  }),
  discover: (b) => run(b, async () => {
    const r = await api('POST', '/api/library/discover', { category: $('#discCat').value, count: Number($('#discCount').value), guidance: $('#discGuide').value });
    B.libraryCount += r.added.length;
    $('#discResults').innerHTML = `<h3>Added ${r.added.length}</h3>${r.added.map((t) => `<div class="small">✅ ${esc(t.artist)} — ${esc(t.title)} <span class="muted">${esc(t.note || '')}</span></div>`).join('')}
      ${r.missed.length ? `<h3 style="margin-top:10px">Not found on monochrome</h3>${r.missed.map((m) => `<div class="small muted">✗ ${esc(m)}</div>`).join('')}` : ''}`;
  }),
  addCat: () => { $('#catRows').insertAdjacentHTML('beforeend', `<tr><td><input data-f="id" style="width:50px"></td><td><input data-f="name"></td><td><input data-f="color" type="color" value="#64748b" style="width:44px;padding:2px"></td><td><input data-f="minRestHours" type="number" step="0.5" value="6" style="width:80px"></td><td><button class="icon danger" data-action="delRow" data-table="catRows">✕</button></td></tr>`); },
  saveCats: () => save('categories', rowsToObjects('#catRows').filter((c) => c.id).map(({ id, name, color, minRestHours }) => ({ id: id.toUpperCase(), name, color, minRestHours }))),
  saveRotation: () => save('rotation', collect($('#rotForm'))),
  delRow: (b) => b.closest('tr').remove(),

  pickClock: (b) => { ui.clockId = b.dataset.id; render(); },
  newClock: () => { const c = { id: 'clk_' + Math.random().toString(36).slice(2, 9), name: 'New Clock', color: '#14b8a6', items: [{ type: 'toh_id' }, { type: 'music', category: B.categories[0]?.id }] }; B.clocks.push(c); ui.clockId = c.id; render(); },
  dupClock: () => { syncClock(); const src = B.clocks.find((c) => c.id === ui.clockId); const c = { ...structuredClone(src), id: 'clk_' + Math.random().toString(36).slice(2, 9), name: src.name + ' (copy)' }; B.clocks.push(c); ui.clockId = c.id; render(); },
  clockAdd: () => { syncClock(); const t = $('#addType').value; const c = B.clocks.find((x) => x.id === ui.clockId); c.items.push(t === 'music' ? { type: t, category: B.categories[0]?.id } : t === 'stopset' ? { type: t, spots: 3 } : t === 'dj' ? { type: t, mode: 'auto' } : { type: t }); render(); },
  clockMove: (b) => { syncClock(); const c = B.clocks.find((x) => x.id === ui.clockId); const i = Number(b.dataset.i); const j = i + Number(b.dataset.dir); if (j < 0 || j >= c.items.length) return; [c.items[i], c.items[j]] = [c.items[j], c.items[i]]; render(); },
  clockDel: (b) => { syncClock(); const c = B.clocks.find((x) => x.id === ui.clockId); c.items.splice(Number(b.dataset.i), 1); render(); },
  saveClock: async () => { syncClock(); await save('clocks', B.clocks, 'Clock saved'); render(); },
  delClock: async () => {
    if (B.clocks.length < 2) return toast('You need at least one clock', true);
    if (!confirm('Delete this clock? Grid hours using it will switch to the first clock.')) return;
    B.clocks = B.clocks.filter((c) => c.id !== ui.clockId);
    const grid = B.grid.map((r) => r.map((cid) => (B.clocks.some((c) => c.id === cid) ? cid : B.clocks[0].id)));
    await save('clocks', B.clocks);
    await save('grid', grid, 'Clock deleted');
    ui.clockId = null; ui.paintClock = null; render();
  },
  saveGrid: () => save('grid', B.grid, 'Grid saved'),

  addDaypart: () => { $('#dpRows').insertAdjacentHTML('beforeend', `<tr><td><input data-f="name" value="New daypart"></td><td><input data-f="startHour" type="number" value="0" style="width:64px"></td><td><input data-f="endHour" type="number" value="23" style="width:64px"></td><td><textarea data-f="mood" rows="2" style="min-height:40px"></textarea></td><td><select data-f="personaId">${B.personas.map((p) => opt(p.id, p.name)).join('')}</select></td><td><button class="icon danger" data-action="delRow" data-table="dpRows">✕</button></td></tr>`); },
  saveDayparts: () => save('dayparts', rowsToObjects('#dpRows')),
  addPersona: async () => { await save('personas', [...readPersonas(), { name: 'New DJ', style: 'Friendly, natural, conversational host.', voice: { elevenLabsVoiceId: '', openaiVoice: 'alloy', instructions: '' } }], 'Persona added'); render(); },
  savePersonas: () => save('personas', readPersonas()),
  delPersona: async (b) => { if (B.personas.length < 2) return toast('Keep at least one DJ', true); await save('personas', readPersonas().filter((p) => p.id !== b.dataset.id)); render(); },
  previewBreak: (b) => {
    const card = b.closest('.card');
    run(b, async () => {
      await save('personas', readPersonas(), 'Persona saved');
      const r = await api('POST', '/api/dj/preview', { kind: $('[data-role=kind]', card).value });
      $('[data-role=out]', card).innerHTML = `<div class="script">“${esc(r.text)}”</div><div class="small muted">Voiced as ${esc(r.persona)} (by daypart). ${r.audio ? '' : 'No TTS configured — script only.'}</div>${r.audio ? `<audio controls autoplay src="${r.audio}" style="width:100%;margin-top:6px"></audio>` : ''}`;
    });
  },

  addImaging: () => { $('#imgRows').insertAdjacentHTML('beforeend', imgRow({ id: '', type: 'sweeper', name: 'New sweeper', text: '{name}.', enabled: true })); },
  saveImaging: async () => { await save('imaging', { voice: collect($('#imgVoice')), items: rowsToObjects('#imgRows') }, 'Imaging saved'); render(); },
  upload: async (b) => {
    const r = await uploadFile();
    if (!r) return;
    const tr = b.closest('tr');
    $('[data-f=file]', tr).value = r.file;
    $('[data-role=fname]', tr).textContent = r.file;
    const dur = $('[data-f=durationSec]', tr);
    if (dur) dur.value = Math.round(r.duration);
    toast(`Uploaded (${r.duration}s) — remember to save`);
  },
  clearFile: (b) => { const tr = b.closest('tr'); $('[data-f=file]', tr).value = ''; $('[data-role=fname]', tr).textContent = '—'; },
  previewImaging: (b) => {
    const tr = b.closest('tr');
    const file = $('[data-f=file]', tr).value;
    if (file) return play(`/uploads/${file}`);
    run(b, async () => { const r = await api('POST', '/api/tts/preview', { text: $('[data-f=text]', tr).value, imaging: true, voice: collect($('#imgVoice')) }); play(r.audio); });
  },

  addAdvertiser: () => { $('#advRows').insertAdjacentHTML('beforeend', `<tr><td><input data-f="name" placeholder="Advertiser name"></td><td><input data-f="category" placeholder="Category"></td><td><button class="icon danger" data-action="delRow" data-table="advRows">✕</button></td></tr>`); },
  saveAdvertisers: async () => { await save('advertisers', rowsToObjects('#advRows').filter((a) => a.name)); render(); },
  addSpot: () => { $('#spotRows').insertAdjacentHTML('beforeend', spotRow({ id: '', advertiserId: B.advertisers[0]?.id, title: 'New spot', durationSec: 30, maxPerDay: 6, enabled: true })); },
  saveSpots: async () => { await save('spots', rowsToObjects('#spotRows').map((s) => ({ ...s, maxPerDay: Number(s.maxPerDay) || 0 }))); render(); },
  previewSpot: (b) => {
    const tr = b.closest('tr');
    const file = $('[data-f=file]', tr).value;
    if (file) return play(`/uploads/${file}`);
    run(b, async () => { const r = await api('POST', '/api/tts/preview', { text: $('[data-f=text]', tr).value }); play(r.audio); });
  },
  loadAffidavit: (b) => run(b, async () => {
    const r = await api('GET', `/api/reports/affidavit?date=${$('#affDate').value || ''}`);
    const name = (id) => B.spots.find((s) => s.id === id)?.title || id;
    $('#affOut').innerHTML = `<b>${esc(r.date)}</b> — ${r.plays.length} spot plays<table><thead><tr><th>Time</th><th>Spot</th><th>Advertiser</th></tr></thead><tbody>${r.plays.map((p) => `<tr><td class="mono">${stationTime(p.at)}</td><td>${esc(p.title)}</td><td>${esc(p.artist)}</td></tr>`).join('')}</tbody></table>
      <div style="margin-top:8px">${Object.entries(r.totals).map(([id, n]) => `<span class="badge">${esc(name(id))}: ${n}</span>`).join(' ')}</div>`;
  }),

  saveStation: () => save('station', collect($('#stationForm')), 'Station saved'),
  addLocation: (b) => run(b, async () => { B = await api('POST', '/api/market/locations', { name: $('#locName').value }); render(); }, 'Location added'),
  delLocation: async (b) => { B = await api('DELETE', `/api/market/locations/${b.dataset.i}`); render(); },
  feed: (b) => run(b, async () => {
    const r = await api('GET', `/api/feeds/${b.dataset.feed}`);
    $('#feedOut').innerHTML = feedHtml(b.dataset.feed, r);
  }),

  saveStream: async () => { await save('stream', { ...collect($('#streamForm')), icecast: collect($('#icecastForm')) }, 'Streaming saved'); },

  design: (b) => {
    ui.brief = $('#brief').value;
    if (!ui.brief.trim()) return toast('Describe your station first', true);
    run(b, async () => { ui.design = await api('POST', '/api/ai/design', { brief: ui.brief }); $('#designOut').innerHTML = designHtml(ui.design); });
  },
  applyDesign: (b) => { if (confirm('Replace your programming with this design?')) run(b, async () => { B = await api('POST', '/api/ai/design/apply', { design: ui.design }); brand(); ui.design = null; location.hash = '#clocks'; }, 'Design applied'); },

  saveSettings: async (b) => {
    const v = collect($('#settingsForm'));
    await run(b, async () => { B = await api('PUT', '/api/settings', v); }, 'Settings saved');
    render();
  },
  ttsTest: (b) => run(b, async () => {
    await api('PUT', '/api/settings', collect($('#settingsForm')));
    B = await api('GET', '/api/bootstrap');
    const p = B.personas[0];
    const r = await api('POST', '/api/tts/preview', { text: $('#ttsTest').value, voice: p.voice });
    play(r.audio);
  }),
};

function readPersonas() {
  return $$('#personaCards > .card').map((card) => ({ id: card.dataset.id, ...collect(card) }));
}

function feedHtml(kind, r) {
  if (kind === 'weather') {
    return r.length ? r.map((w) => `<div class="card" style="margin-top:8px"><b>${esc(w.location)}</b>: ${w.current.temp}${w.units.temp}, ${esc(w.current.conditions)} (feels ${w.current.feelsLike}), wind ${w.current.wind} ${w.units.wind}
      <div class="small muted">Today ${w.today.high}/${w.today.low}, ${esc(w.today.conditions)}, ${w.today.precipChance ?? 0}% precip · Tomorrow ${w.tomorrow?.high}/${w.tomorrow?.low} ${esc(w.tomorrow?.conditions || '')}</div>
      ${(w.alerts || []).map((a) => `<div class="small" style="color:#fca5a5">⚠ ${esc(a.event)}: ${esc(a.headline)}</div>`).join('')}</div>`).join('') : '<div class="muted small">Add a location first.</div>';
  }
  if (kind === 'news') {
    return `<h3>Local</h3>${r.local.map((n) => `<div class="small">• <span class="muted">[${esc(n.area)}]</span> ${esc(n.title)}</div>`).join('') || '<div class="muted small">No local stories.</div>'}
      <h3 style="margin-top:8px">National</h3>${r.national.map((n) => `<div class="small">• ${esc(n.title)}</div>`).join('')}`;
  }
  return `<div class="small muted">Source: ${esc(r.source)}</div>${r.incidents.map((i) => `<div class="small">• ${esc(i.area)}: ${esc(i.type)} ${esc(i.road)} ${esc(i.from)} → ${esc(i.to)} (${esc(i.delay)})</div>`).join('')}${r.headlines.map((h) => `<div class="small">• ${esc(h.area)}: ${esc(h.title)}</div>`).join('')}${!r.incidents.length && !r.headlines.length ? '<div class="small">No incidents reported.</div>' : ''}`;
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'SELECT') return;
  const fn = ACTIONS[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-action-change]');
  if (!el) return;
  const id = el.closest('tr').dataset.id;
  const field = el.dataset.actionChange === 'trackCat' ? 'category' : 'energy';
  try {
    await api('PATCH', `/api/library/${id}`, { [field]: field === 'energy' ? (el.value ? Number(el.value) : null) : el.value });
    toast('Updated');
  } catch (err) { toast(err.message, true); }
});

boot().catch((e) => { document.body.innerHTML = `<pre style="padding:20px">Failed to load studio: ${esc(e.message)}</pre>`; });
