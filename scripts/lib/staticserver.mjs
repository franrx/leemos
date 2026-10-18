// Static file serving for the dev server (npm run dev). Hardened because the project folder holds secrets:
// no dotfiles (.env, .git), no node_modules, no lab/ (the experiment's recordings), nothing outside the root, and bad URLs never crash the server.
import { createReadStream, statSync } from 'node:fs';
import { join, extname, normalize, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg',
};
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// -> { file, size } for a servable file, or { status } (400 bad URL, 404 anything else).
export function resolveFile(root, rawUrl) {
  let p;
  try { p = decodeURIComponent(new URL(rawUrl, 'http://x').pathname); } catch { return { status: 400 }; }
  if (p.includes('\0') || p.includes('\\')) return { status: 400 };
  if (p.endsWith('/')) p += 'index.html';
  // decoded, so "%2e%2e" and "%2F" tricks are seen as what they are
  if (p.split('/').some((seg) => seg.startsWith('.') || seg === 'node_modules')) return { status: 404 };
  if (p.split('/')[1] === 'lab') return { status: 404 }; // the voice-progress experiment (a child's recordings and transcripts): never over HTTP, not even on localhost
  const file = normalize(join(root, p));
  if (file !== root && !file.startsWith(root + sep)) return { status: 404 }; // "root + sep": /x/leemos must not match /x/leemos-old
  let st;
  try { st = statSync(file); } catch { return { status: 404 }; }
  return st.isFile() ? { file, size: st.size } : { status: 404 };
}

// localHostsOnly: refuse any Host header that is not localhost (blocks DNS rebinding from a web page).
export function handleStatic(req, res, { root, localHostsOnly = false }) {
  const end = (status, msg) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(msg); };
  try {
    if (localHostsOnly && !LOCAL_HOSTS.has((req.headers.host || '').replace(/:\d+$/, ''))) return end(403, 'Forbidden');
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(405, 'Method not allowed');
    const r = resolveFile(root, req.url);
    if (r.status) return end(r.status, r.status === 400 ? 'Bad request' : 'Not found');
    const { file, size } = r;
    const type = TYPES[extname(file)] || 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    let status = 200, start = 0, stop = size - 1;
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
    if (range && size > 0) {
      start = range[1] ? Number(range[1]) : 0;
      stop = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > stop || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${stop}/${size}`;
    }
    headers['Content-Length'] = size === 0 ? 0 : stop - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || size === 0) return res.end();
    const stream = createReadStream(file, { start, end: stop });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (e) {
    if (!res.headersSent) end(500, 'Server error'); else res.destroy();
  }
}
