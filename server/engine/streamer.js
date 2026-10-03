// MP3 encoder + listener fan-out (with ICY metadata) + optional Icecast source push.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { FFMPEG, SAMPLE_RATE, CHANNELS } from '../config.js';
import { store } from '../store.js';

const ICY_METAINT = 16000;
const BURST_BYTES = 96 * 1024; // ~6s at 128k so players start instantly

export class Streamer extends EventEmitter {
  constructor() {
    super();
    this.listeners = new Set();
    this.burst = [];
    this.burstSize = 0;
    this.encoder = null;
    this.icecast = null;
    this.icecastStatus = 'off';
    this.title = '';
    this.peakListeners = 0;
    this.stopped = true;
  }

  start() {
    this.stopped = false;
    this.startEncoder();
    this.startIcecast();
  }

  stop() {
    this.stopped = true;
    this.encoder?.kill('SIGKILL');
    this.icecast?.kill('SIGKILL');
    this.encoder = null;
    this.icecast = null;
  }

  startEncoder() {
    const br = `${store.data.stream.bitrate || 128}k`;
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), '-i', 'pipe:0',
      '-c:a', 'libmp3lame', '-b:a', br, '-f', 'mp3', '-flush_packets', '1', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdout.on('data', (chunk) => this.broadcast(chunk));
    p.stderr.on('data', (d) => console.warn('[encoder]', String(d).trim()));
    p.stdin.on('error', () => {});
    p.on('close', (code) => {
      if (this.encoder === p) this.encoder = null;
      if (!this.stopped) {
        console.warn('[encoder] exited', code, '- restarting');
        setTimeout(() => this.startEncoder(), 1000);
      }
    });
    this.encoder = p;
  }

  restartIcecast() {
    this.icecast?.kill('SIGKILL');
    this.icecast = null;
    this.startIcecast();
  }

  startIcecast() {
    const ic = store.data.stream.icecast;
    if (this.stopped || !ic?.enabled || !ic.host || !ic.password) {
      this.icecastStatus = 'off';
      return;
    }
    const st = store.station;
    const mount = ic.mount.startsWith('/') ? ic.mount : `/${ic.mount}`;
    const url = `icecast://${encodeURIComponent(ic.username || 'source')}:${encodeURIComponent(ic.password)}@${ic.host}:${ic.port || 8000}${mount}`;
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'mp3', '-i', 'pipe:0', '-c:a', 'copy',
      '-content_type', 'audio/mpeg', '-ice_name', st.name, '-ice_description', st.slogan || '', '-ice_genre', 'Radio',
      '-ice_public', ic.public ? '1' : '0', '-f', 'mp3', url], { stdio: ['pipe', 'ignore', 'pipe'] });
    this.icecastStatus = 'connecting';
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdin.on('error', () => {});
    setTimeout(() => { if (this.icecast === p) this.icecastStatus = 'connected'; }, 3000);
    p.on('close', (code) => {
      if (this.icecast === p) this.icecast = null;
      this.icecastStatus = `error: ${err.trim().split('\n').pop() || `exit ${code}`}`;
      console.warn('[icecast]', this.icecastStatus);
      if (!this.stopped && store.data.stream.icecast.enabled) setTimeout(() => this.startIcecast(), 10_000);
    });
    this.icecast = p;
  }

  /** Feed PCM (Int16Array interleaved) to the encoder. */
  write(int16) {
    if (!this.encoder) return;
    this.encoder.stdin.write(Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength));
  }

  broadcast(chunk) {
    this.burst.push(chunk);
    this.burstSize += chunk.length;
    while (this.burstSize - this.burst[0].length > BURST_BYTES) this.burstSize -= this.burst.shift().length;
    if (this.icecast) this.icecast.stdin.write(chunk);
    for (const l of this.listeners) this.send(l, chunk);
  }

  send(l, chunk) {
    if (l.res.writableLength > 2 * 1024 * 1024) { // client can't keep up
      l.res.destroy();
      return;
    }
    if (!l.icy) { l.res.write(chunk); return; }
    let offset = 0;
    while (offset < chunk.length) {
      const n = Math.min(chunk.length - offset, ICY_METAINT - l.sinceMeta);
      l.res.write(chunk.subarray(offset, offset + n));
      offset += n;
      l.sinceMeta += n;
      if (l.sinceMeta === ICY_METAINT) {
        l.res.write(this.icyBlock(l));
        l.sinceMeta = 0;
      }
    }
  }

  icyBlock(l) {
    if (l.lastTitle === this.title) return Buffer.from([0]);
    l.lastTitle = this.title;
    const text = `StreamTitle='${this.title.replace(/'/g, '’')}';`;
    const body = Buffer.from(text, 'utf8');
    const len = Math.ceil(body.length / 16);
    const block = Buffer.alloc(1 + len * 16);
    block[0] = len;
    body.copy(block, 1);
    return block;
  }

  /** Express handler for GET /stream.mp3 */
  handle(req, res) {
    const icy = req.headers['icy-metadata'] === '1';
    const st = store.station;
    const headers = {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'icy-name': st.name,
      'icy-description': st.slogan || '',
      'icy-br': String(store.data.stream.bitrate || 128),
    };
    if (icy) headers['icy-metaint'] = String(ICY_METAINT);
    res.writeHead(200, headers);
    const l = { res, icy, sinceMeta: 0, lastTitle: null, since: Date.now(), ip: req.ip };
    for (const c of this.burst) this.send(l, c);
    this.listeners.add(l);
    this.peakListeners = Math.max(this.peakListeners, this.listeners.size);
    this.emit('listeners', this.listeners.size);
    req.on('close', () => {
      this.listeners.delete(l);
      this.emit('listeners', this.listeners.size);
    });
  }

  setTitle(title) {
    this.title = title;
    const ic = store.data.stream.icecast;
    if (ic?.enabled && this.icecast && ic.password) {
      const mount = ic.mount.startsWith('/') ? ic.mount : `/${ic.mount}`;
      const auth = Buffer.from(`${ic.adminUser || 'source'}:${ic.password}`).toString('base64');
      fetch(`http://${ic.host}:${ic.port || 8000}/admin/metadata?mount=${encodeURIComponent(mount)}&mode=updinfo&song=${encodeURIComponent(title)}`, {
        headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
  }
}
