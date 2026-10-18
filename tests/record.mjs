// Tests for tools/record.html + tools/record.js in jsdom, with a fake microphone and a fake dev server.
import { JSDOM } from 'jsdom';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordList } from '../scripts/lib/clipstore.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'tools/record.html'), 'utf8').replace(/<script src="record.js"><\/script>/, '');
const js = readFileSync(join(ROOT, 'tools/record.js'), 'utf8');
const audioDir = mkdtempSync(join(tmpdir(), 'leemos-rec-ui-'));
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open({ peak = 0.2, has = [], postStatus = 200, offline = false, acState = 'running', noFloat = false } = {}) {
  const posts = [];
  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost:5173/tools/record.html',
    beforeParse(w) {
      w.fetch = async (url, opts = {}) => {
        if (offline) throw new TypeError('Failed to fetch');
        if (opts.method === 'POST') {
          posts.push({ url, type: opts.headers && opts.headers['Content-Type'], size: opts.body && opts.body.size });
          return { ok: postStatus === 200, status: postStatus, json: async () => (postStatus === 200 ? { file: 'x.mp3' } : { error: 'boom' }) };
        }
        const lang = new URL(url, 'http://localhost:5173').searchParams.get('lang');
        const list = recordList({ lang, audioDir }).map((c, i) => ({ ...c, has: has.includes(i) }));
        return { ok: true, status: 200, json: async () => list };
      };
      Object.defineProperty(w.navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
      w.URL.createObjectURL = () => 'blob:test'; w.URL.revokeObjectURL = () => {};
      w.Audio = function () { this.play = () => Promise.resolve(); };
      w.MediaRecorder = class { static isTypeSupported() { return true; } constructor() { this.mimeType = 'audio/webm'; } start() {} stop() { this.ondataavailable({ data: new w.Blob(['x'.repeat(2000)]) }); this.onstop(); } };
      w.AudioContext = class { constructor() { this.state = acState; } resume() {} createMediaStreamSource() { return { connect() {}, disconnect() {} }; } createAnalyser() { const an = { fftSize: 1024 }; if (!noFloat) an.getFloatTimeDomainData = (a) => a.fill(peak); return an; } };
    },
  });
  const w = dom.window;
  w.eval(js);
  await sleep(40);
  return { w, $: (id) => w.document.getElementById(id), posts };
}
const startRec = async (p) => { p.$('rec').click(); await sleep(50); };
const stopRec = async (p) => { p.$('rec').click(); await sleep(30); };

let p = await open();
check('page: shows the first letter sound and the progress', p.$('big').textContent === 'a' && /^0 de 48/.test(p.$('progress').textContent), `${p.$('big').textContent} | ${p.$('progress').textContent}`);
for (let i = 0; i < 5; i++) p.$('next').click();
check('page: a letter sound is shown with its picture word as context', p.$('big').textContent === 'm' && /mano/.test(p.$('ctx').textContent) && p.$('ctx').textContent.includes('✋'), p.$('ctx').textContent);
p = await open();
const list = recordList({ lang: 'es', audioDir });
const firstShared = list.findIndex((c) => c.shared);
for (let i = 0; i < firstShared; i++) p.$('next').click();
check('page: a clip that Elsa also uses carries a warning', !p.$('shared').hidden);
const firstPlain = list.findIndex((c, j) => j > firstShared && !c.shared);
for (let i = 0; i < firstPlain - firstShared; i++) p.$('next').click();
check('page: a clip only Leo uses has no warning', p.$('shared').hidden);

p = await open({ has: [0, 1, 2] });
check('page: starts at the first clip that is still missing', p.$('big').textContent === 'o' && /^3 de 48/.test(p.$('progress').textContent), `${p.$('big').textContent} | ${p.$('progress').textContent}`);

p = await open({ peak: 0.2 });
await startRec(p);
check('page: the level bar follows the input while recording', !p.$('meter').hidden && p.$('meterFill').style.width === '60%', p.$('meterFill').style.width);
check('page: a dot shows that the microphone is on', !p.$('recDot').hidden && p.$('recDot').getAttribute('aria-hidden') === 'true');
await stopRec(p);
check('page: the level bar hides when recording stops', p.$('meter').hidden);
check('page: and the recording dot with it', p.$('recDot').hidden);
check('page: a recording with sound can be played and saved', !p.$('save').hidden && !p.$('play').hidden);
p.$('save').click(); await sleep(40);
check('page: saving posts the audio to the dev server for that clip', p.posts.length === 1 && p.posts[0].url === '/__clip?lang=es&key=a' && p.posts[0].type === 'audio/webm' && p.posts[0].size > 0, JSON.stringify(p.posts));
check('page: after saving it moves on to the next missing clip and counts it', p.$('big').textContent === 'e' && /^1 de 48/.test(p.$('progress').textContent), `${p.$('big').textContent} | ${p.$('progress').textContent}`);
check('page: it confirms the save', /Guardada/.test(p.$('status').textContent), p.$('status').textContent);

p = await open({ peak: 0 });
await startRec(p); await stopRec(p);
check('page: a silent recording is rejected with a hint and cannot be saved', /No se oyó nada/.test(p.$('status').textContent) && p.$('save').hidden && p.posts.length === 0, p.$('status').textContent);

for (const [label, cfg] of [['a suspended AudioContext', { acState: 'suspended' }], ['an analyser without sample data', { noFloat: true }]]) {
  p = await open({ peak: 0, ...cfg });
  await startRec(p); await stopRec(p);
  check(`page: ${label} never rejects a recording as silent`, !p.$('save').hidden && !/No se oyó nada/.test(p.$('status').textContent), p.$('status').textContent);
}

p = await open({ peak: 0.2, postStatus: 500 });
await startRec(p); await stopRec(p); p.$('save').click(); await sleep(40);
check('page: a server error is shown and the recording is kept for a retry', /boom/.test(p.$('status').textContent) && !p.$('save').hidden && p.$('big').textContent === 'a', p.$('status').textContent);

p = await open();
p.$('lang').value = 'ca'; p.$('lang').dispatchEvent(new p.w.Event('change')); await sleep(40);
check('page: switching language loads the Catalan list', /^0 de 46/.test(p.$('progress').textContent) && p.$('big').textContent === 'a', p.$('progress').textContent);

p = await open({ offline: true });
check('page: without the dev server it explains how to start it', /npm run dev/.test(p.$('status').textContent), p.$('status').textContent);

rmSync(audioDir, { recursive: true, force: true });
console.log(failures ? `\n${failures} record test(s) FAILED` : '\nAll record tests passed');
process.exit(failures ? 1 : 0);
