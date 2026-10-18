// Tests for the experiment's storage route (scripts/lib/labapi.mjs): readings are stored under lab/<session>/ and the route is local-only.
// Plain Node: a real http server on 127.0.0.1 with a temporary lab folder.
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleLabApi } from '../scripts/lib/labapi.mjs';

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };

const parent = mkdtempSync(join(tmpdir(), 'leemos-lab-'));
const labDir = join(parent, 'lab');
const server = createServer(async (req, res) => {
  const handled = await handleLabApi(req, res, { labDir });
  if (!handled) { res.writeHead(404); res.end('fallthrough'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const call = (method, path, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject);
  req.end(body);
});
const audio = Buffer.alloc(4000, 7);
const labelLines = (s) => (existsSync(join(labDir, s, 'labels.jsonl')) ? readFileSync(join(labDir, s, 'labels.jsonl'), 'utf8').trim().split('\n') : []);
const tree = () => (existsSync(parent) ? readdirSync(parent).sort().join(',') : '');

let r = await call('POST', '/__lab?session=adult-a1&n=0', { body: audio, headers: { 'Content-Type': 'audio/webm' } });
check('lab: a reading is stored as lab/<session>/<n>.webm', r.status === 200 && readFileSync(join(labDir, 'adult-a1', '0.webm')).equals(audio), r.body);
r = await call('POST', '/__lab-label?session=adult-a1&n=0', { body: JSON.stringify({ key: 's:ma', text: 'ma', lang: 'es', who: 'adult', kind: 'read', verdict: 'ok', session: 'evil', n: 99 }) });
check('lab: a label is appended as one JSON line, and session and n come from the query', r.status === 200 && labelLines('adult-a1').length === 1 && JSON.parse(labelLines('adult-a1')[0]).session === 'adult-a1' && JSON.parse(labelLines('adult-a1')[0]).n === 0 && JSON.parse(labelLines('adult-a1')[0]).key === 's:ma', labelLines('adult-a1')[0]);
await call('POST', '/__lab-label?session=adult-a1&n=1', { body: JSON.stringify({ key: 's:me', verdict: 'fail' }) });
check('lab: labels accumulate, one line per reading', labelLines('adult-a1').length === 2);
await call('POST', '/__lab?session=other-b2&n=0', { body: audio });
r = await call('GET', '/something-else');
check('lab: other paths fall through to the static server', r.status === 404 && r.body === 'fallthrough');

for (const [name, path] of [['a path-like session', '/__lab?session=..%2Fx&n=0'], ['a session with dots', '/__lab?session=a.b.c&n=0'], ['a too short session', '/__lab?session=ab&n=0'], ['an uppercase session', '/__lab?session=ABC&n=0'], ['a negative n', '/__lab?session=adult-a1&n=-1'], ['a non numeric n', '/__lab?session=adult-a1&n=abc'], ['n too large', '/__lab?session=adult-a1&n=10000'], ['no session', '/__lab?n=0']]) {
  r = await call('POST', path, { body: audio });
  check(`lab: ${name} is a 400`, r.status === 400, String(r.status));
}
check('lab: nothing was written outside the lab folder, and no stray session exists', tree() === 'lab' && readdirSync(labDir).sort().join(',') === 'adult-a1,other-b2');
r = await call('POST', '/__lab?session=adult-a1&n=5', { body: Buffer.alloc(5 * 1024 * 1024 + 10) });
check('lab: an oversized recording is a 413 and is not stored', r.status === 413 && !existsSync(join(labDir, 'adult-a1', '5.webm')));
r = await call('POST', '/__lab?session=adult-a1&n=6', { body: Buffer.alloc(0) });
check('lab: an empty recording is a 400', r.status === 400 && !existsSync(join(labDir, 'adult-a1', '6.webm')));
r = await call('POST', '/__lab-label?session=adult-a1&n=7', { body: '{not json' });
check('lab: a label that is not JSON is a 400', r.status === 400 && labelLines('adult-a1').length === 2);
r = await call('POST', '/__lab-label?session=adult-a1&n=7', { body: '[1,2]' });
check('lab: a label that is not an object is a 400', r.status === 400 && labelLines('adult-a1').length === 2);
r = await call('POST', '/__lab-label?session=adult-a1&n=7', { body: JSON.stringify({ note: 'x'.repeat(20000) }) });
check('lab: an oversized label is a 413', r.status === 413 && labelLines('adult-a1').length === 2);
r = await call('POST', '/__lab?session=adult-a1&n=8', { body: audio, headers: { Host: 'evil.example' } });
check('lab: a request with a foreign Host header is refused (DNS rebinding)', r.status === 403 && !existsSync(join(labDir, 'adult-a1', '8.webm')));
r = await call('POST', '/__lab?session=adult-a1&n=8', { body: audio, headers: { Host: `localhost:${port}`, Origin: 'http://evil.example' } });
check('lab: a cross-origin browser request is refused (CSRF)', r.status === 403 && !existsSync(join(labDir, 'adult-a1', '8.webm')));
r = await call('DELETE', '/__lab?session=adult-a1', { headers: { Host: 'evil.example' } });
check('lab: a foreign Host cannot delete either', r.status === 403 && existsSync(join(labDir, 'adult-a1', '0.webm')));
r = await call('DELETE', '/__lab?session=..%2F');
check('lab: delete rejects a path-like session', r.status === 400 && existsSync(labDir));
r = await call('DELETE', '/__lab?session=adult-a1');
check('lab: delete removes that session only', r.status === 200 && !existsSync(join(labDir, 'adult-a1')) && existsSync(join(labDir, 'other-b2', '0.webm')));
r = await call('DELETE', '/__lab?session=never-existed');
check('lab: deleting a session that does not exist is harmless', r.status === 200);
r = await call('PUT', '/__lab?session=adult-a1&n=0', { body: audio });
check('lab: other methods are a 405', r.status === 405);

server.close();
rmSync(parent, { recursive: true, force: true });
console.log(failures ? `\n${failures} lab test(s) FAILED` : '\nAll lab tests passed');
process.exit(failures ? 1 : 0);
