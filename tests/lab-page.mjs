// Tests for tools/lab.html + tools/lab.js in jsdom, with a fake microphone and a fake dev server (the experiment's recording page).
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'tools/lab.html'), 'utf8').replace(/<script src="lab.js"><\/script>/, '');
const js = readFileSync(join(ROOT, 'tools/lab.js'), 'utf8');
const levels = { es: JSON.parse(readFileSync(join(ROOT, 'src/data/levels.es.json'), 'utf8')), ca: JSON.parse(readFileSync(join(ROOT, 'src/data/levels.ca.json'), 'utf8')) };
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(params = '', { peak = 0.2, uploadStatus = 200, confirm = true } = {}) {
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true, url: `http://localhost:5173/tools/lab.html${params ? '?' + params : ''}`,
    beforeParse(w) {
      w.__peak = peak;
      w.__recorders = 0;
      w.confirm = () => confirm;
      w.fetch = async (url, opts = {}) => {
        const m = /\/src\/data\/levels\.(es|ca)\.json/.exec(url);
        if (m) return { ok: true, status: 200, json: async () => levels[m[1]] };
        calls.push({ url, method: opts.method, type: opts.headers && opts.headers['Content-Type'], size: opts.body && opts.body.size, body: typeof opts.body === 'string' ? JSON.parse(opts.body) : null });
        const ok = !(uploadStatus !== 200 && url.startsWith('/__lab?') && opts.method === 'POST');
        return { ok, status: ok ? 200 : uploadStatus, json: async () => (ok ? { ok: true } : { error: 'boom' }) };
      };
      Object.defineProperty(w.navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
      w.MediaRecorder = class { static isTypeSupported() { return true; } constructor() { this.mimeType = 'audio/webm'; w.__recorders++; } start() {} stop() { this.ondataavailable({ data: new w.Blob(['x'.repeat(2000)]) }); this.onstop(); } };
      w.AudioContext = class { constructor() { this.state = 'running'; } resume() {} createMediaStreamSource() { return { connect() {}, disconnect() {} }; } createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: (b) => b.fill(w.__peak) }; } };
    },
  });
  const w = dom.window;
  w.eval(js);
  await sleep(10);
  return { w, $: (id) => w.document.getElementById(id), calls };
}
const press = async (p, id, ms = 25) => { p.$(id).click(); await sleep(ms); };
// Runs a whole session: for every item taps Listo, then the verdict (or none for kind=wrong); returns the items shown.
async function runAll(p, n, verdict = 'ok') {
  const shown = [];
  await press(p, 'start', 40);
  for (let i = 0; i < n; i++) {
    shown.push(p.$('big').textContent);
    await press(p, 'done');
    if (!p.$('ok').hidden) await press(p, verdict);
  }
  return shown;
}
const labels = (p) => p.calls.filter((c) => c.url.startsWith('/__lab-label'));
const audios = (p) => p.calls.filter((c) => c.url.startsWith('/__lab?') && c.method === 'POST');

let p = await open('lang=es&level=2&n=20&who=elsa&kind=read&seed=5');
check('page: before starting only the Empezar button is offered', !p.$('start').hidden && p.$('done').hidden && p.$('ok').hidden && p.$('fail').hidden && p.$('retry').hidden && p.$('wipe').hidden && /elsa/.test(p.$('info').textContent));
await press(p, 'start', 40);
check('page: starting shows the first item in capitals and records at that instant', /^[A-ZÑÁÉÍÓÚ]+$/.test(p.$('big').textContent) && p.w.__recorders === 1 && !p.$('done').hidden && !p.$('meter').hidden && p.$('start').hidden);
check('page: the level bar follows the input while recording', p.$('meterFill').style.width === '60%', p.$('meterFill').style.width);
await press(p, 'done');
check('page: after Listo the audio is uploaded and the adult is asked for the verdict', audios(p).length === 1 && /^\/__lab\?session=elsa-read-\d{12}&n=0$/.test(audios(p)[0].url) && audios(p)[0].size > 0 && !p.$('ok').hidden && !p.$('fail').hidden && p.$('done').hidden && p.$('meter').hidden, audios(p)[0] && audios(p)[0].url);
check('page: nothing is labelled until the adult taps', labels(p).length === 0);
await press(p, 'fail');
const l0 = labels(p)[0];
check('page: the verdict is posted with the item and the context', labels(p).length === 1 && /&n=0$/.test(l0.url) && l0.body.verdict === 'fail' && l0.body.lang === 'es' && l0.body.who === 'elsa' && l0.body.kind === 'read' && l0.body.level === 2 && l0.body.seed === 5 && /^(s|w):/.test(l0.body.key) && l0.body.text === l0.body.text.toLowerCase() && l0.body.recMs >= 0 && /^\d{4}-/.test(l0.body.shownAtIso), JSON.stringify(l0.body));
check('page: the next item starts recording by itself', p.w.__recorders === 2 && !p.$('done').hidden && p.$('ok').hidden);

// the whole session, twice with the same parameters, and once with another seed
p = await open('lang=es&level=2&n=20&who=elsa&kind=read&seed=5');
const a = await runAll(p, 20, 'ok');
check('page: a session has exactly n readings, each audio then label, numbered 0..n-1', audios(p).length === 20 && labels(p).length === 20 && labels(p).every((c, i) => new RegExp(`&n=${i}$`).test(c.url)));
check('page: about 15% of the items repeat inside a session', labels(p).filter((c) => c.body.rep).length === 3 && new Set(labels(p).map((c) => c.body.key)).size === 17, `${labels(p).filter((c) => c.body.rep).length} repeats, ${new Set(labels(p).map((c) => c.body.key)).size} distinct`);
check('page: the finished screen says so and offers to delete', p.$('big').textContent === '✓' && !p.$('wipe').hidden && /terminado/.test(p.$('info').textContent) && p.$('done').hidden);
const lv2 = new Set(levels.es.slice(0, 2).flatMap((L) => [...L.syl.map((s) => 's:' + s), ...L.words.map((o) => 'w:' + o.w)]));
check('page: items only come from the chosen level and below, with the app keys', labels(p).every((c) => lv2.has(c.body.key)));
p = await open('lang=es&level=2&n=20&who=elsa&kind=read&seed=5');
const b = await runAll(p, 20, 'ok');
p = await open('lang=es&level=2&n=20&who=elsa&kind=read&seed=6');
const c = await runAll(p, 20, 'ok');
check('page: the same level and seed give the same list, another seed another list', a.join() === b.join() && a.join() !== c.join());

// the wrong-on-purpose mode
p = await open('lang=es&level=1&n=6&who=adult&kind=wrong&seed=2');
await press(p, 'start', 40);
check('page: kind=wrong tells the reader to say another syllable', /OTRA/.test(p.$('ctx').textContent));
await press(p, 'done');
check('page: kind=wrong asks for no verdict and labels the reading as a fail by construction', p.$('ok').hidden && p.$('fail').hidden && labels(p).length === 1 && labels(p)[0].body.verdict === 'fail' && labels(p)[0].body.kind === 'wrong' && /^adult-wrong-/.test(new URL(labels(p)[0].url, 'http://x').searchParams.get('session')));
check('page: and the next one is already recording', p.w.__recorders === 2 && !p.$('done').hidden);

// Catalan keys
p = await open('lang=ca&level=1&n=4&seed=1&upper=0');
await press(p, 'start', 40);
check('page: Catalan items use the ca: keys, and upper=0 shows lowercase', /^[a-zàèéíòóúïüç·l]+$/.test(p.$('big').textContent), p.$('big').textContent);
await press(p, 'done'); await press(p, 'ok');
check('page: Catalan labels carry the ca: prefix', /^ca:(s|w):/.test(labels(p)[0].body.key) && labels(p)[0].body.lang === 'ca', JSON.stringify(labels(p)[0] && labels(p)[0].body));

// a silent microphone is refused, nothing is stored, and the retry records the same item again
p = await open('lang=es&level=1&n=5&seed=3', { peak: 0 });
await press(p, 'start', 40);
const first = p.$('big').textContent;
await press(p, 'done');
check('page: a silent recording is refused with the microphone hint and nothing is uploaded', /No se oyó nada/.test(p.$('status').textContent) && audios(p).length === 0 && !p.$('retry').hidden && p.$('ok').hidden);
p.w.__peak = 0.3;
await press(p, 'retry');
check('page: Repetir esta records the same item again', p.$('big').textContent === first && p.w.__recorders === 2 && !p.$('done').hidden);
await press(p, 'done');
check('page: and the second try is uploaded as the same reading number', audios(p).length === 1 && /&n=0$/.test(audios(p)[0].url) && !p.$('ok').hidden);

// a failing upload
p = await open('lang=es&level=1&n=5&seed=3', { uploadStatus: 500 });
await press(p, 'start', 40);
await press(p, 'done');
check('page: a failed upload says so and offers to repeat, without asking for a verdict', /No se pudo guardar/.test(p.$('status').textContent) && !p.$('retry').hidden && p.$('ok').hidden && labels(p).length === 0);

// wiping the session
p = await open('lang=es&level=1&n=2&seed=3', { confirm: false });
await press(p, 'start', 40);
await press(p, 'wipe');
check('page: declining the confirmation deletes nothing', !p.calls.some((x) => x.method === 'DELETE'));
p = await open('lang=es&level=1&n=2&seed=3', { confirm: true });
await press(p, 'start', 40);
await press(p, 'done'); await press(p, 'ok');
await press(p, 'wipe');
const del = p.calls.find((x) => x.method === 'DELETE');
check('page: confirming deletes exactly this session', !!del && /^\/__lab\?session=elsa-read-\d{12}$/.test(del.url) && audios(p)[0].url.includes(del.url.split('=')[1]), del && del.url);

// bad or missing parameters fall back to safe defaults
p = await open('lang=xx&who=<script>&kind=zzz&level=99&n=-5&seed=abc');
check('page: unknown parameters fall back to safe defaults and the session id stays valid', /^elsa-read-\d{12}$/.test(/sesión (\S+)/.exec(p.$('info').textContent)[1]) && /nivel 5/.test(p.$('info').textContent), p.$('info').textContent);

console.log(failures ? `\n${failures} lab page test(s) FAILED` : '\nAll lab page tests passed');
process.exit(failures ? 1 : 0);
