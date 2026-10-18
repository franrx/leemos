// Dev-server routes behind tools/lab.html (the voice-progress experiment; plan: docs/superpowers/plans/2026-10-17-voice-progress-experiment.md):
//   POST   /__lab?session=<id>&n=<int>        binary body  -> lab/<session>/<n>.webm   (the bytes as the browser recorded them; ffmpeg sniffs the format)
//   POST   /__lab-label?session=<id>&n=<int>  JSON object  -> one line appended to lab/<session>/labels.jsonl
//   DELETE /__lab?session=<id>                              -> removes lab/<session>/
// Local requests only (same guard as the clip recorder). The files are a child's voice: they stay in the gitignored lab/ folder.
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { isLocalRequest } from './clipapi.mjs';
import { ROOT } from './clips.mjs';

export const LAB_DIR = join(ROOT, 'lab');
const MAX_AUDIO = 5 * 1024 * 1024;
const MAX_LABEL = 10 * 1024;
const SESSION = /^[a-z0-9-]{3,40}$/;

const fail = (status, message) => Object.assign(new Error(message), { status });

// Reads the body up to a limit but keeps draining it, so the client always gets an answer.
async function readBody(req, limit) {
  const chunks = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n <= limit) chunks.push(c); }
  if (n > limit) throw fail(413, 'too large');
  return Buffer.concat(chunks);
}

function sessionDir(labDir, session) {
  if (!SESSION.test(session || '')) throw fail(400, 'bad session');
  const dir = resolve(labDir, session);
  if (!dir.startsWith(resolve(labDir) + sep)) throw fail(400, 'bad session'); // belt and braces: never leave lab/
  return dir;
}
function readingNumber(raw) {
  if (!/^\d{1,4}$/.test(raw || '')) throw fail(400, 'bad n');
  return Number(raw);
}

// Returns true when it handled the request, false so the static file server can take over.
export async function handleLabApi(req, res, { labDir = LAB_DIR } = {}) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/__lab' && url.pathname !== '/__lab-label') return false;
  const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); return true; };
  if (!isLocalRequest(req)) return send(403, { error: 'local requests only' });
  try {
    const q = url.searchParams;
    if (req.method === 'POST' && url.pathname === '/__lab') {
      const dir = sessionDir(labDir, q.get('session'));
      const n = readingNumber(q.get('n'));
      const body = await readBody(req, MAX_AUDIO);
      if (!body.length) throw fail(400, 'empty recording');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${n}.webm`), body);
      return send(200, { ok: true, n });
    }
    if (req.method === 'POST' && url.pathname === '/__lab-label') {
      const dir = sessionDir(labDir, q.get('session'));
      const n = readingNumber(q.get('n'));
      let obj;
      try { obj = JSON.parse((await readBody(req, MAX_LABEL)).toString('utf8')); } catch (e) { if (e.status) throw e; throw fail(400, 'label is not JSON'); }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw fail(400, 'label must be an object');
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'labels.jsonl'), JSON.stringify({ ...obj, session: q.get('session'), n }) + '\n');
      return send(200, { ok: true, n });
    }
    if (req.method === 'DELETE' && url.pathname === '/__lab') {
      rmSync(sessionDir(labDir, q.get('session')), { recursive: true, force: true });
      return send(200, { ok: true });
    }
    return send(405, { error: 'method not allowed' });
  } catch (e) {
    return send(e.status || 500, { error: e.message });
  }
}
