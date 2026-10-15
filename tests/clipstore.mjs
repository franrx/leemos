// Tests for the recording export: clip list, saving into audio/ + manifest, and the dev-server API guard.
// Plain Node: a real http server on 127.0.0.1 with a temporary audio folder (ffmpeg is faked except in the last check).
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { recordList, saveClip, convertToMp3 } from '../scripts/lib/clipstore.mjs';
import { handleClipApi } from '../scripts/lib/clipapi.mjs';
import { hasFfmpeg } from '../scripts/lib/post.mjs';

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };

const audioDir = mkdtempSync(join(tmpdir(), 'leemos-clips-'));
const fakeMp3 = (buf) => Buffer.concat([Buffer.from('FAKE'), buf]); // stands in for ffmpeg
const big = Buffer.alloc(1000, 7);

// ---------- clip list ----------
const es = recordList({ lang: 'es', audioDir });
const sounds = es.filter((c) => c.kind === 'sound');
const firstWord = es.findIndex((c) => c.kind === 'word');
check('list: letter sounds come first, in teaching order, then the picture words', sounds.length === 24 && sounds.slice(0, 5).map((c) => c.key).join('') === 'aeiou' && es.slice(0, 24).every((c) => c.kind === 'sound') && firstWord === 24);
const m = es.find((c) => c.key === 'm');
check('list: a sound carries its picture word and emoji as context', m.word === 'mano' && m.emoji === '✋' && m.has === false);
check('list: sounds that Elsa also uses as syllables are flagged as shared', es.some((c) => c.shared) && m.shared === false);
check('list: Catalan has its own list', recordList({ lang: 'ca', audioDir }).filter((c) => c.kind === 'sound').length === 23);

// ---------- saving ----------
const saved = saveClip({ audioDir, lang: 'es', key: 'm', input: big, type: 'audio/webm', convert: fakeMp3 });
const manifest = () => JSON.parse(readFileSync(join(audioDir, 'manifest.json'), 'utf8'));
check('save: writes the converted file under audio/<lang>/', saved.file === 'm.mp3' && readFileSync(join(audioDir, 'es', 'm.mp3')).subarray(0, 4).toString() === 'FAKE');
check('save: registers the clip in the manifest and stamps it', manifest().clips.es.m === 'm.mp3' && !!manifest().generated);
check('save: the list now reports the clip as recorded', recordList({ lang: 'es', audioDir }).find((c) => c.key === 'm').has === true);
saveClip({ audioDir, lang: 'ca', key: 'ny', input: big, type: 'audio/mp4', convert: fakeMp3 });
check('save: keeps earlier manifest entries and handles other languages and digraphs', manifest().clips.es.m === 'm.mp3' && manifest().clips.ca.ny === 'ny.mp3');
const bad = (args) => { try { saveClip({ audioDir, convert: fakeMp3, type: 'audio/webm', ...args }); return null; } catch (e) { return e.status; } };
check('save: rejects an unknown clip key, a bad language, a path-like key', bad({ lang: 'es', key: 'zzz', input: big }) === 404 && bad({ lang: 'fr', key: 'm', input: big }) === 400 && bad({ lang: 'es', key: '../../x', input: big }) === 404);
check('save: rejects empty or oversized recordings', bad({ lang: 'es', key: 'm', input: Buffer.alloc(10) }) === 400 && bad({ lang: 'es', key: 'm', input: Buffer.alloc(6 * 1024 * 1024) }) === 413);

// ---------- dev-server API ----------
const server = createServer(async (req, res) => {
  const handled = await handleClipApi(req, res, { audioDir, convert: fakeMp3 });
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
let r = await call('GET', '/__clips?lang=es');
check('api: GET /__clips returns the list as JSON', r.status === 200 && JSON.parse(r.body).length > 24 && JSON.parse(r.body)[0].key === 'a');
r = await call('POST', '/__clip?lang=es&key=s', { body: big, headers: { 'Content-Type': 'audio/webm' } });
check('api: POST /__clip saves a recording', r.status === 200 && existsSync(join(audioDir, 'es', 's.mp3')) && manifest().clips.es.s === 's.mp3', r.body);
r = await call('POST', '/__clip?lang=es&key=nope', { body: big });
check('api: an unknown key is a 404 and writes nothing', r.status === 404 && !existsSync(join(audioDir, 'es', 'nope.mp3')));
r = await call('POST', '/__clip?lang=es&key=l', { body: Buffer.alloc(6 * 1024 * 1024) });
check('api: an oversized body is a 413', r.status === 413 && !existsSync(join(audioDir, 'es', 'l.mp3')));
r = await call('POST', '/__clip?lang=es&key=p', { body: big, headers: { Host: 'evil.example' } });
check('api: a request with a foreign Host header is refused (DNS rebinding)', r.status === 403 && !existsSync(join(audioDir, 'es', 'p.mp3')));
r = await call('POST', '/__clip?lang=es&key=p', { body: big, headers: { Host: `localhost:${port}`, Origin: 'http://evil.example' } });
check('api: a cross-origin browser request is refused (CSRF)', r.status === 403 && !existsSync(join(audioDir, 'es', 'p.mp3')));
r = await call('POST', '/__clip?lang=es&key=p', { body: big, headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}` } });
check('api: the same-origin page is accepted', r.status === 200 && existsSync(join(audioDir, 'es', 'p.mp3')));
r = await call('GET', '/index.html');
check('api: other paths fall through to the static server', r.status === 404 && r.body === 'fallthrough');
server.close();

// ---------- real ffmpeg ----------
if (hasFfmpeg()) {
  const wav = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=0.6', '-f', 'wav', 'pipe:1'], { maxBuffer: 1 << 24 }).stdout;
  const mp3 = convertToMp3(wav, 'audio/wav');
  check('convert: ffmpeg turns a recording into an mp3', mp3.length > 400 && (mp3[0] === 0xff || mp3.subarray(0, 3).toString() === 'ID3'), `${mp3.length} bytes`);
} else console.log('SKIP  convert: ffmpeg not installed');

rmSync(audioDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} clipstore test(s) FAILED` : '\nAll clipstore tests passed');
process.exit(failures ? 1 : 0);
