// Studio: the on-air console. Deck with countdowns and waveform, segue timeline, back-timed log,
// hour clock, carts, live read and program meters — all animated from the live engine state.

import { $, $$, esc, fmtDur, fmtTenths, state, api, run, toast, bus, subscribe, sinceState, sinceTimeline, stationParts, stationTime, KIND, ICON, TYPE_LABEL, catChip, q, setText, setHtml, setStyle } from './core.js';
import { drawWaveform, drawTimeline, drawHourClock, drawPPM } from './widgets.js';

let raf = 0;
const BAND_NAMES = ['Sub', 'Low', 'Mid', 'Pres', 'Air'];

export function render() {
  const B = state.B;
  return `
  <div class="grid" style="grid-template-columns:minmax(0,1fr) 300px">
    <div class="card">
      <div class="deck">
        <div class="art" id="npArt">📻</div>
        <div style="min-width:0">
          <div class="meta" id="npMeta"></div>
          <div class="title" id="npTitle">—</div>
          <div class="artist" id="npArtist"></div>
        </div>
        <div class="timers">
          <div class="timer intro" id="tIntro"><label>To vocals</label><div class="v">--</div></div>
          <div class="timer remain" id="tRemain"><label>Remaining</label><div class="v">--:--.-</div></div>
        </div>
      </div>
      <canvas class="waveform" id="wave"></canvas>
      <div class="nextline" id="nextLine"></div>
      <div class="script" id="npScript" style="display:none"></div>
      <div class="row" style="margin-top:12px">
        <button class="onair big" id="goBtn" data-action="start">● Go on air</button>
        <button class="big" id="stopBtn" data-action="stop" style="display:none">■ Off air</button>
        <button class="big" data-action="skip" title="Fade the current element and take the next one">⏭ Take next</button>
        <button class="big" id="monBtn" data-action="monitor">🎧 Monitor</button>
        <input type="range" min="0" max="1" step="0.01" id="vol" style="width:100px" title="Monitor volume">
        <span class="spacer"></span>
        <span class="small muted" id="engineNote"></span>
      </div>
    </div>
    <div class="card">
      <h2>Program out</h2>
      <div class="out-meters">
        <canvas class="ppm" id="ppm"></canvas>
        <div class="stack">
          <div><div class="lufs-big num" id="lufsS">--<small> LUFS</small></div><div class="small muted">short-term · int <span id="lufsI" class="num">--</span> · TP <span id="tp" class="num">--</span></div></div>
          <div class="grrow"><span>AGC</span><div class="grbar agc"><i id="grAgc"></i></div><span class="num" id="grAgcV">--</span></div>
          ${BAND_NAMES.map((n, i) => `<div class="grrow"><span>${n}</span><div class="grbar"><i id="gr${i}"></i></div><span class="num" id="grV${i}">--</span></div>`).join('')}
          <div class="grrow"><span>Limit</span><div class="grbar"><i id="grLim"></i></div><span class="num" id="grLimV">--</span></div>
          <div class="small muted" id="procName">${esc(B.processing.presets[B.processing.preset]?.name || '')}${B.processing.overrides?.bypass ? ' · BYPASS' : ''}</div>
        </div>
      </div>
    </div>
    <div class="card" style="grid-column:1 / -1">
      <div class="row" style="margin-bottom:8px"><h2 style="margin:0">Segue timeline</h2><span class="spacer"></span>
        <span class="small muted">white line = level automation · <b style="color:var(--blue)">▍</b>vocals in · <b style="color:var(--purple)">▍</b>vocals out</span></div>
      <canvas class="timeline" id="timeline"></canvas>
    </div>
    <div class="card log" style="padding:10px 6px">
      <div class="row" style="padding:0 8px 6px"><h2 style="margin:0">On-air log</h2><span class="spacer"></span><span class="small muted">drag to reorder</span><a href="#log" class="small">Full log →</a></div>
      <div id="queue"></div>
    </div>
    <div class="stack">
      <div class="card"><h2>Hour</h2><canvas class="hourclock" id="hourclock"></canvas></div>
      <div class="card">
        <h2>Hot carts</h2>
        <div class="carts">${B.imaging.items.filter((i) => i.enabled).slice(0, 12).map((i) => `<button class="cart ${i.type}" data-action="fireCart" data-id="${i.id}">${esc(i.name)}</button>`).join('') || '<div class="muted small">No imaging yet.</div>'}</div>
        <h2 style="margin-top:14px">Insert next</h2>
        <div class="row">
          <button data-action="insertType" data-type="dj">🎙️ Break</button>
          <button data-action="insertType" data-type="weather">🌦 Weather</button>
          <button data-action="insertType" data-type="traffic">🚗 Traffic</button>
          <button data-action="insertType" data-type="news">📰 News</button>
        </div>
        <h2 style="margin-top:14px">Live read</h2>
        <textarea id="sayText" rows="3" placeholder="Type something for the DJ to say next, in their voice…"></textarea>
        <div class="row" style="margin-top:8px"><button data-action="say">Queue live read</button></div>
      </div>
    </div>
  </div>`;
}

export function mount() {
  subscribe(['meters', 'timeline']);
  lastMeters = null;
  const mon = $('#monitor');
  $('#vol').value = mon.volume;
  $('#vol').oninput = (e) => { mon.volume = Number(e.target.value); };
  $('#monBtn').textContent = mon.paused ? '🎧 Monitor' : '🔇 Stop monitor';
  renderQueue();
  updateStatic();
  const offs = [bus.on('log', renderQueue), bus.on('state', () => { updateStatic(); renderQueue(); }), bus.on('nowPlaying', updateStatic)];
  // 30 frames a second: readings arrive 12-20 times a second and the timeline moves ~13 px/s, so it looks
  // the same as 60 and costs the browser half as much
  let drawn = 0;
  const loop = (t) => { if (t - drawn >= 30) { drawn = t; frame(); } raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);
  setupDrag();
  return () => { cancelAnimationFrame(raf); offs.forEach((f) => f()); subscribe([]); };
}

function updateStatic() {
  const S = state.S; const n = S.now;
  $('#goBtn').style.display = S.running ? 'none' : '';
  $('#stopBtn').style.display = S.running ? '' : 'none';
  $('#npTitle').textContent = n ? n.title || TYPE_LABEL[n.type] : S.running ? 'Preparing…' : 'Off air';
  $('#npArtist').textContent = n ? n.artist || '' : S.running ? 'Lining up the first elements' : 'Press “Go on air” to start automation';
  const art = $('#npArt');
  art.style.backgroundImage = n?.artwork ? `url("${n.artwork}")` : '';
  art.textContent = n?.artwork ? '' : ICON[KIND[n?.type]] || '📻';
  const mk = n?.markers || {};
  $('#npMeta').innerHTML = n ? [
    `<span class="badge ${KIND[n.type]}">${esc(TYPE_LABEL[n.type] || n.type)}</span>`, catChip(n.category),
    n.year ? `<span class="badge">${n.year}</span>` : '',
    mk.bpm ? `<span class="badge">${Math.round(mk.bpm)} BPM</span>` : '',
    mk.endType ? `<span class="badge ${mk.endType}">${mk.endType.toUpperCase()} END</span>` : '',
    mk.vocalSource === 'lyrics' ? '<span class="badge" title="Vocal timing from synced lyrics">♪ timed</span>' : mk.vocalSource === 'manual' ? '<span class="badge">♪ marked</span>' : n.type === 'music' ? '<span class="badge" title="No vocal timing: the DJ will not talk over this song">♪ untimed</span>' : '',
    n.transition ? `<span class="badge" title="${esc((n.transition.notes || []).join(' · '))}">↪ ${esc(n.transition.type)}</span>` : '',
  ].join('') : '';
  const sc = $('#npScript');
  sc.style.display = n?.script ? '' : 'none';
  sc.textContent = n?.script ? `“${n.script}”` : '';
  $('#engineNote').textContent = S.lastError ? `⚠ ${S.lastError}` : '';
}

let lastMeters = null; let segs = []; let segsKey = '';
function frame() {
  const S = state.S; const n = S.now;
  const pos = n ? Math.min(n.length, n.position + sinceState()) : 0;
  // deck timers
  const tR = q('#tRemain'); const tI = q('#tIntro');
  if (!tR) return;
  if (n) {
    const remain = Math.max(0, n.length - pos);
    setText(q('#tRemain .v'), fmtTenths(remain));
    tR.classList.toggle('warn', remain <= 30 && remain > 10);
    tR.classList.toggle('end', remain <= 10);
    const intro = n.markers?.intro;
    if (n.type === 'music' && intro != null) {
      const left = intro - pos;
      tI.classList.toggle('vocal', left <= 0);
      setText(q('#tIntro .v'), left > 0 ? fmtTenths(left).slice(1) : 'VOCALS');
    } else setText(q('#tIntro .v'), n.type === 'music' ? '—' : (n.markers?.voiceEnd ? fmtTenths(Math.max(0, n.markers.voiceEnd - pos)).slice(1) : '—'));
    setText(q('#tIntro label'), n.type === 'music' ? 'To vocals' : 'Talk left');
  } else { setText(q('#tRemain .v'), '--:--.-'); setText(q('#tIntro .v'), '--'); }
  // waveform
  const nextIn = S.next ? S.next.in - sinceState() : null;
  drawWaveform(q('#wave'), { peaks: n && state.peaks.get(n.id), length: n?.length || 1, position: pos, markers: n?.type === 'music' ? n.markers : null, nextAt: nextIn != null ? pos + nextIn : null, kind: KIND[n?.type] || 'music' });
  // next line
  const nl = q('#nextLine');
  if (S.next) {
    const notes = S.next.transition?.notes?.[0] || '';
    setHtml(nl, `<span class="badge ${KIND[S.next.type]}">NEXT</span> <b>${esc(S.next.title || TYPE_LABEL[S.next.type])}</b> ${S.next.artist ? `· ${esc(S.next.artist)}` : ''} <span class="num">in ${fmtDur(Math.max(0, nextIn))}</span> ${notes ? `<span class="small" style="color:var(--accent)">↪ ${esc(notes)}</span>` : ''}`);
  } else setHtml(nl, S.running ? '<span class="muted">Planning the next transition…</span>' : '');
  // segue timeline
  drawTimeline(q('#timeline'), state.TL.items || [], sinceTimeline(), (id) => state.peaks.get(id));
  // hour clock (its elements are worked out once a second)
  const p = stationParts();
  const key = `${p.h}:${p.m}:${p.s}`;
  if (key !== segsKey || segs.log !== state.LOG) { segsKey = key; segs = hourSegments(p); segs.log = state.LOG; }
  drawHourClock(q('#hourclock'), { segments: segs, m: p.m, s: p.s + (Date.now() % 1000) / 1000 });
  // meters: the PPM moves every frame; the numbers change when new readings arrive (20 a second)
  drawPPM(q('#ppm'), state.level.l || 0, state.level.r || 0);
  const m = state.meters;
  if (m && m !== lastMeters) {
    lastMeters = m;
    setHtml(q('#lufsS'), `${m.out.s > -69 ? m.out.s.toFixed(1) : '--'}<small> LUFS</small>`);
    setText(q('#tp'), `${m.out.tp > -69 ? m.out.tp.toFixed(1) : '--'} dB`);
    const agc = Math.max(-12, Math.min(12, m.agc));
    setStyle(q('#grAgc'), 'transform', `scaleX(${(agc / 12).toFixed(3)})`); // from the centre, either way
    setText(q('#grAgcV'), `${agc > 0 ? '+' : ''}${agc.toFixed(1)}`);
    m.bands.forEach((g, i) => { setStyle(q(`#gr${i}`), 'transform', `scaleX(${Math.min(1, g / 15).toFixed(3)})`); setText(q(`#grV${i}`), g.toFixed(1)); });
    setStyle(q('#grLim'), 'transform', `scaleX(${Math.min(1, m.limiter / 10).toFixed(3)})`);
    setText(q('#grLimV'), m.limiter.toFixed(1));
  }
  if (S.processing) setText(q('#lufsI'), S.processing.loudness?.outI > -69 ? S.processing.loudness.outI.toFixed(1) : '--');
}

/** Elements of the current hour as clock segments (seconds into the hour). */
function hourSegments(p) {
  const hourNow = p.h;
  const l = state.LOG.find((x) => Number(x.hourKey.slice(-2)) === hourNow) || state.LOG[0];
  if (!l) return [];
  const segs = [];
  const nowInHour = p.m * 60 + p.s;
  let cursor = null;
  for (const it of l.items) {
    if (['dropped', 'skipped', 'failed', 'missed'].includes(it.status)) continue;
    let from;
    if (it.airedAt) { const q = stationParts(new Date(it.airedAt)); from = q.m * 60 + q.s; if (q.h !== hourNow) continue; }
    else from = cursor ?? Math.max(nowInHour, it.estOffset || 0);
    const len = it.duration || 30;
    segs.push({ from, to: from + len, kind: KIND[it.type] });
    cursor = from + len - (it.type === 'music' ? 3 : 0.3);
  }
  return segs;
}

// ------------------------------------------------------------------ back-timed log
function upcoming() {
  return state.LOG.flatMap((l) => l.items.map((i) => ({ ...i, startMs: l.startMs }))).filter((i) => ['playing', 'cued', 'ready', 'preparing', 'scheduled'].includes(i.status));
}

function itemMarkers(i) {
  const m = i.markers || {};
  if (i.type !== 'music') return '';
  const bits = [];
  if (m.intro != null) bits.push(`<b>${Math.round(m.intro)}s</b> intro`);
  else bits.push('<span title="No vocal timing yet">— intro</span>');
  if (m.endType) bits.push(m.endType === 'cold' ? 'C' : 'F');
  if (m.bpm) bits.push(`${Math.round(m.bpm)}`);
  return `<span class="mk">${bits.join(' · ')}</span>`;
}

export function itemRow(i, time, { actions = true, draggable = true } = {}) {
  const kind = KIND[i.type];
  const thumb = i.artwork ? `<div class="thumb" style="background-image:url('${esc(i.artwork)}')"></div>` : `<div class="thumb">${ICON[kind] || '•'}</div>`;
  const pending = ['ready', 'preparing', 'scheduled', 'cued'].includes(i.status);
  return `<div class="item ${i.status}" data-id="${i.id}" ${pending && draggable ? 'draggable="true"' : ''}>
    <div class="time">${time || ''}</div>
    ${thumb}
    <div style="min-width:0">
      <div class="t">${catChip(i.category)} ${esc(i.title || TYPE_LABEL[i.type] || i.type)}</div>
      <div class="a"><span class="badge ${kind}">${esc(TYPE_LABEL[i.type] || i.type)}</span> ${esc(i.artist || '')} · <span class="num">${fmtDur(i.duration)}</span> ${itemMarkers(i)}
        ${i.transition ? `<span class="small" style="color:var(--accent)">↪ ${esc(i.transition.notes?.[0] || i.transition.type)}</span>` : ''}
        ${i.why && i.type === 'music' && !i.transition ? `<span class="why">— ${esc(i.why)}</span>` : ''}</div>
      ${i.script ? `<details><summary class="small">script</summary><div class="script">${esc(i.script)}</div></details>` : ''}
      ${i.error ? `<div class="small" style="color:var(--red)">${esc(i.error)}</div>` : ''}
    </div>
    <div class="row nowrap"><span class="status ${i.status}">${i.status}</span>
      ${actions && pending ? `<button class="icon" title="Move up" data-action="move" data-id="${i.id}" data-dir="-1">↑</button><button class="icon" title="Move down" data-action="move" data-id="${i.id}" data-dir="1">↓</button><button class="icon danger" title="Remove" data-action="removeItem" data-id="${i.id}">✕</button>` : ''}
    </div>
  </div>`;
}

function renderQueue() {
  const q = $('#queue');
  if (!q) return;
  const items = upcoming().slice(0, 12);
  if (!items.length) { q.innerHTML = '<div class="empty">No log yet. Go on air and the log builds itself.</div>'; return; }
  // back-time: playing item's air time, then cumulative estimates
  let cursor = Date.now();
  const S = state.S;
  if (S.now) cursor = Date.now() + Math.max(0, (S.now.length - S.now.position - sinceState())) * 1000;
  q.innerHTML = items.map((i) => {
    let t;
    if (i.status === 'playing') t = i.airedAt;
    else if (i.transition?.at) { t = i.transition.at; cursor = t; }
    else t = cursor;
    if (i.status !== 'playing') cursor = t + Math.max(1, (i.duration || 30) - (i.type === 'music' ? 3 : 0.2)) * 1000;
    return itemRow(i, t ? stationTime(t) : '');
  }).join('');
}

function setupDrag() {
  const q = $('#queue');
  let dragId = null;
  q.addEventListener('dragstart', (e) => { const row = e.target.closest('.item'); dragId = row?.dataset.id; e.dataTransfer.effectAllowed = 'move'; });
  q.addEventListener('dragover', (e) => { const row = e.target.closest('.item'); if (!row || !dragId) return; e.preventDefault(); $$('.item.dragover', q).forEach((x) => x.classList.remove('dragover')); row.classList.add('dragover'); });
  q.addEventListener('dragleave', (e) => e.target.closest('.item')?.classList.remove('dragover'));
  q.addEventListener('drop', async (e) => {
    e.preventDefault();
    const row = e.target.closest('.item');
    $$('.item.dragover', q).forEach((x) => x.classList.remove('dragover'));
    if (!row || !dragId || row.dataset.id === dragId) return;
    await api('POST', `/api/log/${dragId}/moveTo`, { beforeId: row.dataset.id }).catch((err) => toast(err.message, true));
    dragId = null;
  });
}

export const actions = {
  start: (b) => run(b, () => api('POST', '/api/engine/start'), 'Station is on air'),
  stop: (b) => { if (confirm('Take the station off air?')) run(b, () => api('POST', '/api/engine/stop')); },
  skip: () => api('POST', '/api/engine/skip').catch((e) => toast(e.message, true)),
  monitor: (b) => {
    const m = $('#monitor');
    if (m.paused) { m.src = `/stream.mp3?t=${Date.now()}`; m.play().catch((e) => toast(e.message, true)); b.textContent = '🔇 Stop monitor'; }
    else { m.pause(); m.removeAttribute('src'); m.load(); b.textContent = '🎧 Monitor'; }
  },
  fireCart: (b) => { b.classList.remove('firing'); void b.offsetWidth; b.classList.add('firing'); run(null, () => api('POST', `/api/carts/${b.dataset.id}/fire`)); },
  insertType: (b) => run(b, () => api('POST', '/api/log/insert', { type: b.dataset.type }), `${TYPE_LABEL[b.dataset.type]} queued next`),
  say: (b) => {
    const t = $('#sayText').value.trim();
    if (!t) return;
    run(b, () => api('POST', '/api/log/insert', { script: t }), 'Live read queued next').then(() => { $('#sayText').value = ''; });
  },
  move: (b) => api('POST', `/api/log/${b.dataset.id}/move`, { dir: Number(b.dataset.dir) }),
  removeItem: (b) => api('POST', `/api/log/${b.dataset.id}/remove`),
};
