// Program log and music library (catalogue search and import, charts, discovery, song info, categories,
// clean-version sweep and the waveform marker editor).

import { $, $$, esc, fmtDur, state, api, run, toast, bus, stationTime, catChip, catOptions, opt, input, collect, rowsToObjects, save, play, modal, closeModal } from './core.js';
import { itemRow } from './studio.js';
import { drawWaveform } from './widgets.js';

const ui = { tab: 'library', q: '', category: '', results: '', lib: [], chart: null, chartDate: '', chartData: null };

// ------------------------------------------------------------------ program log
function logHtml() {
  if (!state.LOG.length) return '<div class="card empty">No log yet. Click “Build log”, or go on air and it builds itself.</div>';
  return state.LOG.map((l) => `
    <div class="card log" style="margin-bottom:14px;padding:0">
      <div class="row" style="padding:12px 14px;border-bottom:1px solid var(--line)">
        <h2 style="margin:0">${esc(l.hourKey.replace('T', ' '))}:00</h2>
        <span class="badge">${esc(l.clockName || '')}</span><span class="badge">${esc(l.daypart || '')}</span>
        <span class="spacer"></span>
        <span class="small muted">${l.items.filter((i) => i.type === 'music').length} songs · ${l.items.filter((i) => i.type === 'spot').length} spots</span>
        <button data-action="regen" data-key="${l.hourKey}" title="Ask the music director for a fresh hour (playing items are kept)">↻ Regenerate</button>
      </div>
      ${l.items.map((i) => itemRow(i, i.airedAt ? stationTime(i.airedAt) : i.estOffset != null ? `~${stationTime(l.startMs + i.estOffset * 1000).slice(0, 5)}` : '', { draggable: false })).join('')}
    </div>`).join('');
}

export const log = {
  render: () => `
    <div class="row"><div><h1>Program log</h1><p class="sub">Every hour is built from its clock; the music director's reasons are shown in italics.</p></div>
      <span class="spacer"></span><button class="primary" data-action="buildLog">Build log</button></div>
    <div id="logList">${logHtml()}</div>`,
  mount() {
    const off = bus.on('log', () => { const el = $('#logList'); if (el) el.innerHTML = logHtml(); });
    return off;
  },
  actions: {
    buildLog: (b) => run(b, async () => { state.LOG = await api('POST', '/api/log/build'); $('#logList').innerHTML = logHtml(); }),
    regen: (b) => run(b, async () => { state.LOG = await api('POST', '/api/log/regenerate', { hourKey: b.dataset.key }); $('#logList').innerHTML = logHtml(); }, 'Hour regenerated'),
    move: (b) => api('POST', `/api/log/${b.dataset.id}/move`, { dir: Number(b.dataset.dir) }),
    removeItem: (b) => api('POST', `/api/log/${b.dataset.id}/remove`),
  },
};

// ------------------------------------------------------------------ library
const TABS = [['library', '📚 Library'], ['charts', '📈 Charts'], ['search', '🔎 Add music'], ['discover', '🧭 Discover'], ['rules', '⚖️ Categories & rotation']];

function libraryTab() {
  const B = state.B;
  const blocked = B.settings.cleanOnly && B.explicitCount > 0;
  return `
    ${blocked ? `<div class="card banner warn" style="margin-bottom:12px"><b>${B.explicitCount} explicit song${B.explicitCount === 1 ? '' : 's'}</b> can't air (clean versions only is on).
      <button data-action="cleanSweep">Find clean versions</button> <span class="small muted" id="sweepNote"></span></div>` : ''}
    <div class="card">
      <div class="row" style="margin-bottom:10px">
        <input id="libQ" placeholder="Filter by artist, title or album" value="${esc(ui.q)}" style="max-width:320px">
        <select id="libCat" style="max-width:220px"><option value="">All categories</option>${catOptions(ui.category)}</select>
        <span class="spacer"></span><span class="small muted" id="libCount"></span>
      </div>
      <div class="table-wrap"><table class="libtable"><thead><tr><th></th><th>Song</th><th>Category</th><th class="hide-sm" title="Instrumental intro before the vocals — the DJ talks up to here">Intro</th><th class="hide-sm" title="Cold (C) or fade (F) ending">End</th><th class="hide-sm">BPM</th><th class="hide-sm">Plays</th><th class="hide-sm">Last played</th><th></th></tr></thead>
      <tbody id="libRows"><tr><td colspan="9" class="empty"><span class="spin"></span></td></tr></tbody></table></div>
    </div>`;
}

function introCell(t) {
  const m = t.markers || {};
  if (m.instrumental || t.lyrics?.status === 'instrumental') return '<span class="badge">instr.</span>';
  const v = m.intro ?? (t.lyrics?.status === 'found' ? t.lyrics.vocalStart : null);
  if (v == null) return '<span class="muted" title="No vocal timing yet: the DJ will not talk over this song">—</span>';
  const st = t.analysis?.startSec || 0;
  return `<span class="num" title="${m.intro != null ? 'Marked by hand' : 'From synced lyrics'}">${Math.max(0, v - st).toFixed(1)}s${m.intro != null ? ' ✎' : ''}</span>`;
}

function libRow(t) {
  const a = t.analysis || {};
  const end = t.markers?.endType || a.endType;
  return `<tr data-id="${t.id}" class="${t.disabled ? 'off' : ''}">
    <td><button class="icon" data-action="preview" data-id="${t.id}" title="Preview">▶</button></td>
    <td><div class="songcell"><div class="thumb" style="background-image:url('${esc(t.artwork || '')}')"></div><div style="min-width:0">
      <b>${esc(t.title)}</b> ${t.explicit ? '<span class="badge e" title="Explicit version">E</span>' : t.note === 'clean version' ? '<span class="badge clean" title="Swapped for the clean radio edit">clean</span>' : ''}
      <div class="muted small">${t.chart ? `<span class="badge chart" title="${esc(t.chart.chart)}">#${t.chart.rank}</span> ` : t.chartPeak ? `<span class="badge" title="Chart peak (${esc(t.chartPeak.chart)})">pk #${t.chartPeak.peak}</span> ` : ''}${esc(t.artist)}${t.year ? ` · ${t.year}` : ''}${t.facts?.genre ? ` · ${esc(t.facts.genre)}` : ''}${t.facts?.voice ? ` · ${esc(t.facts.voice)}` : ''}${t.facts?.popularity != null ? ` · <span title="Popularity (Deezer)">★${t.facts.popularity}</span>` : ''}${t.album ? ` · ${esc(t.album)}` : ''}</div></div></div></td>
    <td><select data-change="trackCat">${catOptions(t.category)}</select></td>
    <td class="hide-sm">${introCell(t)}</td>
    <td class="hide-sm">${end ? `<span class="badge ${end}">${end === 'cold' ? 'C' : 'F'}</span>` : '<span class="muted">—</span>'}</td>
    <td class="num small hide-sm">${a.headTempo?.bpm ? Math.round(a.headTempo.bpm) : '—'}</td>
    <td class="small num hide-sm">${t.plays || 0}</td>
    <td class="small muted hide-sm">${t.lastPlayed ? stationTime(t.lastPlayed).slice(0, 5) + ' ' + new Date(t.lastPlayed).toLocaleDateString() : 'never'}</td>
    <td class="row nowrap acts"><button class="icon" title="Song info: facts, charts and story" data-action="songInfo" data-artist="${esc(t.artist)}" data-title="${esc(t.title)}">ℹ</button><button class="icon" title="Edit markers (intro, outro, mix point)" data-action="markers" data-id="${t.id}">✎</button><button class="icon" title="Play next" data-action="playNext" data-id="${t.id}">⏩</button><button class="icon" title="${t.disabled ? 'Enable' : 'Disable'}" data-action="toggleTrack" data-id="${t.id}">${t.disabled ? '◻' : '⏸'}</button><button class="icon danger" title="Remove" data-action="delTrack" data-id="${t.id}">✕</button></td>
  </tr>`;
}

async function loadLibrary() {
  const items = await api('GET', `/api/library?${new URLSearchParams({ q: ui.q, category: ui.category })}`);
  ui.lib = items;
  const rows = $('#libRows');
  if (!rows) return;
  rows.innerHTML = items.length ? items.map(libRow).join('') : '<tr><td colspan="9" class="empty">No songs yet — add some from the catalogue, or let the station discover music.</td></tr>';
  $('#libCount').textContent = `${items.length} song${items.length === 1 ? '' : 's'}`;
}

function resultTrack(t) {
  return `<div class="result-row"><img src="${esc(t.artwork)}" alt="" loading="lazy">
    <div style="min-width:0"><b>${esc(t.title)}</b> ${t.explicit ? '<span class="badge e">E</span>' : ''}<div class="small muted">${esc(t.artist)} · ${fmtDur(t.duration)}</div></div>
    <div class="row nowrap"><button class="icon" data-action="preview" data-id="${t.id}">▶</button><button class="icon" data-action="addTrack" data-track='${esc(JSON.stringify(t))}'>＋</button></div></div>`;
}

// ------------------------------------------------------------------ charts
function chartsTab() {
  const C = state.B.charts || { available: [], station: [] };
  if (!ui.chart) ui.chart = C.station[0] || 'hot100';
  const st = C.status || {};
  const others = C.available.filter((c) => !C.station.includes(c.id));
  return `
    <div class="card">
      <div class="row wrap" style="margin-bottom:10px">
        <select id="chartId" style="max-width:260px">
          <optgroup label="Your format's charts">${C.station.map((id) => opt(id, C.available.find((c) => c.id === id)?.name || id, ui.chart)).join('')}</optgroup>
          <optgroup label="Other charts">${others.map((c) => opt(c.id, c.name, ui.chart)).join('')}</optgroup>
        </select>
        <input id="chartDate" type="date" value="${esc(ui.chartDate)}" title="A past week (Billboard Hot 100 history goes back to 1958)" style="max-width:170px;${ui.chart === 'hot100' ? '' : 'display:none'}">
        <button data-action="loadChart">Show</button>
        <span class="spacer"></span>
        <label style="margin:0">Add to</label><select id="chartCat" style="max-width:200px">${catOptions('B')}</select>
        <button class="primary" data-action="addChartSongs">Add selected</button>
      </div>
      <p class="hint" style="margin-top:0">Keyless chart data. Songs in your library show their chart position to the music director and the DJ${st.updatedAt ? ` (updated ${new Date(st.updatedAt).toLocaleString()}: ${st.onChart} of your songs are charting)` : ''}. ${state.B.settings.chartRotation !== false ? 'Chart rotation is on: in current formats, top-15 songs move to power rotation, other chart songs to current, and songs that drop off to recurrent.' : ''}
        <button class="link" data-action="refreshCharts">Refresh now</button>${st.moved?.length ? ` <details style="display:inline"><summary class="small">${st.moved.length} rotation move(s)</summary>${st.moved.map((m) => `<div class="small muted">${esc(m)}</div>`).join('')}</details>` : ''}</p>
      <div id="chartRows">${chartRowsHtml()}</div>
    </div>`;
}

function chartRowsHtml() {
  const c = ui.chartData;
  if (!c) return '<div class="empty"><span class="spin"></span></div>';
  if (!c.entries.length) return '<div class="empty muted">This chart is empty right now.</div>';
  const move = (e) => (e.lastWeek == null ? (e.weeks === 1 ? '<span class="badge new">new</span>' : '') : e.lastWeek > e.rank ? `<span class="up">▲${e.lastWeek - e.rank}</span>` : e.lastWeek < e.rank ? `<span class="down">▼${e.rank - e.lastWeek}</span>` : '<span class="muted">=</span>');
  return `<div class="small muted" style="margin-bottom:6px">${esc(c.name)}${c.date ? ` · week of ${esc(c.date)}` : ''} · <label class="nowrap" style="display:inline;margin:0"><input type="checkbox" id="chartAll"> select all missing</label></div>
    <div class="table-wrap"><table class="charttable"><thead><tr><th></th><th>#</th><th></th><th>Song</th><th class="hide-sm">Peak</th><th class="hide-sm">Wks</th><th>Library</th><th></th></tr></thead><tbody>
    ${c.entries.map((e, i) => `<tr>
      <td>${e.trackId ? '' : `<input type="checkbox" class="chartPick" data-i="${i}">`}</td>
      <td class="num"><b>${e.rank}</b></td><td class="small nowrap">${move(e)}</td>
      <td><b>${esc(e.title)}</b><div class="small muted">${esc(e.artist)}${e.year ? ` · ${e.year}` : ''}</div></td>
      <td class="num small hide-sm">${e.peak ?? ''}</td><td class="num small hide-sm">${e.weeks ?? ''}</td>
      <td>${e.trackId ? catChip(e.category) : '<span class="muted small">—</span>'}</td>
      <td><button class="icon" title="Song info" data-action="songInfo" data-artist="${esc(e.artist)}" data-title="${esc(e.title)}">ℹ</button></td></tr>`).join('')}
    </tbody></table></div>`;
}

async function loadChart() {
  ui.chartData = null;
  const rows = $('#chartRows');
  if (rows) rows.innerHTML = chartRowsHtml();
  try {
    ui.chartData = await api('GET', `/api/charts/${ui.chart}${ui.chart === 'hot100' && ui.chartDate ? `?date=${ui.chartDate}` : ''}`);
  } catch (e) { ui.chartData = { name: '', entries: [] }; toast(e.message, true); }
  if ($('#chartRows')) {
    $('#chartRows').innerHTML = chartRowsHtml();
    const all = $('#chartAll');
    if (all) all.onchange = () => $$('.chartPick').forEach((x) => { x.checked = all.checked; });
  }
}

/** Facts, chart run and the story of a song, looked up from open data. */
export async function openSongInfo(artist, title) {
  const el = modal(`<div class="row"><div><h1>${esc(title)}</h1><p class="sub" style="margin:0">${esc(artist)}</p></div><span class="spacer"></span><button data-role="close">✕</button></div><div id="siBody" style="margin-top:12px"><span class="spin"></span> Looking it up…</div>`);
  $('[data-role=close]', el).onclick = () => closeModal();
  try {
    const i = await api('GET', `/api/songinfo?${new URLSearchParams({ artist, title })}`);
    const f = i.facts || {};
    $('#siBody', el).innerHTML = `
      <div class="kv">
        <span>Year</span><span>${i.year || '—'}</span>
        <span>Genres</span><span>${esc((f.genres || []).join(', ') || '—')}</span>
        <span>Vocal</span><span>${esc(f.voice || '—')}</span>
        <span>Tempo</span><span>${f.bpm ? `${f.bpm} BPM (${esc(f.tempo)})` : '—'}</span>
        <span>Energy</span><span>${f.energy ? `${f.energy} / 5 (estimated)` : '—'}</span>
        <span>Popularity</span><span>${f.popularity != null ? `${f.popularity} / 100` : '—'}</span>
        <span>Charts</span><span>${i.chart ? `#${i.chart.rank} on ${esc(i.chart.chart)}${i.chart.weeks ? `, ${i.chart.weeks} weeks` : ''}` : i.chartPeak ? `peaked at #${i.chartPeak.peak} (${esc(i.chartPeak.chart)})` : 'not on your charts this week'}</span>
        <span>In library</span><span>${i.inLibrary ? 'yes' : 'no'}</span>
      </div>
      ${i.story ? `<h3 style="margin-top:14px">About the song</h3><p>${esc(i.story.extract)}</p><p class="small muted">From Wikipedia${i.story.url ? ` · <a href="${esc(i.story.url)}" target="_blank" rel="noopener">read more</a>` : ''}</p>` : '<p class="small muted" style="margin-top:12px">No encyclopedia entry found for this song.</p>'}
      <p class="small muted">Sources: ${esc((f.sources || []).join(', ') || 'none')}. The music director and DJ see these same facts, so even an AI that doesn't know the song programs it correctly.</p>`;
  } catch (e) { $('#siBody', el).innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

const TABBODY = {
  library: libraryTab,
  charts: chartsTab,
  search: () => `
    <div class="card">
      <div class="row" style="margin-bottom:12px">
        <input id="monoQ" placeholder="Search the catalogue: artist, song or album" style="max-width:420px">
        <button class="primary" data-action="monoSearch">Search</button>
        <span class="spacer"></span>
        <label style="margin:0">Add to</label><select id="addCat" style="max-width:220px">${catOptions('N')}</select>
      </div>
      ${state.B.settings.cleanOnly ? '<p class="hint" style="margin-top:-4px">Clean versions only: explicit picks are swapped for their clean radio edits automatically (or skipped when none exists).</p>' : ''}
      <div id="monoResults" class="grid cols-3">${ui.results || `<div class="muted">Search the ${state.B.settings.musicSource === 'monochrome' ? 'monochrome (TIDAL)' : 'arcod (Qobuz)'} catalogue to add songs, an artist's top tracks or a whole album.</div>`}</div>
    </div>`,
  discover: () => `
    <div class="card stack" style="max-width:760px">
      <p class="muted">Finds songs that fit your format: this week's chart hits (or Billboard hits from the category's era), suggestions from the AI, and songs by artists related to the ones you play. Every song is matched on monochrome before it's added. This also happens on its own when a category runs thin. Settings → AI chooses which of these to use.</p>
      <div class="grid cols-3">
        <div><label>Category</label><select id="discCat">${catOptions('N')}</select></div>
        <div><label>How many</label><input id="discCount" type="number" value="12" min="1" max="40"></div>
      </div>
      <div><label>Direction (optional)</label><input id="discGuide" placeholder="e.g. 90s alternative hits, female vocalists, songs for a summer weekend"></div>
      <div class="row"><button class="primary" data-action="discover">Discover music</button>${state.B.capabilities.claude ? '' : '<span class="small muted">No AI connected: charts and related artists only.</span>'}</div>
      <div id="discResults"></div>
    </div>`,
  rules: () => {
    const B = state.B;
    return `
    <div class="grid cols-2">
      <div class="card">
        <h2>Categories</h2>
        <div class="table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Color</th><th>Min rest (h)</th><th></th></tr></thead><tbody id="catRows">
        ${B.categories.map((c) => `<tr><td><input data-f="id" value="${esc(c.id)}" style="width:50px"></td><td><input data-f="name" value="${esc(c.name)}"></td><td><input data-f="color" type="color" value="${esc(c.color)}" style="width:44px;padding:2px"></td><td><input data-f="minRestHours" type="number" step="0.5" value="${c.minRestHours}" style="width:80px"></td><td><button class="icon danger" data-action="delRow">✕</button></td></tr>`).join('')}
        </tbody></table></div>
        <div class="row" style="margin-top:10px"><button data-action="addCat">+ Category</button><span class="spacer"></span><button class="primary" data-action="saveCats">Save categories</button></div>
      </div>
      <div class="card stack" id="rotForm">
        <h2>Rotation rules</h2>
        ${input('artistSeparationMin', 'Artist separation (minutes)', B.rotation.artistSeparationMin, 'number')}
        ${input('titleSeparationMin', 'Title separation (minutes)', B.rotation.titleSeparationMin, 'number')}
        ${input('maxSameArtistPerHour', 'Max plays per artist per hour', B.rotation.maxSameArtistPerHour, 'number')}
        <p class="hint">Claude picks the music, but every pick must pass these rules; otherwise the rotation engine substitutes the most-due eligible song.</p>
        <div><button class="primary" data-action="saveRotation">Save rules</button></div>
      </div>
    </div>`;
  },
};

export const library = {
  render: () => `
    <h1>Music library</h1>
    <p class="sub">${state.B.libraryCount} songs from ${state.B.settings.musicSource === 'monochrome' ? 'monochrome (TIDAL, lossless)' : `arcod (Qobuz, ${({ 5: 'MP3 320 kbps', 6: 'FLAC', 7: 'hi-res FLAC', 27: 'hi-res FLAC' })[state.B.settings.arcodQuality || 5] || 'MP3 320 kbps'})`}, fetched into the cache ahead of air. Intros, endings and tempo are analysed as songs play.</p>
    <div class="tabs">${TABS.map(([k, l]) => `<button class="${ui.tab === k ? 'active' : ''}" data-action="tab" data-tab="${k}">${l}</button>`).join('')}</div>
    <div id="libBody">${TABBODY[ui.tab]()}</div>`,
  mount() {
    const offs = [bus.on('cleanSweep', (p) => {
      const n = $('#sweepNote');
      if (n) n.textContent = p.running ? `checking ${p.checked || 0}… replaced ${p.replaced || 0}` : `done: ${p.replaced || 0} replaced, ${p.disabled || 0} without a clean version`;
      if (!p.running) { api('GET', '/api/bootstrap').then((b) => { state.B = b; if (ui.tab === 'library') loadLibrary(); }); }
    })];
    if (ui.tab === 'library') {
      loadLibrary();
      $('#libQ').oninput = (e) => { ui.q = e.target.value; clearTimeout(ui.t); ui.t = setTimeout(loadLibrary, 250); };
      $('#libCat').onchange = (e) => { ui.category = e.target.value; loadLibrary(); };
    }
    if (ui.tab === 'charts') {
      $('#chartId').onchange = (e) => { ui.chart = e.target.value; $('#chartDate').style.display = ui.chart === 'hot100' ? '' : 'none'; loadChart(); };
      if (!ui.chartData || ui.chartData.id !== ui.chart) loadChart(); else $('#chartRows').innerHTML = chartRowsHtml();
    }
    if (ui.tab === 'search') $('#monoQ').onkeydown = (e) => { if (e.key === 'Enter') library.actions.monoSearch($('[data-action=monoSearch]')); };
    return () => offs.forEach((f) => f());
  },
  changes: {
    trackCat: async (el) => {
      try { await api('PATCH', `/api/library/${el.closest('tr').dataset.id}`, { category: el.value }); toast('Category updated'); } catch (e) { toast(e.message, true); }
    },
  },
  actions: {
    tab: (b) => { ui.tab = b.dataset.tab; bus.emit('rerender'); },
    preview: (b) => play(`/api/monochrome/stream/${b.dataset.id}`),
    playNext: (b) => run(b, () => api('POST', '/api/log/insert', { trackId: b.dataset.id }), 'Song will play next'),
    toggleTrack: async (b) => { const t = ui.lib.find((x) => x.id === b.dataset.id); await api('PATCH', `/api/library/${t.id}`, { disabled: !t.disabled }); loadLibrary(); },
    delTrack: async (b) => { if (!confirm('Remove this song from the library?')) return; await api('DELETE', `/api/library/${b.dataset.id}`); state.B.libraryCount--; loadLibrary(); },
    cleanSweep: (b) => run(b, () => api('POST', '/api/library/clean'), 'Looking for clean radio edits…'),
    markers: (b) => openMarkerEditor(b.dataset.id),
    songInfo: (b) => openSongInfo(b.dataset.artist, b.dataset.title),
    loadChart: () => { ui.chartDate = $('#chartDate')?.value || ''; loadChart(); },
    refreshCharts: (b) => run(b, async () => { state.B.charts.status = await api('POST', '/api/charts/refresh'); bus.emit('rerender'); }, 'Chart positions updated'),
    addChartSongs: (b) => run(b, async () => {
      const picks = $$('.chartPick:checked').map((x) => ui.chartData.entries[Number(x.dataset.i)]);
      if (!picks.length) throw new Error('Tick the songs to add first');
      const r = await api('POST', '/api/charts/add', { category: $('#chartCat').value, songs: picks.map((e) => ({ artist: e.artist, title: e.title, note: `#${e.rank} on ${ui.chartData.short || ui.chartData.name}${ui.chartData.date ? ` (${ui.chartData.date})` : ''}` })) });
      added(r);
      if (r.missed?.length) toast(`Not found: ${r.missed.slice(0, 3).join('; ')}${r.missed.length > 3 ? '…' : ''}`, true);
      loadChart();
    }),
    monoSearch: (b) => run(b, async () => {
      const q = $('#monoQ').value.trim();
      if (!q) return;
      const r = await api('GET', `/api/monochrome/search?q=${encodeURIComponent(q)}`);
      ui.results = `
        <div><h3>Songs</h3>${r.tracks.slice(0, 20).map(resultTrack).join('') || '<div class="muted small">No songs</div>'}
          ${r.tracks.length ? `<button style="margin-top:8px" data-action="addAll" data-tracks='${esc(JSON.stringify(r.tracks.slice(0, 20)))}'>Add all songs</button>` : ''}</div>
        <div><h3>Albums</h3>${r.releases.slice(0, 12).map((a) => `<div class="result-row"><img src="${esc(a.artwork)}" alt="" loading="lazy"><div><b>${esc(a.title)}</b><div class="small muted">${esc(a.artist)} · ${a.year || ''} ${esc(a.type || '')}</div></div><div class="row nowrap"><button class="icon" data-action="openRelease" data-id="${a.id}" title="Show tracks">☰</button><button class="icon" data-action="importRelease" data-id="${a.id}" title="Import album">＋</button></div></div>`).join('') || '<div class="muted small">No albums</div>'}</div>
        <div><h3>Artists</h3>${r.artists.slice(0, 12).map((a) => `<div class="result-row"><img src="${esc(a.avatar)}" alt="" loading="lazy"><div><b>${esc(a.name)}</b></div><button data-action="importArtist" data-id="${a.id}" title="Import top tracks">＋ Top 10</button></div>`).join('') || '<div class="muted small">No artists</div>'}</div>`;
      $('#monoResults').innerHTML = ui.results;
    }),
    addTrack: (b) => run(b, async () => { const r = await api('POST', '/api/library', { track: JSON.parse(b.dataset.track), category: $('#addCat').value }); added(r); }),
    addAll: (b) => run(b, async () => added(await api('POST', '/api/library', { tracks: JSON.parse(b.dataset.tracks), category: $('#addCat').value }))),
    importArtist: (b) => run(b, async () => added(await api('POST', '/api/library/import', { kind: 'artist', id: b.dataset.id, category: $('#addCat').value, limit: 10 }))),
    importRelease: (b) => run(b, async () => added(await api('POST', '/api/library/import', { kind: 'release', id: b.dataset.id, category: $('#addCat').value, limit: 40 }))),
    openRelease: (b) => run(b, async () => {
      const r = await api('GET', `/api/monochrome/release/${b.dataset.id}`);
      b.closest('.result-row').insertAdjacentHTML('afterend', `<div style="padding-left:20px">${r.tracks.map(resultTrack).join('')}</div>`);
    }),
    discover: (b) => run(b, async () => {
      const r = await api('POST', '/api/library/discover', { category: $('#discCat').value, count: Number($('#discCount').value), guidance: $('#discGuide').value });
      state.B.libraryCount += r.added.length;
      const by = Object.entries(r.by || {}).filter(([, n]) => n).map(([k, n]) => `${n} from ${{ charts: 'charts', ai: 'the AI', catalog: 'related artists' }[k] || k}`).join(', ');
      $('#discResults').innerHTML = `<h3>Added ${r.added.length}${by ? ` <span class="small muted">(${by})</span>` : ''}</h3>${r.added.map((t) => `<div class="small">✅ ${esc(t.artist)} — ${esc(t.title)} <span class="muted">${esc(t.note || '')}</span></div>`).join('')}
        ${r.missed?.length ? `<h3 style="margin-top:10px">Not found in the catalogue</h3>${r.missed.map((m) => `<div class="small muted">✗ ${esc(m)}</div>`).join('')}` : ''}`;
    }),
    addCat: () => $('#catRows').insertAdjacentHTML('beforeend', '<tr><td><input data-f="id" style="width:50px"></td><td><input data-f="name"></td><td><input data-f="color" type="color" value="#64748b" style="width:44px;padding:2px"></td><td><input data-f="minRestHours" type="number" step="0.5" value="6" style="width:80px"></td><td><button class="icon danger" data-action="delRow">✕</button></td></tr>'),
    saveCats: () => save('categories', rowsToObjects('#catRows').filter((c) => c.id).map(({ id, name, color, minRestHours }) => ({ id: id.toUpperCase(), name, color, minRestHours }))),
    saveRotation: () => save('rotation', collect($('#rotForm'))),
  },
};

function added(r) {
  const n = r.added?.length || 0;
  state.B.libraryCount += n;
  const bits = [`Added ${n} song${n === 1 ? '' : 's'}`];
  if (r.swapped) bits.push(`${r.swapped} swapped for clean versions`);
  if (r.skipped?.length) bits.push(`${r.skipped.length} skipped (explicit only)`);
  toast(bits.join(' · '));
}

// ------------------------------------------------------------------ marker editor

async function openMarkerEditor(id) {
  let d;
  try { d = await api('GET', `/api/library/${id}/detail`); } catch (e) { toast(e.message, true); return; }
  const el = modal(`
    <div class="row"><div><h1>${esc(d.title)}</h1><p class="sub" style="margin:0">${esc(d.artist)}</p></div><span class="spacer"></span><button data-role="close">✕</button></div>
    <canvas class="editor-wave" id="mkWave" style="margin-top:12px"></canvas>
    <div class="row" style="margin-top:10px">
      <span class="small muted">Click the waveform to set</span>
      <div class="seg" id="mkMode"><button class="on" data-m="intro">Vocals in</button><button data-m="outro">Vocals out</button><button data-m="mixOut">Mix out</button></div>
      <span class="spacer"></span>
      <button id="mkPlay">▶ Play from cursor</button><span class="num small" id="mkPos">0:00.0</span>
    </div>
    <div class="grid cols-4" style="margin-top:12px" id="mkForm"></div>
    <div class="small muted" id="mkDetected" style="margin-top:8px"></div>
    <div class="row" style="margin-top:14px">
      <button id="mkAnalyze">🔬 Analyze now</button><button id="mkReset">Use detected values</button>
      <span class="spacer"></span><button class="primary" id="mkSave">Save markers</button>
    </div>`, { cls: 'wide' });
  let mode = 'intro'; let cursor = 0;
  const a = $('#preview');
  const decode = (b64) => { if (!b64) return null; const bin = atob(b64); const u = new Int8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = (bin.charCodeAt(i) << 24) >> 24; return u; };
  let peaks = { res: d.peakRes, data: decode(d.peaks) };
  const detected = () => ({
    intro: d.lyrics?.status === 'found' ? d.lyrics.vocalStart : null,
    outro: d.lyrics?.status === 'found' ? d.lyrics.vocalEnd : null,
    mixOut: d.analysis?.mixOut ?? null,
    endType: d.analysis?.endType || '',
  });
  const cur = { ...detected(), ...d.markers };
  const form = () => {
    $('#mkForm', el).innerHTML = `
      ${input('intro', 'Vocals in (s)', cur.intro != null ? Number(cur.intro).toFixed(2) : '', 'number', 'step="0.05"')}
      ${input('outro', 'Vocals out (s)', cur.outro != null ? Number(cur.outro).toFixed(2) : '', 'number', 'step="0.05"')}
      ${input('mixOut', 'Mix out (s)', cur.mixOut != null ? Number(cur.mixOut).toFixed(2) : '', 'number', 'step="0.05"')}
      <div><label>Ending</label><select data-k="endType">${opt('', 'Auto-detect', cur.endType)}${opt('cold', 'Cold (stops)', cur.endType)}${opt('fade', 'Fade out', cur.endType)}</select></div>
      <label class="row nowrap" style="color:var(--text);margin:0"><input type="checkbox" data-k="instrumental" ${cur.instrumental ? 'checked' : ''}> Instrumental (DJ may talk anywhere)</label>`;
    const det = detected();
    $('#mkDetected', el).innerHTML = `Detected: vocals in <b>${det.intro != null ? det.intro.toFixed(1) + 's' : '—'}</b>, out <b>${det.outro != null ? det.outro.toFixed(1) + 's' : '—'}</b> (${esc(d.lyrics?.status || 'not checked')}${d.lyrics?.status === 'found' ? ', synced lyrics' : ''}) · mix out <b>${det.mixOut != null ? det.mixOut.toFixed(1) + 's' : '—'}</b> · ${esc(det.endType || 'ending unknown')}${d.analysis?.headTempo?.bpm ? ` · ${Math.round(d.analysis.headTempo.bpm)} BPM` : ''}${d.analysis?.loudness ? ` · ${d.analysis.loudness} LUFS` : ''}`;
  };
  const sync = () => { Object.assign(cur, collect($('#mkForm', el))); for (const k of ['intro', 'outro', 'mixOut']) if (cur[k] === null || Number.isNaN(cur[k])) cur[k] = null; };
  form();
  $('#mkForm', el).addEventListener('input', sync);
  $('#mkMode', el).onclick = (e) => { const m = e.target.dataset.m; if (!m) return; mode = m; $$('#mkMode button', el).forEach((x) => x.classList.toggle('on', x.dataset.m === m)); };
  const canvas = $('#mkWave', el);
  canvas.onclick = (e) => {
    const r = canvas.getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * (d.duration || 1);
    cursor = t;
    if (!a.paused) a.currentTime = t;
    cur[mode] = Math.round(t * 20) / 20;
    form();
  };
  $('#mkPlay', el).onclick = () => {
    if (!a.paused && a.dataset.src === `mk:${id}`) { a.pause(); return; }
    a.dataset.src = `mk:${id}`;
    if (!a.src.includes(`/api/monochrome/stream/${id}`)) a.src = `/api/monochrome/stream/${id}`;
    const go = () => { a.currentTime = cursor; a.play().catch((err) => toast(err.message, true)); };
    if (a.readyState >= 1) go(); else a.addEventListener('loadedmetadata', go, { once: true });
  };
  $('#mkAnalyze', el).onclick = (e) => run(e.currentTarget, async () => {
    d = await api('POST', `/api/library/${id}/analyze`);
    peaks = { res: d.peakRes, data: decode(d.peaks) };
    Object.assign(cur, detected(), d.markers);
    form();
  }, 'Analysis updated');
  $('#mkReset', el).onclick = () => { Object.assign(cur, detected(), { instrumental: false }); form(); };
  $('#mkSave', el).onclick = (e) => run(e.currentTarget, async () => {
    sync();
    await api('PUT', `/api/library/${id}/markers`, cur);
    closeModal();
    if (ui.tab === 'library') loadLibrary();
  }, 'Markers saved');
  $('[data-role=close]', el).onclick = () => closeModal();
  let raf = 0;
  const loop = () => {
    if (!el.isConnected) { cancelAnimationFrame(raf); if (a.dataset.src === `mk:${id}`) a.pause(); return; }
    const playing = !a.paused && a.dataset.src === `mk:${id}`;
    const pos = playing ? a.currentTime : cursor;
    $('#mkPos', el).textContent = `${Math.floor(pos / 60)}:${(pos % 60).toFixed(1).padStart(4, '0')}`;
    $('#mkPlay', el).textContent = playing ? '■ Stop' : '▶ Play from cursor';
    drawWaveform(canvas, { peaks, length: d.duration || 1, position: pos, markers: { intro: cur.instrumental ? null : cur.intro, outro: cur.instrumental ? null : cur.outro, mixOut: cur.mixOut, endType: cur.endType }, kind: 'music' });
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
}
