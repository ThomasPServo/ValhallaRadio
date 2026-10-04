// First-run setup: station identity, format, market, AI & voice, then the station builds itself.

import { $, $$, esc, state, api, toast, bus, modal, closeModal } from './core.js';

const w = { step: 0, name: '', slogan: '', callSign: '', frequency: '', formatId: 'hotac', locations: '', units: 'imperial', cleanOnly: true, startOnAir: true, building: false, progress: null };
const STEPS = ['Your station', 'Format', 'Market', 'AI & voice', 'Launch'];

export function maybeWizard() {
  if (!state.B.station.setupComplete) openWizard();
}

export function openWizard() {
  const st = state.B.station;
  if (st.setupComplete) {
    Object.assign(w, { name: st.name, slogan: st.slogan, callSign: st.callSign, frequency: st.frequency, formatId: st.formatId || w.formatId, units: st.units, cleanOnly: state.B.settings.cleanOnly !== false, locations: st.market.locations.map((l) => l.name).join('\n'), startOnAir: false });
  }
  w.step = 0;
  draw();
}

function body() {
  const B = state.B;
  const ai = B.capabilities.ai || {};
  const k = B.capabilities.voice?.kokoro || {};
  switch (w.step) {
    case 0: return `
      <h1>Let's put your station on the air</h1>
      <p class="sub">Valhalla is the automation system; the station is yours. Everything here can be changed later.</p>
      <div class="grid cols-2">
        <div><label>Station name *</label><input id="wName" value="${esc(w.name)}" placeholder="Mix 101.9" autofocus></div>
        <div><label>Slogan</label><input id="wSlogan" value="${esc(w.slogan)}" placeholder="Today's best mix"></div>
        <div><label>Call letters (for legal IDs)</label><input id="wCall" value="${esc(w.callSign)}" placeholder="KMXV — leave blank for internet radio"></div>
        <div><label>Frequency / dial position</label><input id="wFreq" value="${esc(w.frequency)}" placeholder="101.9 FM"></div>
      </div>`;
    case 1: return `
      <h1>Pick a format</h1>
      <p class="sub">Sets music categories, hour clocks, dayparts, DJs, imaging, music beds and the processing sound. Claude fine-tunes everything to your market.</p>
      <div class="formats">${B.formats.map((f) => `<button class="format ${w.formatId === f.id ? 'on' : ''}" data-f="${f.id}"><b>${esc(f.name)}</b><span class="small muted">${esc(f.description)}</span></button>`).join('')}</div>`;
    case 2: return `
      <h1>Where are you on the air?</h1>
      <p class="sub">Add your city, several cities, or whole counties. Local weather, traffic and news come from these (no API keys), and the station clock follows the first one.</p>
      <div><label>Cities or counties, one per line</label><textarea id="wLocs" rows="4" placeholder="Austin, Texas&#10;Williamson County, Texas">${esc(w.locations)}</textarea></div>
      <div class="grid cols-2" style="margin-top:10px">
        <div><label>Units</label><select id="wUnits"><option value="imperial" ${w.units === 'imperial' ? 'selected' : ''}>Imperial (°F, mph)</option><option value="metric" ${w.units === 'metric' ? 'selected' : ''}>Metric (°C, km/h)</option></select></div>
        <label class="row nowrap" style="color:var(--text);align-self:end;margin:0"><input type="checkbox" id="wClean" ${w.cleanOnly ? 'checked' : ''}> Clean versions only (radio edits, recommended)</label>
      </div>`;
    case 3: return `
      <h1>AI &amp; voice</h1>
      <p class="sub">An AI programs the music and writes the DJ — Claude, ChatGPT or a local model in LM Studio — and a voice engine performs it. Neither needs an API key.</p>
      <div class="stack">
        <div class="caprow"><span class="dot ${ai.provider ? 'ok' : 'bad'}"></span><b>${ai.provider ? `${esc(ai.label)} is connected (${esc(ai.model || '')}) — it runs the station` : 'No AI is connected yet'}</b></div>
        ${ai.provider ? '' : '<div class="small muted">Any one of these works: sign in to <b>Claude Code</b> (<code>claude</code>) or <b>Codex</b> with your ChatGPT account (<code>codex login</code>), or start an <b>LM Studio</b> server with a model loaded. API keys work too (Settings). Without AI the station still runs, using rotation rules and template copy.</div>'}
        <div class="caprow"><span class="dot ${k.installed ? 'ok' : k.installing ? 'warn' : 'bad'}"></span><b>${k.installed ? 'Local voice installed' : k.installing ? 'Installing the local voice…' : 'Local voice not installed'}</b></div>
        ${k.installed ? '' : `<div class="small muted">A free neural voice (Kokoro) that runs on this machine — about 300 MB, one time.</div><div><button class="primary" id="wKokoro" ${k.installing ? 'disabled' : ''}>Install local voice</button> <span class="small muted" id="wKokoroLog"></span></div>`}
      </div>`;
    default: {
      const f = B.formats.find((x) => x.id === w.formatId);
      if (w.building || w.progress) return progressHtml();
      return `
        <h1>Ready to launch</h1>
        <div class="kv" style="margin:12px 0 16px">
          <span>Station</span><span><b>${esc(w.name)}</b>${w.slogan ? ` — ${esc(w.slogan)}` : ''}</span>
          <span>On air as</span><span>${esc([w.callSign, w.frequency].filter(Boolean).join(' · ') || 'internet radio')}</span>
          <span>Format</span><span>${esc(f?.name || '')}</span>
          <span>Market</span><span>${esc(w.locations.split('\n').filter(Boolean).join(' · ') || '—')}</span>
          <span>Clean versions only</span><span>${w.cleanOnly ? 'yes' : 'no'}</span>
        </div>
        <p class="small muted">Valhalla now builds a starter library of ${f?.seedCount ? `around ${f.seedCount * 4}` : 'about a hundred'} songs for the format${state.B.capabilities.claude ? ', asks Claude for fresh picks,' : ''} renders your imaging and music bed, and prepares the first hour.</p>
        <label class="row nowrap" style="color:var(--text);margin:0"><input type="checkbox" id="wGo" ${w.startOnAir ? 'checked' : ''}> Go on air automatically when the library is ready</label>`;
    }
  }
}

function progressHtml() {
  const p = w.progress || { completed: 0, total: 1, added: 0, phase: 'starting' };
  const pct = p.done ? 100 : Math.round((p.completed / Math.max(1, p.total)) * (p.phase === 'discovering' ? 100 : 90));
  return `
    <h1>${p.done ? 'Your station is ready' : 'Building your station…'}</h1>
    <div class="progress" style="margin:16px 0"><div style="width:${pct}%"></div></div>
    <div class="kv">
      <span>Songs added</span><span class="num"><b>${p.added || 0}</b></span>
      <span>Artists</span><span class="num">${p.completed || 0} / ${p.total || 0}</span>
      <span>Now</span><span>${esc(p.phase === 'discovering' ? 'Claude is picking fresh music for your format' : p.done ? 'done' : p.last || 'searching the catalogue')}</span>
    </div>
    ${(p.errors || []).length ? `<details style="margin-top:8px"><summary class="small">${p.errors.length} note(s)</summary>${p.errors.slice(0, 12).map((e) => `<div class="small muted">${esc(e)}</div>`).join('')}</details>` : ''}
    ${p.done ? `<p class="sub" style="margin-top:12px">${w.startOnAir ? 'The station is going on air — head to the studio to watch it run.' : 'Press “Go on air” in the studio when you are ready.'}</p>` : ''}`;
}

function draw() {
  const last = w.step === STEPS.length - 1;
  const el = modal(`
    <div class="steps">${STEPS.map((_, i) => `<i class="${i <= w.step ? 'on' : ''}"></i>`).join('')}</div>
    <div class="small muted" style="margin-bottom:6px">Step ${w.step + 1} of ${STEPS.length} · ${STEPS[w.step]}</div>
    <div id="wBody">${body()}</div>
    <div class="row" style="margin-top:18px">
      ${w.step && !w.building && !w.progress ? '<button id="wBack">← Back</button>' : ''}
      ${state.B.station.setupComplete && !w.building ? '<button id="wCancel">Close</button>' : ''}
      <span class="spacer"></span>
      ${w.progress?.done ? '<button class="primary big" id="wDone">Open the studio</button>' : w.building || w.progress ? '' : `<button class="primary big" id="wNext">${last ? '🚀 Build my station' : 'Continue →'}</button>`}
    </div>`, { cls: 'wizard' });
  $('#wBack', el)?.addEventListener('click', () => { read(); w.step--; draw(); });
  $('#wCancel', el)?.addEventListener('click', () => closeModal());
  $('#wDone', el)?.addEventListener('click', () => { closeModal(); w.progress = null; location.hash = '#studio'; bus.emit('rerender'); });
  $('#wNext', el)?.addEventListener('click', next);
  $$('.format', el).forEach((b) => b.addEventListener('click', () => { w.formatId = b.dataset.f; $$('.format', el).forEach((x) => x.classList.toggle('on', x === b)); }));
  $('#wKokoro', el)?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await api('POST', '/api/voice/kokoro/install'); state.B.capabilities.voice.kokoro.installing = true; } catch (err) { toast(err.message, true); }
  });
  $('#wName', el)?.focus();
}

function read() {
  const v = (id) => $(`#${id}`)?.value;
  if (w.step === 0) Object.assign(w, { name: v('wName').trim(), slogan: v('wSlogan').trim(), callSign: v('wCall').trim().toUpperCase(), frequency: v('wFreq').trim() });
  if (w.step === 2) Object.assign(w, { locations: v('wLocs'), units: v('wUnits'), cleanOnly: $('#wClean').checked });
  if (w.step === STEPS.length - 1 && $('#wGo')) w.startOnAir = $('#wGo').checked;
}

async function next() {
  read();
  if (w.step === 0 && !w.name) return toast('Your station needs a name', true);
  if (w.step < STEPS.length - 1) { w.step++; draw(); return; }
  w.building = true;
  w.progress = { completed: 0, total: 1, added: 0, phase: 'starting' };
  draw();
  try {
    state.B = await api('POST', '/api/setup', {
      station: { name: w.name, slogan: w.slogan, callSign: w.callSign, frequency: w.frequency, units: w.units },
      formatId: w.formatId,
      locations: w.locations.split('\n').map((x) => x.trim()).filter(Boolean),
      cleanOnly: w.cleanOnly,
      startOnAir: w.startOnAir,
    });
    bus.emit('bootstrap', state.B);
  } catch (e) {
    w.building = false; w.progress = null;
    toast(e.message, true);
    draw();
  }
}

bus.on('setup', (p) => {
  if (!w.building) return;
  w.progress = p;
  if (p.done) {
    w.building = false;
    api('GET', '/api/bootstrap').then((b) => { state.B = b; bus.emit('bootstrap', b); });
  }
  const b = $('#wBody');
  if (b) { if (p.done) draw(); else b.innerHTML = progressHtml(); }
});
bus.on('voiceInstall', (m) => {
  const log = $('#wKokoroLog');
  if (log && m.line) log.textContent = m.line.slice(0, 80);
  if (m.done) api('GET', '/api/bootstrap').then((b) => { state.B = b; if (w.step === 3 && $('#wBody')) $('#wBody').innerHTML = body(); });
});
