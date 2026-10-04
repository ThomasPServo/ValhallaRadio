// Canvas widgets for the studio: waveform, segue timeline, hour clock, meters, spectrum, goniometer.

import { KIND_COLOR } from './core.js';

/** Size a canvas for the device pixel ratio; returns a 2D context in CSS pixels. */
export function fit(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth; const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

const fmt = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const dbOf = (v) => 20 * Math.log10(Math.max(v, 1e-6));

/** Peak amplitude (0..1) of the peaks array over [t0, t1) seconds, or -1 if not decoded yet. */
function peakAt(p, t0, t1) {
  if (!p?.data?.length) return -1;
  const i0 = Math.floor(t0 / p.res); const i1 = Math.max(i0 + 1, Math.floor(t1 / p.res));
  if (i0 * 2 >= p.data.length) return -1;
  let m = 0;
  for (let i = i0; i < i1 && i * 2 + 1 < p.data.length; i++) m = Math.max(m, Math.abs(p.data[i * 2]), Math.abs(p.data[i * 2 + 1]));
  return m / 127;
}

function marker(ctx, x, h, color, label, top = true) {
  ctx.strokeStyle = color; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  if (!label) return;
  ctx.font = '700 9px Inter, system-ui, sans-serif';
  const tw = ctx.measureText(label).width + 8;
  ctx.fillStyle = color;
  const y = top ? 2 : h - 14;
  ctx.fillRect(x + 1, y, tw, 12);
  ctx.fillStyle = '#05070b';
  ctx.fillText(label, x + 5, y + 9);
}

/**
 * Full-song waveform with intro/outro/mix markers, played region and the planned next start.
 * @param {{peaks, length, position, markers, nextAt, kind}} o
 */
export function drawWaveform(canvas, o) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  const len = Math.max(1, o.length || 1);
  const x = (t) => (t / len) * w;
  const mid = h / 2;
  const m = o.markers || {};
  const color = KIND_COLOR[o.kind] || KIND_COLOR.music;
  // talk windows: instrumental intro (before vocals) and vocal-free outro
  if (m.intro != null && m.intro > 0) { ctx.fillStyle = 'rgba(62,166,255,.10)'; ctx.fillRect(0, 0, x(m.intro), h); }
  if (m.outro != null && m.outro < len) { ctx.fillStyle = 'rgba(177,140,255,.10)'; ctx.fillRect(x(m.outro), 0, w - x(m.outro), h); }
  for (let px = 0; px < w; px += 2) {
    const t0 = (px / w) * len; const t1 = ((px + 2) / w) * len;
    const v = peakAt(o.peaks, t0, t1);
    const played = t0 < o.position;
    if (v < 0) { ctx.fillStyle = 'rgba(120,130,150,.18)'; ctx.fillRect(px, mid - 0.5, 1.5, 1); continue; }
    const bh = Math.max(1, Math.pow(v, 0.8) * (h * 0.46));
    ctx.fillStyle = played ? 'rgba(130,140,160,.38)' : color;
    ctx.fillRect(px, mid - bh, 1.5, bh * 2);
  }
  if (m.intro != null && m.intro > 0) marker(ctx, x(m.intro), h, '#3ea6ff', `VOCALS ${fmt(m.intro)}`);
  if (m.outro != null && m.outro < len - 0.5) marker(ctx, x(m.outro), h, '#b18cff', 'VOCALS END');
  if (m.mixOut != null) marker(ctx, x(m.mixOut), h, '#ffb020', m.endType === 'cold' ? 'COLD' : 'MIX', false);
  if (o.nextAt != null && o.nextAt > 0) {
    ctx.setLineDash([4, 3]); marker(ctx, x(o.nextAt), h, '#22d36b', 'NEXT', false); ctx.setLineDash([]);
  }
  // playhead
  const px = x(o.position || 0);
  ctx.shadowColor = 'rgba(255,255,255,.8)'; ctx.shadowBlur = 8;
  ctx.fillStyle = '#fff'; ctx.fillRect(px - 1, 0, 2, h);
  ctx.shadowBlur = 0;
  ctx.font = '10px "JetBrains Mono", ui-monospace, monospace'; ctx.fillStyle = 'rgba(200,205,220,.6)';
  ctx.fillText('0:00', 4, h - 4);
  const end = fmt(len); ctx.fillText(end, w - ctx.measureText(end).width - 4, h - 4);
}

/**
 * Multitrack segue timeline: what is playing and what's planned, with overlaps and gain automation.
 * Items carry `start` (s, relative to the timeline snapshot) and `len`.
 */
export function drawTimeline(canvas, items, dt, getPeaks, { before = 12, span = 92 } = {}) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  const X = (t) => ((t + before) / span) * w;
  const lanes = { musicA: [8, 52], musicB: [62, 106], other: [116, 142] };
  // grid every 10 s
  ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
  for (let t = -10; t < span - before; t += 10) {
    const gx = X(t);
    ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fillRect(gx, 0, 1, h);
    if (t) { ctx.fillStyle = 'rgba(160,170,190,.45)'; ctx.fillText(`${t > 0 ? '+' : ''}${t}s`, gx + 3, h - 3); }
  }
  ctx.fillStyle = 'rgba(160,170,190,.5)';
  ctx.fillText('MUSIC A', 4, 18); ctx.fillText('MUSIC B', 4, 72); ctx.fillText('VOICE / FX / SPOTS', 4, 128);
  let deck = 0;
  const assigned = new Map();
  const sorted = [...items].sort((a, b) => a.start - b.start);
  for (const it of sorted) {
    if (it.kind === 'music' && !it.overlay) { assigned.set(it.id, deck ? 'musicB' : 'musicA'); deck ^= 1; } else assigned.set(it.id, 'other');
  }
  for (const it of sorted) {
    const s = it.start - dt; const e = s + it.len;
    if (e < -before || s > span - before) continue;
    const [y0, y1] = lanes[assigned.get(it.id)];
    const x0 = Math.max(0, X(s)); const x1 = Math.min(w, X(e));
    const color = KIND_COLOR[it.kind] || '#888';
    ctx.globalAlpha = it.estimated ? 0.45 : 1;
    ctx.fillStyle = `${color}22`;
    roundRect(ctx, x0, y0, Math.max(2, x1 - x0), y1 - y0, 6); ctx.fill();
    // waveform inside the block
    const p = getPeaks(it.id);
    if (p) {
      const mid = (y0 + y1) / 2; const hh = (y1 - y0) / 2 - 3;
      ctx.fillStyle = `${color}cc`;
      for (let px = x0; px < x1; px += 2) {
        const t = ((px / w) * span - before) - s;
        const v = peakAt(p, t, t + (span / w) * 2);
        if (v < 0) continue;
        const bh = Math.max(0.5, Math.pow(v, 0.8) * hh);
        ctx.fillRect(px, mid - bh, 1.4, bh * 2);
      }
    }
    // gain automation (fade x duck)
    if (it.fade || it.duck) {
      ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.4; ctx.beginPath();
      for (let px = x0; px <= x1; px += 3) {
        const t = (px / w) * span - before + dt; // timeline-relative seconds
        const g = laneValue(it.fade, t) * laneValue(it.duck, t);
        const y = y1 - 2 - g * (y1 - y0 - 4);
        if (px === x0) ctx.moveTo(px, y); else ctx.lineTo(px, y);
      }
      ctx.stroke();
    }
    // vocal markers
    const mk = it.markers || {};
    if (it.kind === 'music') {
      if (mk.intro != null) { ctx.fillStyle = '#3ea6ff'; ctx.fillRect(X(s + mk.intro), y0, 2, y1 - y0); }
      if (mk.outro != null) { ctx.fillStyle = '#b18cff'; ctx.fillRect(X(s + mk.outro), y0, 2, y1 - y0); }
    } else if (mk.voiceStart != null && mk.voiceEnd != null) {
      ctx.fillStyle = 'rgba(255,176,32,.25)';
      ctx.fillRect(X(s + mk.voiceStart), y0, X(s + mk.voiceEnd) - X(s + mk.voiceStart), y1 - y0);
    }
    ctx.strokeStyle = it.cued ? '#ffb020' : it.playing ? color : `${color}88`;
    ctx.lineWidth = it.cued ? 2 : 1;
    if (it.estimated) ctx.setLineDash([5, 4]);
    roundRect(ctx, x0, y0, Math.max(2, x1 - x0), y1 - y0, 6); ctx.stroke();
    ctx.setLineDash([]);
    // label
    ctx.save();
    ctx.beginPath(); ctx.rect(x0 + 4, y0, Math.max(0, x1 - x0 - 8), y1 - y0); ctx.clip();
    ctx.fillStyle = '#e8ebf2'; ctx.font = '700 11px Inter, system-ui, sans-serif';
    ctx.fillText(it.title || it.type, Math.max(x0 + 6, 70), y0 + 14);
    if (it.transition?.notes?.[0] && it.cued) { ctx.fillStyle = '#ffb020'; ctx.font = '10px Inter, system-ui, sans-serif'; ctx.fillText(it.transition.notes[0], Math.max(x0 + 6, 70), y1 - 6); }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  // NOW line
  const nx = X(0);
  ctx.fillStyle = '#ff2d3d'; ctx.shadowColor = '#ff2d3d'; ctx.shadowBlur = 10;
  ctx.fillRect(nx - 1, 0, 2, h);
  ctx.shadowBlur = 0;
  ctx.font = '800 9px Inter, system-ui, sans-serif'; ctx.fillText('NOW', nx + 4, 9);
}

function laneValue(pts, t) {
  if (!pts || !pts.length) return 1;
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i][0]) {
      const [t0, v0] = pts[i - 1]; const [t1, v1] = pts[i];
      return v0 + (v1 - v0) * ((t - t0) / Math.max(1e-6, t1 - t0));
    }
  }
  return pts[pts.length - 1][1];
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/**
 * Broadcast hour clock: this hour's elements as arcs, sweeping second hand, time to the top.
 * @param {{segments: {from:number,to:number,kind:string}[], m:number, s:number}} o (seconds in hour)
 */
export function drawHourClock(canvas, o) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2; const cy = h / 2; const R = Math.min(w, h) / 2 - 6;
  const ang = (sec) => (sec / 3600) * Math.PI * 2 - Math.PI / 2;
  const nowSec = o.m * 60 + o.s;
  ctx.lineWidth = R * 0.16;
  ctx.strokeStyle = 'rgba(255,255,255,.05)';
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.86, 0, Math.PI * 2); ctx.stroke();
  for (const seg of o.segments) {
    ctx.strokeStyle = KIND_COLOR[seg.kind] || '#888';
    ctx.globalAlpha = seg.to < nowSec ? 0.28 : 0.95;
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.86, ang(Math.max(0, seg.from)), ang(Math.min(3600, seg.to - 4))); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // ticks
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2 - Math.PI / 2; const long = i % 5 === 0;
    ctx.strokeStyle = long ? 'rgba(232,235,242,.7)' : 'rgba(232,235,242,.22)';
    ctx.lineWidth = long ? 2 : 1;
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * R * (long ? 0.66 : 0.7), cy + Math.sin(a) * R * (long ? 0.66 : 0.7));
    ctx.lineTo(cx + Math.cos(a) * R * 0.74, cy + Math.sin(a) * R * 0.74); ctx.stroke();
  }
  // minute hand (position in hour) and second hand
  const ma = ang(nowSec);
  ctx.strokeStyle = '#ffb020'; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(ma) * R * 0.95, cy + Math.sin(ma) * R * 0.95); ctx.stroke();
  const sa = (o.s / 60) * Math.PI * 2 - Math.PI / 2;
  ctx.strokeStyle = '#ff2d3d'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(sa) * R * 0.6, cy + Math.sin(sa) * R * 0.6); ctx.stroke();
  ctx.fillStyle = '#10141c'; ctx.beginPath(); ctx.arc(cx, cy, R * 0.36, 0, Math.PI * 2); ctx.fill();
  const left = 3600 - nowSec;
  ctx.fillStyle = '#e8ebf2'; ctx.textAlign = 'center';
  ctx.font = `800 ${Math.round(R * 0.2)}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.fillText(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`, cx, cy + R * 0.04);
  ctx.font = `700 ${Math.round(R * 0.08)}px Inter, system-ui, sans-serif`; ctx.fillStyle = '#8a93a8';
  ctx.fillText('TO THE TOP', cx, cy + R * 0.18);
  ctx.textAlign = 'start'; ctx.lineCap = 'butt';
}

const holds = new WeakMap();
/** Vertical PPM pair with peak hold. l/r are linear peaks. */
export function drawPPM(canvas, l, r) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  const hold = holds.get(canvas) || { l: -60, r: -60, tl: 0, tr: 0 };
  const now = performance.now();
  const scale = (db) => Math.pow(Math.max(0, Math.min(1, (db + 60) / 60)), 1.6);
  const bw = (w - 18) / 2;
  [[l, 'l'], [r, 'r']].forEach(([v, k], i) => {
    const db = dbOf(v);
    if (db > hold[k] || now - hold[`t${k}`] > 1500) { if (db > hold[k]) hold[`t${k}`] = now; hold[k] = Math.max(db, hold[k] - 0.6); }
    const x = 16 + i * (bw + 2);
    ctx.fillStyle = '#080b11'; ctx.fillRect(x, 0, bw, h);
    const g = ctx.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, '#16a34a'); g.addColorStop(scale(-12), '#22d36b'); g.addColorStop(scale(-9), '#f6c445'); g.addColorStop(scale(-3), '#ff9f1c'); g.addColorStop(1, '#ff4b55');
    const hh = scale(db) * h;
    ctx.fillStyle = g; ctx.fillRect(x, h - hh, bw, hh);
    ctx.fillStyle = hold[k] > -3 ? '#ff4b55' : '#e8ebf2';
    ctx.fillRect(x, h - scale(hold[k]) * h - 1, bw, 2);
  });
  holds.set(canvas, hold);
  ctx.fillStyle = 'rgba(160,170,190,.6)'; ctx.font = '8px "JetBrains Mono", ui-monospace, monospace';
  for (const db of [0, -6, -12, -20, -40]) ctx.fillText(String(db), 0, h - scale(db) * h + 3);
}

/** Thin stereo bar meter for the top bar. */
export function drawBarMeter(canvas, l, r) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  const scale = (v) => Math.pow(Math.max(0, Math.min(1, (dbOf(v) + 60) / 60)), 1.6);
  [l, r].forEach((v, i) => {
    const y = i * (h / 2 + 1); const bh = h / 2 - 1;
    ctx.fillStyle = '#10141c'; ctx.fillRect(0, y, w, bh);
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, '#16a34a'); g.addColorStop(0.75, '#22d36b'); g.addColorStop(0.88, '#f6c445'); g.addColorStop(1, '#ff4b55');
    ctx.fillStyle = g; ctx.fillRect(0, y, scale(v) * w, bh);
  });
}

const specHold = new WeakMap();
export function drawSpectrum(canvas, bands) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!bands) return;
  const holdArr = specHold.get(canvas) || bands.map(() => -90);
  const n = bands.length; const bw = w / n;
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Math.min(1, (bands[i] + 80) / 80));
    holdArr[i] = Math.max(bands[i], holdArr[i] - 0.8);
    const hv = Math.max(0, Math.min(1, (holdArr[i] + 80) / 80));
    const g = ctx.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, '#1d4ed8'); g.addColorStop(0.6, '#3ea6ff'); g.addColorStop(1, '#a5f3fc');
    ctx.fillStyle = g;
    ctx.fillRect(i * bw + 1, h - v * h, bw - 2, v * h);
    ctx.fillStyle = '#e8ebf2'; ctx.fillRect(i * bw + 1, h - hv * h - 1, bw - 2, 2);
  }
  specHold.set(canvas, holdArr);
  ctx.fillStyle = 'rgba(160,170,190,.6)'; ctx.font = '9px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillText('63', bw * 4, h - 3); ctx.fillText('250', bw * 10, h - 3); ctx.fillText('1k', bw * 16, h - 3); ctx.fillText('4k', bw * 22, h - 3); ctx.fillText('16k', bw * 28, h - 3);
}

/** Goniometer (M/S vectorscope) with phosphor persistence. */
export function drawGonio(canvas, pts) {
  const { ctx, w, h } = fit(canvas);
  ctx.fillStyle = 'rgba(8,11,17,.32)'; ctx.fillRect(0, 0, w, h);
  const cx = w / 2; const cy = h / 2; const R = Math.min(w, h) * 0.46;
  ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx - R, cy - R); ctx.lineTo(cx + R, cy + R); ctx.moveTo(cx + R, cy - R); ctx.lineTo(cx - R, cy + R);
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
  if (!pts) return;
  ctx.fillStyle = 'rgba(46,211,211,.85)';
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const l = pts[i]; const r = pts[i + 1];
    const x = cx + (r - l) * R * 0.75; const y = cy - (l + r) * R * 0.75;
    ctx.fillRect(x, y, 1.6, 1.6);
  }
}

/** Short-term loudness history (LUFS) with a target line. */
export function drawHistory(canvas, values, target = -14) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  const Y = (v) => h - ((Math.max(-40, Math.min(0, v)) + 40) / 40) * h;
  ctx.strokeStyle = 'rgba(255,176,32,.5)'; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(0, Y(target)); ctx.lineTo(w, Y(target)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(160,170,190,.6)'; ctx.font = '9px "JetBrains Mono", ui-monospace, monospace';
  for (const v of [-10, -20, -30]) ctx.fillText(String(v), 2, Y(v) - 2);
  if (values.length < 2) return;
  ctx.strokeStyle = '#3ea6ff'; ctx.lineWidth = 1.6; ctx.beginPath();
  values.forEach((v, i) => { const x = (i / (values.length - 1)) * w; if (i) ctx.lineTo(x, Y(v)); else ctx.moveTo(x, Y(v)); });
  ctx.stroke();
}
