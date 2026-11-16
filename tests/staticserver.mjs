// Tests for the dev server's static file handling: it must never hand out dotfiles (.env, .git), survive bad URLs,
// stay inside its folder, and (by default) listen on loopback only.
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { handleStatic } from '../scripts/lib/staticserver.mjs';
import { startFakeServer, SEED } from '../scripts/fake-supabase-server.mjs';

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parent = mkdtempSync(join(tmpdir(), 'leemos-static-'));
const root = join(parent, 'leemos-site');
mkdirSync(join(root, '.git'), { recursive: true });
mkdirSync(join(root, 'sub'), { recursive: true });
mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
mkdirSync(join(root, 'lab', 'elsa-read-1'), { recursive: true });
mkdirSync(join(parent, 'leemos-site-old'), { recursive: true });
writeFileSync(join(root, 'index.html'), '<h1>hello</h1>');
writeFileSync(join(root, '.env'), 'AZURE_SPEECH_KEY=SECRETSECRETSECRET');
writeFileSync(join(root, '.git', 'config'), '[core] SECRETSECRETSECRET');
writeFileSync(join(root, 'sub', 'file.txt'), 'plain');
writeFileSync(join(root, 'node_modules', 'x', 'a.js'), 'x');
writeFileSync(join(root, 'clip.mp3'), Buffer.from('0123456789'));
writeFileSync(join(root, 'lab', 'elsa-read-1', '0.webm'), 'CHILDVOICE');
writeFileSync(join(root, 'lab', 'report.md'), 'CHILDVOICE');
writeFileSync(join(root, 'labels.json'), 'not the lab folder');
writeFileSync(join(parent, 'leemos-site-old', 'secret.txt'), 'SECRETSECRETSECRET');

const call = (port, path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject);
  req.end();
});
const serve = async (opts) => {
  const s = createServer((req, res) => handleStatic(req, res, { root, ...opts }));
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { s, port: s.address().port };
};

let { s: server, port } = await serve({});
let r = await call(port, '/index.html');
check('static: serves a normal file', r.status === 200 && r.body === '<h1>hello</h1>' && r.headers['content-type'].startsWith('text/html'));
r = await call(port, '/');
check('static: "/" serves index.html', r.status === 200 && r.body.includes('hello'));
r = await call(port, '/.env');
check('static: never serves .env', r.status === 404 && !r.body.includes('SECRET'), `${r.status}`);
r = await call(port, '/.git/config');
check('static: never serves anything under .git', r.status === 404 && !r.body.includes('SECRET'));
r = await call(port, '/%2e%2e/leemos-site-old/secret.txt');
check('static: an encoded ".." is refused', r.status === 404 && !r.body.includes('SECRET'));
r = await call(port, '/..%2Fleemos-site-old%2Fsecret.txt');
check('static: a sibling folder that shares the name prefix is out of reach', r.status === 404 && !r.body.includes('SECRET'));
r = await call(port, '/node_modules/x/a.js');
check('static: node_modules is not served', r.status === 404);
r = await call(port, '/lab/elsa-read-1/0.webm');
check('static: the experiment folder lab/ (a child\'s voice) is never served', r.status === 404 && !r.body.includes('CHILDVOICE'), `${r.status}`);
r = await call(port, '/lab/report.md');
check('static: nor its report', r.status === 404 && !r.body.includes('CHILDVOICE'));
r = await call(port, '/%6Cab/elsa-read-1/0.webm');
check('static: an encoded name does not get around it', r.status === 404 && !r.body.includes('CHILDVOICE'));
r = await call(port, '/labels.json');
check('static: a file that merely starts with "lab" is still served', r.status === 200 && r.body.includes('not the lab folder'));
r = await call(port, '/%E0%A4%A');
const after = await call(port, '/index.html');
check('static: a malformed percent escape is a 400 and does not kill the server', r.status === 400 && after.status === 200, `${r.status}/${after.status}`);
r = await call(port, '/index.html', { method: 'POST' });
check('static: only GET and HEAD are allowed', r.status === 405);
r = await call(port, '/clip.mp3', { headers: { Range: 'bytes=2-5' } });
check('static: byte ranges still work (Safari needs them for audio)', r.status === 206 && r.body === '2345' && r.headers['content-range'] === 'bytes 2-5/10', JSON.stringify(r.headers['content-range']));
r = await call(port, '/missing.txt');
check('static: a missing file is a 404', r.status === 404);
server.close();

({ s: server, port } = await serve({ localHostsOnly: true }));
r = await call(port, '/index.html', { headers: { Host: 'evil.example' } });
check('static: with the local-only guard a foreign Host header is refused (DNS rebinding)', r.status === 403);
r = await call(port, '/index.html', { headers: { Host: `localhost:${port}` } });
check('static: with the local-only guard a localhost Host is accepted', r.status === 200);
server.close();

// The real dev server: by default it must not be reachable through the machine's network address.
const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
const devPort = 20000 + Math.floor(Math.random() * 10000);
const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'dev-server.mjs')], { env: { ...process.env, PORT: String(devPort), HOST: '' }, stdio: 'ignore' });
let up = false;
for (let i = 0; i < 50 && !up; i++) { await sleep(100); try { up = (await call(devPort, '/index.html')).status === 200; } catch { /* not listening yet */ } }
check('dev server: starts and serves the app on localhost', up);
r = await call(devPort, '/.env');
check('dev server: the real .env is not served on localhost either', r.status === 404, `${r.status}`);
if (lan) {
  const reachable = await new Promise((resolve) => { const q = httpRequest({ host: lan.address, port: devPort, path: '/index.html', timeout: 1500 }, () => resolve(true)); q.on('error', () => resolve(false)); q.on('timeout', () => { q.destroy(); resolve(false); }); q.end(); });
  check('dev server: by default it is NOT reachable through the LAN address', reachable === false, lan.address);
} else console.log('SKIP  dev server: no LAN address to test');
child.kill();


// The development override of the sync config (QA against the fake backend): off by default, exact path only.
const CFG_PATH = '/src/data/sync.config.json', CFG_JSON = '{"url":"http://127.0.0.1:5174","anonKey":"dev"}';
({ s: server, port } = await serve({ overrides: { [CFG_PATH]: CFG_JSON } }));
r = await call(port, CFG_PATH + '?x=1');
check('static override: the configured path answers with the given JSON, uncached', r.status === 200 && r.body === CFG_JSON && /json/.test(r.headers['content-type']) && r.headers['cache-control'] === 'no-cache', r.body);
r = await call(port, '/src/data/other.json');
check('static override: any other path is untouched', r.status === 404);
r = await call(port, '/.env');
check('static override: dotfiles are still refused', r.status === 404 && !r.body.includes('SECRET'));
server.close();
({ s: server, port } = await serve({ localHostsOnly: true, overrides: { [CFG_PATH]: CFG_JSON } }));
r = await call(port, CFG_PATH, { headers: { Host: 'evil.example' } });
check('static override: the local-only Host guard still applies to it', r.status === 403 && !r.body.includes('anonKey'));
server.close();

const spawnDev = async (env) => {
  const p2 = 30000 + Math.floor(Math.random() * 10000);
  const c = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'dev-server.mjs')], { env: { ...process.env, PORT: String(p2), HOST: '', LEEMOS_SYNC_CONFIG_JSON: '', ...env }, stdio: 'ignore' });
  let ok = false;
  for (let i = 0; i < 50 && !ok; i++) { await sleep(100); try { ok = (await call(p2, '/index.html')).status === 200; } catch { /* not listening yet */ } }
  return { c, p2, ok };
};
const committed = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'sync.config.json'), 'utf8');
let dv = await spawnDev({});
r = dv.ok ? await call(dv.p2, CFG_PATH) : { body: '' };
check('dev server: without LEEMOS_SYNC_CONFIG_JSON it serves the committed sync config', dv.ok && r.body === committed, r.body.slice(0, 60));
dv.c.kill();
dv = await spawnDev({ LEEMOS_SYNC_CONFIG_JSON: CFG_JSON });
r = dv.ok ? await call(dv.p2, CFG_PATH) : { body: '' };
check('dev server: LEEMOS_SYNC_CONFIG_JSON replaces the sync config in the response only', dv.ok && r.body === CFG_JSON && readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'sync.config.json'), 'utf8') === committed, r.body.slice(0, 60));
dv.c.kill();
const bad = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'dev-server.mjs')], { env: { ...process.env, PORT: '0', LEEMOS_SYNC_CONFIG_JSON: '{nope' }, stdio: 'ignore' });
const badCode = await new Promise((res) => { bad.on('exit', res); setTimeout(() => { bad.kill(); res('hung'); }, 5000); });
check('dev server: an invalid LEEMOS_SYNC_CONFIG_JSON stops it with an error', badCode === 1, String(badCode));

// The fake backend for QA: CORS, seeded accounts, the fixed code.
{
  const fx = await startFakeServer({ port: 0 });
  const base = `http://127.0.0.1:${fx.port}`;
  const pre = await fetch(base + '/rest/v1/rpc/whoami', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' } });
  check('fake backend: answers the CORS preflight', pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*' && /authorization/.test(pre.headers.get('access-control-allow-headers')));
  const signIn = async (email, code = SEED.code) => {
    await fetch(base + '/auth/v1/otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    return fetch(base + '/auth/v1/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, token: code, type: 'email' }) });
  };
  const bad2 = await signIn(SEED.teacher, '000000');
  const ok = await signIn(SEED.teacher);
  const sess = await ok.json();
  const who = await (await fetch(base + '/rest/v1/rpc/whoami', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sess.access_token }, body: '{}' })).json();
  const cls = await (await fetch(base + '/rest/v1/classes?select=id,name', { headers: { Authorization: 'Bearer ' + sess.access_token } })).json();
  check('fake backend: code 123456 signs a seeded teacher in (and a wrong one is refused)', bad2.status === 403 && ok.status === 200 && who.role === 'teacher' && !!who.teacher_ack_at && cls.length === 1 && cls[0].name === '3A', JSON.stringify({ who, cls }));
  const adm = await (await signIn(SEED.admin)).json();
  const aw = await (await fetch(base + '/rest/v1/rpc/whoami', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adm.access_token }, body: '{}' })).json();
  check('fake backend: the seeded admin and parent have their roles', aw.role === 'admin' && (await (await fetch(base + '/rest/v1/rpc/whoami', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await (await signIn(SEED.parent)).json()).access_token }, body: '{}' })).json()).role === 'parent');
  fx.server.close();
}

rmSync(parent, { recursive: true, force: true });
console.log(failures ? `\n${failures} staticserver test(s) FAILED` : '\nAll staticserver tests passed');
process.exit(failures ? 1 : 0);
