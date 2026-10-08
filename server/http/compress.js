// Response compression without dependencies.
//  - JSON API responses over ~1.4 KB are gzipped on libuv's thread pool (never on the audio thread).
//  - The studio's own files (HTML, CSS, JS) are compressed once at maximum level and kept in memory,
//    with an ETag so repeat visits revalidate with a 304 instead of downloading again.

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MIN_BYTES = 1400; // a smaller response fits in one packet anyway
const acceptsGzip = (req) => /\bgzip\b/.test(req.headers['accept-encoding'] || '');

export function gzipJson(req, res, next) {
  if (!acceptsGzip(req)) return next();
  res.json = (body) => {
    const str = JSON.stringify(body);
    if (str === undefined || str.length < MIN_BYTES) return res.type('json').send(str ?? '');
    zlib.gzip(str, { level: 6 }, (err, buf) => {
      if (res.headersSent) return;
      if (err) { res.type('json').send(str); return; }
      res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Content-Length': buf.length });
      res.vary('Accept-Encoding');
      res.end(buf);
    });
    return res;
  };
  next();
}

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json' };

export function gzipStatic(dir) {
  const root = path.resolve(dir);
  const cache = new Map(); // file -> { mtimeMs, size, gz, etag }
  return (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !acceptsGzip(req)) return next();
    let rel;
    try { rel = decodeURIComponent(req.path); } catch { return next(); }
    if (rel.endsWith('/')) rel += 'index.html';
    const type = TYPES[path.extname(rel)];
    if (!type) return next();
    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep)) return next();
    let st;
    try { st = fs.statSync(file); } catch { return next(); }
    if (!st.isFile()) return next();
    let c = cache.get(file);
    if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
      const raw = fs.readFileSync(file);
      c = { mtimeMs: st.mtimeMs, size: st.size, gz: zlib.gzipSync(raw, { level: 9 }), etag: `"${crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 20)}-gz"` };
      cache.set(file, c);
    }
    res.set({ 'Content-Type': type, 'Content-Encoding': 'gzip', ETag: c.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' });
    if (req.headers['if-none-match'] === c.etag) return res.status(304).end();
    res.set('Content-Length', c.gz.length);
    return req.method === 'HEAD' ? res.end() : res.end(c.gz);
  };
}
