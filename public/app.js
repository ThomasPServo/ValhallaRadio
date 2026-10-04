// Valhalla Studio — router, top bar and live status. Views are ES modules in /js (no build step).

import { $, $$, esc, state, api, toast, bus, connect, stationParts } from './js/core.js';
import { drawBarMeter } from './js/widgets.js';
import * as studio from './js/studio.js';
import * as engineering from './js/engineering.js';
import { log, library } from './js/music.js';
import { clocks, djs } from './js/programming.js';
import { imaging, spots } from './js/imaging.js';
import { station, streaming, ai, settings } from './js/station.js';
import { maybeWizard, openWizard } from './js/wizard.js';

const VIEWS = { studio, log, library, clocks, engineering, programming: djs, imaging, commercials: spots, station, streaming, ai, settings };
let current = 'studio';
let unmount = null;

async function boot() {
  state.B = await api('GET', '/api/bootstrap');
  state.LOG = await api('GET', '/api/log').catch(() => []);
  brand();
  connect();
  window.addEventListener('hashchange', route);
  $('#moreBtn').onclick = () => setNav(!document.body.classList.contains('navopen'));
  $('#navScrim').onclick = () => setNav(false);
  $('#nav').addEventListener('click', (e) => { if (e.target.closest('a')?.dataset.view === current) setNav(false); });
  route();
  requestAnimationFrame(chrome);
  setInterval(pills, 1000);
  maybeWizard();
}

/** The station's own name, logo and colors everywhere ("Valhalla" is only the software). */
export function brand() {
  const st = state.B.station;
  $('#stName').textContent = st.name || 'My Station';
  $('#stSub').textContent = [st.callSign, st.frequency].filter(Boolean).join(' · ') || (st.slogan || 'POWERED BY VALHALLA');
  const mark = $('#stationMark');
  mark.innerHTML = st.logo ? `<img src="/station-logo?v=${encodeURIComponent(st.logo)}" alt="">` : esc((st.name || 'V').trim()[0] || 'V');
  document.title = `${st.name || 'Valhalla'} — Studio`;
}

/** Phones: the full navigation opens as a sheet above the tab bar. */
function setNav(open) {
  document.body.classList.toggle('navopen', open);
  $('#moreBtn').setAttribute('aria-expanded', String(open));
}

function route() {
  const next = (location.hash || '#studio').slice(1);
  current = VIEWS[next] ? next : 'studio';
  $$('#nav a, #tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.view === current));
  $('#moreBtn').classList.toggle('active', !$(`#tabbar a[data-view="${current}"]`));
  setNav(false);
  render();
  window.scrollTo(0, 0);
}

export function render() {
  unmount?.();
  unmount = null;
  const v = VIEWS[current];
  $('#view').innerHTML = v.render();
  unmount = v.mount?.() || null;
}

// ------------------------------------------------------------------ top bar
let lastSec = -1;
function chrome() {
  const S = state.S;
  const now = new Date();
  const p = stationParts(now);
  if (p.s !== lastSec) {
    lastSec = p.s;
    $('#clock').textContent = `${String(p.h).padStart(2, '0')}:${String(p.m).padStart(2, '0')}:${String(p.s).padStart(2, '0')}`;
    const left = 3600 - (p.m * 60 + p.s);
    $('#toh').textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    $('#toh').parentElement.classList.toggle('soon', left <= 60);
    const zones = state.B?.marketZones || [];
    $('#zone').textContent = zones[0]?.label || '';
    $('#zone').title = zones.length > 1 ? zones.map((z) => `${z.label}: ${z.places.join(', ')}`).join('\n') : state.B?.station?.timezone || '';
    const tally = $('#tally');
    const dead = S.running && S.deadAir;
    tally.textContent = !S.running ? 'Off air' : dead ? 'Dead air' : 'On air';
    tally.className = `tally ${S.running ? (dead ? 'warn' : 'live') : ''}`;
  }
  drawBarMeter($('#topMeter'), state.level.l || 0, state.level.r || 0);
  if (!S.running) state.level = { l: state.level.l * 0.9, r: state.level.r * 0.9 };
  requestAnimationFrame(chrome);
}

function pills() {
  const B = state.B; const S = state.S;
  if (!B) return;
  const c = B.capabilities;
  const ai = c.ai || {};
  const set = (id, cls, title) => { const el = $(`#${id} .dot`); el.className = `dot ${cls}`; $(`#${id}`).title = title; };
  set('pillAi', ai.provider ? 'ok' : 'bad', ai.provider ? `AI: ${ai.label} · ${ai.model || ''}${ai.chain?.length > 1 ? ` (fallback: ${ai.chain.slice(1).join(', ')})` : ''}` : 'No AI connected — Settings → AI');
  $('#pillAi b').textContent = ai.label || 'AI off';
  const v = c.voice || {};
  set('pillVoice', c.tts ? 'ok' : v.kokoro?.installing ? 'warn' : 'bad', c.tts ? `Voice: ${v.provider}` : 'No voice engine — Settings → Voice');
  $('#pillVoice b').textContent = c.tts ? ({ kokoro: 'Local voice', elevenlabs: 'ElevenLabs', openai: 'OpenAI voice' }[v.provider] || v.provider) : 'No voice';
  set('pillStream', S.running ? 'ok' : '', S.icecast ? `Icecast: ${S.icecast}` : 'Built-in stream');
  $('#listeners').textContent = S.listeners || 0;
  set('pillBed', S.bed?.on ? 'ok' : S.bed?.ready ? '' : 'warn', S.bed?.on ? `Auto-bed on: ${S.bed.name}` : S.bed?.ready ? `Auto-bed ready: ${S.bed.name}` : 'Auto-bed loads when the station goes on air');
}

// ------------------------------------------------------------------ live updates
bus.on('bootstrap', (b) => { if (b) state.B = b; brand(); });
bus.on('rerender', () => render());
bus.on('state', () => { if (current !== 'studio' && current !== 'engineering') return; });
bus.on('setup', (p) => { if (p?.done && current === 'library') render(); });
bus.on('connected', () => { api('GET', '/api/bootstrap').then((b) => { state.B = b; brand(); pills(); }).catch(() => {}); });

// ------------------------------------------------------------------ actions
/** Actions shared by every view (rows, uploads, previews). */
const COMMON = {
  delRow: (b) => b.closest('tr')?.remove(),
  wizard: () => openWizard(),
  go: (b) => { location.hash = b.dataset.to; },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'SELECT' || el.tagName === 'INPUT') return;
  const fn = VIEWS[current]?.actions?.[el.dataset.action] || COMMON[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  const fn = VIEWS[current]?.changes?.[el.dataset.change];
  if (fn) fn(el, e);
});

window.addEventListener('error', (e) => toast(`UI error: ${e.message}`, true));
boot().catch((e) => { document.body.innerHTML = `<pre style="padding:20px;color:#fca5a5">Failed to load the studio: ${esc(e.message)}</pre>`; });
