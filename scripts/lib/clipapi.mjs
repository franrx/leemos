// Dev-server routes behind tools/record.html: GET /__clips?lang=es and POST /__clip?lang=es&key=m (binary body).
import { recordList, saveClip, convertToMp3, MAX_BYTES } from './clipstore.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const hostName = (h = '') => h.replace(/:\d+$/, '');

// The dev server listens on every interface, so only loopback, same-origin requests may touch the files:
// the socket must be local, the Host header must be localhost (blocks DNS rebinding) and any Origin must match it (blocks CSRF).
export function isLocalRequest(req) {
  if (!LOOPBACK.has(req.socket.remoteAddress)) return false;
  if (!HOSTS.has(hostName(req.headers.host))) return false;
  if (req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return false; } catch { return false; }
  }
  return true;
}

// Returns true when it handled the request, false so the static file server can take over.
export async function handleClipApi(req, res, { audioDir, convert = convertToMp3 } = {}) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/__clips' && url.pathname !== '/__clip') return false;
  const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); return true; };
  if (!isLocalRequest(req)) return send(403, { error: 'local requests only' });
  const lang = url.searchParams.get('lang');
  try {
    if (req.method === 'GET' && url.pathname === '/__clips') return send(200, recordList({ lang, audioDir }));
    if (req.method === 'POST' && url.pathname === '/__clip') {
      const chunks = [];
      let n = 0;
      for await (const c of req) { n += c.length; if (n <= MAX_BYTES) chunks.push(c); } // keep draining so the client gets its answer
      if (n > MAX_BYTES) return send(413, { error: 'the recording is too large' });
      return send(200, saveClip({ audioDir, lang, key: url.searchParams.get('key'), input: Buffer.concat(chunks), type: req.headers['content-type'] || '', convert }));
    }
    return send(405, { error: 'method not allowed' });
  } catch (e) {
    return send(e.status || 500, { error: e.message });
  }
}
