// Engineering: the broadcast processor (presets, live controls, bypass), loudness and true-peak
// metering, spectrum, goniometer, gain reduction per stage, and the streaming decks.

import { $, $$, esc, state, api, toast, bus, subscribe } from './core.js';
import { drawSpectrum, drawGonio, drawHistory, drawPPM } from './widgets.js';

const CTL = [
  ['loudness.targetLufs', 'Loudness target', -20, -8, 0.5, 'LUFS'],
  ['inputGainDb', 'Input gain', -12, 12, 0.5, 'dB'],
  ['agc.targetDb', 'AGC target', -28, -12, 0.5, 'dB'],
  ['agc.maxGainDb', 'AGC max gain', 0, 18, 0.5, 'dB'],
  ['agc.speed', 'AGC speed', 0.3, 3, 0.1, '×'],
  ['stereo.width', 'Stereo width', 0.6, 1.6, 0.01, '×'],
  ['stereo.bassMonoHz', 'Bass mono below', 0, 250, 5, 'Hz'],
  ['eq.bassDb', 'Bass', -6, 8, 0.5, 'dB'],
  ['eq.warmthDb', 'Warmth · 300 Hz', -6, 6, 0.5, 'dB'],
  ['eq.presenceDb', 'Presence · 3.2 kHz', -6, 6, 0.5, 'dB'],
  ['eq.airDb', 'Air · 11 kHz', -6, 8, 0.5, 'dB'],
  ['multiband.drive', 'Multiband drive', 0, 10, 0.5, 'dB'],
  ['clipper.driveDb', 'Clipper drive', 0, 6, 0.5, 'dB'],
  ['limiter.ceilingDb', 'Ceiling', -3, -0.1, 0.1, 'dBTP'],
  ['limiter.releaseMs', 'Limiter release', 20, 300, 5, 'ms'],
  ['outputGainDb', 'Output gain', -12, 6, 0.5, 'dB'],
];
const BANDS = ['Sub · <110', 'Low · 110-420', 'Mid · 420-2k', 'Pres · 2-6.2k', 'Air · >6.2k'];
const get = (o, path) => path.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
const setPath = (o, path, v) => { const ks = path.split('.'); let x = o; while (ks.length > 1) { const k = ks.shift(); x = x[k] ||= {}; } x[ks[0]] = v; return o; };
const hist = [];
let lastHist = 0;
let raf = 0;
let timer = null;

function controls() {
  const p = state.B.processing.params;
  const ov = state.B.processing.overrides || {};
  return CTL.map(([k, label, min, max, step, unit]) => {
    const v = get(p, k);
    const changed = get(ov, k) !== undefined;
    return `<div class="ctl ${changed ? 'changed' : ''}"><label><span>${label}</span><span class="num" data-v="${k}">${Number(v).toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0)} ${unit}</span></label>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-ctl="${k}"></div>`;
  }).join('');
}

export function render() {
  const P = state.B.processing;
  return `
  <div class="row"><div><h1>Engineering</h1><p class="sub">Broadcast chain: AGC → stereo → EQ → 5-band compressor → clipper → true-peak limiter, metered to ITU-R BS.1770.</p></div>
    <span class="spacer"></span>
    <button class="${P.overrides?.bypass ? 'onair' : ''}" data-action="bypass" id="bypassBtn">${P.overrides?.bypass ? 'BYPASSED' : 'Bypass'}</button></div>
  <div class="readouts" style="margin-bottom:14px">
    <div class="readout"><label>Momentary</label><div class="v" id="rM">--</div></div>
    <div class="readout"><label>Short-term</label><div class="v" id="rS">--</div></div>
    <div class="readout"><label>Integrated <span id="rTarget"></span></label><div class="v" id="rI">--</div></div>
    <div class="readout"><label>True peak</label><div class="v" id="rTP">--</div></div>
    <div class="readout"><label>Input short-term</label><div class="v" id="rIn">--</div></div>
    <div class="readout"><label>AGC</label><div class="v" id="rAgc">--</div></div>
    <div class="readout"><label>Phase correlation</label><div class="v" id="rCorr">--</div></div>
    <div class="readout"><label>Limiter</label><div class="v" id="rLim">--</div></div>
  </div>
  <div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(0,1fr) auto">
    <div class="card"><h2>Spectrum · ⅓ octave</h2><canvas class="spectrum" id="spec"></canvas>
      <h2 style="margin-top:12px">Loudness · last 2 minutes <span class="muted" style="text-transform:none;letter-spacing:0">(target −14 LUFS)</span></h2><canvas class="lufs-hist" id="lhist"></canvas></div>
    <div class="card"><h2>Goniometer</h2><canvas class="gonio" id="gonio"></canvas>
      <h2 style="margin-top:12px">Gain reduction</h2>
      <div class="stack" style="--gap:6px">
        <div class="grrow"><span>AGC</span><div class="grbar agc"><i id="eAgc"></i></div><span class="num" id="eAgcV">--</span></div>
        ${BANDS.map((n, i) => `<div class="grrow"><span title="${n}">${n.split(' · ')[0]}</span><div class="grbar"><i id="eB${i}"></i></div><span class="num" id="eBV${i}">--</span></div>`).join('')}
        <div class="grrow"><span>Limit</span><div class="grbar"><i id="eLim"></i></div><span class="num" id="eLimV">--</span></div>
      </div></div>
    <div class="card"><h2>Out</h2><canvas class="ppm" id="eppm" style="height:330px"></canvas></div>
  </div>
  <div class="card" style="margin-top:14px">
    <div class="row" style="margin-bottom:10px"><h2 style="margin:0">Processing preset</h2><span class="spacer"></span><button data-action="resetPreset">Reset to preset</button></div>
    <div class="presets">${Object.entries(P.presets).map(([id, p]) => `<button class="preset ${P.preset === id ? 'on' : ''}" data-action="preset" data-id="${id}"><b>${esc(p.name)}</b><span>${esc(p.description)}</span></button>`).join('')}</div>
    <div class="knobs" id="knobs" style="margin-top:14px">${controls()}</div>
    <p class="hint">Changes apply live to the air chain. Highlighted controls differ from the preset.</p>
  </div>
  <div class="grid cols-2" style="margin-top:14px">
    <div class="card"><h2>Decks · streaming buffers</h2><div id="decks"></div><p class="hint">Songs decode just ahead of air, from the cache or straight from a fetch that's still arriving.</p><div id="fetcher"></div></div>
    <div class="card"><h2>Air chain status</h2><div id="chain" class="kv"></div></div>
  </div>`;
}

function frame() {
  const m = state.meters;
  if (m && $('#spec')) {
    const f = (v, u = '') => (v > -69 ? `${v.toFixed(1)}${u}` : '--');
    $('#rM').textContent = f(m.out.m); $('#rS').textContent = f(m.out.s); $('#rTP').textContent = f(m.out.tp, ' dB');
    $('#rIn').textContent = f(m.in.s); $('#rAgc').textContent = `${m.agc > 0 ? '+' : ''}${m.agc.toFixed(1)} dB${m.gated ? ' ⏸' : ''}`;
    $('#rCorr').textContent = m.corr.toFixed(2); $('#rCorr').style.color = m.corr < 0 ? 'var(--red)' : m.corr < 0.3 ? 'var(--yellow)' : '';
    $('#rLim').textContent = `${m.limiter.toFixed(1)} dB`;
    $('#rTarget').textContent = `· target ${m.target} · trim ${m.trim > 0 ? '+' : ''}${(m.trim ?? 0).toFixed(1)}`;
    const li = state.S.processing?.loudness?.outI;
    $('#rI').textContent = li > -69 ? li.toFixed(1) : '--';
    $('#rTP').style.color = m.out.tp > -1 ? 'var(--red)' : '';
    drawSpectrum($('#spec'), m.spectrum);
    drawGonio($('#gonio'), m.gonio);
    const now = performance.now();
    if (now - lastHist > 500) { lastHist = now; hist.push(m.out.s > -69 ? m.out.s : -40); if (hist.length > 240) hist.shift(); }
    drawHistory($('#lhist'), hist, -14);
    const agc = Math.max(-12, Math.min(12, m.agc));
    const ga = $('#eAgc'); ga.style.width = `${(Math.abs(agc) / 24) * 100}%`; ga.style.left = agc >= 0 ? '50%' : `${50 - (Math.abs(agc) / 24) * 100}%`;
    $('#eAgcV').textContent = `${agc > 0 ? '+' : ''}${agc.toFixed(1)}`;
    m.bands.forEach((g, i) => { $(`#eB${i}`).style.width = `${Math.min(100, (g / 15) * 100)}%`; $(`#eBV${i}`).textContent = g.toFixed(1); });
    $('#eLim').style.width = `${Math.min(100, (m.limiter / 10) * 100)}%`; $('#eLimV').textContent = m.limiter.toFixed(1);
  }
  if ($('#eppm')) drawPPM($('#eppm'), state.level.l || 0, state.level.r || 0);
  raf = requestAnimationFrame(frame);
}

function decks() {
  const el = $('#decks');
  if (!el) return;
  const d = state.S.decks || [];
  el.innerHTML = d.length ? d.map((x) => `<div class="deckrow"><div style="min-width:0"><b class="small">${x.playing ? '▶ ' : ''}${esc(x.title || x.label || '')}</b><div class="small muted">${esc(x.source)} · ${x.mb}${x.totalMb ? `/${x.totalMb}` : ''} MB · ${x.memMb} MB in memory${x.retries ? ` · ${x.retries} resumes` : ''}${x.underrun ? ' · <b style="color:var(--red)">UNDERRUN</b>' : ''}</div></div>
    <div class="bufbar" title="Decoded ahead of the play head"><i style="width:${Math.min(100, (x.aheadSec / 75) * 100)}%;background:${x.aheadSec < 5 && !x.ended ? 'var(--red)' : 'var(--green)'}"></i></div>
    <span class="num small">${x.ended ? 'all' : `${x.aheadSec.toFixed(0)}s`} ahead</span><span class="num small muted">${x.decodedSec.toFixed(0)}s</span></div>`).join('') : '<div class="muted small">No songs loaded. Decks appear here when the station is on air.</div>';
  const fx = state.S.fetcher;
  const fe = $('#fetcher');
  if (fe && fx) {
    const kb = (n) => `${Math.round(n / 1024)} KB/s`;
    fe.innerHTML = `<div class="small" style="margin-top:8px"><b>Fetching songs</b> · ${fx.connections}/${fx.limit} connections (max ${fx.max}) · ${kb(fx.rate)}${fx.throttled ? ` · origin refused ${fx.throttled}×, eased off` : ''}</div>
      ${fx.songs.slice(0, 8).map((f) => { const t = state.LOG.flatMap((l) => l.items).find((i) => String(i.trackId) === f.key); const pct = f.total ? Math.round((100 * f.received) / f.total) : 0; return `<div class="deckrow"><div style="min-width:0" class="small">${esc(t ? `${t.artist} - ${t.title}` : `track ${f.key}`)}<div class="muted">${f.total ? `${(f.received / 1048576).toFixed(1)}/${(f.total / 1048576).toFixed(1)} MB` : 'starting'}${f.rate ? ` · ${kb(f.rate)}` : ''}${f.eta != null && f.total ? ` · ~${Math.ceil(f.eta / 60)} min left` : ''}</div></div><div class="bufbar"><i style="width:${pct}%"></i></div><span class="num small">${pct}%</span><span class="num small muted">#${f.priority}</span></div>`; }).join('') || '<div class="small muted">All upcoming songs are in the cache.</div>'}`;
  }
  const S = state.S; const B = state.B;
  const ab = B.settings.autoBed || {};
  $('#chain').innerHTML = `
    <span>Engine</span><span>${S.running ? (S.deadAir ? '<b style="color:var(--yellow)">dead air protection</b>' : '<b style="color:var(--green)">on air</b>') : 'off air'}</span>
    <span>Processing</span><span>${esc(B.processing.presets[B.processing.preset]?.name || B.processing.preset)}${B.processing.overrides?.bypass ? ' · <b style="color:var(--red)">bypassed</b>' : ''}</span>
    <span>Loudness</span><span>target ${B.processing.params?.loudness?.targetLufs ?? -14} LUFS · peaks ≤ ${B.processing.params?.limiter?.ceilingDb ?? -1} dBTP · auto-trim ${B.processing.params?.loudness?.autoTrim === false ? 'off' : 'on'}</span>
    <span>Auto-bed</span><span>${ab.enabled === false ? 'off' : S.bed?.on ? `<b style="color:var(--green)">up</b> · ${esc(S.bed.name)}` : `ready · ${esc(S.bed?.name || 'loads on air')}`} (${ab.levelDb ?? -12} dB)</span>
    <span>Transitions</span><span>duck ${B.settings.duckDb} dB · vocals ${B.settings.postGap}s after talk · ${B.settings.beatMatch ? 'beat-matched' : 'free'} segues</span>
    <span>Stream</span><span>${B.stream.bitrate} kbps MP3 · ${S.listeners || 0} listening${S.icecast ? ` · Icecast ${esc(S.icecast)}` : ''}</span>
    ${S.lastError ? `<span>Last error</span><span style="color:var(--red)">${esc(S.lastError)}</span>` : ''}`;
}

async function apply(body) {
  try {
    state.B.processing = await api('PUT', '/api/processing', body);
  } catch (e) { toast(e.message, true); }
}

export function mount() {
  subscribe(['meters']);
  raf = requestAnimationFrame(frame);
  decks();
  timer = setInterval(decks, 1000);
  const knobs = $('#knobs');
  knobs.addEventListener('input', (e) => {
    const k = e.target.dataset.ctl; if (!k) return;
    const c = CTL.find((x) => x[0] === k);
    $(`[data-v="${k}"]`).textContent = `${Number(e.target.value).toFixed(c[4] < 0.1 ? 2 : c[4] < 1 ? 1 : 0)} ${c[5]}`;
  });
  knobs.addEventListener('change', async (e) => {
    const k = e.target.dataset.ctl; if (!k) return;
    const overrides = setPath(structuredClone(state.B.processing.overrides || {}), k, Number(e.target.value));
    await apply({ preset: state.B.processing.preset, overrides });
    e.target.closest('.ctl').classList.add('changed');
  });
  return () => { cancelAnimationFrame(raf); clearInterval(timer); subscribe([]); };
}

export const actions = {
  preset: async (b) => { await apply({ preset: b.dataset.id }); $$('.preset').forEach((x) => x.classList.toggle('on', x.dataset.id === b.dataset.id)); $('#knobs').innerHTML = controls(); toast(`Preset: ${state.B.processing.presets[b.dataset.id].name}`); },
  resetPreset: async () => { await apply({ preset: state.B.processing.preset, overrides: {} }); $('#knobs').innerHTML = controls(); toast('Back to the preset'); },
  bypass: async (b) => {
    const on = !state.B.processing.overrides?.bypass;
    if (on && !confirm('Bypass the processor? The air chain will run unprocessed (limiter still protects peaks).')) return;
    await apply({ bypass: on });
    b.classList.toggle('onair', on); b.textContent = on ? 'BYPASSED' : 'Bypass';
  },
};

bus.on('state', () => {});
