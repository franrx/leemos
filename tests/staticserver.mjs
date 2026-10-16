// Tests for the dev server's static file handling: it must never hand out dotfiles (.env, .git), survive bad URLs,
// stay inside its folder, and (by default) listen on loopback only.
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleStatic } from '../scripts/lib/staticserver.mjs';

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parent = mkdtempSync(join(tmpdir(), 'leemos-static-'));
const root = join(parent, 'leemos-site');
mkdirSync(join(root, '.git'), { recursive: true });
mkdirSync(join(root, 'sub'), { recursive: true });
mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
mkdirSync(join(parent, 'leemos-site-old'), { recursive: true });
writeFileSync(join(root, 'index.html'), '<h1>hello</h1>');
writeFileSync(join(root, '.env'), 'AZURE_SPEECH_KEY=SECRETSECRETSECRET');
writeFileSync(join(root, '.git', 'config'), '[core] SECRETSECRETSECRET');
writeFileSync(join(root, 'sub', 'file.txt'), 'plain');
writeFileSync(join(root, 'node_modules', 'x', 'a.js'), 'x');
writeFileSync(join(root, 'clip.mp3'), Buffer.from('0123456789'));
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

rmSync(parent, { recursive: true, force: true });
console.log(failures ? `\n${failures} staticserver test(s) FAILED` : '\nAll staticserver tests passed');
process.exit(failures ? 1 : 0);
