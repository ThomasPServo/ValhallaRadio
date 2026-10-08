// The studio monitor: the program exactly as the engine makes it, as raw PCM over the WebSocket, played
// through an AudioWorklet with a small jitter buffer. About a tenth of a second behind the engine, where
// the public stream (an MP3 encoder plus the player's own buffering) runs several seconds behind.
import { bus, state, setMonitoring } from './core.js';

const WORKLET = `
class MonitorPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = sampleRate * 2;                 // 2 s ring, stereo
    this.l = new Float32Array(this.cap); this.r = new Float32Array(this.cap);
    this.w = 0; this.rd = 0; this.n = 0;
    this.target = Math.round(sampleRate * 0.1); // start (and restart after a gap) with 100 ms in hand
    this.max = Math.round(sampleRate * 0.35);   // never drift further behind than this
    this.playing = false; this.ticks = 0;
    this.port.onmessage = (e) => {
      const s = new Int16Array(e.data);
      for (let i = 0; i < s.length; i += 2) {
        this.l[this.w] = s[i] / 32768; this.r[this.w] = s[i + 1] / 32768;
        this.w = (this.w + 1) % this.cap;
        if (this.n < this.cap) this.n++; else this.rd = (this.rd + 1) % this.cap;
      }
      if (this.n > this.max) { const drop = this.n - this.target; this.rd = (this.rd + drop) % this.cap; this.n -= drop; }
    };
  }
  process(_in, outs) {
    const [L, R] = outs[0]; const len = L.length;
    if (!this.playing && this.n >= this.target) this.playing = true;
    if (this.playing && this.n < len) this.playing = false; // ran dry: wait for a cushion again
    for (let i = 0; i < len; i++) {
      if (this.playing) { L[i] = this.l[this.rd]; (R || L)[i] = this.r[this.rd]; this.rd = (this.rd + 1) % this.cap; this.n--; }
      else { L[i] = 0; if (R) R[i] = 0; }
    }
    if (++this.ticks % 50 === 0) this.port.postMessage(this.n / sampleRate);
    return true;
  }
}
registerProcessor('monitor-player', MonitorPlayer);`;

let ctx = null; let node = null; let gain = null; let off = null; let volume = 1;
export const monitor = { on: false, bufferSec: 0 };

export async function startMonitor() {
  if (monitor.on) return;
  ctx = new AudioContext({ sampleRate: state.S?.sampleRate || 44100, latencyHint: 'interactive' });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  node = new AudioWorkletNode(ctx, 'monitor-player', { numberOfInputs: 0, outputChannelCount: [2] });
  gain = new GainNode(ctx, { gain: volume });
  node.connect(gain).connect(ctx.destination);
  node.port.onmessage = (e) => { monitor.bufferSec = e.data; };
  off = bus.on('pcm', (buf) => node?.port.postMessage(buf, [buf]));
  await ctx.resume();
  monitor.on = true;
  setMonitoring(true);
}

export function stopMonitor() {
  setMonitoring(false);
  off?.(); off = null;
  node?.disconnect(); node = null;
  ctx?.close(); ctx = null;
  monitor.on = false; monitor.bufferSec = 0;
}

export function setMonitorVolume(v) { volume = v; if (gain) gain.gain.value = v; }
export const monitorVolume = () => volume;
