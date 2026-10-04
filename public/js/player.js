// The preview player: anything previewed in the studio (songs, imaging, spots, beds, voice tests)
// plays here, with its whole waveform as a scrub bar. Click or drag to jump; arrow keys skip 5 s,
// space plays/pauses while the bar has focus.

import { $, bus, api, toast } from './core.js';
import { drawWaveform } from './widgets.js';

const audio = new Audio();
audio.preload = 'auto';
audio.id = 'playerAudio';
document.body.append(audio); // hidden (no controls): the bar is the UI
const ui = { src: '', title: '', peaks: null, len: 0, dragging: false, raf: 0 };

function bar() {
  let el = $('#playerBar');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'playerBar';
  el.className = 'playerbar';
  el.tabIndex = 0;
  el.innerHTML = `
    <button class="icon" data-p="toggle" title="Play / pause">⏸</button>
    <div class="pmeta"><b data-p="title"></b><span class="num small muted" data-p="time">0:00 / 0:00</span></div>
    <canvas class="pwave" data-p="wave" title="Click or drag to scrub"></canvas>
    <button class="icon" data-p="close" title="Close">✕</button>`;
  document.body.append(el);
  $('[data-p=toggle]', el).onclick = () => (audio.paused ? audio.play().catch((e) => toast(e.message, true)) : audio.pause());
  $('[data-p=close]', el).onclick = close;
  const wave = $('[data-p=wave]', el);
  const seekTo = (e) => {
    const r = wave.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    const len = length();
    if (len) audio.currentTime = Math.max(0, Math.min(len - 0.05, (x / r.width) * len));
    paint();
  };
  wave.addEventListener('pointerdown', (e) => { ui.dragging = true; wave.setPointerCapture(e.pointerId); seekTo(e); });
  wave.addEventListener('pointermove', (e) => { if (ui.dragging) seekTo(e); });
  wave.addEventListener('pointerup', () => { ui.dragging = false; });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { audio.currentTime = Math.min(length() || Infinity, audio.currentTime + 5); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { audio.currentTime = Math.max(0, audio.currentTime - 5); e.preventDefault(); }
    if (e.key === ' ') { $('[data-p=toggle]', el).click(); e.preventDefault(); }
    if (e.key === 'Escape') close();
  });
  return el;
}

const length = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : ui.len);
const fmt = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;

function paint() {
  const el = $('#playerBar');
  if (!el) return;
  const len = length();
  $('[data-p=toggle]', el).textContent = audio.paused ? '▶' : '⏸';
  $('[data-p=time]', el).textContent = `${fmt(audio.currentTime)} / ${len ? fmt(len) : '…'}`;
  drawWaveform($('[data-p=wave]', el), {
    peaks: ui.peaks || { res: 0.05, data: new Int8Array(0) }, length: len || 1, position: audio.currentTime,
    kind: /\/stream\//.test(ui.src) ? 'music' : 'imaging',
  });
}

function loop() {
  paint();
  ui.raf = audio.paused && !ui.dragging ? 0 : requestAnimationFrame(loop);
}
for (const ev of ['play', 'pause', 'loadedmetadata', 'durationchange', 'seeked', 'progress', 'ended']) {
  audio.addEventListener(ev, () => { if (!ui.raf) ui.raf = requestAnimationFrame(loop); });
}
audio.addEventListener('error', () => { if (ui.src) toast('This audio could not be played', true); });

function close() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  ui.src = '';
  $('#playerBar')?.remove();
  document.body.classList.remove('playing-preview');
}

bus.on('preview', async ({ src, title }) => {
  const el = bar();
  document.body.classList.add('playing-preview');
  if (ui.src === src) { // same file: toggle
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
    return;
  }
  ui.src = src; ui.title = title; ui.peaks = null; ui.len = 0;
  $('[data-p=title]', el).textContent = title || decodeURIComponent(src.split('/').pop().split('?')[0]).replace(/\.[a-z0-9]+$/i, '');
  audio.src = src;
  audio.play().catch((e) => { if (e.name !== 'AbortError') toast(e.message, true); });
  paint();
  try {
    const w = await api('GET', `/api/waveform?src=${encodeURIComponent(src)}`);
    if (ui.src !== src) return;
    const bin = atob(w.data); const arr = new Int8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = (bin.charCodeAt(i) << 24) >> 24;
    ui.peaks = { res: w.res, data: arr };
    ui.len = (arr.length / 2) * w.res;
    paint();
  } catch { /* no waveform: the bar still plays and scrubs by time */ }
});

