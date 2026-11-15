// Smoke tests: loads index.html + src/app.js in jsdom (no browser needed) and drives the real UI.
// jsdom does not run ES modules, so app.js is evaluated inside an async wrapper (top-level await) in strict mode.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFakeSupabase } from './lib/fake-supabase.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8').replace(/<script type="module"[^>]*><\/script>/, '');
const appJs = readFileSync(join(ROOT, 'src/app.js'), 'utf8');
const readJSON = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot({ manifest = null, lang = 'en-US', storage = {}, swMock = null, importFails = false, mic = null, levelsPatch = null, reduced = false, voice = null, syncConfig = null, supa = null, syncEvery = 0, openPath = true, hangImport = null, onDom = null } = {}) {
  const errors = [];
  const audioCalls = [];
  const vc = new VirtualConsole();
  // jsdom does not navigate; navs records what a real browser would have left behind when the page asked to reload (location.reload)
  const navs = []; let wRef = null;
  vc.on('jsdomError', (e) => {
    if (!/Not implemented: navigation/.test(e.message)) { console.error(e.message); return; }
    if (wRef) navs.push({ auth: wRef.localStorage.getItem('leemos-auth'), profiles: JSON.parse(wRef.localStorage.getItem('leemos-profiles') || 'null'), note: wRef.sessionStorage.getItem('leemos-acct-note'), log: supa ? [...supa.log] : [] });
  });
  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/', virtualConsole: vc,
    beforeParse(w) {
      Object.defineProperty(w.navigator, 'language', { value: lang });
      // Most tests were written before the letter path: unless a test asks for the real defaults (openPath:false) the saved
      // reader states start with every letter open, which is what an existing profile gets.
      const withPath = (k, v) => (openPath && typeof v !== 'string' && /^leemos-v1(:|$)/.test(k) && v.pathEs === undefined ? { ...v, pathEs: 12, pathCa: 12 } : v);
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(withPath(k, v)));
      if (openPath && !('leemos-profiles' in storage) && !('leemos-v1' in storage)) w.localStorage.setItem('leemos-v1', JSON.stringify({ pathEs: 12, pathCa: 12 }));
      w.__leemosImport = importFails ? () => Promise.reject(new Error('offline')) : (p) => (hangImport && p.endsWith(hangImport) ? new Promise(() => {}) : import(pathToFileURL(join(ROOT, 'src', p)).href));
      if (hangImport) { w.__leemosFindTimeout = 150; w.__leemosCloseTimeout = 150; } // a stalled import must give up; short here so the test does not wait
      w.matchMedia = (q) => ({ matches: reduced && /reduced-motion/.test(q), addEventListener() {}, removeListener() {} });
      w.speechSynthesis = { getVoices: () => [{ name: 'Joana Online (Natural)', lang: 'ca-ES', voiceURI: 'j' }, { name: 'Google español', lang: 'es-ES', voiceURI: 'g' }], cancel() {}, speak(u) { (w.__tts ||= []).push(u.text); } };
      w.SpeechSynthesisUtterance = function (t) { this.text = t; };
      // w.__audioMode: 'manual' (default: a clip never ends by itself), 'auto' (ends at once), 'blocked' (the browser refuses to start it: NotAllowedError), 'missing' (it cannot be loaded)
      // w.__strict models iOS: an element that has never played may only start inside a tap (w.__inTap); one a tap already played may start any time, with any new src
      w.Audio = function (src) {
        if (src !== undefined) audioCalls.push(src);
        (w.__audios ||= []).push(this);
        let cur = src; Object.defineProperty(this, 'src', { get: () => cur, set: (v) => { cur = v; audioCalls.push(v); } });
        this.play = () => {
          w.__plays = (w.__plays || 0) + 1;
          if (w.__audioMode === 'blocked') return Promise.reject(Object.assign(new Error('play() was not allowed'), { name: 'NotAllowedError' }));
          if (w.__audioMode === 'missing') return Promise.reject(Object.assign(new Error('no supported source'), { name: 'NotSupportedError' }));
          if (w.__strict && !this.__unlocked && !w.__inTap) { w.__refused = (w.__refused || 0) + 1; return Promise.reject(Object.assign(new Error('play() was not allowed'), { name: 'NotAllowedError' })); }
          this.__unlocked = true;
          if (w.__audioMode === 'auto' && this.onended) this.onended(); // ends at once, before play() returns
          return Promise.resolve();
        };
        this.pause = () => { this.paused = true; };
      };
      // fake Web Audio for Lumi's beak: voice.sample is the constant byte the analyser reports (128 = silence); voice.state is the context state
      if (voice) w.AudioContext = class { constructor() { (w.__acs ||= []).push(1); this.state = voice.state || 'running'; this.destination = {}; } resume() { return Promise.resolve(); } createMediaElementSource() { return { connect() {} }; } createAnalyser() { return { fftSize: 0, connect() {}, getByteTimeDomainData: (arr) => arr.fill(voice.sample) }; } };
      if (mic) {
        // fake microphone: mic.peak is the constant sample level the analyser reports; mic.deny refuses permission
        Object.defineProperty(w.navigator, 'mediaDevices', { value: { getUserMedia: async () => { if (mic.deny) throw new Error('denied'); return { getTracks: () => [{ stop() {} }] }; } } });
        w.URL.createObjectURL = () => 'blob:test'; w.URL.revokeObjectURL = () => {};
        w.MediaRecorder = class { static isTypeSupported() { return true; } constructor() { this.mimeType = 'audio/webm'; } start() {} stop() { this.ondataavailable({ data: new w.Blob(['abc']) }); this.onstop(); } };
        // mic.state: what the AudioContext reports ('running' by default; browsers may leave it 'suspended'); mic.noFloat: an analyser without getFloatTimeDomainData
        w.AudioContext = class { constructor() { this.state = mic.state || 'running'; } resume() {} createMediaStreamSource() { return { connect() {}, disconnect() {} }; } createAnalyser() { const an = { fftSize: 1024 }; if (!mic.noFloat) an.getFloatTimeDomainData = (a) => a.fill(mic.peak); return an; } };
      }
      w.__fetched = [];
      if (syncEvery) w.__leemosSyncEvery = syncEvery; // shortens the once-a-minute pull so a test does not wait a minute
      if (supa) w.__leemosSyncFetch = supa.fetch; // the fake Supabase the app's sync client talks to
      if (swMock) {
        Object.defineProperty(w.navigator, 'serviceWorker', { value: { controller: {}, register: () => Promise.resolve() } });
        w.caches = { match: async () => (swMock.cached ? {} : undefined) };
      }
      w.fetch = async (u) => {
        w.__fetched.push(u);
        if (u === 'src/data/sync.config.json') return { ok: true, status: 200, json: async () => syncConfig || { url: '', anonKey: '' } }; // never the real local file: tests must not depend on it
        if (u === 'audio/manifest.json') return manifest ? { ok: true, status: 200, json: async () => manifest } : { ok: false, status: 404, json: async () => ({}) };
        const p = join(ROOT, u);
        if (!existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => { const d = JSON.parse(readFileSync(p, 'utf8')); return levelsPatch && /levels\.(es|ca)\.json$/.test(u) ? levelsPatch(d) : d; } };
      };
      // run the short UI timers immediately so a whole session fits in one test
      const st = w.setTimeout;
      w.setTimeout = (f, ms, ...a) => (ms >= 100 && ms <= 4000 ? (Promise.resolve().then(() => { try { f(); } catch (e) { errors.push('timer: ' + e.message); } }), 0) : st(f, ms, ...a));
      w.addEventListener('error', (e) => errors.push(e.message));
    },
  });
  const w = dom.window; wRef = w;
  if (onDom) onDom(w); // a test can observe the page from the start
  const p = w.eval(`(async()=>{'use strict';${appJs}\n})()`);
  p.catch((e) => errors.push('boot: ' + e.message));
  for (let i = 0; i < 100 && !w.document.getElementById('hello').textContent.startsWith('¡Hola') && !w.document.getElementById('hello').textContent.startsWith('Hola,'); i++) await sleep(20);
  await sleep(30);
  return { w, d: w.document, $: (id) => w.document.getElementById(id), errors, audioCalls, navs };
}

async function playSession(app, n, verdict = () => true) {
  for (let i = 0; i < n; i++) {
    if (!app.$('end').hidden) app.$('endMore').click();
    app.$('joinBtn').click(); await sleep(0);
    app.$(verdict() ? 'okBtn' : 'noBtn').click(); await sleep(5);
    if (!app.$('reward').hidden) app.$('rewardOk').click();
  }
}

const dump = (w) => Object.fromEntries(Array.from({ length: w.localStorage.length }, (_, i) => w.localStorage.key(i)).map((k) => [k, w.localStorage.getItem(k)]));

// ---------- 1. boot + structure ----------
let a = await boot();
check('boots without errors', a.errors.length === 0, a.errors.join(' | '));
check('default language is Spanish', a.$('hello').textContent === '¡Hola, Elsa!');
check('5 level chips', a.d.querySelectorAll('.level').length === 5);
a.$('worldBtn').click();
check('theme picker: Surprise + 16 worlds', a.d.querySelectorAll('#worldGrid .wbtn').length === 17);
a.$('worldsClose').click();

// ---------- 2. language switch ----------
a.$('langBtn').click();
check('Catalan UI', a.$('mSyl').textContent === 'Síl·labes' && a.$('joinBtn').textContent === 'Ajuntar');
check('Catalan greeting uses the name', a.$('hello').textContent === 'Hola, Elsa!');
a.$('langBtn').click();
check('back to Spanish', a.$('mSyl').textContent === 'Sílabas');

// ---------- 3. every level, both modes, both languages ----------
for (const lang of ['es', 'ca']) {
  if (a.d.documentElement.lang !== lang) a.$('langBtn').click();
  let bad = 0;
  for (let lv = 0; lv < 5; lv++) {
    a.d.querySelectorAll('.level')[lv].click();
    for (const m of ['mSyl', 'mWord']) {
      a.$(m).click();
      for (let i = 0; i < 15; i++) {
        if (!a.$('end').hidden) a.$('endMore').click();
        a.$('joinBtn').click();
        const tiles = [...a.d.querySelectorAll('#tiles .tile')].map((b) => b.textContent);
        if (!tiles.length || tiles.some((t) => !t)) bad++;
        a.$(Math.random() < 0.7 ? 'okBtn' : 'noBtn').click();
        await sleep(0);
        if (!a.$('reward').hidden) a.$('rewardOk').click();
      }
    }
  }
  check(`[${lang}] all levels/modes render non-empty tiles`, bad === 0);
}
check('no runtime errors across the run', a.errors.length === 0, a.errors.slice(0, 3).join(' | '));

// ---------- 4. the world is only scenery: it does not bias the words ----------
a = await boot();
a.d.querySelectorAll('.level')[2].click();
a.$('mWord').click();
a.$('worldBtn').click();
const worlds = readJSON('src/data/worlds.json');
const gi = worlds.findIndex((w) => w.id === 'granja');
a.d.querySelectorAll('#worldGrid .wbtn')[gi + 1].click();
const lv3 = readJSON('src/data/levels.es.json')[2].words;
let themed = 0; const N = 80;
for (let i = 0; i < N; i++) {
  if (!a.$('end').hidden) a.$('endMore').click();
  a.$('joinBtn').click();
  const word = [...a.d.querySelectorAll('#tiles .tile')].map((b) => b.textContent).join('');
  const entry = lv3.find((o) => o.w.replace(/-/g, '') === word);
  if (entry && (entry.g || '').split(' ').includes('granja')) themed++;
  a.$('okBtn').click(); await sleep(0);
  if (!a.$('reward').hidden) a.$('rewardOk').click();
}
check('word mode does not favour the words tagged with the current world (Granja is 10 of 60 words at level 3)', themed / N < 0.4, `${themed}/${N} themed`);
a = await boot();
a.$('worldBtn').click();
check('a new child starts with Sorpresa (the world rotates each session)', a.d.querySelectorAll('#worldGrid .wbtn')[0].getAttribute('aria-pressed') === 'true' && a.d.querySelectorAll('#worldGrid .wbtn')[1].getAttribute('aria-pressed') === 'false');

// ---------- 5. session end + stickers ----------
a = await boot();
await playSession(a, 10);
check('session-complete screen appears after 10', !a.$('end').hidden && /Sesión completada/.test(a.$('endTitle').textContent));
a.$('endStop').click();
check('"enough for today" leaves a goodbye message', /Hasta mañana/.test(a.$('hint').textContent));
check('sticker earned after completing a session', Number(a.$('albumCount').textContent) >= 1);

// ---------- 6. audio priority: generated clip beats browser voice ----------
const manifest = { generated: 'test', clips: { es: new Proxy({}, { get: (_, k) => (typeof k === 'string' ? 'x.mp3' : undefined) }), ca: {} } };
a = await boot({ manifest });
a.$('joinBtn').click();
check('generated clip is played when present', a.audioCalls.some((s) => s === 'audio/es/x.mp3'), a.audioCalls.join(','));
check('browser TTS not used when a clip exists', !(a.w.__tts || []).length);
a = await boot();
a.$('joinBtn').click();
check('falls back to browser TTS without clips', (a.w.__tts || []).length > 0);

// ---------- 7. data integrity ----------
const tags = new Set(worlds.map((w) => w.id));
let dataOk = true; const problems = [];
for (const l of ['es', 'ca']) {
  const levels = readJSON(`src/data/levels.${l}.json`);
  levels.forEach((L, i) => {
    const seen = new Set();
    L.words.forEach((o) => {
      if (seen.has(o.w)) problems.push(`dup ${l} N${i + 1} ${o.w}`);
      seen.add(o.w);
      (o.g || '').split(' ').filter(Boolean).forEach((g) => { if (!tags.has(g)) problems.push(`bad tag ${g} in ${o.w}`); });
    });
  });
}
const ies = readJSON('src/data/i18n.es.json'), ica = readJSON('src/data/i18n.ca.json');
Object.keys(ies).forEach((k) => { if (!(k in ica)) problems.push('missing ca key ' + k); });
Object.keys(ica).forEach((k) => { if (!(k in ies)) problems.push('missing es key ' + k); });
check('data: no duplicate words, unknown world tags or missing translations', problems.length === 0, problems.slice(0, 4).join(' | '));

// ---------- 8. profiles ----------
const elsaSaved = { name: 'Elsa', stickers: 3, total: 7, stats: { 's:ma': { ok: 2, fail: 0 } } };
a = await boot({ storage: { 'leemos-v1': elsaSaved } });
check('profiles: no profiles key behaves as Elsa alone', a.$('hello').textContent === '¡Hola, Elsa!' && a.$('profileName').textContent === 'Elsa');
a.$('profileBtn').click();
check('profiles: the overlay lists Elsa', !a.$('profiles').hidden && a.d.querySelectorAll('#profileList .wbtn').length === 1);
a.$('pfName').value = 'Mia'; a.$('pfKind').value = 'reader'; a.$('pfAdd').click();
const savedProfiles = JSON.parse(a.w.localStorage.getItem('leemos-profiles'));
check('profiles: adding a child stores it and makes it active', savedProfiles.active === 'mia' && savedProfiles.list.length === 2 && savedProfiles.list[1].kind === 'reader', JSON.stringify(savedProfiles));
const elsaKept = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
check("profiles: Elsa's saved state is untouched", elsaKept.stickers === 3 && elsaKept.total === 7 && elsaKept.name === 'Elsa' && elsaKept.stats['s:ma'].ok === 2);

a = await boot({ storage: dump(a.w) });
check('profiles: reboot loads the new child with their own name', a.$('hello').textContent === '¡Hola, Mia!');
await playSession(a, 1);
const miaSaved = JSON.parse(a.w.localStorage.getItem('leemos-v1:mia'));
const elsaAfter = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
check("profiles: progress goes to the active child's own key", miaSaved.total === 1 && elsaAfter.total === 7 && elsaAfter.stickers === 3);
a.$('nm').value = 'Mía'; a.$('nm').dispatchEvent(new a.w.Event('input'));
check('profiles: renaming updates the chip and the stored list', a.$('profileName').textContent === 'Mía' && JSON.parse(a.w.localStorage.getItem('leemos-profiles')).list[1].name === 'Mía');

// Review Focus 3: corrupt or hostile stores fall back to Elsa and never throw.
const badStores = [
  ['invalid JSON', '{nope'],
  ['active not in the list', JSON.stringify({ active: 'zzz', list: [{ id: 'leo', name: 'Leo', kind: 'pre' }] })],
  ['empty list', JSON.stringify({ active: 'elsa', list: [] })],
  ['non-string id', JSON.stringify({ active: 'x', list: [{ id: 5, name: 'X', kind: 'reader' }] })],
];
for (const [label, bad] of badStores) {
  const b = await boot({ storage: { 'leemos-profiles': bad } });
  check(`profiles: ${label} falls back to Elsa`, b.$('hello').textContent === '¡Hola, Elsa!' && b.errors.length === 0, b.errors.join(' | '));
}
a = await boot({ storage: { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader' }, { id: 'x', name: '<b>x</b>', kind: 'reader' }] } } });
a.$('profileBtn').click();
check('profiles: names are rendered as text, never as HTML', a.d.querySelectorAll('#profileList b').length === 0 && a.d.querySelectorAll('#profileList .wbtn')[1].textContent.includes('<b>x</b>'));

// ---------- 9. letter sounds: home, intro, game ----------
const LEO = { 'leemos-profiles': { active: 'leo', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader' }, { id: 'leo', name: 'Leo', kind: 'pre' }] } };
const allEs = readJSON('src/data/sounds.es.json').groups.flatMap((g) => g.letters);
const manifestAny = { generated: 'test', clips: { es: new Proxy({}, { get: (_, k) => (typeof k === 'string' ? 'x.mp3' : undefined) }), ca: {} } };
const until = async (fn, ms = 2000) => { for (let i = 0; i < ms / 20; i++) { if (fn()) return true; await sleep(20); } return false; };
const bootLeo = async (extra = {}) => { const x = await boot({ storage: LEO, ...extra }); x.w.__audioMode = 'auto'; await until(() => x.$('prePlay')); return x; }; // Leo's sounds are heard at once unless a test says otherwise
const choice = (app, l) => [...app.d.querySelectorAll('.pre-choice')].find((b) => b.dataset.l === l);
async function playPre(app, n, { right = true } = {}) {
  for (let i = 0; i < n; i++) {
    if (app.$('preNext')) app.$('preNext').click();
    const l = app.$('preChoices').dataset.answer;
    if (right) choice(app, l).click();
    else { [...app.d.querySelectorAll('.pre-choice')].find((b) => b.dataset.l !== l).click(); choice(app, l).click(); }
    await sleep(5);
    if (!app.$('reward').hidden) app.$('rewardOk').click();
  }
}

a = await bootLeo({ manifest: manifestAny });
check('sounds: Leo boots into the sounds home without errors', a.errors.length === 0 && a.d.documentElement.classList.contains('pre') && !!a.$('prePlay'), a.errors.join(' | '));
check('sounds: greeting and progress use Leo and the letter total', a.$('hello').textContent === '¡Hola, Leo!' && a.$('hint').textContent.includes('Leo') && a.d.querySelector('#pre .small').textContent === `0 de ${allEs.length} letras dominadas`, a.d.querySelector('#pre .small').textContent);
check('sounds: the session is 5 exercises by default', a.$('slabel').textContent === '0 de 5');
a.$('prePlay').click();
check('sounds: the first exercise is an intro card', !!a.$('preLetter') && !!a.$('preWord') && !!a.$('preNext'));
const l0 = a.$('preLetter').getAttribute('aria-label');
const e0 = allEs.find((x) => x.l === l0);
check('sounds: intro shows upper and lower case and the picture word', a.$('preLetter').textContent === l0.toUpperCase() + l0 && a.$('preWord').textContent.includes(e0.w) && a.$('preWord').textContent.includes(e0.e));
const callsBefore = a.audioCalls.length;
a.$('preLetter').click();
check('sounds: tapping the letter plays its sound', a.audioCalls.length === callsBefore + 1 && a.audioCalls.at(-1) === 'audio/es/x.mp3');
a.$('preNext').click();
// Review Focus 2: first exercise, nothing seen except the target.
const opts0 = [...a.d.querySelectorAll('.pre-choice')];
check('sounds: a new letter gets exactly 2 distinct choices including the answer', opts0.length === 2 && new Set(opts0.map((b) => b.dataset.l)).size === 2 && opts0.some((b) => b.dataset.l === l0) && a.$('preChoices').dataset.answer === l0);
check('sounds: the picture stays hidden until the right answer', !a.$('prePic'));
const wrongBtn = opts0.find((b) => b.dataset.l !== l0);
wrongBtn.click();
const st = () => JSON.parse(a.w.localStorage.getItem('leemos-v1:leo')).stats['snd:' + l0];
check('sounds: a wrong tap fades that choice, counts one fail, keeps the exercise open', wrongBtn.disabled && wrongBtn.classList.contains('gone') && st().fail === 1 && a.$('slabel').textContent === '0 de 5');
check('sounds: the hard list shows the bare letter', a.d.querySelector('#hard .chip')?.textContent === l0, a.d.querySelector('#hard').textContent);
choice(a, l0).click();
check('sounds: the right answer reveals the picture and counts the exercise', !!a.$('prePic') && a.$('slabel').textContent === '1 de 5');
check('sounds: the picture takes the place of the speaker button (same slot, so the screen does not grow and game mode never scrolls)', !a.$('preHear') && a.$('prePic').nextElementSibling === a.$('preChoices') && a.$('prePic').parentElement === a.$('preChoices').parentElement);
check('sounds: an exercise that needed a retry adds no ok', st().ok === 0 && st().fail === 1);
await sleep(5);

// Review Focus 4: mashing.
a = await bootLeo();
a.$('prePlay').click(); a.$('preNext').click();
const ans = a.$('preChoices').dataset.answer;
const good = choice(a, ans);
good.click(); good.click(); good.click();
check('sounds: mashing the right answer counts once', a.$('slabel').textContent === '1 de 5' && JSON.parse(a.w.localStorage.getItem('leemos-v1:leo')).stats['snd:' + ans].ok === 1);
a = await bootLeo();
a.$('prePlay').click(); await playPre(a, 4);
const seenLetters = Object.keys(JSON.parse(a.w.localStorage.getItem('leemos-v1:leo')).stats);
check('sounds: at most 2 new letters are introduced per session', seenLetters.length === 2, seenLetters.join(','));
check('sounds: the whole run raised no errors', a.errors.length === 0, a.errors.join(' | '));

// ---------- 10. letter sounds: end of session, unlock, language, recorder, reset ----------
const mast = (n) => ({ ok: n, fail: 0 });
a = await bootLeo();
a.$('prePlay').click();
await playPre(a, 5);
await sleep(10);
check('sounds: finishing a session shows the end screen and a sticker', !a.$('end').hidden && Number(a.$('albumCount').textContent) === 1);
check('sounds: the end text counts first-try answers', a.$('endInfo').textContent.startsWith('Has acertado 5 de 5.'), a.$('endInfo').textContent);
check('sounds: no group unlock is offered after one session', a.$('endLevelUpBtn').hidden);
a.$('endStop').click();
check('sounds: "enough for today" returns to the home with a goodbye', !!a.$('prePlay') && /Hasta mañana, Leo/.test(a.$('hint').textContent), a.$('hint').textContent);

a = await boot({ storage: { ...LEO, 'leemos-v1:leo': { name: 'Leo', stats: { 'snd:a': mast(3), 'snd:e': mast(3), 'snd:i': mast(3), 'snd:o': mast(3) } } } });
await until(() => a.$('prePlay'));
a.$('prePlay').click(); await playPre(a, 5); await sleep(10);
check('sounds: with most of the group mastered, the next group is offered', !a.$('endLevelUpBtn').hidden && a.$('endLevelUpBtn').textContent === 'Sí, letras nuevas', a.$('endLevelUpBtn').textContent);
a.$('endLevelUpBtn').click();
check('sounds: accepting unlocks the next group and starts a new session', JSON.parse(a.w.localStorage.getItem('leemos-v1:leo')).pre.es === 1 && a.$('end').hidden && !!(a.$('preLetter') || a.$('preChoices')));

// Review Focus 5a: last group fully mastered.
a = await boot({ storage: { ...LEO, 'leemos-v1:leo': { name: 'Leo', pre: { es: 5, ca: 0 }, stats: Object.fromEntries(allEs.map((x) => ['snd:' + x.l, mast(3)])) } } });
await until(() => a.$('prePlay'));
a.$('prePlay').click(); await playPre(a, 5); await sleep(10);
check('sounds: a mastered last group offers no unlock and raises no error', !a.$('end').hidden && a.$('endLevelUpBtn').hidden && a.errors.length === 0, a.errors.join(' | '));

// Review Focus 5b: language switch keeps per-language progress.
a = await bootLeo();
a.$('langBtn').click(); await sleep(10);
check('sounds: switching language rebuilds the home in Catalan', !!a.$('prePlay') && /lletres dominades/.test(a.d.querySelector('#pre .small').textContent), a.d.querySelector('#pre .small')?.textContent);
a.$('prePlay').click(); await playPre(a, 1);
const caKeys = Object.keys(JSON.parse(a.w.localStorage.getItem('leemos-v1:leo')).stats);
check('sounds: Catalan progress is stored under the ca: prefix only', caKeys.length >= 1 && caKeys.every((k) => k.startsWith('ca:snd:')), caKeys.join(','));

a = await bootLeo();
a.$('recOpen').click();
check('sounds: the recorder lists the letter sounds first, then the picture words', a.$('recText').textContent === allEs[0].l && a.$('recCount').textContent.startsWith(`1 de ${allEs.length * 2}`) && /Sonidos de las letras/.test(a.$('recWorld').textContent), a.$('recCount').textContent);

a = await bootLeo();
a.$('prePlay').click(); await playPre(a, 2);
a.$('resetBtn').click(); a.$('resetBtn').click();
check('sounds: reset clears this language and returns to the home', Object.keys(JSON.parse(a.w.localStorage.getItem('leemos-v1:leo')).stats).length === 0 && !!a.$('prePlay'));
check('sounds: Elsa tests above and this run stayed error-free', a.errors.length === 0, a.errors.join(' | '));

// ---------- 11. fixes from the final review ----------
// Stale timers must not resurrect a screen after a language switch.
a = await bootLeo();
a.$('prePlay').click(); a.$('preNext').click();
choice(a, a.$('preChoices').dataset.answer).click();
a.$('langBtn').click();
await sleep(10);
check('review: a pending next-exercise timer does not start a game after a language switch', !!a.$('prePlay') && !a.$('preChoices') && a.d.body.classList.contains('pre-home'));
a = await bootLeo();
a.$('prePlay').click(); await playPre(a, 4);
a.$('preNext')?.click();
choice(a, a.$('preChoices').dataset.answer).click();
a.$('langBtn').click();
await sleep(10);
check('review: a pending reward/end timer does not pop over the home after a language switch', a.$('reward').hidden && a.$('end').hidden && !!a.$('prePlay'));

// Elsa keeps offline audio after a service-worker cache bump: warm again when the cache lost the files.
const warmManifest = { generated: 'g1', clips: { es: { ma: 'ma.mp3' }, ca: {} } };
a = await boot({ manifest: warmManifest, swMock: { cached: false }, storage: { 'leemos-v1': { warmed: 'g1' } } });
await sleep(30);
check('review: audio is re-downloaded when the cache no longer holds it', a.w.__fetched.includes('audio/es/ma.mp3'), a.w.__fetched.join(','));
a = await boot({ manifest: warmManifest, swMock: { cached: true }, storage: { 'leemos-v1': { warmed: 'g1' } } });
await sleep(30);
check('review: nothing is re-downloaded when the cache already holds the audio', !a.w.__fetched.includes('audio/es/ma.mp3'), a.w.__fetched.join(','));

// A parent hint when the unlocked consonants have neither a clip nor a recording.
const LEO_MSLP = { ...LEO, 'leemos-v1:leo': { name: 'Leo', pre: { es: 1, ca: 0 } } };
a = await boot({ storage: LEO_MSLP }); await until(() => a.$('prePlay'));
check('review: a parent hint appears when consonant sounds have no audio', !!a.$('preNotice'));
a = await boot({ storage: LEO_MSLP, manifest: manifestAny }); await until(() => a.$('prePlay'));
check('review: no hint when the sounds have clips', !a.$('preNotice'));
a = await bootLeo();
check('review: no hint for the vowels alone (the voice reads them correctly)', !a.$('preNotice'));

// ---------- 12. deferred minors from the final review ----------
// A partly corrupt profile store keeps its valid entries; hostile fields are sanitised.
a = await boot({ storage: { 'leemos-profiles': { active: 'leo', list: [{ id: 'leo', name: 'Leo', kind: 'pre' }, { id: 5 }, null] } } });
await until(() => a.$('prePlay'));
check('minor: a partly corrupt store keeps the valid profiles', a.$('hello').textContent === '¡Hola, Leo!' && !!a.$('prePlay') && a.errors.length === 0, a.errors.join(' | '));
a = await boot({ storage: { 'leemos-profiles': { active: 'x', list: [{ id: 'x', name: 123, kind: 'reader' }, { id: 'y', name: {}, kind: 'pre' }, { id: 'z', kind: 'weird' }] } } });
a.$('profileBtn').click();
check('minor: non-string names and unknown kinds are sanitised', a.errors.length === 0 && a.$('profileName').textContent === 'x' && a.d.querySelectorAll('#profileList .wbtn').length === 3, a.errors.join(' | '));
// If sounds.js cannot load, show the normal screen instead of a blank stage.
a = await boot({ storage: LEO, importFails: true });
await sleep(50);
check('minor: a failed sounds.js import falls back to the normal screen', !a.d.documentElement.classList.contains('pre') && !a.$('joinBtn').hidden && a.errors.length === 0, a.errors.join(' | '));

// The unlock button is not the big primary one, so a child tapping the first big button just plays again.
a = await boot({ storage: { ...LEO, 'leemos-v1:leo': { name: 'Leo', stats: { 'snd:a': mast(3), 'snd:e': mast(3), 'snd:i': mast(3), 'snd:o': mast(3) } } } });
await until(() => a.$('prePlay'));
a.$('prePlay').click(); await playPre(a, 5); await sleep(10);
check('minor: for Leo the unlock button is secondary and "Otra sesión" is primary and focused', !a.$('endLevelUpBtn').hidden && !a.$('endLevelUpBtn').classList.contains('primary') && a.$('endMore').classList.contains('primary') && a.d.activeElement === a.$('endMore'));

// Parents switch profile from their panel; the child cannot reach the chip.
a = await bootLeo();
check('minor: Leo has the profile chip on his home screen (an adult switches there) and the parents panel keeps its switch button', !a.$('profileBtn').hidden && a.d.body.classList.contains('pre-home') && !!a.$('profileOpen'));
a.$('profileOpen').click();
check('minor: the parents-panel button opens the profile sheet', !a.$('profiles').hidden);
a = await boot();
check('minor: readers keep the chip', !a.$('profileBtn').hidden);

// An intro card that is abandoned does not count the letter as seen.
a = await bootLeo();
a.$('prePlay').click();
a.$('langBtn').click(); await sleep(10);
const savedLeo = a.w.localStorage.getItem('leemos-v1:leo');
check('minor: leaving an intro card does not mark the letter as seen', !savedLeo || Object.keys(JSON.parse(savedLeo).stats || {}).length === 0, savedLeo);

// Neutral wording for Leo.
a = await boot({ storage: { ...LEO, 'leemos-v1:leo': { name: 'Leo', sessionLen: 100 } } });
await until(() => a.$('prePlay'));
a.$('prePlay').click();
let lectora = 0;
for (let i = 0; i < 60; i++) {
  if (a.$('preNext')) a.$('preNext').click();
  choice(a, a.$('preChoices').dataset.answer).click();
  if (/lectora/.test(a.$('hint').textContent)) lectora++;
  await sleep(5);
}
check('minor: praise shown to Leo never says "lectora"', lectora === 0, `${lectora}/60`);
a = await bootLeo();
a.$('nm').value = ''; a.$('nm').dispatchEvent(new a.w.Event('input'));
check('minor: with the name cleared Leo is greeted by his profile name, not "campeona"', a.$('hello').textContent === '¡Hola, Leo!', a.$('hello').textContent);

// Focus follows the screen (keyboard and switch users).
a = await bootLeo();
check('minor: the home focuses Jugar', a.d.activeElement === a.$('prePlay'));
a.$('prePlay').click();
check('minor: the intro card focuses Siguiente', a.d.activeElement === a.$('preNext'));
a.$('preNext').click();
check('minor: the game focuses the hear button', a.d.activeElement === a.$('preHear'));
[...a.d.querySelectorAll('.pre-choice')].find((b) => b.dataset.l !== a.$('preChoices').dataset.answer).click();
check('minor: after a wrong tap focus moves to an enabled choice', !!a.d.activeElement && a.d.activeElement.classList.contains('pre-choice') && !a.d.activeElement.disabled);

// ---------- 13. recorder: live level bar and silence check ----------
const recStart = async (micCfg) => { const x = await boot({ mic: micCfg }); x.$('recOpen').click(); x.$('recBtn').click(); await sleep(60); return x; };
a = await recStart({ peak: 0.2 });
check('recorder: the level bar shows and follows the input while recording', !a.$('recMeter').hidden && a.$('recMeterFill').style.width === '60%', a.$('recMeterFill').style.width);
check('recorder: a dot beside the level bar shows that the microphone is on, even when the bar is flat (decorative for screen readers: the status says it)', !a.$('recDot').hidden && a.$('recDot').getAttribute('aria-hidden') === 'true' && /Grabando/.test(a.$('recStatus').textContent), a.$('recStatus').textContent);
a.$('recBtn').click(); await sleep(30);
check('recorder: a recording with sound is saved', a.$('recStatus').textContent === 'Guardada ✓' && /ya grabada/.test(a.$('recCount').textContent), a.$('recStatus').textContent);
check('recorder: the level bar hides when recording stops', a.$('recMeter').hidden);
check('recorder: and so does the dot', a.$('recDot').hidden);
{ const c = await boot(); c.$('recOpen').click(); check('recorder: before recording the dot is not there', c.$('recDot').hidden); }
check('recorder: the dot sits in the same row as the bar, and its pulse stops with reduced motion', /rec-row/.test(a.$('recMeter').parentElement.className) && /\.rec-dot\{animation:none\}|\.rec-dot,[^}]*animation:none/.test(readFileSync(join(ROOT, 'src/styles.css'), 'utf8').replace(/\s+/g, '')) , a.$('recMeter').parentElement.className);
a = await recStart({ peak: 0 });
a.$('recBtn').click(); await sleep(30);
check('recorder: a silent recording is rejected with a hint about the microphone', /No se oyó nada/.test(a.$('recStatus').textContent) && !/ya grabada/.test(a.$('recCount').textContent) && a.$('recPlay').hidden, a.$('recStatus').textContent);
// The silence check needs evidence: a suspended AudioContext or an analyser without sample data reads zeros, not silence.
a = await recStart({ peak: 0, state: 'suspended' });
a.$('recBtn').click(); await sleep(30);
check('recorder: a suspended AudioContext never rejects a recording as silent', a.$('recStatus').textContent === 'Guardada ✓', a.$('recStatus').textContent);
a = await recStart({ peak: 0, noFloat: true });
a.$('recBtn').click(); await sleep(30);
check('recorder: an analyser without sample data never rejects a recording as silent', a.$('recStatus').textContent === 'Guardada ✓', a.$('recStatus').textContent);
a = await boot({ mic: { deny: true } }); a.$('recOpen').click(); a.$('recBtn').click(); await sleep(30);
check('recorder: a refused microphone still shows the permission message', /No pude usar el micrófono/.test(a.$('recStatus').textContent), a.$('recStatus').textContent);

// ---------- 14. clip revisions: a re-recorded or regenerated clip must be fetched again by installed devices ----------
const revManifest = { generated: 'g2', clips: { es: { a: 'a.mp3', e: 'e.mp3', i: 'i.mp3', o: 'o.mp3', u: 'u.mp3', ma: 'ma.mp3' }, ca: {} }, rev: { es: { a: 11, e: 12, i: 13, o: 14, u: 15 } } };
a = await bootLeo({ manifest: revManifest });
a.$('prePlay').click();
const l14 = a.$('preLetter').getAttribute('aria-label');
check('revisions: a clip with a revision is played from a versioned URL', a.audioCalls.at(-1) === `audio/es/${l14}.mp3?v=${revManifest.rev.es[l14]}`, a.audioCalls.at(-1));
a = await boot({ manifest: revManifest, swMock: { cached: false }, storage: { 'leemos-v1': { warmed: 'g2' } } });
await sleep(30);
check('revisions: warming the cache uses the same versioned URLs', a.w.__fetched.includes('audio/es/a.mp3?v=11') && a.w.__fetched.includes('audio/es/ma.mp3'), a.w.__fetched.filter((u) => u.startsWith('audio/es')).join(','));

// ---------- 15. optional pictures ----------
a = await boot({ levelsPatch: (d) => { d[0].words = [{ w: 'ma-mi' }]; return d; } }); // level 1 with a single picture-less word
a.$('mWord').click();
check('pictures: a word without an emoji shows no picture slot before reading', a.$('pic').hidden === true);
a.$('joinBtn').click();
check('pictures: ... and none after reading it', a.$('pic').hidden === true);
a = await boot();
a.$('mWord').click();
check('pictures: a word with an emoji still shows the "?" slot before reading', a.$('pic').hidden === false && a.$('pic').textContent === '?');
a.$('joinBtn').click();
check('pictures: ... and its picture after reading', a.$('pic').hidden === false && a.$('pic').textContent !== '?' && a.$('pic').textContent.length > 0);

// ---------- 16. the new inverse syllables render as non-empty tiles ----------
const INV = [...'aeiou'].flatMap((v) => [...'mctpb'].map((c) => v + c));
a = await boot({ levelsPatch: (d) => { d[0].syl = INV; return d; } }); // level 1 holds only the 25 inverse syllables
const shown = new Set(); let emptyTile = 0;
for (let i = 0; i < 80; i++) {
  if (!a.$('end').hidden) a.$('endMore').click();
  const tiles = [...a.d.querySelectorAll('#tiles .tile')].map((b) => b.textContent);
  if (!tiles.length || tiles.some((t) => !t)) emptyTile++;
  shown.add(tiles.join(''));
  a.$('joinBtn').click(); a.$('okBtn').click(); await sleep(0);
  if (!a.$('reward').hidden) a.$('rewardOk').click();
}
check('syllables: every shown inverse syllable has non-empty tiles and belongs to the series', emptyTile === 0 && [...shown].every((s) => INV.includes(s)) && shown.size >= 20, `${shown.size} distinct, ${emptyTile} empty`);

// ---------- 17. capitals by default, one-time switch for existing readers ----------
a = await boot();
check('capitals: a new profile starts in capitals', a.d.body.classList.contains('upper') && a.$('caseBtn').getAttribute('aria-pressed') === 'true');
a = await boot({ storage: { 'leemos-v1': { name: 'Elsa', upper: false, total: 4 } } });
check('capitals: an existing lowercase reader is switched to capitals once', a.d.body.classList.contains('upper') && JSON.parse(a.w.localStorage.getItem('leemos-v1')).upper === true && JSON.parse(a.w.localStorage.getItem('leemos-v1')).upperMigrated === true);
a.$('caseBtn').click();
check('capitals: she can switch back to lowercase', !a.d.body.classList.contains('upper') && JSON.parse(a.w.localStorage.getItem('leemos-v1')).upper === false);
a = await boot({ storage: dump(a.w) });
check('capitals: the switch does not fire again after she chose lowercase', !a.d.body.classList.contains('upper') && JSON.parse(a.w.localStorage.getItem('leemos-v1')).upper === false);
a = await boot({ storage: { 'leemos-v1': { name: 'Elsa', upper: false, upperMigrated: 'yes' } } });
check('capitals: an odd saved flag is treated as already migrated and never throws', !a.d.body.classList.contains('upper') && a.errors.length === 0, a.errors.join(' | '));
a = await boot({ storage: { ...LEO, 'leemos-v1:leo': { name: 'Leo', upper: false } } });
await until(() => a.$('prePlay'));
const leoRaw = a.w.localStorage.getItem('leemos-v1:leo');
check("capitals: Leo's profile is never migrated", !leoRaw || JSON.parse(leoRaw).upperMigrated === undefined, leoRaw);

// ---------- 18. Lumi speaks her instruction sentences (generated clip only, never the browser voice) ----------
const HINT_KEYS = ['Elsa, lee la sílaba en voz alta. Luego pulsa «Juntar».', 'Elsa, lee cada sílaba y únelas. Toca una para oírla.', '¡Escucha! Ahora papá o mamá me dicen cómo te salió.'].map((s) => s.toLowerCase());
const hintManifest = { generated: 'test', clips: { es: Object.fromEntries(HINT_KEYS.map((k) => [k, 'h.mp3'])), ca: {} } };
const hintPlays = (x) => x.audioCalls.filter((s) => s === 'audio/es/h.mp3').length;
a = await boot({ manifest: hintManifest });
check("hint: Lumi's first sentence of the session plays by itself", hintPlays(a) === 1, String(hintPlays(a)));
a.$('hint').click();
check('hint: tapping the bubble plays it again', hintPlays(a) === 2, String(hintPlays(a)));
a.$('joinBtn').click();
a.$('hint').click();
check('hint: in the judging phase the bubble says the judging sentence', hintPlays(a) === 3, String(hintPlays(a)));
a.$('okBtn').click();
const afterFirst = hintPlays(a);
check('hint: the next exercise does not repeat the sentence by itself', afterFirst === 3, String(afterFirst));
a = await boot();
a.$('hint').click();
check('hint: with no clip the bubble stays silent (no robotic browser voice)', !(a.w.__tts || []).length && !a.audioCalls.length, `tts=${(a.w.__tts || []).length} audio=${a.audioCalls.length}`);

// ---------- 19. Lumi talks: big on tap, small and quiet on the automatic one ----------
const lastAudio = (x) => x.w.__audios[x.w.__audios.length - 1];
const hintText = (x) => x.$('hint').textContent;
a = await boot({ manifest: hintManifest });
check('lumi: the automatic sentence moves the small Lumi only (no zoom)', a.$('lumiBig').hidden && a.$('mascot').classList.contains('talking'));
lastAudio(a).onended();
check('lumi: the small Lumi stops talking when the clip ends', !a.$('mascot').classList.contains('talking'));
a.$('hint').click();
check('lumi: tapping the bubble opens the big Lumi with the sentence under him', !a.$('lumiBig').hidden && a.$('lumiBigText').textContent === hintText(a) && !!a.$('lumiBigArt').querySelector('svg') && a.$('lumiBig').classList.contains('talking'));
check('lumi: the big copy is hidden from screen readers and has no duplicate id', a.$('lumiBigArt').querySelector('svg').getAttribute('aria-hidden') === 'true' && a.d.querySelectorAll('#mascot').length === 1);
lastAudio(a).onended();
check('lumi: the big Lumi goes back when the clip ends', await until(() => a.$('lumiBig').hidden));
a.$('mascot').dispatchEvent(new a.w.MouseEvent('click', { bubbles: true })); // SVG elements have no .click()
check('lumi: tapping Lumi himself opens him too', !a.$('lumiBig').hidden);
a.$('lumiBig').click();
check('lumi: tapping anywhere closes him and stops the audio', (await until(() => a.$('lumiBig').hidden)) && lastAudio(a).paused === true);
a = await boot();
a.$('hint').click();
check('lumi: with no clip nothing opens and nothing talks', a.$('lumiBig').hidden && !a.$('mascot').classList.contains('talking'));
a = await boot({ manifest: hintManifest, reduced: true });
a.$('hint').click();
check('lumi: reduced motion opens him without the zoom', !a.$('lumiBig').hidden && a.$('lumiBig').classList.contains('still') && !a.$('lumiBigArt').style.transform, a.$('lumiBigArt').style.transform);

// ---------- 20. the beak follows the loudness of the clip ----------
const jawOf = (x) => parseFloat(x.$('lumiBigArt').querySelector('svg').style.getPropertyValue('--jaw') || '0');
const maxJaw = async (x, ms) => { let m = 0; for (let i = 0; i < ms / 20; i++) { m = Math.max(m, jawOf(x)); await sleep(20); } return m; }; // the beak moves, so look over a window
a = await boot({ manifest: hintManifest, voice: { sample: 128 + 90 } });
a.$('hint').click();
const loud = await maxJaw(a, 300);
check('beak: a loud voice opens it wide', loud > 0.8, String(loud));
a = await boot({ manifest: hintManifest, voice: { sample: 128 } });
a.$('hint').click();
const quiet = await maxJaw(a, 300);
check('beak: silence keeps it closed', quiet < 0.05, String(quiet));
a = await boot({ manifest: hintManifest, voice: { sample: 128, state: 'suspended' } });
a.$('hint').click();
const fallback = await maxJaw(a, 400);
check('beak: with a suspended audio context the clip is not rerouted and the beak still moves', fallback > 0, String(fallback));

a = await boot({ manifest: hintManifest, voice: { sample: 128 + 90 } });
check('beak: the automatic sentence creates no audio context (one made without a tap stays suspended)', !(a.w.__acs || []).length, String((a.w.__acs || []).length));
a.$('hint').click();
check('beak: a tap creates it', (a.w.__acs || []).length === 1, String((a.w.__acs || []).length));

// ---------- 21. Lumi comes big for his praise too (each answer, the sticker, the end of the session) ----------
const praiseManifest = { generated: 'test', clips: { es: new Proxy({}, { get: (_, k) => (typeof k === 'string' ? 'x.mp3' : undefined) }), ca: {} } };
const fillElsa = (list) => list.map((s) => s.replace('{n}', 'Elsa'));
a = await boot({ manifest: praiseManifest });
a.$('joinBtn').click(); a.$('noBtn').click();
await sleep(300);
check('praise: after a wrong answer Lumi comes big with the encouragement', !a.$('lumiBig').hidden && fillElsa(ies.nos).includes(a.$('lumiBigText').textContent), a.$('lumiBigText').textContent);
a = await boot({ manifest: praiseManifest });
a.w.Math.random = () => 0.1; // the praise after a right answer plays 60% of the time
a.$('joinBtn').click(); a.$('okBtn').click();
await sleep(300);
check('praise: after a right answer Lumi comes big with the praise', !a.$('lumiBig').hidden && fillElsa(ies.oks).includes(a.$('lumiBigText').textContent), a.$('lumiBigText').textContent);
a = await boot({ manifest: praiseManifest });
await playSession(a, 9);
a.$('joinBtn').click(); await sleep(0); a.$('okBtn').click(); // the 10th answer, by hand: playSession would close the sticker at once
await until(() => !a.$('reward').hidden);
await sleep(20);
check('praise: the sticker brings Lumi big with its title', !a.$('lumiBig').hidden && a.$('lumiBigText').textContent === a.$('rewardTitle').textContent, a.$('lumiBigText').textContent);
a.$('rewardOk').click();
await until(() => !a.$('end').hidden);
await sleep(20);
check('praise: the end of the session brings Lumi big with its title', !a.$('lumiBig').hidden && a.$('lumiBigText').textContent === a.$('endTitle').textContent, a.$('lumiBigText').textContent);
a = await boot();
a.$('joinBtn').click(); a.$('noBtn').click();
await sleep(300);
check('praise: with no clip there is no zoom (the browser voice speaks as before)', a.$('lumiBig').hidden && (a.w.__tts || []).length > 0);

// ---------- 22. state for sync: profile rid, reset counters, modAt only when progress changes ----------
const RID1 = '11111111-1111-4111-8111-111111111111';
a = await boot({ storage: { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader', rid: RID1 }, { id: 'leo', name: 'Leo', kind: 'pre', rid: 'not-a-uuid' }] } } });
a.$('pfName').value = 'Ana'; a.$('pfAdd').click(); // adding a child saves the profile list (and reloads the page, which jsdom ignores)
const savedList = JSON.parse(a.w.localStorage.getItem('leemos-profiles')).list;
check('sync state: a valid rid survives loading and saving the profile list', savedList.find((p) => p.id === 'elsa').rid === RID1, JSON.stringify(savedList));
check('sync state: an invalid rid is dropped', !savedList.some((p) => p.rid === 'not-a-uuid') && !('rid' in savedList.find((p) => p.id === 'leo')), JSON.stringify(savedList));

a = await boot({ storage: { 'leemos-profiles': { active: 'leo', list: [{ id: 'leo', name: 'Leo', kind: 'pre' }] } } });
a.$('profileOpen').click(); a.$('pfSwitch').click();
check('profiles: a sounds-only child can be switched to reader (and back)', JSON.parse(a.w.localStorage.getItem('leemos-profiles')).list[0].kind === 'reader');

a = await boot();
a.$('joinBtn').click(); a.$('okBtn').click();
const st1 = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
check('sync state: answering stamps modAt and the counters', st1.modAt > 0 && st1.total === 1, JSON.stringify({ m: st1.modAt, t: st1.total }));
a.$('themeBtn').click();
check('sync state: changing the theme does not touch modAt', JSON.parse(a.w.localStorage.getItem('leemos-v1')).modAt === st1.modAt);
a.$('sessionSel').value = '15'; a.$('sessionSel').dispatchEvent(new a.w.Event('change'));
check('sync state: changing the session length does not touch modAt', JSON.parse(a.w.localStorage.getItem('leemos-v1')).modAt === st1.modAt);
a.$('resetBtn').click(); a.$('resetBtn').click();
const st3 = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
check('sync state: "Borrar progreso" counts a reset for the current language only', st3.resets.es === 1 && st3.resets.ca === 0 && st3.modAt >= st1.modAt, JSON.stringify(st3.resets));
check('sync state: the reset deleted the Spanish counters', !Object.keys(st3.stats).some((k) => k.indexOf('ca:') !== 0));
a = await boot({ storage: { 'leemos-v1': { name: 'Elsa', total: 3, stats: { 's:ma': { ok: 1, fail: 0 } }, modAt: 0 } } });
const old = JSON.parse(a.w.localStorage.getItem('leemos-v1') || '{}');
check('sync state: loading an old saved state does not stamp modAt by itself', !old.modAt);

// ---------- 23. account block: hidden without config, zero Supabase traffic until the adult signs in ----------
const CFG = { url: 'https://x.supabase.co', anonKey: 'anon' };
let supa = createFakeSupabase();
a = await boot({ supa });
a.$('parents').open = true; a.$('parents').dispatchEvent(new a.w.Event('toggle'));
await sleep(30);
check('account: with an empty config the account block stays hidden', a.$('acct').hidden);
check('account: and nothing was sent to Supabase', supa.log.length === 0);

supa = createFakeSupabase();
a = await boot({ supa, syncConfig: CFG });
check('account: a configured app that was never signed in sends nothing at start', supa.log.length === 0);
a.$('parents').open = true; a.$('parents').dispatchEvent(new a.w.Event('toggle'));
await until(() => !a.$('acct').hidden);
check("account: opening the parents' panel shows the sign-in block", !a.$('acct').hidden && !a.$('acctOut').hidden && a.$('acctIn').hidden);
check('account: and still nothing was sent to Supabase', supa.log.length === 0, supa.log.join(' | '));

a.$('acctEmail').value = 'mama@example.com';
a.$('acctSend').click();
await sleep(20);
check('account: sending a code without accepting the consent is refused and sends nothing', supa.log.length === 0 && a.$('acctMsg').textContent.length > 0 && a.$('acctCodeRow').hidden);
a.$('acctEmail').value = 'not-an-email';
a.$('acctConsent').checked = true;
a.$('acctSend').click();
await sleep(20);
check('account: an invalid email is refused locally', supa.log.length === 0 && a.$('acctCodeRow').hidden);
a.$('acctEmail').value = 'mama@example.com';
a.$('acctSend').click();
await until(() => !a.$('acctCodeRow').hidden);
check('account: a valid email and consent request the code and reveal the code field', supa.log.includes('POST /auth/v1/otp') && !a.$('acctCodeRow').hidden);
a.$('acctCode').value = '000000';
a.$('acctVerify').click();
await sleep(30);
check('account: a wrong code shows a message and stays signed out', a.$('acctIn').hidden && /código/i.test(a.$('acctMsg').textContent), a.$('acctMsg').textContent);
a.$('acctCode').value = '123456';
a.$('acctVerify').click();
await until(() => !a.$('acctIn').hidden);
check('account: the right code signs in and shows the email', !a.$('acctIn').hidden && a.$('acctOut').hidden && a.$('acctWho').textContent.includes('mama@example.com'));
await until(() => supa.rows.size === 1, 3000);
check('account: the first sign-in uploads the local profile', supa.rows.size === 1 && JSON.parse(a.w.localStorage.getItem('leemos-profiles')).list[0].rid === [...supa.rows.keys()][0]);
a.$('acctOutBtn').click();
await sleep(20);
check('account: sign out returns to the sign-in view and keeps local progress and the link', !a.$('acctOut').hidden && a.$('acctIn').hidden && !!JSON.parse(a.w.localStorage.getItem('leemos-profiles')).list[0].rid && a.w.localStorage.getItem('leemos-auth') === null);

const swText = readFileSync(join(ROOT, 'sw.js'), 'utf8');
check('account: the service worker pre-caches the sync modules and config', ['src/merge.js', 'src/sync.js', 'src/data/sync.config.json'].every((f) => swText.includes(`'${f}'`)));
check('account: the nickname hint is present under the name field', !!a.d.querySelector('[data-i="nickHint"]'));

// ---------- 24. linking on first sign-in, other account on the same device ----------
const signInUi = async (app, email) => {
  app.$('parents').open = true; app.$('parents').dispatchEvent(new app.w.Event('toggle'));
  await until(() => !app.$('acct').hidden);
  app.$('acctEmail').value = email; app.$('acctConsent').checked = true; app.$('acctSend').click();
  await until(() => !app.$('acctCodeRow').hidden);
  app.$('acctCode').value = '123456'; app.$('acctVerify').click();
};
const LINK_PROFILES = { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader' }, { id: 'leo', name: 'Leo', kind: 'pre' }] } };
const withAccount = async (rows) => { // a fake project whose account already has children created by another device
  const s = createFakeSupabase();
  await s.fetch('https://x/auth/v1/otp', { method: 'POST', body: JSON.stringify({ email: 'mama@example.com' }) });
  await s.fetch('https://x/auth/v1/verify', { method: 'POST', body: JSON.stringify({ email: 'mama@example.com', token: '123456', type: 'email' }) });
  const uid = s.userByEmail('mama@example.com').id;
  rows.forEach(([id, name, kind, d]) => { s.rows.set(id, { id, owner: uid, name, kind, data: d, version: 1 }); s.links.set(id, new Set([uid])); }); // the account's own children: a parent link each
  return s;
};
const dat = (o = {}) => ({ stats: {}, total: 0, stickers: 0, pre: { es: 0, ca: 0 }, resets: { es: 0, ca: 0 }, level: 0, name: '', modAt: 1, ...o });
const RID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', RID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const linkButtons = (app) => [...app.$('linkOpts').querySelectorAll('button')];
const profList = (app) => (JSON.parse(app.w.localStorage.getItem('leemos-profiles') || 'null') || { list: [] }).list;

// 24a: empty account: every local profile is uploaded, no questions
supa = createFakeSupabase();
a = await boot({ supa, syncConfig: CFG, storage: LINK_PROFILES });
await signInUi(a, 'mama@example.com');
await until(() => supa.rows.size === 2, 3000);
check('link: an empty account receives every local profile without asking', supa.rows.size === 2 && a.$('link').hidden);

// 24b: the account already has "Elsa" from another tablet: ask, and linking merges both sides' progress
supa = await withAccount([[RID_A, 'Elsa', 'reader', dat({ stats: { 's:pa': { ok: 6, fail: 0 } }, total: 20, stickers: 2, level: 1, name: 'Elsa', modAt: 5 })]]);
a = await boot({ supa, syncConfig: CFG, storage: { ...LINK_PROFILES, 'leemos-v1': { name: 'Elsa', total: 3, stickers: 1, stats: { 's:ma': { ok: 2, fail: 1 } } } } });
await signInUi(a, 'mama@example.com');
await until(() => !a.$('link').hidden);
check('link: with account profiles present the adult is asked about the first local profile', !a.$('link').hidden && /Elsa/.test(a.$('linkAsk').textContent), a.$('linkAsk').textContent);
check('link: the options are the account profiles plus "add as a new child"', linkButtons(a).length === 2 && /Elsa/.test(linkButtons(a)[0].textContent), linkButtons(a).map((b) => b.textContent).join('|'));
linkButtons(a)[0].click(); // yes, same child as the account's Elsa
await until(() => supa.rows.size === 2 && supa.rows.get(RID_A).data.stats['s:ma'], 3000);
const merged = supa.rows.get(RID_A).data;
check('link: linking keeps the progress of both devices', merged.total === 20 && merged.stats['s:pa'].ok === 6 && merged.stats['s:ma'].ok === 2 && merged.stickers === 2, JSON.stringify(merged));
check('link: the local profile now points at the account profile', JSON.parse(a.w.localStorage.getItem('leemos-profiles')).list.find((p) => p.id === 'elsa').rid === RID_A);
check('link: with no account profile left to match, the next local profile (Leo) is added as new without asking', a.$('link').hidden && supa.rows.size === 2 && [...supa.rows.values()].some((r) => r.name === 'Leo'));

// 24c: account profiles that no local profile claimed are added to this device
supa = await withAccount([[RID_A, 'Elsa', 'reader', dat({ total: 4, stickers: 1, name: 'Elsa' })], [RID_B, 'Mateo', 'reader', dat({ stats: { 's:ma': { ok: 3, fail: 0 } }, total: 8, level: 2, name: 'Mateo', modAt: 2 })]]);
a = await boot({ supa, syncConfig: CFG });
await signInUi(a, 'mama@example.com');
await until(() => !a.$('link').hidden);
linkButtons(a)[0].click(); // local Elsa = account Elsa
await until(() => profList(a).length === 2, 3000);
const lp = profList(a);
const mateo = lp.find((p) => p.rid === RID_B);
check('link: a child that exists only in the account is added to this device', !!mateo && mateo.name === 'Mateo' && mateo.kind === 'reader', JSON.stringify(lp));
const mst = JSON.parse(a.w.localStorage.getItem('leemos-v1:' + mateo.id));
check("link: and arrives with the account's progress", mst.total === 8 && mst.stats['s:ma'].ok === 3 && mst.level === 2, JSON.stringify(mst));

// 24d: a different account on the same device: old rids are dropped before anything is uploaded
supa = createFakeSupabase();
a = await boot({ supa, syncConfig: CFG, storage: { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader', rid: RID_A }] }, 'leemos-auth-user': 'user-from-another-account' } });
await signInUi(a, 'otra@example.com');
await until(() => supa.rows.size === 1, 3000);
const newRid = [...supa.rows.keys()][0];
check('other account: the old link is dropped and the profile is uploaded under a new id', newRid !== RID_A && JSON.parse(a.w.localStorage.getItem('leemos-profiles')).list[0].rid === newRid);
check('other account: the new user id is remembered', a.w.localStorage.getItem('leemos-auth-user') === supa.userByEmail('otra@example.com').id);

// 24e: the network drops after the adult chose: local data is untouched and nothing is half-linked
supa = await withAccount([[RID_A, 'Elsa', 'reader', dat({ total: 1, name: 'Elsa' })]]);
a = await boot({ supa, syncConfig: CFG, storage: { ...LINK_PROFILES, 'leemos-v1': { name: 'Elsa', total: 3, stats: { 's:ma': { ok: 2, fail: 1 } } } } });
await signInUi(a, 'mama@example.com');
await until(() => !a.$('link').hidden);
supa.setOffline(true);
linkButtons(a)[0].click();
await sleep(100);
const afterDrop = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
check('network drop: local progress is untouched', afterDrop.total === 3 && afterDrop.stats['s:ma'].ok === 2);
check('network drop: nothing was uploaded and there was no error', supa.rows.get(RID_A).data.total === 1 && a.errors.length === 0, a.errors.join(' | '));

// 24f: closing the dialog cancels the linking and leaves the profiles as they were
supa = await withAccount([[RID_A, 'Elsa', 'reader', dat({ total: 1, name: 'Elsa' })]]);
a = await boot({ supa, syncConfig: CFG, storage: LINK_PROFILES });
await signInUi(a, 'mama@example.com');
await until(() => !a.$('link').hidden);
a.$('linkCancel').click();
await sleep(60);
const listAfterCancel = JSON.parse(a.w.localStorage.getItem('leemos-profiles')).list;
check('cancel: closing the dialog links nothing and uploads nothing', a.$('link').hidden && listAfterCancel.every((p) => !p.rid) && supa.rows.size === 1);

// ---------- 25. when it syncs: at start (signed in), after progress changes, when the page is hidden ----------
supa = createFakeSupabase();
await supa.fetch('https://x/auth/v1/otp', { method: 'POST', body: JSON.stringify({ email: 'mama@example.com' }) });
const sess = await (await supa.fetch('https://x/auth/v1/verify', { method: 'POST', body: JSON.stringify({ email: 'mama@example.com', token: '123456', type: 'email' }) })).json();
const authStored = { access_token: sess.access_token, refresh_token: sess.refresh_token, expires_at: Date.now() + 3600 * 1000, user: sess.user };
supa.log.length = 0;
a = await boot({ supa, syncConfig: CFG, storage: { 'leemos-auth': authStored, 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader', rid: RID_A }] }, 'leemos-v1': { name: 'Elsa', total: 2, stats: { 's:ma': { ok: 1, fail: 0 } }, modAt: 10 } } });
await until(() => supa.rows.has(RID_A), 3000);
check('triggers: a signed-in app syncs at start', supa.rows.has(RID_A) && supa.rows.get(RID_A).data.total === 2);
const row = supa.rows.get(RID_A); // another device moves ahead meanwhile
row.data = { ...row.data, stk: undefined, total: 40, stickers: 3, modAt: 99999999999999 }; row.version++; // another device on the old version: only the counter
a.$('joinBtn').click(); a.$('okBtn').click();
Object.defineProperty(a.d, 'hidden', { value: true, configurable: true });
a.d.dispatchEvent(new a.w.Event('visibilitychange'));
await until(() => JSON.parse(a.w.localStorage.getItem('leemos-v1')).total >= 40, 3000);
const afterHide = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
check("triggers: hiding the page syncs, and the answer plus the other device's progress are both kept", afterHide.total >= 40 && afterHide.stickers === 3 && supa.rows.get(RID_A).data.stats['s:ma'].ok >= 1, JSON.stringify({ t: afterHide.total, s: afterHide.stickers }));
const writes = () => supa.log.filter((l) => l.startsWith('PATCH') || l.startsWith('POST /rest')).length;
const w0 = writes();
await sleep(200);
check('triggers: data that came from the server does not start another round of writes', writes() === w0, String(w0));
const before = supa.log.length;
a = await boot({ supa, syncConfig: CFG, storage: { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader' }] } } });
await sleep(60);
check('triggers: a signed-out app makes no request to Supabase at start', supa.log.length === before && a.errors.length === 0, supa.log.slice(before).join(' | '));

// ---------- 26. review fixes: no lost progress during a sync, one sync at a time, failed linking, per-profile errors, monotonic modAt ----------
const signedAuth = async (srv, email = 'mama@example.com') => {
  await srv.fetch('https://x/auth/v1/otp', { method: 'POST', body: JSON.stringify({ email }) });
  const s = await (await srv.fetch('https://x/auth/v1/verify', { method: 'POST', body: JSON.stringify({ email, token: '123456', type: 'email' }) })).json();
  return { auth: { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Date.now() + 3600 * 1000, user: s.user }, uid: s.user.id };
};
const PROF_A = { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader', rid: RID_A }] } };

// 26a (critical): the child answers while a sync is in flight: the answer must survive the sync
supa = createFakeSupabase();
let sa = await signedAuth(supa);
let release; const gate = new Promise((r) => { release = r; });
const slow = { ...supa, fetch: async (u, o) => { if (String(u).includes('/rest/v1/')) await gate; return supa.fetch(u, o); } };
a = await boot({ supa: slow, syncConfig: CFG, storage: { 'leemos-auth': sa.auth, 'leemos-auth-user': sa.uid, ...PROF_A, 'leemos-v1': { name: 'Elsa', total: 2, stats: { 's:ma': { ok: 1, fail: 0 } }, modAt: 10 } } });
await sleep(60); // the start-up sync is now waiting on its first request
a.$('joinBtn').click(); a.$('okBtn').click();
const mid = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
release();
await until(() => supa.rows.has(RID_A), 3000);
await sleep(80);
const endSt = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
check('review C1: an answer given while a sync is running is not lost', mid.total === 3 && endSt.total === 3, `${mid.total} -> ${endSt.total}`);
const answered = Object.values(endSt.stats).reduce((n, s) => n + s.ok + s.fail, 0);
check('review C1: and its per-item counters survive too', answered === 2, String(answered));

// 26b (important): two triggers at once run one sync, and the refresh token is used once
supa = createFakeSupabase();
sa = await signedAuth(supa);
a = await boot({ supa, syncConfig: CFG, storage: { 'leemos-auth': sa.auth, 'leemos-auth-user': sa.uid, ...PROF_A, 'leemos-v1': { name: 'Elsa', total: 2, modAt: 10 } } });
await until(() => supa.rows.has(RID_A), 3000);
await sleep(50);
const nearExpiry = JSON.parse(a.w.localStorage.getItem('leemos-auth')); nearExpiry.expires_at = Date.now() + 20000;
a.w.localStorage.setItem('leemos-auth', JSON.stringify(nearExpiry));
const refreshes0 = supa.log.filter((l) => l.includes('grant_type=refresh_token')).length;
Object.defineProperty(a.d, 'hidden', { value: true, configurable: true });
a.d.dispatchEvent(new a.w.Event('visibilitychange'));
a.w.dispatchEvent(new a.w.Event('pagehide'));
await sleep(150);
check('review I1: visibilitychange and pagehide together refresh the session once and stay signed in', supa.log.filter((l) => l.includes('grant_type=refresh_token')).length === refreshes0 + 1 && a.w.localStorage.getItem('leemos-auth') !== null, supa.log.slice(-4).join(' | '));

// 26c (important): cancelling or failing the linking leaves the device signed out, with the profile list intact and usable
supa = await withAccount([[RID_A, 'Elsa', 'reader', dat({ total: 1, name: 'Elsa' })]]);
a = await boot({ supa, syncConfig: CFG, storage: LINK_PROFILES });
await signInUi(a, 'mama@example.com');
await until(() => !a.$('link').hidden);
a.$('linkCancel').click();
await sleep(60);
check('review I2: cancelling the linking signs the device out (no half-signed-in state)', a.w.localStorage.getItem('leemos-auth') === null && !a.$('acctOut').hidden && a.$('acctIn').hidden);
a.$('nm').value = 'Elsita'; a.$('nm').dispatchEvent(new a.w.Event('input'));
check('review I2: after a cancelled linking, renaming the child still reaches the saved profile list', profList(a).find((p) => p.id === 'elsa').name === 'Elsita', JSON.stringify(profList(a)));

supa = await withAccount([[RID_A, 'Elsa', 'reader', dat({ total: 1, name: 'Elsa' })]]);
let restDown = false;
const flaky = { ...supa, fetch: async (u, o) => { if (restDown && String(u).includes('/rest/v1/')) throw new TypeError('fetch failed'); return supa.fetch(u, o); } };
a = await boot({ supa: flaky, syncConfig: CFG, storage: LINK_PROFILES });
a.$('parents').open = true; a.$('parents').dispatchEvent(new a.w.Event('toggle'));
await until(() => !a.$('acct').hidden);
a.$('acctEmail').value = 'mama@example.com'; a.$('acctConsent').checked = true; a.$('acctSend').click();
await until(() => !a.$('acctCodeRow').hidden);
restDown = true; // the code is accepted, then the data connection drops
a.$('acctCode').value = '123456'; a.$('acctVerify').click();
await sleep(120);
check('review I2: a network failure during the linking signs out and leaves every profile unlinked', a.w.localStorage.getItem('leemos-auth') === null && profList(a).every((p) => !p.rid) && /conexi/i.test(a.$('acctMsg').textContent), a.$('acctMsg').textContent);

// 26d (important): a leftover session of another account never syncs this device's profiles
supa = createFakeSupabase();
sa = await signedAuth(supa, 'otra@example.com');
a = await boot({ supa, syncConfig: CFG, storage: { 'leemos-auth': sa.auth, 'leemos-auth-user': 'user-of-account-A', ...PROF_A } });
await sleep(80);
check("review I2: a session of a different account than the one that linked this device sends no data requests", !supa.log.some((l) => l.includes('/rest/v1/')), supa.log.join(' | '));

// 26e (important): one profile that cannot sync does not stop the others
supa = createFakeSupabase();
sa = await signedAuth(supa);
const picky = { ...supa, fetch: async (u, o = {}) => { if ((o.method || 'GET') === 'POST' && o.body && o.body.includes(RID_A)) return { ok: false, status: 400, json: async () => ({ message: 'rejected' }) }; return supa.fetch(u, o); } };
a = await boot({ supa: picky, syncConfig: CFG, storage: { 'leemos-auth': sa.auth, 'leemos-auth-user': sa.uid, 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader', rid: RID_A }, { id: 'leo', name: 'Leo', kind: 'pre', rid: RID_B }] } } });
await until(() => supa.rows.has(RID_B), 3000);
check('review I3: a profile the server rejects does not block the next one', supa.rows.has(RID_B) && !supa.rows.has(RID_A));

// 26f (important): the progress stamp never goes backwards, even if a synced stamp came from a faster clock
const future = Date.now() + 3600 * 1000;
a = await boot({ storage: { 'leemos-v1': { name: 'Elsa', total: 1, modAt: future } } });
a.$('joinBtn').click(); a.$('okBtn').click();
check('review I4: modAt is always newer than the stamp already stored', JSON.parse(a.w.localStorage.getItem('leemos-v1')).modAt > future);

// ---------- 27. review minors: init once, safe linking, level clamp, texts, blocked storage ----------
// m1: opening the panel twice at once loads the sync modules once
supa = createFakeSupabase();
a = await boot({ supa, syncConfig: CFG });
let imports = 0; const origImport = a.w.__leemosImport; a.w.__leemosImport = (p) => { imports++; return origImport(p); };
a.$('parents').open = true; a.$('parents').dispatchEvent(new a.w.Event('toggle')); a.$('parents').dispatchEvent(new a.w.Event('toggle'));
await until(() => !a.$('acct').hidden); await sleep(30);
check('review m1: two syncInit calls at once load the sync modules only once', imports === 2, String(imports));

// m3: a leftover storage key is never overwritten by a child that comes from the account, and a bad remote name cannot crash the linking
supa = await withAccount([[RID_B, 'Mateo', 'reader', dat({ total: 8, name: 'Mateo', modAt: 2 })]]);
a = await boot({ supa, syncConfig: CFG, storage: { 'leemos-v1:mateo': { name: 'Other child', total: 99 } } });
await signInUi(a, 'mama@example.com');
await until(() => !a.$('link').hidden);
linkButtons(a).pop().click(); // local Elsa is a new child: the account's Mateo is then added to this device
await until(() => profList(a).length === 2, 3000);
const mt = profList(a).find((p) => p.rid === RID_B);
check('review m3: the account child gets a free storage slot instead of overwriting a leftover one', !!mt && mt.id !== 'mateo' && JSON.parse(a.w.localStorage.getItem('leemos-v1:mateo')).total === 99, JSON.stringify(profList(a)));
supa = await withAccount([[RID_B, 'x', 'reader', dat({ total: 8, modAt: 2 })]]);
supa.rows.get(RID_B).name = 123; // a broken remote row
a = await boot({ supa, syncConfig: CFG });
await signInUi(a, 'mama@example.com');
await until(() => !a.$('link').hidden);
linkButtons(a).pop().click();
await until(() => !a.$('acctIn').hidden, 3000);
check('review m3: a remote profile with an invalid name is skipped and the sign-in still completes', !a.$('acctIn').hidden && !profList(a).some((p) => p.rid === RID_B) && a.errors.length === 0, a.errors.join(' | '));

// m4: a saved level beyond the known levels cannot crash the app
a = await boot({ storage: { 'leemos-v1': { name: 'Elsa', level: 9, total: 3 } } });
check('review m4: a saved level that does not exist falls back to the first one without errors', a.errors.length === 0 && a.d.querySelectorAll('#tiles .tile').length > 0, a.errors.join(' | '));

// m6: linking offers only children of the same kind, adopts the account name, focuses the dialog and closes with Escape
supa = await withAccount([[RID_B, 'Leo', 'pre', dat({ total: 4, name: 'Leo', modAt: 2 })]]);
a = await boot({ supa, syncConfig: CFG });
await signInUi(a, 'mama@example.com');
await until(() => supa.rows.size === 2, 3000);
check('review m6: a reader is never offered a pre-reader account profile, so no question is asked', a.$('link').hidden && [...supa.rows.values()].some((r) => r.name === 'Elsa' && r.kind === 'reader'));
supa = await withAccount([[RID_A, 'Elsita', 'reader', dat({ total: 1, name: 'Elsita', modAt: 2 })]]);
a = await boot({ supa, syncConfig: CFG, storage: LINK_PROFILES });
await signInUi(a, 'mama@example.com');
await until(() => !a.$('link').hidden);
check('review m6: the dialog moves focus to its first option', a.d.activeElement === linkButtons(a)[0], String(a.d.activeElement && a.d.activeElement.textContent));
linkButtons(a)[0].click();
await until(() => profList(a).some((p) => p.rid === RID_A), 3000);
check('review m6: a linked profile takes the name it has in the account', profList(a).find((p) => p.rid === RID_A).name === 'Elsita', JSON.stringify(profList(a)));
supa = await withAccount([[RID_A, 'Elsa', 'reader', dat({ total: 1, name: 'Elsa' })]]);
a = await boot({ supa, syncConfig: CFG, storage: LINK_PROFILES });
await signInUi(a, 'mama@example.com');
await until(() => !a.$('link').hidden);
a.d.dispatchEvent(new a.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await sleep(60);
check('review m6: Escape closes the dialog like "Ahora no" (signed out, nothing linked)', a.$('link').hidden && a.w.localStorage.getItem('leemos-auth') === null && profList(a).every((p) => !p.rid));

// m10: the account texts do not assume the child is a girl
check('review m10: the intro text is neutral in both languages', !/\bella\b/i.test(ies.acctIntro) && !/\bella\b/i.test(ica.acctIntro), ies.acctIntro + ' | ' + ica.acctIntro);

// m11: blocked or full storage
supa = createFakeSupabase();
a = await boot({ supa, syncConfig: CFG });
const origGet = a.w.Storage.prototype.getItem;
a.w.Storage.prototype.getItem = function (k) { if (k === 'leemos-auth-user' || k === 'leemos-sync-at') throw new Error('storage blocked'); return origGet.call(this, k); };
await signInUi(a, 'mama@example.com');
await until(() => !a.$('acctIn').hidden, 3000);
check('review m11: reading a blocked storage key never breaks sign-in or the panel', !a.$('acctIn').hidden && a.errors.length === 0, a.errors.join(' | '));
a.w.Storage.prototype.getItem = origGet;
supa = createFakeSupabase();
a = await boot({ supa, syncConfig: CFG, storage: LINK_PROFILES });
const origSet = a.w.Storage.prototype.setItem;
a.w.Storage.prototype.setItem = function (k, v) { if (k === 'leemos-profiles') throw new Error('quota exceeded'); return origSet.call(this, k, v); };
await signInUi(a, 'mama@example.com');
await sleep(120);
check('review m11: if the linked profile list cannot be saved the linking is undone and the adult is told', a.w.localStorage.getItem('leemos-auth') === null && /No se pudo/.test(a.$('acctMsg').textContent), a.$('acctMsg').textContent);
a.w.Storage.prototype.setItem = origSet;

// ---------- 28. pulling what other devices did: page visible again, back online, once a minute while visible ----------
const bumpRemote = (srv, total) => { const r = srv.rows.get(RID_A); r.data = { ...r.data, total }; r.version++; };
const localTotal = (app) => JSON.parse(app.w.localStorage.getItem('leemos-v1')).total;
const signedBoot = async (extra = {}) => {
  const s = createFakeSupabase(); const { auth, uid } = await signedAuth(s);
  const app = await boot({ supa: s, syncConfig: CFG, ...extra, storage: { 'leemos-auth': auth, 'leemos-auth-user': uid, ...PROF_A, 'leemos-v1': { name: 'Elsa', total: 2, modAt: 10 } } });
  await until(() => s.rows.has(RID_A), 3000); await sleep(40);
  return { s, app };
};
{
  const { s, app } = await signedBoot({ syncEvery: 150 });
  bumpRemote(s, 30);
  await until(() => localTotal(app) >= 30, 3000);
  check('pull: an open page picks up another device\'s progress on its own (periodic pull)', localTotal(app) >= 30, String(localTotal(app)));
}
{
  const { s, app } = await signedBoot();
  bumpRemote(s, 31);
  Object.defineProperty(app.d, 'hidden', { value: false, configurable: true });
  app.d.dispatchEvent(new app.w.Event('visibilitychange'));
  await until(() => localTotal(app) >= 31, 3000);
  check('pull: coming back to the page (visible again) pulls', localTotal(app) >= 31, String(localTotal(app)));
}
{
  const { s, app } = await signedBoot();
  bumpRemote(s, 32);
  app.w.dispatchEvent(new app.w.Event('focus'));
  await until(() => localTotal(app) >= 32, 3000);
  check('pull: focusing the window pulls', localTotal(app) >= 32, String(localTotal(app)));
}
{
  const { s, app } = await signedBoot();
  bumpRemote(s, 33);
  app.w.dispatchEvent(new app.w.Event('online'));
  await until(() => localTotal(app) >= 33, 3000);
  check('pull: the connection coming back pulls', localTotal(app) >= 33, String(localTotal(app)));
}
{
  const { s, app } = await signedBoot({ syncEvery: 100 });
  Object.defineProperty(app.d, 'hidden', { value: true, configurable: true }); // hidden, and no visibilitychange event fired
  bumpRemote(s, 34);
  await sleep(450);
  check('pull: a hidden page does not poll in the background', localTotal(app) < 34, String(localTotal(app)));
}
{
  const { s, app } = await signedBoot({ syncEvery: 120 });
  const r = s.rows.get(RID_A); r.data = { ...r.data, stk: undefined, stickers: 3 }; r.version++; // a device on the old version pushes only the counter
  await until(() => JSON.parse(app.w.localStorage.getItem('leemos-v1')).stickers === 3, 3000);
  await sleep(40);
  check('pull: stickers earned on another device show in the counter without a reload', app.$('albumCount').textContent === '3', app.$('albumCount').textContent);
}

// ---------- 29. the session and the preferences have their own timestamps; the session survives a reload ----------
a = await boot();
a.$('joinBtn').click(); a.$('okBtn').click(); await sleep(5); a.$('joinBtn').click(); a.$('noBtn').click(); await sleep(5);
const s29 = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
check('session: counters and their own timestamp are saved after each answer', s29.session.done === 2 && s29.session.ok === 1 && s29.session.at > 0, JSON.stringify(s29.session));
a = await boot({ storage: dump(a.w) });
check('session: reloading the page keeps "2 de 10"', /2 de 10/.test(a.$('slabel').textContent), a.$('slabel').textContent);
a = await boot({ storage: { 'leemos-v1': { name: 'Elsa', session: { done: 4, ok: 3, stk: 0, at: Date.now() - 13 * 3600 * 1000 } } } });
check('session: one older than 12 hours does not resume', /0 de 10/.test(a.$('slabel').textContent), a.$('slabel').textContent);
a = await boot({ storage: { 'leemos-v1': { name: 'Elsa', session: { done: 10, ok: 9, stk: 1, at: Date.now() - 1000 } } } });
check('session: a finished one does not resume either', /0 de 10/.test(a.$('slabel').textContent), a.$('slabel').textContent);
a = await boot();
a.$('joinBtn').click(); a.$('okBtn').click();
const afterAnswer = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
a.$('soundBtn').click();
const afterSound = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
check('prefs: a preference change is stamped on its own key and does not touch modAt or the session stamp', afterSound.prefs.sound.v === false && afterSound.prefs.sound.at > 0 && afterSound.modAt === afterAnswer.modAt && afterSound.session.at === afterAnswer.session.at, JSON.stringify(afterSound.prefs));
a.$('themeBtn').click();
const afterTheme = JSON.parse(a.w.localStorage.getItem('leemos-v1'));
check('prefs: only the changed keys are recorded (defaults never travel)', Object.keys(afterTheme.prefs).sort().join() === 'sound,theme', Object.keys(afterTheme.prefs).join());
a = await boot();
check('prefs: loading an untouched profile records no preference', Object.keys(JSON.parse(a.w.localStorage.getItem('leemos-v1') || '{}').prefs || {}).length === 0);
a = await boot();
await playSession(a, 10);
await until(() => !a.$('end').hidden);
a.$('endMore').click();
await sleep(20);
check('session: starting another session saves it as zero', JSON.parse(a.w.localStorage.getItem('leemos-v1')).session.done === 0);

// ---------- 30. applying a pull: session and preferences from another device, idle rule, hostile values ----------
const NOW = () => Date.now();
const seed = async (extraData, localState = {}, bootExtra = {}) => {
  const s = createFakeSupabase(); const { auth, uid } = await signedAuth(s);
  s.rows.set(RID_A, { id: RID_A, owner: uid, name: 'Elsa', kind: 'reader', version: 1, data: dat({ total: 1, name: 'Elsa', modAt: 5, ...extraData }) });
  const app = await boot({ supa: s, syncConfig: CFG, ...bootExtra, storage: { 'leemos-auth': auth, 'leemos-auth-user': uid, ...PROF_A, 'leemos-v1': { name: 'Elsa', total: 1, modAt: 5, ...localState } } });
  return { s, app };
};
const localState = (app) => JSON.parse(app.w.localStorage.getItem('leemos-v1'));
const OLD = () => NOW() - 120000; // idle for two minutes

// a: the session in progress arrives and shows
{
  const { s, app } = await seed({ session: { done: 4, ok: 3, stk: 0, at: NOW() - 1000 } }, { session: { done: 1, ok: 1, stk: 0, at: OLD() } });
  await until(() => /4 de 10/.test(app.$('slabel').textContent), 3000);
  check('pull a: the session in progress from another device shows "4 de 10"', /4 de 10/.test(app.$('slabel').textContent), app.$('slabel').textContent);
  check('pull a: and it is saved locally as that session', localState(app).session.done === 4);
}
// b: a device being used keeps its own session and pushes it back
{
  const { s, app } = await seed({ session: { done: 6, ok: 6, stk: 0, at: NOW() + 5000 } }, { session: { done: 2, ok: 1, stk: 0, at: NOW() } });
  await until(() => app.w.localStorage.getItem('leemos-sync-at'), 3000); await sleep(40);
  check('pull b: a session changed on this device a moment ago is not overwritten', /2 de 10/.test(app.$('slabel').textContent), app.$('slabel').textContent);
  await until(() => s.rows.get(RID_A).data.session.done === 2, 9000); // pushed back through the normal 5 s debounce
  check('pull b: and it is pushed back, so the other device adopts it', s.rows.get(RID_A).data.session.done === 2, JSON.stringify(s.rows.get(RID_A).data.session));
}
// c: every preference arrives and is applied through the UI
{
  const t0 = NOW() - 1000;
  const { s, app } = await seed({ prefs: { theme: { v: 'dark', at: t0 }, sound: { v: false, at: t0 }, mode: { v: 'word', at: t0 }, sessionLen: { v: 5, at: t0 }, upper: { v: false, at: t0 }, rate: { v: 0.6, at: t0 }, world: { v: 3, at: t0 }, lang: { v: 'ca', at: t0 } } });
  await until(() => app.d.documentElement.lang === 'ca', 3000);
  await sleep(60);
  const st = localState(app);
  check('pull c: theme, sound, mode, session length, capitals, speed and world are applied', app.d.documentElement.getAttribute('data-theme') === 'dark' && app.$('soundBtn').getAttribute('aria-pressed') === 'false' && app.$('mWord').getAttribute('aria-pressed') === 'true' && app.$('sessionSel').value === '5' && !app.d.body.classList.contains('upper') && app.$('rate').value === '0.6' && st.world === 3, JSON.stringify({ t: st.theme, s: st.sound, m: st.mode, l: st.sessionLen, u: st.upper, r: st.rate, w: st.world }));
  check('pull c: the language switches the interface', app.d.documentElement.lang === 'ca' && app.$('langBtn').textContent === 'CA', app.$('langBtn').textContent);
  check('pull c: the page shows the session length of the pulled preference', /de 5/.test(app.$('slabel').textContent), app.$('slabel').textContent);
}
// d: preferences are independent per key
{
  const { s, app } = await seed({ prefs: { sound: { v: false, at: NOW() - 1000 }, theme: { v: 'light', at: NOW() - 200000 } } }, { theme: 'dark', prefs: { theme: { v: 'dark', at: NOW() - 60000 } } });
  await until(() => app.$('soundBtn').getAttribute('aria-pressed') === 'false', 3000);
  check('pull d: the newer remote sound is applied while the newer local theme is kept', app.$('soundBtn').getAttribute('aria-pressed') === 'false' && app.d.documentElement.getAttribute('data-theme') === 'dark');
}
// e: a finished or stale remote session starts a new one
{
  const { app } = await seed({ session: { done: 10, ok: 9, stk: 1, at: NOW() - 1000 } }, { session: { done: 3, ok: 3, stk: 0, at: OLD() } });
  await until(() => /0 de 10/.test(app.$('slabel').textContent), 3000);
  check('pull e: a finished remote session applies as zero, not as "10 de 10"', /0 de 10/.test(app.$('slabel').textContent), app.$('slabel').textContent);
  const { app: app2 } = await seed({ session: { done: 7, ok: 5, stk: 0, at: NOW() - 13 * 3600 * 1000 } }, { session: { done: 0, ok: 0, stk: 0, at: 0 } });
  await until(() => app2.w.localStorage.getItem('leemos-sync-at'), 3000); await sleep(40);
  check('pull e: a remote session older than 12 hours is ignored', /0 de 10/.test(app2.$('slabel').textContent), app2.$('slabel').textContent);
}
// f: the voice never leaves the device
{
  const { s, app } = await seed({}, { voiceURIs: { es: 'my-private-voice', ca: '' }, voiceURI: 'my-private-voice', theme: 'dark', prefs: { theme: { v: 'dark', at: NOW() - 60000 } } });
  await until(() => s.rows.get(RID_A).data.prefs && s.rows.get(RID_A).data.prefs.theme, 3000);
  check('pull f: the voice is never uploaded', !JSON.stringify(s.rows.get(RID_A).data).includes('my-private-voice') && !('voiceURI' in s.rows.get(RID_A).data.prefs));
}
// g: a session or preference change never reverts the level
{
  const { s, app } = await seed({ level: 3, name: 'Elsa', modAt: NOW() - 1000 }, { level: 0, modAt: 10 });
  await until(() => localState(app).level === 3, 3000);
  app.$('themeBtn').click(); app.$('soundBtn').click();
  await sleep(100);
  app.w.dispatchEvent(new app.w.Event('online'));
  await sleep(150);
  check('pull g: the level from the other device survives local preference changes and the next sync', localState(app).level === 3 && s.rows.get(RID_A).data.level === 3, `${localState(app).level} ${s.rows.get(RID_A).data.level}`);
}
// h: hostile remote values are dropped
{
  const t0 = NOW() - 1000;
  const { app } = await seed({ prefs: { theme: { v: 'purple', at: t0 }, mode: { v: 'x', at: t0 }, sessionLen: { v: 7, at: t0 }, rate: { v: 99, at: t0 }, lang: { v: 'fr', at: t0 } }, session: { done: -3, ok: 'a', stk: 1e300, at: t0 } });
  await until(() => app.w.localStorage.getItem('leemos-sync-at'), 3000); await sleep(40);
  const st = localState(app);
  check('pull h: invalid remote preferences are never applied and nothing crashes', app.errors.length === 0 && (st.theme || '') !== 'purple' && st.mode !== 'x' && st.sessionLen !== 7 && st.rate !== 99 && st.lang !== 'fr', app.errors.join(' | '));
}

// ---------- 31. review fixes for the session/preferences sync ----------
// I1: the echo of this device's own push must not wipe a session that just finished (the end screen reads its counters)
{
  const s = createFakeSupabase(); const { auth, uid } = await signedAuth(s);
  const app = await boot({ supa: s, syncConfig: CFG, storage: { 'leemos-auth': auth, 'leemos-auth-user': uid, ...PROF_A, 'leemos-v1': { name: 'Elsa', total: 0, modAt: 5 } } });
  await until(() => s.rows.has(RID_A), 3000); await sleep(40);
  let n = 0;
  await playSession(app, 9, () => n++ % 2 === 0); // 5 right, 4 wrong
  app.$('joinBtn').click(); await sleep(0); app.$('noBtn').click(); await sleep(5); // the 10th answer: wrong
  await until(() => !app.$('reward').hidden, 3000);
  app.w.dispatchEvent(new app.w.Event('online')); // a sync while the sticker is on screen
  await sleep(200);
  check('review I1: a sync while the sticker is showing does not wipe the finished session', /10 de 10/.test(app.$('slabel').textContent), app.$('slabel').textContent);
  app.$('rewardOk').click();
  await until(() => !app.$('end').hidden, 3000);
  check('review I1: the end screen still reports the right answers and the new sticker', /\b5\b/.test(app.$('endInfo').textContent) && /pegatina/i.test(app.$('endInfo').textContent), app.$('endInfo').textContent);
}
// I2: a language change from another device never switches the language under an open recorder
{
  const s = createFakeSupabase(); const { auth, uid } = await signedAuth(s);
  s.rows.set(RID_A, { id: RID_A, owner: uid, name: 'Elsa', kind: 'reader', version: 1, data: dat({ total: 1, name: 'Elsa', modAt: 5, prefs: { lang: { v: 'ca', at: Date.now() - 1000 } } }) });
  let release; const gate = new Promise((r) => { release = r; });
  const slowS = { ...s, fetch: async (u, o) => { if (String(u).includes('/rest/v1/')) await gate; return s.fetch(u, o); } };
  const app = await boot({ supa: slowS, syncConfig: CFG, storage: { 'leemos-auth': auth, 'leemos-auth-user': uid, ...PROF_A, 'leemos-v1': { name: 'Elsa', total: 1, modAt: 5 } } });
  await sleep(60);
  app.$('parents').open = true; app.$('recOpen').click(); // the parent is recording in Spanish
  release();
  await until(() => s.rows.get(RID_A).version >= 1 && true, 3000); await sleep(200);
  check('review I2: a remote language change does not apply while the recorder is open', app.d.documentElement.lang === 'es' && JSON.parse(app.w.localStorage.getItem('leemos-v1')).lang !== 'ca', app.d.documentElement.lang);
  app.$('recClose') && app.$('recClose').click();
  app.w.dispatchEvent(new app.w.Event('online'));
  await until(() => app.d.documentElement.lang === 'ca', 3000);
  check('review I2: and it is applied after the recorder closes', app.d.documentElement.lang === 'ca', app.d.documentElement.lang);
}
// I3: Leo continues the session in progress instead of starting from zero when he presses Play
{
  const x = await bootLeo({ storage: { ...LEO, 'leemos-v1:leo': { name: 'Leo', session: { done: 3, ok: 3, stk: 0, at: Date.now() - 1000 } } } });
  check('review I3: the home shows the restored session of the pre-reader', /3 de 5/.test(x.$('slabel').textContent), x.$('slabel').textContent);
  x.$('prePlay').click(); await sleep(20);
  check('review I3: pressing Play continues it ("3 de 5"), it does not reset to zero', /3 de 5/.test(x.$('slabel').textContent), x.$('slabel').textContent);
  const y = await bootLeo({ storage: { ...LEO, 'leemos-v1:leo': { name: 'Leo', session: { done: 5, ok: 5, stk: 0, at: Date.now() - 1000 } } } });
  y.$('prePlay').click(); await sleep(20);
  check('review I3: a finished session does start again from zero', /0 de 5/.test(y.$('slabel').textContent), y.$('slabel').textContent);
}

// ---------- 32. review minors M1-M9 ----------
const waitSynced = async (app) => { await until(() => app.w.localStorage.getItem('leemos-sync-at'), 3000); await sleep(40); };
// M1: a remote mode change while resting must not start (and stamp) a new session
{
  const s = createFakeSupabase(); const { auth, uid } = await signedAuth(s);
  const app = await boot({ supa: s, syncConfig: CFG, storage: { 'leemos-auth': auth, 'leemos-auth-user': uid, ...PROF_A, 'leemos-v1': { name: 'Elsa', total: 0, modAt: 5 } } });
  await until(() => s.rows.has(RID_A), 3000); await sleep(40);
  await playSession(app, 10);
  await until(() => !app.$('end').hidden, 3000);
  app.$('endStop').click(); await sleep(30);
  const before = localState(app).session;
  const r = s.rows.get(RID_A); r.data = { ...r.data, prefs: { ...(r.data.prefs || {}), mode: { v: 'word', at: NOW() + 1000 } } }; r.version++;
  app.w.dispatchEvent(new app.w.Event('online'));
  await until(() => localState(app).mode === 'word', 3000); await sleep(40);
  const after = localState(app).session;
  check('review M1: a remote mode change while resting does not start and stamp a new session', after.done === before.done && after.at === before.at, JSON.stringify([before, after]));
}
// M2: stamps in the future
a = await boot({ storage: { 'leemos-v1': { name: 'Elsa', session: { done: 4, ok: 3, stk: 0, at: Date.now() + 2 * 3600 * 1000 } } } });
check('review M2: a session stamped far in the future does not resume (it would never expire)', /0 de 10/.test(a.$('slabel').textContent), a.$('slabel').textContent);
a = await boot({ storage: { 'leemos-v1': { name: 'Elsa', theme: 'dark', prefs: { theme: { v: 'dark', at: 8.64e15 } } } } });
a.$('themeBtn').click();
const th32 = localState(a).prefs.theme;
check('review M2: a new stamp never goes beyond the largest valid date, so the local value is not dropped', th32.at <= 8.64e15 && th32.v === 'light', JSON.stringify(th32));
// M4: a session-length change must not leave a protected session at or above its new length
{
  const { app } = await seed({ prefs: { sessionLen: { v: 5, at: NOW() - 1000 } } }, { session: { done: 7, ok: 5, stk: 0, at: NOW() - 10000 } });
  await until(() => app.$('sessionSel').value === '5', 3000); await sleep(60);
  check('review M4: a session at 7 of 10 becomes 4 of 5 when another device shortens the sessions', /4 de 5/.test(app.$('slabel').textContent) && localState(app).session.done === 4, app.$('slabel').textContent);
}
// M5: the capitals migration respects a synced preference
a = await boot({ storage: { 'leemos-v1': { name: 'Elsa', upper: false, prefs: { upper: { v: false, at: 5 } } } } });
check('review M5: a profile that already has a synced capitals preference is not forced to capitals', !a.d.body.classList.contains('upper'));
// M6: a pull that changes no world leaves the worlds grid alone
{
  const { s, app } = await seed({}, {}, { syncEvery: 120 });
  await waitSynced(app);
  app.$('worldBtn').click(); await sleep(20);
  const btn = app.d.querySelector('#worldGrid .wbtn');
  await sleep(500); // several pulls
  check('review M6: the worlds grid is not rebuilt by a pull that changes nothing', !!btn && app.d.contains(btn));
}
// M8: a level clamped at load is a correction, not a progress change
a = await boot({ storage: { 'leemos-v1': { name: 'Elsa', level: 9, modAt: 10 } } });
check('review M8: clamping a bad saved level at load does not stamp modAt', localState(a).modAt === 10, String(localState(a).modAt));
// M9: stronger versions of weak tests
{
  const s = createFakeSupabase(); const { auth, uid } = await signedAuth(s);
  s.rows.set(RID_A, { id: RID_A, owner: uid, name: 'Elsa', kind: 'reader', version: 1, data: dat({ level: 3, name: 'Elsa', modAt: NOW() - 1000 }) });
  let release; const gate = new Promise((r) => { release = r; });
  const slowS = { ...s, fetch: async (u, o) => { if (String(u).includes('/rest/v1/')) await gate; return s.fetch(u, o); } };
  const app = await boot({ supa: slowS, syncConfig: CFG, storage: { 'leemos-auth': auth, 'leemos-auth-user': uid, ...PROF_A, 'leemos-v1': { name: 'Elsa', level: 0, modAt: 10 } } });
  await sleep(60);
  app.$('themeBtn').click(); app.$('soundBtn').click(); // preference changes made BEFORE the pull
  release();
  await until(() => localState(app).level === 3, 3000);
  check("review M9: preference changes made before a pull cannot beat the other device's level", localState(app).level === 3, String(localState(app).level));
}
{
  const { app } = await seed({ session: { done: 6, ok: 6, stk: 0, at: NOW() - 1000 } }, { session: { done: 2, ok: 1, stk: 0, at: NOW() - 40000 } });
  await until(() => /6 de 10/.test(app.$('slabel').textContent), 3000);
  check('review M9: a session idle for 40 s is replaced by the newer one from another device', /6 de 10/.test(app.$('slabel').textContent), app.$('slabel').textContent);
}
{
  const { app } = await seed({ session: { done: 6, ok: 6, stk: 0, at: NOW() - 1000 } }, { session: { done: 2, ok: 1, stk: 0, at: NOW() - 20000 } });
  await waitSynced(app);
  check('review M9: a session changed 20 s ago is kept', /2 de 10/.test(app.$('slabel').textContent), app.$('slabel').textContent);
}

// ---------- 33. sticker sets per world ----------
{
  const st = (app, key = 'leemos-v1') => JSON.parse(app.w.localStorage.getItem(key));
  const WSTK = (id) => worlds.find((w) => w.id === id).stk;
  const full = (ids) => Object.fromEntries(ids.map((id) => [id, 6]));
  let x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', stickers: 7, world: 0, sessionLen: 5 } } });
  check('world stickers: an old counter of 7 still shows 7 after the migration', x.$('albumCount').textContent === '7');
  x.$('joinBtn').click(); await sleep(0); x.$('okBtn').click(); await sleep(5);
  let s = st(x);
  check('world stickers: the 7 old stickers land in their worlds', JSON.stringify(s.stk) === JSON.stringify({ bosque: 1, montana: 1, castillo: 1, mar: 2, jardin: 1, ciudad: 1 }) && s.stickers === 7, JSON.stringify(s.stk));
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', stickers: 7, modAt: 55, total: 3 } } });
  x.$('themeBtn').click(); await sleep(5); // a save() that is not a progress change
  check('world stickers: loading an old state does not stamp modAt (it decides level and name in the sync)', st(x).modAt === 55, String(st(x).modAt));
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', world: 0, sessionLen: 5 } } });
  await playSession(x, 5);
  s = st(x);
  check('world stickers: finishing a session adds a sticker to the world being played', s.stk.bosque === 1 && s.stickers === 1 && x.$('rewardEmoji').textContent === WSTK('bosque')[0], JSON.stringify(s.stk));
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', world: 3, sessionLen: 5 } } });
  await playSession(x, 5);
  check('world stickers: another world gets its own first sticker', st(x).stk.montana === 1 && x.$('rewardEmoji').textContent === WSTK('montana')[0]);
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', sessionLen: 5 } } });
  await playSession(x, 5);
  s = st(x);
  check('world stickers: with Sorpresa exactly one world gets the sticker', Object.keys(s.stk).length === 1 && Object.values(s.stk)[0] === 1 && s.stickers === 1, JSON.stringify(s.stk));
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', world: 99, sessionLen: 5 } } });
  await playSession(x, 5);
  check('world stickers: a world number out of range uses the last world', st(x).stk.ciudad === 1 && x.$('rewardEmoji').textContent === WSTK('ciudad')[0]);
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', world: 0, sessionLen: 5, stk: full(['bosque']), stickers: 6 } } });
  await playSession(x, 5);
  s = st(x);
  check('world stickers: a complete set passes the sticker to the first incomplete world', s.stk.bosque === 6 && s.stk.playa === 1 && s.stickers === 7 && x.$('rewardEmoji').textContent === WSTK('playa')[0], JSON.stringify(s.stk));
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', world: 0, sessionLen: 5, stk: full(worlds.map((w) => w.id)), stickers: 96 } } });
  await playSession(x, 5);
  s = st(x);
  check('world stickers: with every set complete no sticker drops and nothing breaks', x.$('reward').hidden && s.stickers === 96 && Object.values(s.stk).every((n) => n === 6) && x.errors.length === 0, x.errors.join(' | '));
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', stk: { bosque: 500 }, stickers: 500 } } });
  check('world stickers: a hostile count is clamped to the size of the set', x.$('albumCount').textContent === '6' && x.errors.length === 0, x.$('albumCount').textContent);
  // Leo goes through the same function
  x = await bootLeo({ storage: { ...LEO, 'leemos-v1:leo': { name: 'Leo', world: 0 } } });
  x.$('prePlay').click(); await playPre(x, 5); await sleep(10);
  s = st(x, 'leemos-v1:leo');
  check('world stickers: Leo earns his sticker in the world being played too', s.stk && s.stk.bosque === 1 && x.$('albumCount').textContent === '1', JSON.stringify(s.stk));
  // another device pushes per-world stickers: they arrive in the counter without a reload
  const { s: supa, app } = await signedBoot({ syncEvery: 120 });
  const r = supa.rows.get(RID_A); r.data = { ...r.data, stk: { circo: 2 }, stickers: 2 }; r.version++;
  await until(() => (JSON.parse(app.w.localStorage.getItem('leemos-v1')).stk || {}).circo === 2, 3000);
  await sleep(40);
  check('world stickers: per-world stickers from another device arrive without a reload', st(app).stickers === 2 && app.$('albumCount').textContent === '2', app.$('albumCount').textContent);
}

// review: after a pull the counter follows the sets that exist (out-of-range counts and unknown worlds are not shown)
{
  const { s: supa, app } = await signedBoot({ syncEvery: 120 });
  const r = supa.rows.get(RID_A); r.data = { ...r.data, stk: { bosque: 10, zzzz: 5 } }; r.version++;
  await until(() => (JSON.parse(app.w.localStorage.getItem('leemos-v1')).stk || {}).bosque === 10, 3000);
  await sleep(40);
  check('review: a pulled count above the set size or for an unknown world does not inflate the counter', app.$('albumCount').textContent === '6' && JSON.parse(app.w.localStorage.getItem('leemos-v1')).stickers === 6, app.$('albumCount').textContent);
}

// ---------- 34. sticker sets per world: what she sees ----------
{
  const own = (stk, n) => ({ 'leemos-v1': { name: 'Elsa', world: 0, sessionLen: 5, stk, stickers: n } });
  let x = await boot({ storage: own({ bosque: 2 }, 2) });
  x.$('worldBtn').click();
  const btns = [...x.d.querySelectorAll('#worldGrid .wbtn')];
  check('world sets: each world tile shows its progress and Sorpresa the total', btns.length === 17 && /2\/6/.test(btns[1].textContent) && /0\/6/.test(btns[2].textContent) && /2\/96/.test(btns[0].textContent), btns.slice(0, 3).map((b) => b.textContent).join(' | '));
  check('world sets: every tile stays selectable (nothing is locked)', btns.every((b) => !b.disabled));
  x = await boot({ storage: own({ bosque: 6 }, 6) });
  x.$('worldBtn').click();
  check('world sets: a complete set is marked with a tick', /6\/6 ✓/.test(x.d.querySelectorAll('#worldGrid .wbtn')[1].textContent));
  x = await boot({ storage: own({ bosque: 2, mar: 1 }, 3) });
  x.$('albumBtn').click();
  const sets = x.d.querySelectorAll('#stickerGrid .sset');
  check('album: grouped by world, 6 slots each, owned ones are not dimmed', sets.length === 16 && x.d.querySelectorAll('#stickerGrid .sticker').length === 96 && x.d.querySelectorAll('#stickerGrid .sticker:not(.locked)').length === 3);
  check('album: each group has a heading with its world and count', /Bosque.*2\/6/.test(x.d.querySelectorAll('#stickerGrid .sset-h')[0].textContent) && /3 de 96/.test(x.$('albumInfo').textContent), x.$('albumInfo').textContent);
  x = await boot({ storage: own({ bosque: 6 }, 6) });
  await playSession(x, 5);
  check('reward: when the sticker comes from another world, the screen says which', !x.$('rewardFrom').hidden && /Playa/.test(x.$('rewardFrom').textContent), x.$('rewardFrom').textContent);
  x = await boot({ storage: own({}, 0) });
  await playSession(x, 5);
  check('reward: a sticker from the world being played shows no origin line', x.$('rewardFrom').hidden);
  x = await boot({ lang: 'ca-ES', storage: own({ bosque: 6 }, 6) });
  await playSession(x, 5);
  check('reward: the origin line is in Catalan too', /Platja/.test(x.$('rewardFrom').textContent), x.$('rewardFrom').textContent);
}

// ---------- 35. Camino de Elsa: what she practices ----------
{
  const { stepOf } = await import('../src/levelrule.js');
  const LVES = readJSON('src/data/levels.es.json');
  const drawn = async (app, n) => {
    const seen = [];
    for (let i = 0; i < n; i++) {
      if (!app.$('end').hidden) app.$('endMore').click();
      app.$('joinBtn').click();
      seen.push([...app.d.querySelectorAll('#tiles .tile')].map((b) => b.textContent).join(''));
      app.$('okBtn').click(); await sleep(0);
      if (!app.$('reward').hidden) app.$('rewardOk').click();
    }
    return seen;
  };
  const st = (app) => JSON.parse(app.w.localStorage.getItem('leemos-v1'));
  let x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', level: 4, sessionLen: 20, pathEs: 1, pathCa: 1, pathAuto: false } } });
  let seen = await drawn(x, 40);
  check('path: with only M open every exercise needs no other letter (even at level 5)', seen.every((s) => stepOf(s) <= 1), seen.filter((s) => stepOf(s) > 1).join(','));
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', level: 2, sessionLen: 100, pathEs: 12, pathCa: 12 } } });
  seen = await drawn(x, 60);
  check('path: the pool is cumulative, so earlier levels keep coming back', seen.some((s) => LVES[0].syl.includes(s)) && seen.some((s) => LVES[1].syl.includes(s)) && seen.some((s) => LVES[2].syl.includes(s)));
  check('path: the same exercise does not come back within the recent window', seen.every((s, i) => !seen.slice(Math.max(0, i - 6), i).includes(s)), seen.join(','));
  check('path: the whole run raised no errors', x.errors.length === 0, x.errors.join(' | '));
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', mode: 'word', pathEs: 1, pathCa: 1 } } });
  x.$('joinBtn').click();
  check('path: Palabras is dimmed while too few words are open, and a syllable is shown instead', x.$('mWord').getAttribute('aria-disabled') === 'true' && x.$('mSyl').getAttribute('aria-pressed') === 'true' && x.$('pic').hidden && x.$('mWord').title.length > 0);
  x.$('mWord').click(); await sleep(5);
  check('path: tapping the dimmed Palabras changes nothing and the saved mode is untouched', x.$('mSyl').getAttribute('aria-pressed') === 'true' && st(x).mode === 'word');
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 12, pathCa: 12 } } });
  check('path: with every letter open Palabras is available', x.$('mWord').getAttribute('aria-disabled') === 'false');
  // defaults (the real ones: openPath:false)
  x = await boot({ openPath: false });
  x.$('joinBtn').click(); x.$('okBtn').click(); await sleep(5);
  check('path: a new reader profile starts at M with the automatic switch on', st(x).pathEs === 1 && st(x).pathCa === 1 && st(x).pathAuto === true, JSON.stringify([st(x).pathEs, st(x).pathAuto]));
  x = await boot({ openPath: false, storage: { 'leemos-v1': { name: 'Elsa', total: 3, stats: { 's:ma': { ok: 2, fail: 0 } } } } });
  x.$('joinBtn').click(); x.$('okBtn').click(); await sleep(5);
  check('path: a profile that already has progress starts with every letter open', st(x).pathEs === 12 && st(x).pathCa === 12);
  x = await boot({ openPath: false, storage: { 'leemos-v1': { name: 'Elsa', total: 3, pathEs: 99, pathCa: 0, pathAuto: 'yes' } } });
  x.$('joinBtn').click(); x.$('okBtn').click(); await sleep(5);
  check('path: a broken saved value falls back to the default', st(x).pathEs === 12 && st(x).pathCa === 12 && st(x).pathAuto === true);
  x = await boot({ openPath: false, storage: { 'leemos-v1': { name: 'Elsa', total: 3, modAt: 55, stats: { 's:ma': { ok: 2, fail: 0 } } } } });
  x.$('themeBtn').click(); await sleep(5);
  check('path: loading an old state stamps nothing (modAt and the preference stamps stay put)', st(x).modAt === 55 && !(st(x).prefs && st(x).prefs.pathEs), JSON.stringify([st(x).modAt, st(x).prefs]));
  // the level bars count only the open items, and the level-up offer waits for every letter
  const lvl0 = [...LVES[0].syl.map((s) => 's:' + s), ...LVES[0].words.map((o) => 'w:' + o.w)];
  const mastered = Object.fromEntries(lvl0.map((k) => [k, { ok: 3, fail: 0 }]));
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', sessionLen: 5, pathEs: 1, pathCa: 1, pathAuto: false, stats: mastered } } });
  await playSession(x, 5);
  check('path: the level-up offer is not shown while letters are still closed', !x.$('end').hidden && x.$('endLevelUpBtn').hidden);
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', sessionLen: 5, pathEs: 12, pathCa: 12, stats: mastered } } });
  await playSession(x, 5);
  check('path: with every letter open the level-up offer works as before', !x.$('end').hidden && !x.$('endLevelUpBtn').hidden);
  // the rule module cannot load: the app still works, every item open
  x = await boot({ importFails: true, storage: { 'leemos-v1': { name: 'Elsa', pathEs: 1, pathCa: 1 } } });
  x.$('joinBtn').click();
  check('path: if the rule cannot load the app still shows an exercise', [...x.d.querySelectorAll('#tiles .tile')].length > 0 && x.errors.length === 0, x.errors.join(' | '));
}

// ---------- 36. Camino de Elsa: opening letters ----------
{
  const { stepOf } = await import('../src/levelrule.js');
  const LVES = readJSON('src/data/levels.es.json');
  const st = (app) => JSON.parse(app.w.localStorage.getItem('leemos-v1'));
  const m1 = Object.fromEntries([...LVES[0].syl.map((s) => ['s:' + s, s]), ...LVES[0].words.map((o) => ['w:' + o.w, o.w])].filter(([, h]) => stepOf(h) === 1).map(([k]) => [k, { ok: 3, fail: 0 }]));
  let x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', sessionLen: 5, pathEs: 1, pathCa: 1, stats: m1 } } });
  await playSession(x, 5);
  check('path: mastering the letter that just opened opens the next one, once', st(x).pathEs === 2 && st(x).prefs.pathEs.v === 2, JSON.stringify([st(x).pathEs]));
  check('path: the end screen announces the new letter', !x.$('endPath').hidden && /P/.test(x.$('endPath').textContent), x.$('endPath').textContent);
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', sessionLen: 5, pathEs: 1, pathCa: 1 } } });
  await playSession(x, 5);
  check('path: a new letter does not open before it is mastered', st(x).pathEs === 1 && x.$('endPath').hidden);
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', sessionLen: 5, pathEs: 1, pathCa: 1, pathAuto: false, stats: m1 } } });
  await playSession(x, 5);
  check('path: with the automatic switch off the position stays', st(x).pathEs === 1 && x.$('endPath').hidden);
  // the parent's block
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 3, pathCa: 12 } } });
  const btns = () => [...x.d.querySelectorAll('#pathRow button')];
  check('path: the Camino block shows 12 steps for this language, open ones lit', btns().length === 12 && btns().filter((b) => !b.classList.contains('closed')).length === 3 && btns()[2].getAttribute('aria-pressed') === 'true' && /M/.test(btns()[0].textContent));
  btns()[1].click(); await sleep(5);
  check('path: tapping a letter opens up to it and closes the rest, and it is saved as a preference', st(x).pathEs === 2 && st(x).prefs.pathEs.v === 2 && btns().filter((b) => !b.classList.contains('closed')).length === 2, JSON.stringify(st(x).pathEs));
  x.$('pathAuto').click(); await sleep(5);
  check('path: the automatic switch is saved', st(x).pathAuto === false && st(x).prefs.pathAuto.v === false);
  btns()[11].click(); await sleep(5);
  check('path: the last step opens everything', st(x).pathEs === 12 && x.$('mWord').getAttribute('aria-disabled') === 'false');
  // Catalan has its own position and texts
  x = await boot({ lang: 'ca-ES', storage: { 'leemos-v1': { name: 'Elsa', pathEs: 12, pathCa: 2 } } });
  check('path: Catalan uses its own position and its own texts', [...x.d.querySelectorAll('#pathRow button')].filter((b) => !b.classList.contains('closed')).length === 2 && /Camí/.test(x.$('path').textContent), x.$('path').textContent.slice(0, 40));
  // pulls
  const { s: supa, app } = await signedBoot({ syncEvery: 120 });
  const row = supa.rows.get(RID_A); row.data = { ...row.data, prefs: { ...(row.data.prefs || {}), pathEs: { v: 3, at: Date.now() + 5000 } } }; row.version++;
  await until(() => JSON.parse(app.w.localStorage.getItem('leemos-v1')).pathEs === 3, 3000);
  await sleep(40);
  check('path: a position pulled from another device is applied and redrawn', [...app.d.querySelectorAll('#pathRow button')].filter((b) => !b.classList.contains('closed')).length === 3);
  const { s: supa2, app: app2 } = await signedBoot({ syncEvery: 120 });
  const row2 = supa2.rows.get(RID_A); row2.data = { ...row2.data, prefs: { pathEs: { v: 99, at: Date.now() + 5000 }, pathAuto: { v: 'yes', at: Date.now() + 5000 } } }; row2.version++;
  await sleep(500);
  check('path: hostile pulled values never reach the app', JSON.parse(app2.w.localStorage.getItem('leemos-v1')).pathEs !== 99 && app2.errors.length === 0, app2.errors.join(' | '));
}

// ---------- 37. review of Camino de Elsa ----------
{
  const { stepOf } = await import('../src/levelrule.js');
  const LVES = readJSON('src/data/levels.es.json'), LVCA = readJSON('src/data/levels.ca.json');
  const st = (app) => JSON.parse(app.w.localStorage.getItem('leemos-v1'));
  const masterSyl = (lv, pos, pre = '') => Object.fromEntries(lv[0].syl.filter((s) => stepOf(s) === pos).map((s) => [pre + 's:' + s, { ok: 3, fail: 0 }]));
  // the automatic opening judges what she can practise (syllables in Sílabas), not words she cannot be shown
  let x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', sessionLen: 5, pathEs: 4, pathCa: 4, stats: masterSyl(LVES, 4) } } });
  await playSession(x, 5);
  check('review: mastering the syllables of a letter opens the next even though its words are not practised (Spanish N)', st(x).pathEs === 5, String(st(x).pathEs));
  x = await boot({ lang: 'ca-ES', storage: { 'leemos-v1': { name: 'Elsa', sessionLen: 5, pathEs: 12, pathCa: 1, stats: masterSyl(LVCA, 1, 'ca:') } } });
  await playSession(x, 5);
  check('review: the Catalan first letter opens the second once its syllables are mastered', st(x).pathCa === 2, String(st(x).pathCa));
  // a second device that has never had progress must not lock an experienced child at M
  {
    const s = createFakeSupabase(); const { auth, uid } = await signedAuth(s);
    s.rows.set(RID_A, { id: RID_A, owner: uid, name: 'Elsa', kind: 'reader', data: dat({ stats: { 's:ma': { ok: 5, fail: 0 } }, total: 200, name: 'Elsa', modAt: 5 }), version: 1 });
    const app = await boot({ openPath: false, supa: s, syncConfig: CFG, syncEvery: 150, storage: { 'leemos-auth': auth, 'leemos-auth-user': uid, ...PROF_A, 'leemos-v1': { name: 'Elsa' } } });
    await until(() => JSON.parse(app.w.localStorage.getItem('leemos-v1')).total === 200, 3000); await sleep(40);
    check('review: a fresh device that pulls an experienced child starts with every letter open', st(app).pathEs === 12 && st(app).pathCa === 12 && !(st(app).prefs && st(app).prefs.pathEs), JSON.stringify([st(app).pathEs, st(app).prefs]));
  }
  // the rule module cannot load: no letter is opened and the parent block is not offered
  x = await boot({ importFails: true, storage: { 'leemos-v1': { name: 'Elsa', sessionLen: 5, pathEs: 1, pathCa: 1 } } });
  await playSession(x, 15);
  check('review: without the rule module no letter opens and the Camino block is hidden', st(x).pathEs === 1 && x.$('path').hidden && x.$('endPath').hidden, String(st(x).pathEs));
  // a parent closing letters swaps an exercise that is no longer allowed; opening more keeps it
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 12, pathCa: 12 } } });
  const card = () => [...x.d.querySelectorAll('#tiles .tile')].map((b) => b.textContent).join('');
  x.d.querySelectorAll('#pathRow button')[0].click(); await sleep(5);
  check('review: closing letters leaves only an allowed exercise on screen', stepOf(card()) <= 1, card());
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 1, pathCa: 1 } } });
  const before = card();
  x.d.querySelectorAll('#pathRow button')[2].click(); await sleep(5);
  check('review: opening more letters keeps the exercise she is reading', card() === before, before + ' -> ' + card());
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', mode: 'word', pathEs: 1, pathCa: 1 } } });
  x.$('mWord').click(); await sleep(5);
  check('review: tapping the dimmed Palabras explains why', /Palabras se abre/.test(x.$('hint').textContent), x.$('hint').textContent);
}

// ---------- 39. Leo: the sound is heard before he can answer ----------
{
  const LEO_CLIPS = { generated: 'test', clips: { es: new Proxy({}, { get: (_, k) => (typeof k === 'string' ? 'x.mp3' : undefined) }), ca: {} } };
  const leoState = (x) => JSON.parse(x.w.localStorage.getItem('leemos-v1:leo') || '{}');
  // starts a session and goes through the intro card to the first game round
  const toGame = async (mode, opts = {}) => {
    const x = await bootLeo({ manifest: opts.noClips ? null : LEO_CLIPS });
    x.w.__audioMode = mode;
    x.$('prePlay').click(); await sleep(10);
    if (x.$('preNext')) { x.$('preNext').click(); await sleep(10); }
    return x;
  };
  const choices = (x) => [...x.d.querySelectorAll('#preChoices .pre-choice')];
  const finish = async (x) => { const a = x.w.__audios[x.w.__audios.length - 1]; a.onended(); await sleep(5); };
  const statsOf = (x) => JSON.stringify([leoState(x).stats, leoState(x).total]);

  let x = await toGame('manual');
  const before = statsOf(x);
  check('listen first: when a round starts the answers are locked and look it', choices(x).length >= 2 && choices(x).every((b) => b.disabled) && x.$('preChoices').classList.contains('waiting'));
  choices(x).forEach((b) => b.onclick()); await sleep(5);
  check('listen first: tapping an answer before the sound has played does nothing, even bypassing the disabled button', statsOf(x) === before && leoState(x).total === 0 && choices(x).every((b) => !b.classList.contains('gone')), statsOf(x));
  await finish(x);
  check('listen first: when the sound ends the answers unlock', choices(x).every((b) => !b.disabled) && !x.$('preChoices').classList.contains('waiting'));
  const right = choices(x).find((b) => b.dataset.l === x.$('preChoices').dataset.answer);
  right.click(); await sleep(5);
  check('listen first: and a right answer then counts', leoState(x).total === 1 && JSON.stringify(leoState(x).stats).includes('"ok":1'), statsOf(x));

  // the browser refuses to start the sound by itself (no tap in this call stack): the answers stay locked until he taps the speaker
  x = await toGame('blocked');
  check('autoplay refused: the answers stay locked, the speaker button is marked and says what to do', choices(x).every((b) => b.disabled) && x.$('preHear').classList.contains('needed') && /Toca 🔊/.test(x.$('hint').textContent) && x.d.activeElement === x.$('preHear'), x.$('hint').textContent);
  x.w.__audioMode = 'auto';
  x.$('preHear').click(); await sleep(10);
  check('autoplay refused: tapping the speaker plays it and unlocks the answers', choices(x).every((b) => !b.disabled) && !x.$('preHear').classList.contains('needed'));
  const plays = x.w.__plays;
  x.$('preHear').click(); await sleep(10);
  check('listen first: tapping the speaker again just replays it and does not lock the answers again', x.w.__plays === plays + 1 && choices(x).every((b) => !b.disabled) && !x.$('preChoices').classList.contains('waiting'));

  // a wrong answer replays the sound and locks the answers again until it has ended: no tapping the same ones over and over
  x = await toGame('manual');
  await finish(x);
  const target = x.$('preChoices').dataset.answer;
  const wrong = choices(x).find((b) => b.dataset.l !== target);
  wrong.click(); await sleep(5);
  check('wrong answer: it is marked, counted once, and the rest lock again while the sound plays', wrong.classList.contains('gone') && wrong.disabled && leoState(x).stats['snd:' + wrong.dataset.l] === undefined && leoState(x).stats['snd:' + target].fail === 1 && choices(x).every((b) => b.disabled) && x.$('preChoices').classList.contains('waiting'), statsOf(x));
  choices(x).forEach((b) => b.onclick()); await sleep(5);
  check('wrong answer: hammering the answers while it plays changes nothing', leoState(x).stats['snd:' + target].fail === 1 && leoState(x).stats['snd:' + target].ok === 0 && leoState(x).total === 0);
  await finish(x);
  const left = choices(x).filter((b) => !b.disabled);
  check('wrong answer: when it ends only the answers not yet tried unlock, and focus goes to one of them', left.length >= 1 && left.every((b) => b.dataset.l !== wrong.dataset.l) && wrong.disabled && left.includes(x.d.activeElement), String(left.length));

  // never a dead end
  x = await toGame('auto', { noClips: true });
  check('no clip at all: there is nothing to wait for, so the answers are open', choices(x).length >= 2 && choices(x).every((b) => !b.disabled));
  x = await toGame('missing');
  check('a clip that cannot be loaded does not lock him out either', choices(x).length >= 2 && choices(x).every((b) => !b.disabled));
  x = await toGame('manual');
  x.w.__audios[x.w.__audios.length - 1].onerror(); await sleep(5);
  check('a clip that fails while loading unlocks the answers', choices(x).every((b) => !b.disabled));

  // the next round after a right answer starts by itself (a timer, not a tap): it must try to play and start locked
  x = await toGame('auto');
  await sleep(10);
  const p0 = x.w.__plays;
  choices(x).find((b) => b.dataset.l === x.$('preChoices').dataset.answer).click(); await sleep(30);
  check('next round: after a right answer the next sound is attempted on its own', x.w.__plays > p0, `${p0} -> ${x.w.__plays}`);

  // iOS: a timer cannot start a fresh audio element, but it can start the one a tap already played. Letters he has seen, so every round is a game.
  {
    const MA = { ok: 3, fail: 0 }, d0 = readJSON('src/data/sounds.es.json').groups[0].letters.map((x) => x.l); // the whole first group is already seen
    const strictLeo = async () => {
      const y = await boot({ storage: { ...LEO, 'leemos-v1:leo': { name: 'Leo', stats: Object.fromEntries(d0.map((l) => ['snd:' + l, MA])) } }, manifest: LEO_CLIPS });
      y.w.__audioMode = 'auto'; y.w.__strict = true; await until(() => y.$('prePlay'));
      y.w.__inTap = true; y.$('prePlay').click(); y.w.__inTap = false; await sleep(10);
      return y;
    };
    const y = await strictLeo();
    check('iOS rule: the first round (started by a tap) plays and unlocks the answers', !!y.$('preChoices') && choices(y).every((b) => !b.disabled) && !y.$('preHear').classList.contains('needed'));
    const n0 = y.w.__audios.length, calls0 = y.audioCalls.filter((u) => u === 'audio/es/x.mp3').length;
    y.w.__inTap = true; choices(y).find((b) => b.dataset.l === y.$('preChoices').dataset.answer).click(); y.w.__inTap = false; await sleep(30);
    // +2 clips: Lumi's praise (a new element, started inside the tap) and the next letter sound (the reused one)
    check('iOS rule: the next round (started by a timer) plays by itself, on the element the first tap unlocked (only the praise needs a new one)', !y.$('preHear').classList.contains('needed') && choices(y).every((b) => !b.disabled) && y.audioCalls.filter((u) => u === 'audio/es/x.mp3').length === calls0 + 2 && y.w.__audios.length === n0 + 1, `needed=${y.$('preHear').classList.contains('needed')} audios ${n0}->${y.w.__audios.length}`);
    check('iOS rule: no errors', y.errors.length === 0, y.errors.join(' | '));
  }

  // Lumi praises by himself at the end of a round (a clip with Leo's name; he comes big), not only when tapped
  {
    const MA2 = { ok: 3, fail: 0 }, seen0 = Object.fromEntries(readJSON('src/data/sounds.es.json').groups[0].letters.map((l) => ['snd:' + l.l, MA2])); // every round is a game, none an intro card
    const roundEnd = async (sound) => {
      const y = await boot({ storage: { ...LEO, 'leemos-v1:leo': { name: 'Leo', stats: seen0 } }, manifest: LEO_CLIPS });
      y.w.__audioMode = 'auto'; await until(() => y.$('prePlay'));
      if (!sound) { y.$('soundBtn').click(); await sleep(5); }
      y.$('prePlay').click(); await sleep(10);
      const a0 = y.w.__audios.length;
      choices(y).find((b) => b.dataset.l === y.$('preChoices').dataset.answer).click();
      const praise = y.$('hint').textContent; // read before the next round replaces it
      await sleep(30);
      return { y, praise, played: y.w.__audios.length - a0 };
    };
    const on = await roundEnd(true);
    check('Lumi (Leo): a right answer ends the round with his praise clip on a new audio element (the letter sounds reuse their own)', on.played === 1, String(on.played));
    check('Lumi (Leo): the praise is the sentence on screen, with Leo\'s name', /Leo/.test(on.praise) && on.y.errors.length === 0, on.praise + ' ' + on.y.errors.join('|'));
    const off = await roundEnd(false);
    check('Lumi (Leo): with the sounds button off he stays quiet', off.played === 0 && off.y.errors.length === 0, String(off.played));
  }

  // ?debug=1 (kept in localStorage) shows what the app plays and what the browser refuses, for devices with no console (the iPad)
  {
    const MA3 = { ok: 3, fail: 0 }, seen1 = Object.fromEntries(readJSON('src/data/sounds.es.json').groups[0].letters.map((l) => ['snd:' + l.l, MA3]));
    const plain = await bootLeo({ manifest: LEO_CLIPS });
    check('debug: off by default, nothing is added to the page', !plain.$('dbg') && plain.errors.length === 0);
    const y = await boot({ storage: { ...LEO, 'leemos-v1:leo': { name: 'Leo', stats: seen1 }, 'leemos-debug': '1' }, manifest: LEO_CLIPS });
    y.w.__audioMode = 'blocked'; await until(() => y.$('prePlay'));
    check('debug: with the flag the panel shows the sound setting, the language and the name', !!y.$('dbg') && /sound=true/.test(y.$('dbg').textContent) && /lang=es/.test(y.$('dbg').textContent) && /name=Leo/.test(y.$('dbg').textContent), (y.$('dbg') || {}).textContent);
    y.$('prePlay').click(); await sleep(20);
    check('debug: a play the browser refuses is listed with its error name and the clip', /REJECT NotAllowedError/.test(y.$('dbg').textContent) && /x\.mp3/.test(y.$('dbg').textContent), y.$('dbg').textContent);
    check('debug: the page is still usable and raised no errors', y.errors.length === 0, y.errors.join(' | '));
  }

  // iOS/iPadOS: Lumi's clip must not be rerouted through Web Audio (that route can be silent there) and the page asks for the "playback" audio session
  {
    const MA4 = { ok: 3, fail: 0 }, seen2 = Object.fromEntries(readJSON('src/data/sounds.es.json').groups[0].letters.map((l) => ['snd:' + l.l, MA4]));
    const ipad = (w) => { Object.defineProperty(w.navigator, 'platform', { value: 'MacIntel' }); Object.defineProperty(w.navigator, 'maxTouchPoints', { value: 5 }); Object.defineProperty(w.navigator, 'audioSession', { value: { type: 'auto' }, configurable: true }); };
    const round = async (onDom) => {
      const y = await boot({ storage: { ...LEO, 'leemos-v1:leo': { name: 'Leo', stats: seen2 }, 'leemos-debug': '1' }, manifest: LEO_CLIPS, voice: { state: 'running', sample: 128 }, onDom });
      y.w.__audioMode = 'auto'; await until(() => y.$('prePlay'));
      y.$('prePlay').click(); await sleep(10);
      const a0 = y.w.__audios.length, c0 = y.audioCalls.length;
      choices(y).find((b) => b.dataset.l === y.$('preChoices').dataset.answer).click(); await sleep(30);
      return { y, praised: y.w.__audios.length - a0, clips: y.audioCalls.length - c0 };
    };
    const ip = await round(ipad);
    check('iPad: Lumi\'s praise plays on the shared element a tap unlocked (no new one) and no Web Audio context is made for his beak', ip.praised === 0 && ip.clips >= 1 && (ip.y.w.__acs || []).length === 1 && ip.y.errors.length === 0, `new elements=${ip.praised} clips=${ip.clips} acs=${(ip.y.w.__acs || []).length} ${ip.y.errors.join('|')}`); // the one context left is the chime's, not Lumi's
    check('iPad: the page asks for the "playback" audio session (sound even with the mute setting on)', ip.y.w.navigator.audioSession.type === 'playback');
    check('iPad: the debug panel says which route Lumi used', /lumi route=direct/.test(ip.y.$('dbg').textContent), ip.y.$('dbg').textContent);
    const other = await round(null);
    check('other browsers keep the beak following the real loudness (a Web Audio context is made)', other.praised === 1 && (other.y.w.__acs || []).length === 2 && /lumi route=/.test(other.y.$('dbg').textContent), `acs=${(other.y.w.__acs || []).length}`);
  }

  // Lumi in Leo's screen: a tap on him or the bubble says the sentence on screen (a clip only, never the robot voice), but never over the letter sound
  {
    const G1 = 'escucha el sonido y toca su letra.';
    const HINT_ONLY = { generated: 'test', clips: { es: { [G1]: 'g.mp3' }, ca: {} } };
    const lumiRound = async (mode, manifest) => { const y = await bootLeo({ manifest }); y.w.__audioMode = mode; y.$('prePlay').click(); await sleep(10); if (y.$('preNext')) { y.$('preNext').click(); await sleep(10); } return y; };
    const y = await lumiRound('auto', HINT_ONLY);
    check('Lumi (Leo): the round shows the game hint', y.$('hint').textContent === 'Escucha el sonido y toca su letra.');
    const c0 = y.audioCalls.length; y.$('hint').click();
    check('Lumi (Leo): tapping the bubble plays the clip of the sentence on screen', y.audioCalls.length === c0 + 1 && y.audioCalls.at(-1) === 'audio/es/g.mp3', y.audioCalls.slice(-2).join(','));
    const c1 = y.audioCalls.length; y.$('mascot').dispatchEvent(new y.w.Event('click'));
    check('Lumi (Leo): so does tapping Lumi himself', y.audioCalls.length === c1 + 1 && y.audioCalls.at(-1) === 'audio/es/g.mp3');
    const z = await lumiRound('auto', null); const tts0 = (z.w.__tts || []).length, c2 = z.audioCalls.length; z.$('hint').click(); z.$('mascot').dispatchEvent(new z.w.Event('click'));
    check('Lumi (Leo): with no clip for the sentence he stays silent (no browser voice)', z.audioCalls.length === c2 && (z.w.__tts || []).length === tts0);
    const w2 = await lumiRound('manual', { generated: 'test', clips: { es: new Proxy({}, { get: (_, k) => (typeof k === 'string' ? 'x.mp3' : undefined) }), ca: {} } });
    const c3 = w2.audioCalls.length; w2.$('hint').click(); w2.$('mascot').dispatchEvent(new w2.w.Event('click'));
    check('Lumi (Leo): while the letter sound is still playing a tap on him does not cut it, and the answers stay locked', w2.audioCalls.length === c3 && choices(w2).every((b) => b.disabled));
    check('Lumi (Leo): no errors', y.errors.length + z.errors.length + w2.errors.length === 0, [...y.errors, ...z.errors, ...w2.errors].join(' | '));
  }
  check('the whole run raised no errors', x.errors.length === 0, x.errors.join(' | '));
}

// ---------- 39b. Leo's top of screen matches Elsa's: same header buttons that suit him, and his letter groups as level cards ----------
{
  const MAS = { ok: 3, fail: 0 };
  const cssT = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
  const preHide = (cssT.match(/html\.pre #levels[^{]*\{[^}]*\}|html\.pre [^{]*#stage \.actions[^{]*\{[^}]*\}/) || [''])[0];
  check('Leo header: the level row and the world button are no longer hidden for him; the profile switch and Aa still are', !/#levels/.test(preHide) && !/#worldBtn/.test(preHide) && /#caseBtn/.test(preHide) && /\.modes/.test(preHide), preHide.slice(0, 200));
  check('Leo header: the profile chip shows only on his home screen: a rule hides it once a round starts (no pre-home class) and the game button is in the header for both', /html\.pre body:not\(\.pre-home\) #profileBtn\{[^}]*display:none/.test(cssT) && !!readFileSync(join(ROOT, 'index.html'), 'utf8').match(/<header>[\s\S]*id="gameBtn"[\s\S]*<\/header>/));
  const g0 = readJSON('src/data/sounds.es.json').groups, gca = readJSON('src/data/sounds.ca.json').groups;
  const x = await boot({ storage: { ...LEO, 'leemos-v1:leo': { name: 'Leo', stats: Object.fromEntries(g0[0].letters.map((l) => ['snd:' + l.l, MAS])) } } });
  x.w.__audioMode = 'auto'; await until(() => x.$('prePlay'));
  const cards = () => [...x.d.querySelectorAll('#levels .level')];
  check('Leo header: his letter groups are cards in the level row, in the same style as Elsa\'s', cards().length === g0.length && cards().every((c) => c.querySelector('b') && c.querySelector('small') && c.querySelector('.bar i')), String(cards().length));
  check('Leo header: a card is titled with its number and letters, like "2. m s l p"', cards()[1].querySelector('b').textContent === '2. ' + g0[1].letters.map((l) => l.l).join(' '), cards()[1].querySelector('b').textContent);
  check('Leo header: the group he is in is marked current, the ones ahead are dimmed, none is a button (they only show progress)', cards()[0].getAttribute('aria-current') === 'true' && !cards()[1].hasAttribute('aria-current') && cards().slice(1).every((c) => c.classList.contains('locked')) && cards().every((c) => c.tagName !== 'BUTTON'));
  check('Leo header: each card shows how many letters of its group are mastered, with a bar', cards()[0].querySelector('small').textContent === '5 de 5' && cards()[0].querySelector('.bar i').style.width === '100%' && cards()[1].querySelector('small').textContent === '0 de 4' && cards()[1].querySelector('.bar i').style.width === '0%', cards().map((c) => c.querySelector('small').textContent).join(','));
  check('Leo header: the world button is there for him, and the language switch redraws the groups in Catalan', (() => { x.$('langBtn').click(); return true; })());
  await sleep(30);
  check('Leo header (ca): the cards follow the language', cards().length === gca.length && cards()[1].querySelector('b').textContent === '2. ' + gca[1].letters.map((l) => l.l).join(' ') && x.errors.length === 0, x.errors.join(' | ') || cards()[1].querySelector('b').textContent);
  check('Leo header: the profile chip is visible while he is on the Jugar screen and a round hides the home class', !x.$('profileBtn').hidden && x.d.body.classList.contains('pre-home'));
  x.$('prePlay').click(); await sleep(10);
  check('Leo header: once a round has started the home class is gone (so the chip is hidden by CSS)', !x.d.body.classList.contains('pre-home'));
  // the game-mode button is in the header for both profiles and turns the mode on without opening the panel
  const gb = await boot({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 12, pathCa: 12 } } });
  check('game button: the header has it, named for screen readers in both languages', !!gb.$('gameBtn') && gb.$('gameBtn').getAttribute('aria-label') === 'Modo juego (pantalla completa)');
  gb.$('gameBtn').click(); await sleep(5);
  check('game button: one tap turns game mode on (no need to open the parents\' panel) and remembers it', gb.d.documentElement.classList.contains('game') && gb.w.localStorage.getItem('leemos-game') === '1' && gb.errors.length === 0, gb.errors.join(' | '));
  const gl = await bootLeo(); gl.$('gameBtn').click(); await sleep(5);
  check('game button: it works on Leo\'s screen too', gl.d.documentElement.classList.contains('game') && gl.errors.length === 0, gl.errors.join(' | '));
  const gc = await boot({ lang: 'ca-ES', storage: { 'leemos-v1': { name: 'Elsa', pathEs: 12, pathCa: 12 } } });
  check('game button (ca): the label is in Catalan', gc.$('gameBtn').getAttribute('aria-label') === 'Mode joc (pantalla completa)', gc.$('gameBtn').getAttribute('aria-label'));
  // Elsa's own cards are untouched
  const e = await boot({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 12, pathCa: 12 } } });
  check('Leo header: Elsa still has her five level buttons', [...e.d.querySelectorAll('#levels .level')].length === 5 && [...e.d.querySelectorAll('#levels .level')].every((c) => c.tagName === 'BUTTON'));
}

// ---------- 40. a new session starts with an empty row of dots, and fast taps do not zoom ----------
{
  const dotsOn = (x) => x.d.querySelectorAll('#goal i.on').length;
  const dots = (x) => x.d.querySelectorAll('#goal i').length;
  // reader: finish a session, press "Otra sesión": the dots must be empty before the first answer
  let x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', sessionLen: 5, world: 0, pathEs: 12, pathCa: 12 } } });
  await playSession(x, 5);
  check('dots: the end of a session shows every dot filled', dotsOn(x) === 5 && dots(x) === 5, String(dotsOn(x)));
  x.$('endMore').click();
  check('dots: pressing Otra sesión empties them straight away, before the first answer', dots(x) === 5 && dotsOn(x) === 0, String(dotsOn(x)));
  // Leo
  x = await bootLeo();
  x.$('prePlay').click(); await playPre(x, 5); await sleep(10);
  check('dots (Leo): the end of a session shows every dot filled', dotsOn(x) === 5, String(dotsOn(x)));
  x.$('endMore').click(); await sleep(10);
  check('dots (Leo): and the next session starts with none filled', dotsOn(x) === 0 && dots(x) === 5, String(dotsOn(x)));
  // the "enough for today" rest and starting again
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', sessionLen: 5, world: 0, pathEs: 12, pathCa: 12 } } });
  await playSession(x, 5);
  x.$('endStop').click(); await sleep(5);
  x.$('mWord').click(); await sleep(5); // a parent changing the mode ends the rest and starts a new session
  check('dots: resting and coming back starts with none filled', dotsOn(x) === 0 && /0 de 5/.test(x.$('slabel').textContent), `${dotsOn(x)} ${x.$('slabel').textContent}`);
  // a longer session length from the parent panel: the row is redrawn with the new length
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', sessionLen: 5, world: 0, pathEs: 12, pathCa: 12 } } });
  x.$('sessionSel').value = '10'; x.$('sessionSel').dispatchEvent(new x.w.Event('change')); await sleep(5);
  check('dots: changing the session length redraws the row with that many dots, none filled', dots(x) === 10 && dotsOn(x) === 0, `${dots(x)} ${dotsOn(x)}`);

  // fast repeated taps must not zoom the page or select text (double-tap zoom off, pinch zoom stays)
  const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
  check('zoom: double-tap zoom is turned off for the whole page with touch-action: manipulation (pinch zoom is kept)', /html[^{]*\{[^}]*touch-action:\s*manipulation/.test(css) && !/user-scalable\s*=\s*no|maximum-scale/.test(readFileSync(join(ROOT, 'index.html'), 'utf8')));
  check('zoom: the buttons, tiles and answers also carry it, and the game area cannot be selected or long-pressed into a menu', /\.pre-choice[^{]*\{[^}]*touch-action:\s*manipulation/.test(css) && /#stage[^{]*\{[^}]*user-select:\s*none/.test(css) && /-webkit-touch-callout:\s*none/.test(css));
}

// ---------- 41. game mode: only the game on screen, full screen where the browser allows, a small X to leave ----------
{
  const root = (x) => x.d.documentElement;
  let x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 12, pathCa: 12 } } });
  check('game mode: the parents\' panel offers it, and it is off at first (the exit button is not there)', !!x.d.querySelector('#parents #gameOn') && !root(x).classList.contains('game') && x.$('gameOff').hidden);
  let asked = 0;
  root(x).requestFullscreen = () => { asked++; return Promise.resolve(); };
  x.$('parents').open = true;
  x.$('gameOn').click(); await sleep(5);
  check('game mode: turning it on marks the page, shows the exit button, closes the panel, remembers it on this device and asks for full screen', root(x).classList.contains('game') && !x.$('gameOff').hidden && x.$('parents').open === false && x.w.localStorage.getItem('leemos-game') === '1' && asked === 1, `asked ${asked}`);
  let left = 0;
  root(x).constructor; Object.defineProperty(x.d, 'fullscreenElement', { value: root(x), configurable: true });
  x.d.exitFullscreen = () => { left++; return Promise.resolve(); };
  x.$('gameOff').click(); await sleep(5);
  check('game mode: the X turns it off, forgets it and leaves full screen', !root(x).classList.contains('game') && x.$('gameOff').hidden && x.w.localStorage.getItem('leemos-game') === null && left === 1 && x.errors.length === 0, `left ${left}`);
  // a phone whose browser has no full screen API: the extras are hidden anyway and nothing throws
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 12, pathCa: 12 } } });
  x.$('gameOn').click(); await sleep(5);
  check('game mode: without a full screen API it still works and raises no error', root(x).classList.contains('game') && x.errors.length === 0, x.errors.join(' | '));
  // a refused full screen request is swallowed
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 12, pathCa: 12 } } });
  root(x).requestFullscreen = () => Promise.reject(new Error('denied'));
  x.$('gameOn').click(); await sleep(10);
  check('game mode: a refused full screen request does not break it', root(x).classList.contains('game') && x.errors.length === 0, x.errors.join(' | '));
  // coming back to the page keeps it on, without asking for full screen (that needs a tap)
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 12, pathCa: 12 }, 'leemos-game': '1' } });
  let again = 0;
  check('game mode: reloading keeps it on and shows the exit button', root(x).classList.contains('game') && !x.$('gameOff').hidden && again === 0);
  x.$('gameOff').click(); await sleep(5);
  check('game mode: and the exit button works after a reload', !root(x).classList.contains('game') && x.w.localStorage.getItem('leemos-game') === null);
  // a big screen is used: the game is zoomed to fit the viewport (never below 1, so phones are unchanged), and the zoom goes away with the mode
  {
    const gz = (y) => Number(y.d.documentElement.style.getPropertyValue('--gz') || 0);
    const air = (h) => h * 1.03 + 2; // the card + padding plus a little air so rounding never makes it scroll
    const view = (y, w, h) => { Object.defineProperty(y.w, 'innerWidth', { value: w, configurable: true }); Object.defineProperty(y.w, 'innerHeight', { value: h, configurable: true }); y.w.dispatchEvent(new y.w.Event('resize')); };
    const g = await boot({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 12, pathCa: 12 }, 'leemos-game': '1' } });
    view(g, 1000, 650);
    check('game zoom: a tablet viewport (1000x650) zooms by the tighter side (the height, with a little air)', Math.abs(gz(g) - 650 / air(480)) < 0.01, String(gz(g)));
    view(g, 834, 1194);
    check('game zoom: portrait follows the width (834 / 560)', Math.abs(gz(g) - 834 / 560) < 0.01, String(gz(g)));
    view(g, 390, 844);
    check('game zoom: a phone is never shrunk (stays at 1)', gz(g) === 1, String(gz(g)));
    view(g, 3000, 2000);
    check('game zoom: a huge screen stops at 2.4', gz(g) === 2.4, String(gz(g)));
    g.$('gameOff').click(); await sleep(5); view(g, 1000, 650);
    check('game zoom: leaving the mode removes the zoom and a resize does not bring it back', g.d.documentElement.style.getPropertyValue('--gz') === '', g.d.documentElement.style.getPropertyValue('--gz'));
    const g2 = await boot({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 12, pathCa: 12 } } });
    view(g2, 1000, 650); g2.d.querySelector('#parents').open = true; g2.$('gameOn').click(); await sleep(5);
    check('game zoom: turning the mode on applies the zoom for the current viewport', Math.abs(gz(g2) - 650 / air(480)) < 0.01 && g2.errors.length === 0, String(gz(g2)));
    // content that is taller than the default (Busca's 12 tiles, a word with its picture) lowers the zoom so the card still fits the height: no scroll in game mode
    {
      const g3 = await boot({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 12, pathCa: 12 }, 'leemos-game': '1' } });
      const natural = { h: 430 }; // the card's height at zoom 1
      let reportZoomed = true; // engines differ on whether a rect under CSS zoom is zoomed: the fit must give the same answer either way
      g3.w.Element.prototype.getBoundingClientRect = function () { const z = reportZoomed ? Number(g3.d.documentElement.style.getPropertyValue('--gz')) || 1 : 1; return { width: 0, height: this.classList && this.classList.contains('stage') ? natural.h * z : 0, top: 0, left: 0, right: 0, bottom: 0 }; };
      const pad = (() => { const cs = g3.w.getComputedStyle(g3.d.querySelector('main')); return (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0); })();
      view(g3, 1194, 834);
      check('game zoom: a card of the default height gets the same zoom as before (height / (card + padding))', Math.abs(gz(g3) - Math.min(1194 / 560, 834 / air(430 + pad))) < 0.01, String(gz(g3)));
      natural.h = 700; view(g3, 1194, 834);
      check('game zoom: a taller card (700) lowers the zoom so card + padding fit the viewport height', Math.abs(gz(g3) - 834 / air(700 + pad)) < 0.01 && gz(g3) * (700 + pad) <= 834, String(gz(g3)));
      natural.h = 900; view(g3, 1194, 834);
      check('game zoom: and it never goes below 1', gz(g3) === 1, String(gz(g3)));
      natural.h = 430; view(g3, 1194, 834); // a zoom above 1 is in force first
      reportZoomed = false; natural.h = 700; view(g3, 1194, 834);
      check('game zoom: the same answer when the engine reports unzoomed sizes (Safari may), because the card is measured at zoom 1', Math.abs(gz(g3) - 834 / air(700 + pad)) < 0.01, String(gz(g3)));
      reportZoomed = true;
      natural.h = 430; view(g3, 1194, 834);
      g3.d.querySelector('main').appendChild(g3.d.createElement('div')); natural.h = 650; await sleep(60);
      check('game zoom: a change of content in main refits the zoom by itself', Math.abs(gz(g3) - 834 / air(650 + pad)) < 0.01 && g3.errors.length === 0, `${gz(g3)} ${g3.errors.join('|')}`);
    }
    const cssG = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
    check('game zoom: the page is not capped at 660px in game mode and takes the zoom', /html\.game main\{[^}]*max-width:none[^}]*zoom:var\(--gz/.test(cssG));
  }
  // the exit button has a name for screen readers, in both languages
  check('game mode: the exit button is named for screen readers', x.$('gameOff').getAttribute('aria-label') === 'Salir del modo juego', x.$('gameOff').getAttribute('aria-label'));
  x = await boot({ lang: 'ca-ES', storage: { 'leemos-v1': { name: 'Elsa', pathEs: 12, pathCa: 12 } } });
  check('game mode: and in Catalan', x.$('gameOff').getAttribute('aria-label') === 'Sortir del mode joc' && /Mode joc/.test(x.$('gameOn').textContent), x.$('gameOn').textContent);
  // Leo can use it too
  x = await bootLeo();
  x.$('gameOn').click(); await sleep(5);
  x.$('prePlay').click(); await sleep(10);
  check('game mode: it works for Leo, who keeps playing', root(x).classList.contains('game') && !!(x.$('preNext') || x.$('preHear')) && x.errors.length === 0, x.errors.join(' | '));

  // what the CSS hides, and where the exit button sits
  const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8').replace(/\s+/g, ' ');
  const hides = (sel) => new RegExp(`html\\.game[^{]*${sel.replace(/[.#]/g, '\\$&')}[^{]*\\{[^}]*display:\\s*none`).test(css);
  check('game mode: the header, the level chips, the mode switch and the parents\' panel are hidden', ['header', '#levels', '.modes', '#parents'].every(hides), ['header', '#levels', '.modes', '#parents'].filter((s) => !hides(s)).join(','));
  check('game mode: the game is centred on a screen of its own (full height, which the zoom divides out, and safe-area padding)', /html\.game main\{[^}]*min-height:\s*calc\(100dvh \/ var\(--gz,1\)\)[^}]*justify-content:\s*center[^}]*safe-area-inset-top/.test(css) && /html\.game main\{[^}]*safe-area-inset-bottom/.test(css));
  check('game mode: the game itself (Lumi, the dots, the tiles, the answers, the buttons of the exercise) is not hidden', !hides('#stage') && !hides('.coach') && !hides('#goal') && !hides('#tiles') && !hides('.actions') && !hides('#pre'));
  check('game mode: the exit button is small, in a corner, inside the safe area, and at least 44 px to tap', /\.game-off\{[^}]*position:\s*fixed[^}]*env\(safe-area-inset-top\)/.test(css) && /\.game-off\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px|\.game-off\{[^}]*width:\s*44px[^}]*height:\s*44px/.test(css));
}

// ---------- 42. words shown whole, like the school book ----------
{
  const WORDS4 = [{ w: 'ma-no', e: '✋' }, { w: 'ma-ma', e: '👩' }, { w: 'so-pa', e: '🍲' }, { w: 'pa-la', e: '🪓' }];
  const patchLevels = (d) => d.map((L, i) => (i === 0 ? { ...L, syl: ['ma', 'me', 'mi', 'mo', 'mu'], words: WORDS4 } : L));
  const patchSol = (d) => d.map((L, i) => (i === 0 ? { ...L, syl: ['ma', 'me', 'mi', 'mo', 'mu'], words: [{ w: 'sol', e: '☀️' }, ...WORDS4.slice(0, 3)] } : L));
  const st = (extra = {}) => ({ name: 'Elsa', mode: 'word', level: 0, pathEs: 12, pathCa: 12, ...extra });
  const KEYS4 = WORDS4.map((o) => 'w:' + o.w);
  const stats = (ok, fail) => Object.fromEntries(KEYS4.map((k) => [k, { ok, fail }]));
  const tiles = (x) => [...x.d.querySelectorAll('#tiles .tile')];
  const wordNow = (x) => tiles(x).map((b) => b.textContent).join('');
  const first = async (state, extra = {}) => { const x = await boot({ levelsPatch: patchLevels, storage: { 'leemos-v1': state }, ...extra }); return x; };
  const isWhole = (x) => tiles(x).length === 1 && tiles(x)[0].classList.contains('whole');

  // the parents' panel offers the three styles, automatic first
  let x = await first(st());
  const opts = [...x.d.querySelectorAll('#wordStyleSel option')].map((o) => o.value);
  check('whole words: the parents\' panel offers Automático, Separadas and Como el libro, and automatic is the default', opts.join() === 'auto,split,whole' && x.$('wordStyleSel').value === 'auto', opts.join());

  // the rule in automatic: read correctly at least twice AND wins ahead of failures by 2
  const cases = [['no record', {}, false], ['ok 1', stats(1, 0), false], ['ok 2', stats(2, 0), true], ['ok 2 fail 1', stats(2, 1), false], ['ok 3 fail 1', stats(3, 1), true], ['ok 5 fail 4', stats(5, 4), false], ['ok 0 fail 3', stats(0, 3), false]];
  for (const [name, s, expectWhole] of cases) {
    x = await first(st({ stats: s }));
    const w = wordNow(x);
    const multi = WORDS4.some((o) => o.w.replace(/-/g, '') === w);
    check(`whole words (auto): ${name} -> ${expectWhole ? 'whole' : 'split'}`, multi && isWhole(x) === expectWhole && (expectWhole ? tiles(x).length === 1 : tiles(x).length === 2), `${w} ${tiles(x).length} tiles`);
  }

  // forced styles
  x = await first(st({ wordStyle: 'split', stats: stats(5, 0) }));
  check('whole words (separadas): always split, even for a word she has mastered', tiles(x).length === 2 && !isWhole(x) && x.$('joinBtn').textContent === 'Juntar');
  x = await first(st({ wordStyle: 'whole' }));
  check('whole words (como el libro): one plain block with the whole word, even when it is new', isWhole(x) && WORDS4.some((o) => o.w.replace(/-/g, '') === wordNow(x)), wordNow(x));
  check('whole words: the block has no syllable colour, is not tappable (hearing it would give the answer away) and the button says Comprobar', !/\bc[0-4]\b/.test(tiles(x)[0].className) && tiles(x)[0].onclick === null && x.$('joinBtn').textContent === 'Comprobar', tiles(x)[0].className + ' | ' + x.$('joinBtn').textContent);
  check('whole words: Lumi\'s instruction is to read the word aloud, not to join syllables', /lee la palabra/i.test(x.$('hint').textContent) && !/únelas/.test(x.$('hint').textContent), x.$('hint').textContent);
  // the normal flow still works: check, then the adult judges
  x.$('joinBtn').click(); await sleep(5);
  check('whole words: Comprobar plays the word, shows the picture and asks the adult to judge', !x.$('okBtn').hidden && !x.$('noBtn').hidden && x.$('joinBtn').hidden && x.$('pic').classList.contains('on'));
  x.$('okBtn').click(); await sleep(10);
  const rec = JSON.parse(x.w.localStorage.getItem('leemos-v1'));
  check('whole words: a judged reading counts like any other (same record, same total)', rec.total === 1 && Object.values(rec.stats).some((s) => s.ok === 1), JSON.stringify(rec.stats));
  // one-syllable words and Sílabas mode are not touched
  x = await first(st({ wordStyle: 'whole', mode: 'syl' }));
  check('whole words: in Sílabas mode the syllables stay as they are', tiles(x).every((b) => !b.classList.contains('whole')) && x.$('joinBtn').textContent === 'Juntar');
  let one = null;
  for (let i = 0; i < 40 && !one; i++) { const y = await boot({ levelsPatch: patchSol, storage: { 'leemos-v1': st({ wordStyle: 'whole' }) } }); if (wordNow(y) === 'sol') one = y; }
  check('whole words: a one-syllable word has nothing to split and keeps the normal tile and the Juntar button', !!one && tiles(one).length === 1 && !tiles(one)[0].classList.contains('whole') && one.$('joinBtn').textContent === 'Juntar');

  // the parent's setting acts at once, is saved and stamped as a preference
  x = await first(st({ wordStyle: 'split' }));
  x.$('wordStyleSel').value = 'whole'; x.$('wordStyleSel').dispatchEvent(new x.w.Event('change')); await sleep(10);
  const saved = JSON.parse(x.w.localStorage.getItem('leemos-v1'));
  check('whole words: choosing Como el libro in the panel shows the next word whole and saves it as a synced preference', isWhole(x) && saved.wordStyle === 'whole' && saved.prefs.wordStyle.v === 'whole', JSON.stringify(saved.prefs && saved.prefs.wordStyle));
  // a bad stored value falls back to automatic
  x = await first(st({ wordStyle: 'weird' }));
  check('whole words: an unknown saved value falls back to automatic', x.$('wordStyleSel').value === 'auto' && x.errors.length === 0);
  // another device changes it
  const { s: supa, app } = await signedBoot({ syncEvery: 120, levelsPatch: patchLevels });
  const row = supa.rows.get(RID_A); row.data = { ...row.data, prefs: { ...(row.data.prefs || {}), wordStyle: { v: 'whole', at: Date.now() + 5000 } } }; row.version++;
  await until(() => JSON.parse(app.w.localStorage.getItem('leemos-v1')).wordStyle === 'whole', 3000);
  await sleep(40);
  check('whole words: a style chosen on another device is applied and shown in the panel', app.$('wordStyleSel').value === 'whole');
  const { s: supa2, app: app2 } = await signedBoot({ syncEvery: 120, levelsPatch: patchLevels });
  const row2 = supa2.rows.get(RID_A); row2.data = { ...row2.data, prefs: { wordStyle: { v: 'zzz', at: Date.now() + 5000 } } }; row2.version++;
  await sleep(500);
  check('whole words: a hostile value from the server never reaches the app', JSON.parse(app2.w.localStorage.getItem('leemos-v1')).wordStyle !== 'zzz' && app2.errors.length === 0);
  // Catalan texts
  x = await first(st({ wordStyle: 'whole' }), { lang: 'ca-ES' });
  check('whole words: and in Catalan', x.$('joinBtn').textContent === 'Comprova' && /llegeix la paraula/i.test(x.$('hint').textContent) && /Com el llibre/.test(x.$('wordStyleSel').textContent), x.$('joinBtn').textContent + ' | ' + x.$('hint').textContent);
  // the whole-word tile is static: no animation or transition
  const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
  check('whole words: the plain tile is styled, and has no animation or transition', /\.tile\.whole\{/.test(css) && !/\.tile\.whole\{[^}]*(animation|transition)/.test(css));
}
// ---------- 38. motion: the new letter lands, the new sticker is found in the album, the Camino letters change in place ----------
{
  const { stepOf } = await import('../src/levelrule.js');
  const LVES = readJSON('src/data/levels.es.json');
  const m1 = Object.fromEntries([...LVES[0].syl.map((s) => ['s:' + s, s]), ...LVES[0].words.map((o) => ['w:' + o.w, o.w])].filter(([, h]) => stepOf(h) === 1).map(([k]) => [k, { ok: 3, fail: 0 }]));
  const newLetterState = { name: 'Elsa', sessionLen: 5, world: 0, pathEs: 1, pathCa: 1, stats: m1 };
  // sparkles are removed by a timer the harness runs at once, so count them as they are added
  const watchSparks = (app) => { app.w.__sparks = 0; new app.w.MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList && n.classList.contains('spark')) app.w.__sparks++; }).observe(app.d.body, { childList: true, subtree: true }); };
  let x = await boot({ storage: { 'leemos-v1': newLetterState } });
  watchSparks(x);
  const base = () => x.w.__sparks;
  await playSession(x, 5);
  const tile = x.d.querySelector('#endPath .newletter');
  check('motion: the new letter is announced with a tile in the app\'s own tile colours, hidden from screen readers (the sentence says it)', !!tile && tile.textContent === 'P' && tile.getAttribute('aria-hidden') === 'true' && /^newletter c[0-4]$/.test(tile.className) && /P/.test(x.$('endPath').textContent.replace(/^P/, '')), tile && tile.className);
  await sleep(30);
  check('motion: and it ends with a sparkle burst over the tile', base() >= 10, String(base()));
  x = await boot({ reduced: true, storage: { 'leemos-v1': newLetterState } });
  watchSparks(x);
  await playSession(x, 5);
  await sleep(30);
  check('motion: with reduced motion the tile is there but nothing sparkles', !!x.d.querySelector('#endPath .newletter') && x.w.__sparks === 0, String(x.w.__sparks));
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', sessionLen: 5, world: 0, pathEs: 1, pathCa: 1 } } });
  await playSession(x, 5);
  check('motion: no tile when no letter opened', x.$('endPath').hidden && !x.d.querySelector('#endPath .newletter'));

  // the sticker she just earned is found in the album
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', sessionLen: 5, world: 3, pathEs: 12, pathCa: 12 } } });
  await playSession(x, 5);
  x.$('albumBtn').click();
  const fresh = [...x.d.querySelectorAll('#stickerGrid .sticker.fresh')];
  check('motion: opening the album after earning marks exactly the new sticker', fresh.length === 1 && fresh[0].textContent === x.$('rewardEmoji').textContent && !fresh[0].classList.contains('locked'), fresh.map((e) => e.textContent).join(','));
  x.$('albumClose').click();
  x.$('albumBtn').click();
  check('motion: the second time the album opens nothing is marked (it arrives once)', x.d.querySelectorAll('#stickerGrid .sticker.fresh').length === 0);
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 12, pathCa: 12, stk: { bosque: 2 }, stickers: 2 } } });
  x.$('albumBtn').click();
  check('motion: an album opened without a new sticker marks none', x.d.querySelectorAll('#stickerGrid .sticker.fresh').length === 0);

  // the Camino letters keep their buttons, so their state can transition
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 3, pathCa: 12 } } });
  const before = [...x.d.querySelectorAll('#pathRow button')];
  before[5].click(); await sleep(5);
  const after = [...x.d.querySelectorAll('#pathRow button')];
  check('motion: tapping a letter updates the same 12 buttons in place (so the change can transition) and the states are right', after.length === 12 && after.every((b, i) => b === before[i]) && after.filter((b) => !b.classList.contains('closed')).length === 6 && after[5].getAttribute('aria-pressed') === 'true' && before[2].getAttribute('aria-pressed') === 'false');
  check('motion: a button tapped again still works after the in-place update', (() => { after[1].click(); return true; })());
  await sleep(5);
  check('motion: and moves the position', JSON.parse(x.w.localStorage.getItem('leemos-v1')).pathEs === 2 && x.d.querySelectorAll('#pathRow button:not(.closed)').length === 2);
}

// ---------- 43a. Elsa's mute for the reading sounds (words, syllables, letters): Lumi and the effects stay ----------
{
  const ANYC = { generated: 'test', clips: { es: new Proxy({}, { get: (_, k) => (typeof k === 'string' ? 'x.mp3' : undefined) }), ca: {} } };
  const ELSA = { 'leemos-v1': { name: 'Elsa', pathEs: 12, pathCa: 12, world: 0, mode: 'word' } }; // word mode: its split tiles are tappable
  const m = await boot({ storage: ELSA, manifest: ANYC }); m.w.__audioMode = 'auto';
  check('mute: the header has a button for the reading sounds, named in Spanish, separate from the bell', !!m.$('muteBtn') && m.$('muteBtn').getAttribute('aria-label') === 'Silenciar palabras, sílabas y letras' && m.$('muteBtn').id !== 'soundBtn' && m.$('muteBtn').getAttribute('aria-pressed') === 'false' && m.$('muteBtn').textContent === '🔊');
  check('mute: game mode has its own copy next to the exit X', !!m.$('muteGame') && m.$('muteGame').classList.contains('game-off') && m.$('muteGame').getAttribute('aria-label') === 'Silenciar palabras, sílabas y letras');
  const tile = () => m.d.querySelector('#tiles .tile'), tts0 = (m.w.__tts || []).length, c0 = m.audioCalls.length;
  tile().click();
  check('mute: with it off a tapped syllable is read aloud', m.audioCalls.length > c0 || (m.w.__tts || []).length > tts0);
  m.$('muteBtn').click(); await sleep(5);
  check('mute: the button shows it is on, and the choice is kept on this device only (its own key, not in the profile)', m.$('muteBtn').getAttribute('aria-pressed') === 'true' && m.$('muteBtn').textContent === '🔇' && m.w.localStorage.getItem('leemos-mute') === '1' && !('mute' in JSON.parse(m.w.localStorage.getItem('leemos-v1'))));
  const c1 = m.audioCalls.length, t1 = (m.w.__tts || []).length;
  tile().click(); m.$('hearBtn').click(); await sleep(5);
  check('mute: a syllable or word tapped now makes no sound at all, neither a clip nor the browser voice', m.audioCalls.length === c1 && (m.w.__tts || []).length === t1);
  const c2 = m.audioCalls.length; m.$('hint').click(); await sleep(5);
  check('mute: Lumi still speaks his sentence when tapped (it is not a reading sound)', m.audioCalls.length === c2 + 1);
  m.w.__osc = 0; m.w.AudioContext = class { constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; } createOscillator() { m.w.__osc++; return { frequency: {}, connect() {}, start() {}, stop() {} }; } createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; } resume() {} };
  m.$('soundBtn').click(); m.$('soundBtn').click(); await sleep(5);
  check('mute: the bell and its effects are untouched', m.w.__osc > 0, String(m.w.__osc));
  m.$('muteBtn').click(); await sleep(5);
  const c3 = m.audioCalls.length, t3 = (m.w.__tts || []).length; tile().click();
  check('mute: tapping it again brings the reading sounds back and forgets the choice', m.$('muteBtn').getAttribute('aria-pressed') === 'false' && m.w.localStorage.getItem('leemos-mute') === null && (m.audioCalls.length > c3 || (m.w.__tts || []).length > t3));
  check('mute: no errors', m.errors.length === 0, m.errors.join(' | '));
  // saved on this device, and the game-mode copy keeps the same state
  const g = await boot({ storage: { ...ELSA, 'leemos-mute': '1', 'leemos-game': '1' }, manifest: ANYC }); g.w.__audioMode = 'auto';
  check('mute: a saved mute is on after a reload, in both buttons', g.$('muteBtn').getAttribute('aria-pressed') === 'true' && g.$('muteGame').getAttribute('aria-pressed') === 'true' && g.$('muteGame').textContent === '🔇');
  g.$('muteGame').click(); await sleep(5);
  check('mute: the game-mode button toggles the same setting and the header one follows', g.$('muteBtn').getAttribute('aria-pressed') === 'false' && g.w.localStorage.getItem('leemos-mute') === null);
  const ca = await boot({ lang: 'ca-ES', storage: ELSA }); 
  check('mute (ca): the label is in Catalan', ca.$('muteBtn').getAttribute('aria-label') === 'Silenciar paraules, síl·labes i lletres', ca.$('muteBtn').getAttribute('aria-label'));
  // Cierra and Busca: their syllables and letter sounds are muted, the instruction by Lumi is not
  const cman = { generated: 'test', clips: { es: new Proxy({}, { get: (_, k) => (typeof k === 'string' ? 'c' + k + '.mp3' : undefined) }), ca: {} } };
  const cx = await boot({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 3, pathCa: 12, world: 0 }, 'leemos-mute': '1' }, manifest: cman }); cx.w.__audioMode = 'auto'; cx.w.__leemosRescueMs = 9000;
  cx.$('mClose').click(); await until(() => !cx.$('closeRoom').hidden);
  const intro = cx.audioCalls.length;
  cx.d.querySelector('.close-tile.base').click(); const cd = cx.d.querySelector('.close-coda'); cd.click(); await sleep(30);
  check('mute (Cierra): the base, the coda sound and the stretched syllable are silent, and the syllable still closes and the screen goes on', cx.audioCalls.length === intro && cx.d.querySelectorAll('.close-dots i.on').length === 1 && cx.errors.length === 0, `${cx.audioCalls.length - intro} extra, dots=${cx.d.querySelectorAll('.close-dots i.on').length} ${cx.errors.join('|')}`);
  const bx = await boot({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 3, pathCa: 12, world: 0 }, 'leemos-mute': '1' }, manifest: ANYC }); bx.w.__audioMode = 'auto';
  bx.$('mFind').click(); await until(() => !bx.$('findRoom').hidden);
  const bi = bx.audioCalls.length, tg = bx.d.querySelector('.find-target').textContent;
  [...bx.d.querySelectorAll('.find-tile')].find((b) => b.textContent === tg).click(); bx.d.querySelector('.find-target').click(); await sleep(5);
  check('mute (Busca): a tapped word is silent', bx.audioCalls.length === bi && bx.errors.length === 0);
  // Leo is never muted (his whole game is the letter sounds, and he has no button to undo it)
  const lx = await boot({ storage: { ...LEO, 'leemos-v1:leo': { name: 'Leo', stats: Object.fromEntries(['a', 'e', 'i', 'o', 'u'].map((l) => ['snd:' + l, { ok: 3, fail: 0 }])) }, 'leemos-mute': '1' }, manifest: ANYC }); lx.w.__audioMode = 'auto'; await until(() => lx.$('prePlay'));
  const l0 = lx.audioCalls.length; lx.$('prePlay').click(); await sleep(20);
  check('mute (Leo): a saved mute does not silence his letter sounds', lx.audioCalls.length > l0 && lx.errors.length === 0);
  const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
  check('mute (Leo): the buttons are not shown on his screen', /html\.pre #muteBtn[^{]*\{[^}]*display:none/.test(css) || /html\.pre [^{]*#muteBtn[^{]*\{[^}]*display:none/.test(css));
}

// ---------- 43b. iPad: the praise that starts from a timer (the sticker after Busca, the answer's praise) still plays ----------
{
  const ipad = (w) => { Object.defineProperty(w.navigator, 'platform', { value: 'MacIntel' }); Object.defineProperty(w.navigator, 'maxTouchPoints', { value: 5 }); };
  const ANY = { generated: 'test', clips: { es: new Proxy({}, { get: (_, k) => (typeof k === 'string' ? 'x.mp3' : undefined) }), ca: {} } };
  const tap = (y, f) => { y.w.__inTap = true; try { f(); } finally { y.w.__inTap = false; } }; // a real tap: audio may start inside it
  const y = await boot({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 3, pathCa: 12, world: 0 } }, manifest: ANY, onDom: ipad });
  y.w.__audioMode = 'auto'; y.w.__strict = true;
  tap(y, () => y.$('mFind').click()); await until(() => !y.$('findRoom').hidden);
  const pageCopies = () => { const t = y.d.querySelector('.find-target').textContent; return [...y.d.querySelectorAll('.find-tile')].filter((b) => b.textContent === t); };
  for (let p = 0; p < 5; p++) { tap(y, () => pageCopies().forEach((b) => b.click())); await sleep(30); } // the pages and the reward follow from timers, with no tap
  check('iPad (Busca): the sticker reward is shown after the last page', !y.$('reward').hidden);
  check('iPad (Busca): nothing the app played was refused, including the praise that started from a timer', !(y.w.__refused > 0) && y.errors.length === 0, `refused=${y.w.__refused} ${y.errors.join('|')}`);
  const calls = y.audioCalls.length; tap(y, () => y.$('rewardOk').click()); await sleep(10);
  check('iPad (Busca): the clips of the game were played (intro, the words, the praise)', calls >= 8, String(calls));
}

// ---------- 43. Busca la paraula: find the 3 copies among 12 look-alikes ----------
{
  const R = (extra = {}) => ({ 'leemos-v1': { name: 'Elsa', pathEs: 3, pathCa: 12, world: 0, ...extra } });
  const room = (x) => x.$('findRoom');
  const tiles = (x) => [...x.d.querySelectorAll('.find-tile')];
  const target = (x) => x.d.querySelector('.find-target').textContent;
  const copies = (x) => tiles(x).filter((b) => b.textContent === target(x));
  const others = (x) => tiles(x).filter((b) => b.textContent !== target(x));
  const saved = (x) => JSON.parse(x.w.localStorage.getItem('leemos-v1'));
  const progress = (x) => JSON.stringify({ s: saved(x).stats, t: saved(x).total, p: saved(x).progress, lv: saved(x).level, m: saved(x).modAt, sess: saved(x).session });
  const start = async (extra, opts = {}) => { const x = await boot({ storage: R(extra), ...opts }); x.w.__audioMode = 'auto'; x.$('mFind').click(); await until(() => !room(x).hidden); return x; };

  const withSfx = (x) => { x.w.__osc = 0; x.w.AudioContext = class { constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; } createOscillator() { x.w.__osc++; return { frequency: {}, connect() {}, start() {}, stop() {} }; } createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; } resume() {} }; }; // counts the sound effects
  let x = await start();
  withSfx(x);
  check('find: the third mode button exists and a tap opens the game', !!x.$('mFind') && !room(x).hidden && x.d.documentElement.classList.contains('find') && x.$('mFind').getAttribute('aria-pressed') === 'true');
  check('find: a page has 12 tiles, 3 copies of the target, and 5 dots', tiles(x).length === 12 && copies(x).length === 3 && x.d.querySelectorAll('.find-dots i').length === 5);
  check('find: the target is a word of the current letters (Camino step 3 = m p l)', /^[mpl]/.test(target(x)));
  check('find: the saved preference is the mode', saved(x).mode === 'find');
  const before = progress(x), tts0 = (x.w.__tts || []).length, audio0 = x.audioCalls.length;
  others(x)[0].click();
  check('find: a wrong tap wobbles, says nothing and counts nothing', others(x).some((b) => b.classList.contains('wobble')) && (x.w.__tts || []).length === tts0 && x.audioCalls.length === audio0 && progress(x) === before);
  check('find: and no sound effect plays for a wrong tap (never a punishment sound)', x.w.__osc === 0, String(x.w.__osc));
  const c = copies(x);
  c[0].click();
  check('find: a copy lights up and is read aloud, with its pleasant sound', c[0].classList.contains('found') && (x.w.__tts || []).includes(target(x)) && x.w.__osc > 0);
  const tts1 = (x.w.__tts || []).length;
  c[0].click();
  check('find: tapping a found copy again does nothing', (x.w.__tts || []).length === tts1 && x.d.querySelectorAll('.find-tile.found').length === 1);
  c[1].click(); c[2].click();
  check('find: after the third copy a tap on a look-alike does not wobble (the page is closing)', (() => { const o = others(x)[1]; o.click(); return !o.classList.contains('wobble'); })());
  await sleep(20);
  check('find: the next page starts by itself with one dot filled', x.d.querySelectorAll('.find-dots i.on').length === 1 && tiles(x).length === 12 && x.d.querySelectorAll('.find-tile.found').length === 0);
  check('find: no sticker and no session progress before the end', (saved(x).stickers | 0) === 0 && (saved(x).session.done | 0) === 0);
  for (let p = 1; p < 5; p++) { copies(x).forEach((b) => b.click()); await sleep(20); }
  check('find: after 5 pages the game ends with one sticker, the reward and the again button', saved(x).stickers === 1 && !x.$('reward').hidden && !!x.$('findAgain') && tiles(x).length === 0, `stickers=${saved(x).stickers}`);
  check('find: the whole game left the stats, total and the session untouched', JSON.stringify(saved(x).stats || {}) === '{}' && !saved(x).total && (saved(x).session.done | 0) === 0);
  x.$('rewardOk').click(); await sleep(10);
  check('find: when the reward closes keyboard focus goes to the again button', x.d.activeElement === x.$('findAgain'));
  x.$('findAgain').click(); await sleep(10);
  check('find: again starts a new game from page 1', tiles(x).length === 12 && x.d.querySelectorAll('.find-dots i.on').length === 0 && saved(x).stickers === 1);
  check('find: the whole run raised no errors', x.errors.length === 0, x.errors.join(' | '));

  // leaving mid-game gives nothing and cancels the pending page
  x = await start();
  copies(x).forEach((b) => b.click());
  x.$('mSyl').click(); await sleep(30);
  check('find: changing mode mid-game closes it, no sticker, and the stale page timer does not reopen it', room(x).hidden && !x.d.documentElement.classList.contains('find') && (saved(x).stickers | 0) === 0 && x.d.querySelectorAll('.find-tile').length === 0 && saved(x).mode === 'syl' && x.errors.length === 0, x.errors.join(' | '));

  // reload with the mode saved
  x = await boot({ storage: R({ mode: 'find' }) });
  await until(() => !room(x).hidden);
  check('find: a saved mode starts the game on load', !room(x).hidden && tiles(x).length === 12);

  // the last Camino step draws book letters
  x = await start({ pathEs: 12 });
  check('find: with every letter open the target starts with one of the 11 book letters', /^[mplntsfbdrc]/.test(target(x)) && tiles(x).length === 12);

  // Catalan
  x = await boot({ storage: R({ lang: 'ca', pathCa: 2 }) });
  x.$('mFind').click(); await until(() => !room(x).hidden);
  check('find (ca): works in Catalan with the current letters', tiles(x).length === 12 && /^[mp]/.test(target(x)));

  // a pool that is too small: locked, preference untouched
  x = await boot({ storage: R(), levelsPatch: (d) => d.map((l) => ({ ...l, words: l.words.slice(0, 3) })) });
  x.$('mFind').click(); await sleep(30);
  check('find: with too few words the button says so and the saved mode does not change', room(x).hidden && x.$('hint').textContent === 'Busca la palabra se abre cuando hay palabras suficientes de la letra.' && (saved(x).mode || 'syl') === 'syl');

  // the module cannot load (offline): normal exercises, preference untouched
  x = await boot({ storage: R({ mode: 'find' }), importFails: true });
  await sleep(30);
  check('find: if the module cannot load the app still shows a normal exercise and keeps the saved mode', room(x).hidden && x.d.querySelectorAll('.tile').length > 0 && saved(x).mode === 'find');

  // review fixes: Lumi's bubble in the game, the highlighted button, Aa, the found colour, a second tap on Busca
  {
    const FIND_HINT = 'busca la palabra y toca las 3 copias.';
    const man = { generated: 'test', clips: { es: { ...Object.fromEntries(HINT_KEYS.map((k) => [k, 'h.mp3'])), [FIND_HINT]: 'f.mp3' }, ca: {} } };
    const plays = (x, f) => x.audioCalls.filter((u) => u === 'audio/es/' + f).length;
    x = await boot({ storage: R({ mode: 'find' }), manifest: man });
    await until(() => !room(x).hidden); await sleep(30);
    check('find: opening in Busca never plays a reading instruction (syllable, word or judge sentence)', plays(x, 'h.mp3') === 0, String(plays(x, 'h.mp3')));
    x.$('hint').click(); x.$('mascot').dispatchEvent(new x.w.Event('click'));
    check('find: tapping the bubble or Lumi in the game plays the Busca sentence, not a reading one', plays(x, 'f.mp3') >= 2 && plays(x, 'h.mp3') === 0, `f=${plays(x, 'f.mp3')} h=${plays(x, 'h.mp3')}`);
    check('find: a saved Busca mode highlights the Busca button on load, not Sílabas', x.$('mFind').getAttribute('aria-pressed') === 'true' && x.$('mSyl').getAttribute('aria-pressed') === 'false' && x.$('mWord').getAttribute('aria-pressed') === 'false');
    x = await boot({ storage: R(), manifest: man });
    x.$('joinBtn').click(); // the judging step of a word: its phase must not leak into the game
    x.$('mFind').click(); await until(() => !room(x).hidden);
    const h0 = plays(x, 'h.mp3'); x.$('hint').click();
    check('find: coming from the judging step the bubble still says the Busca sentence', plays(x, 'h.mp3') === h0 && plays(x, 'f.mp3') >= 1, `h=${plays(x, 'h.mp3')} f=${plays(x, 'f.mp3')}`);
    // a second tap on Busca does not throw the game away
    x = await start();
    copies(x)[0].click();
    x.$('mFind').click(); await sleep(30);
    check('find: tapping Busca again keeps the game and the copies already found', x.d.querySelectorAll('.find-tile.found').length === 1);
    // Aa changes the case of the game on screen
    x.$('caseBtn').click();
    check('find: the Aa button changes the case of the tiles in the game on screen', !room(x).classList.contains('upper') && saved(x).upper === false);
    x.$('caseBtn').click();
    check('find: and back', room(x).classList.contains('upper'));
    // the text of a found tile must stay readable on its green
    const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
    check('find: a found tile uses dark text on the green (white on it is 2.75:1 light, 1.77:1 dark)', /\.find-tile\.found\{[^}]*color:#06251A/.test(css));
  }

  // deferred minors: a stray next(), a stalled import, screen readers, the end of a reading session
  {
    // a stray next() (the parent changes the word style) keeps the page, and one landing in the pause after page 5 keeps the sticker
    x = await start();
    copies(x)[0].click();
    x.$('wordStyleSel').value = 'whole'; x.$('wordStyleSel').dispatchEvent(new x.w.Event('change')); await sleep(30);
    check('find: a change of word style mid-game keeps the page and the copies already found', x.d.querySelectorAll('.find-tile.found').length === 1);
    x.$('wordStyleSel').value = 'auto'; x.$('wordStyleSel').dispatchEvent(new x.w.Event('change'));
    copies(x).forEach((b) => b.click()); await sleep(20);
    for (let p = 2; p < 5; p++) { copies(x).forEach((b) => b.click()); await sleep(20); }
    copies(x).forEach((b) => b.click());
    x.$('wordStyleSel').value = 'whole'; x.$('wordStyleSel').dispatchEvent(new x.w.Event('change')); // lands in the pause after the last page
    await sleep(30);
    check('find: and one landing in the pause after the last page does not cost the sticker', saved(x).stickers === 1 && !!x.$('findAgain'), `stickers=${saved(x).stickers}`);
    // changes that do need a new game still start one
    x = await start();
    copies(x)[0].click();
    x.$('langBtn').click(); await sleep(30);
    check('find: changing the language starts a new game in that language', x.d.querySelectorAll('.find-tile.found').length === 0 && x.$('hint').textContent === 'Busca la paraula i toca les 3 còpies.');
    x = await start();
    copies(x)[0].click();
    x.d.querySelectorAll('#pathRow button')[0].click(); await sleep(30);
    check('find: a parent moving the Camino starts a new game with the new letter', x.d.querySelectorAll('.find-tile.found').length === 0 && /^m/.test(target(x)) && tiles(x).length === 12, target(x));

    // a position pulled from another device mid-game starts a new game with that letter
    {
      const { s: sp, app } = await signedBoot({ syncEvery: 120 });
      app.$('mFind').click(); await until(() => !app.$('findRoom').hidden);
      const cp = [...app.d.querySelectorAll('.find-tile')].filter((b) => b.textContent === app.d.querySelector('.find-target').textContent);
      cp[0].click();
      const cur = JSON.parse(app.w.localStorage.getItem('leemos-v1')).pathEs, nv = cur === 3 ? 4 : 3;
      const row = sp.rows.get(RID_A); row.data = { ...row.data, prefs: { ...(row.data.prefs || {}), pathEs: { v: nv, at: Date.now() + 5000 } } }; row.version++;
      await until(() => JSON.parse(app.w.localStorage.getItem('leemos-v1')).pathEs === nv, 3000);
      await sleep(40);
      check('find: a Camino position pulled from another device mid-game starts a new game', app.d.querySelectorAll('.find-tile.found').length === 0 && app.d.querySelectorAll('.find-tile').length === 12 && !app.$('findRoom').hidden, `cur=${cur} nv=${nv}`);
    }

    // a stalled find.js import gives up instead of leaving the stage empty
    x = await boot({ storage: R({ mode: 'find' }), hangImport: 'find.js' });
    await sleep(30);
    check('find: if the find.js import stalls the app gives up and shows a normal exercise, keeping the saved mode', room(x).hidden && x.d.querySelectorAll('.tile').length > 0 && saved(x).mode === 'find');

    // screen readers and keyboard
    x = await start();
    check('find: the target button says the word, and every tile announces its state', x.d.querySelector('.find-target').getAttribute('aria-label').includes(target(x)) && tiles(x).every((b) => b.getAttribute('aria-pressed') === 'false'));
    copies(x)[0].click();
    check('find: a found tile is announced as pressed', copies(x)[0].getAttribute('aria-pressed') === 'true');
    copies(x).forEach((b) => b.click()); await sleep(20);
    check('find: each new page puts keyboard focus on the target, not on the page', x.d.activeElement === x.d.querySelector('.find-target'));

    // the end of a reading session must not open over the game
    x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', sessionLen: 5, world: 0, pathEs: 12, pathCa: 12 } } });
    await playSession(x, 4);
    x.$('joinBtn').click(); x.$('okBtn').click(); // the last answer: its reward is due in 500 ms
    x.$('mFind').click(); await sleep(30);
    check('find: Busca is ignored while the end of a reading session is on its way', room(x).hidden && saved(x).mode !== 'find' && !x.$('reward').hidden);
    x.$('rewardOk').click(); await sleep(300);
    check('find: and the session end screen then shows on the normal screen', !x.$('end').hidden && room(x).hidden);
  }

  // the game wiring is generic: a saved game mode with the module unavailable keeps the mode and shows a normal exercise
  x = await boot({ storage: R({ mode: 'find' }), importFails: true });
  await sleep(30);
  check('find: (generic wiring) an unloadable game keeps the saved mode, the normal screen is shown, and no game class is on', saved(x).mode === 'find' && !x.d.documentElement.classList.contains('find') && x.d.querySelectorAll('.tile').length > 0);
  // Leo never sees the mode
  x = await bootLeo();
  check('find: Leo is in his own screen where the modes row is hidden', x.d.documentElement.classList.contains('pre'));
}

// ---------- 44. Cierra / Tanca: closed syllables built as 2 + 1 ----------
{
  const CR = (extra = {}) => ({ 'leemos-v1': { name: 'Elsa', pathEs: 3, pathCa: 12, world: 0, ...extra } });
  const cman = { generated: 'test', clips: { es: new Proxy({}, { get: (_, k) => (typeof k === 'string' ? 'c' + k + '.mp3' : undefined) }), ca: {} } };
  const croom = (x) => x.$('closeRoom');
  const csaved = (x) => JSON.parse(x.w.localStorage.getItem('leemos-v1'));
  const cprogress = (x) => JSON.stringify({ s: csaved(x).stats, t: csaved(x).total, p: csaved(x).progress, lv: csaved(x).level, sess: csaved(x).session });
  const base = (x) => x.d.querySelector('.close-tile.base')?.textContent;
  const action = (x) => x.d.querySelector('.close-coda') || x.d.querySelector('.close-card');
  const played = (x, f) => x.audioCalls.filter((u) => u.startsWith('audio/es/' + f)).length;
  const startC = async (extra, opts = {}) => { const x = await boot({ storage: CR(extra), manifest: cman, ...opts }); x.w.__audioMode = 'auto'; x.w.__leemosRescueMs = 9000; x.$('mClose').click(); await until(() => !croom(x).hidden); return x; };
  const finishScreen = async (x) => { action(x).click(); await sleep(20); };

  // locked at steps 1-2, open at 3
  let x = await boot({ storage: CR({ pathEs: 2 }), manifest: cman });
  x.$('mClose').click(); await sleep(30);
  check('close: with no coda letter open (Camino step 2) the button says so and the saved mode does not change', croom(x).hidden && x.$('hint').textContent === 'Cierra se abre con la letra L.' && (csaved(x).mode || 'syl') === 'syl');
  x = await startC();
  check('close: at step 3 the mode opens, the fourth button is pressed and the reading screen is replaced', !croom(x).hidden && x.d.documentElement.classList.contains('close') && x.$('mClose').getAttribute('aria-pressed') === 'true' && csaved(x).mode === 'close');
  // the first syllable screen: base + glowing coda tile, an arc, the base sound
  const b0 = base(x), a0 = action(x);
  check('close: a syllable screen shows the CV base and a glowing coda tile (just the letter l at step 3, no plus sign), never three letters at once', /^[a-z]{2}$/.test(b0) && a0.classList.contains('close-coda') && a0.textContent === 'l' && !!x.d.querySelector('.close-arc') && !x.d.querySelector('.close-arc').classList.contains('wide'));
  check('close: the first screen of the session says the instruction text and shows 6 dots', x.$('hint').textContent === 'Lee la sílaba en voz alta y toca para cerrarla.' && x.d.querySelectorAll('.close-dots i').length === 6);
  const st0 = cprogress(x), tts0 = (x.w.__tts || []).length;
  x.d.querySelector('.close-tile.base').click();
  check('close: tapping the base plays the base sound', (x.w.__tts || []).length > tts0 || played(x, 'c' + b0) > 0);
  let buzz = 0; x.w.navigator.vibrate = (ms) => { buzz++; return true; };
  check('close: the base tile marks its vowel (same text, vowel in its own span)', x.d.querySelector('.close-tile.base .v')?.textContent === b0[1] && base(x) === b0);
  action(x).click();
  check('close: docking the coda gives one short haptic tick', buzz === 1);
  const syl0 = b0 + 'l';
  check('close: tapping the coda docks it and grows the arc at once', x.d.querySelector('.close-coda.docked')?.textContent === 'l' && x.d.querySelector('.close-arc').classList.contains('wide'));
  action(x)?.click(); action(x)?.click(); // the docked coda ignores taps
  await sleep(20); // the coda says its own sound first, then the stretched syllable
  check('close: and plays the STRETCHED clip (~syllable) once, whatever the extra taps', played(x, 'c~' + syl0) === 1 && buzz === 1, `plays=${played(x, 'c~' + syl0)} ${syl0}`);
  check('close: the next screen starts by itself with one dot filled', x.d.querySelectorAll('.close-dots i.on').length === 1 && !x.d.querySelector('.close-coda.docked'));
  check('close: nothing is recorded (stats, total, level, session) and there is no sticker yet', cprogress(x) === st0 && (csaved(x).stickers | 0) === 0);
  // the second half of the syllable screens peeks
  await finishScreen(x); await finishScreen(x);
  const card = x.d.querySelector('.close-card');
  check('close: from the 4th screen the coda is hidden behind a "?" card, and tapping it reveals the letter with the stretched clip', !!card && card.textContent === '?' && (() => { const bs = base(x); card.click(); card.dataset.bs = bs; return card.textContent === 'l'; })());
  check('close: revealing the peek card also ticks', buzz === 4, `buzz=${buzz}`);
  await sleep(20);
  check('close: and the stretched clip of the revealed syllable plays', played(x, 'c~' + card.dataset.bs + 'l') === 1);
  await finishScreen(x); await finishScreen(x);
  check('close: after 6 screens a sticker is given once, the reward shows and the again button appears', csaved(x).stickers === 1 && !x.$('reward').hidden && !!x.$('closeAgain'), `stickers=${csaved(x).stickers}`);
  check('close: the whole session left stats, total and the session counters untouched', cprogress(x) === st0);
  x.$('rewardOk').click(); await sleep(10);
  check('close: when the reward closes keyboard focus goes to the again button', x.d.activeElement === x.$('closeAgain'));
  x.$('closeAgain').click(); await sleep(10);
  check('close: again starts a new session from screen 1', x.d.querySelectorAll('.close-dots i.on').length === 0 && !!action(x) && csaved(x).stickers === 1);
  check('close: the whole run raised no errors', x.errors.length === 0, x.errors.join(' | '));

  // leaving the mode closes it and cancels the pending screen
  x = await startC();
  action(x).click(); x.$('mSyl').click(); await sleep(30);
  check('close: changing mode mid-session closes it, no sticker, and the pending screen does not reopen it', croom(x).hidden && !x.d.documentElement.classList.contains('close') && (csaved(x).stickers | 0) === 0 && csaved(x).mode === 'syl' && x.errors.length === 0, x.errors.join(' | '));
  // Busca and Cierra never overlap
  x = await startC();
  x.$('mFind').click(); await until(() => !x.$('findRoom').hidden);
  check('close: opening Busca closes Cierra (one play mode on screen at a time)', croom(x).hidden && !x.$('findRoom').hidden && !x.d.documentElement.classList.contains('close') && x.d.documentElement.classList.contains('find'));
  x.$('mClose').click(); await until(() => !croom(x).hidden);
  check('close: and back', x.$('findRoom').hidden && !croom(x).hidden && !x.d.documentElement.classList.contains('find'));
  // a saved mode starts on load, in Catalan too
  x = await boot({ storage: CR({ mode: 'close' }), manifest: cman }); await until(() => !croom(x).hidden);
  check('close: a saved mode starts the session on load and highlights its button', !croom(x).hidden && x.$('mClose').getAttribute('aria-pressed') === 'true' && x.$('mSyl').getAttribute('aria-pressed') === 'false');
  x = await boot({ storage: CR({ lang: 'ca', pathCa: 3 }), manifest: cman }); x.$('mClose').click(); await until(() => !croom(x).hidden);
  check('close (ca): works in Catalan', !croom(x).hidden && x.$('hint').textContent === 'Llegeix la síl·laba en veu alta i toca per tancar-la.');
  // Aa changes the case of the screen on screen
  x = await startC();
  x.$('caseBtn').click();
  check('close: the Aa button changes the case of the screen on screen', !croom(x).classList.contains('upper') && csaved(x).upper === false);
  // word screens: Spanish at step 12 has 2+ qualifying words, so a session is 4 syllables + 2 words
  {
    const wx = await startC({ pathEs: 12 });
    const act = () => wx.d.querySelector('.close-current .close-coda') || wx.d.querySelector('.close-current .close-tile.base'); // the coda to dock if there is one, else the open syllable
    for (let i = 0; i < 4; i++) { await finishScreen(wx); }
    check('close: after the 4 syllable screens the word screens come, with an empty anchor row and the first syllable', !!wx.d.querySelector('.close-anchors') && wx.d.querySelectorAll('.close-chip').length === 0 && !!wx.d.querySelector('.close-current'));
    const picBefore = wx.d.querySelector('.close-pic');
    check('close: a word screen says its own instruction, not the one about closing a syllable', wx.$('hint').textContent === 'Lee cada sílaba y junta la palabra.');
    check('close: the picture is hidden until the word is read (the app rule)', !picBefore || picBefore.hidden || !picBefore.textContent);
    let wbuzz = 0; wx.w.navigator.vibrate = () => { wbuzz++; return true; };
    const first = act();
    first.click(); await sleep(20);
    check('close: a closed syllable docks with a tick, an open one (a tile with no coda) does not', first.classList.contains('close-coda') ? wbuzz === 1 : wbuzz === 0, `buzz=${wbuzz}`);
    check('close: the anchor chip marks the vowel of its syllable', !!wx.d.querySelector('.close-chip .v'));
    check('close: a finished syllable docks into the anchor chip', wx.d.querySelectorAll('.close-chip').length === 1);
    const chip = wx.d.querySelector('.close-chip');
    const before = wx.audioCalls.length + (wx.w.__tts || []).length;
    chip.click();
    check('close: tapping the anchor chip plays that syllable again (a stretched clip for the closed one)', wx.audioCalls.length + (wx.w.__tts || []).length > before);
    check('close: the anchor chip has a screen-reader label', chip.getAttribute('aria-label').length > 0);
    act().click(); await sleep(20);
    const join = wx.$('closeJoin');
    check('close: when every syllable is done a Juntar button appears (not before)', !!join && wx.d.querySelectorAll('.close-chip').length === 2);
    check('close: the closed syllable shows in the chip as its base and its coda, not one unsegmented block', wx.d.querySelectorAll('.close-chip .chip-coda').length === 1 && wx.d.querySelectorAll('.close-chip .chip-base').length === 1);
    check('close: the picture is still hidden before Juntar', !wx.d.querySelector('.close-pic') || wx.d.querySelector('.close-pic').hidden);
    check('close: before Juntar the chips are not dimmed and the picture has no pop', !wx.d.querySelector('.close-anchors.joined') && !wx.d.querySelector('.close-pic.pop'));
    const pw0 = wx.audioCalls.length + (wx.w.__tts || []).length;
    join.click(); join.click(); // a double tap
    check('close: Juntar plays the word and only then shows the picture (a double tap counts once)', wx.d.querySelector('.close-pic') && !wx.d.querySelector('.close-pic').hidden && wx.d.querySelector('.close-pic').textContent.length > 0 && wx.audioCalls.length + (wx.w.__tts || []).length - pw0 === 1);
    check('close: Juntar pops the picture in and dims the anchor chips', wx.d.querySelector('.close-pic').classList.contains('pop') && wx.d.querySelector('.close-anchors').classList.contains('joined'));
    await sleep(5);
    await sleep(20);
    check('close: the second word screen starts with an empty anchor row', wx.d.querySelectorAll('.close-chip').length === 0 && wx.d.querySelectorAll('.close-dots i.on').length === 5);
    for (let k = 0; k < 2; k++) { act()?.click(); await sleep(20); }
    const j2 = wx.$('closeJoin'); if (j2) { j2.click(); await sleep(30); }
    check('close: after the second word the session ends with one sticker, nothing else recorded', csaved(wx).stickers === 1 && !csaved(wx).total && !wx.$('reward').hidden && wx.errors.length === 0, `stickers=${csaved(wx).stickers} ${wx.errors.join('|')}`);
  }

  // the 3-second rescue: once per step, never an error signal, nothing recorded
  {
    const spoken = (rx, v) => played(rx, 'c' + v) + (rx.w.__tts || []).filter((q) => q === v).length;
    let rx = await boot({ storage: CR(), manifest: cman }); rx.w.__audioMode = 'auto'; rx.w.__leemosRescueMs = 150;
    rx.$('mClose').click(); await until(() => !croom(rx).hidden); await sleep(40);
    const b1 = base(rx);
    check('close: after 3 s without a tap Lumi plays the base and the coda tile pulses harder; the child still has the last tap', action(rx).classList.contains('rescue') && !action(rx).classList.contains('docked') && spoken(rx, b1) >= 1);
    const n1 = spoken(rx, b1);
    await sleep(60);
    rx.d.querySelector('.close-dots').click(); await sleep(60); // a tap that does nothing re-arms a timer that must not fire a second rescue
    check('close: the rescue fires once per step (no repeated nagging, even after another tap)', spoken(rx, b1) === n1);
    check('close: the rescue shows or plays no error signal and records nothing', !rx.d.querySelector('.wobble, .error, .wrong') && (csaved(rx).stickers | 0) === 0 && !csaved(rx).total && JSON.stringify(csaved(rx).stats || {}) === '{}');
    action(rx).click(); await sleep(60);
    check('close: after the tap the next screen has its own fresh rescue (it does not carry over)', !!action(rx) && action(rx).classList.contains('rescue') && rx.errors.length === 0, rx.errors.join('|'));
    // word screen: the syllable on screen is modelled and docked for her, the rest is hers
    rx = await boot({ storage: CR({ pathEs: 12 }), manifest: cman }); rx.w.__audioMode = 'auto'; rx.w.__leemosRescueMs = 9000;
    rx.$('mClose').click(); await until(() => !croom(rx).hidden);
    for (let i = 0; i < 4; i++) { action(rx).click(); await sleep(20); }
    rx.w.__leemosRescueMs = 150;
    rx.d.querySelector('.close-anchors').click(); await sleep(60); // a tap in the room re-arms the rescue with the short time
    check('close: on a word screen the rescue docks the syllable on screen into the anchor chip', rx.d.querySelectorAll('.close-chip').length >= 1 && rx.errors.length === 0, `chips=${rx.d.querySelectorAll('.close-chip').length} ${rx.errors.join('|')}`);
    check('close: the rescue never finishes the whole word for her (no sticker, picture still hidden)', (csaved(rx).stickers | 0) === 0 && (!rx.d.querySelector('.close-pic') || rx.d.querySelector('.close-pic').hidden));
    // leaving cancels the rescue
    rx = await boot({ storage: CR(), manifest: cman }); rx.w.__audioMode = 'auto'; rx.w.__leemosRescueMs = 150;
    rx.$('mClose').click(); await until(() => !croom(rx).hidden); rx.$('mSyl').click(); await sleep(60);
    check('close: leaving the mode cancels a pending rescue (no error, no sound after leaving)', rx.errors.length === 0 && croom(rx).hidden, rx.errors.join('|'));
  }

  // stray next() calls and the other guards
  {
    let gx = await startC();
    action(gx).click(); await sleep(20);
    gx.$('wordStyleSel').value = 'whole'; gx.$('wordStyleSel').dispatchEvent(new gx.w.Event('change')); await sleep(30);
    check('close: a change of word style mid-session keeps the screen she is on', gx.d.querySelectorAll('.close-dots i.on').length === 1);
    gx.$('langBtn').click(); await sleep(30);
    check('close: changing the language starts a new session in that language', gx.d.querySelectorAll('.close-dots i.on').length === 0 && gx.$('hint').textContent === 'Llegeix la síl·laba en veu alta i toca per tancar-la.');
    gx = await startC();
    action(gx).click(); await sleep(20);
    gx.d.querySelectorAll('#pathRow button')[3].click(); await sleep(30);
    check('close: a parent moving the Camino starts a new session', gx.d.querySelectorAll('.close-dots i.on').length === 0 && !!action(gx));
    gx.$('mClose').click(); await sleep(20);
    check('close: tapping Cierra again keeps the session', !!action(gx));
    // the module cannot load or stalls
    gx = await boot({ storage: CR({ mode: 'close' }), manifest: cman, importFails: true }); await sleep(30);
    check('close: if the module cannot load the app shows a normal exercise and keeps the saved mode', croom(gx).hidden && gx.d.querySelectorAll('.tile').length > 0 && csaved(gx).mode === 'close');
    gx = await boot({ storage: CR({ mode: 'close' }), manifest: cman, hangImport: 'close.js' }); await sleep(30);
    check('close: a stalled import gives up and shows a normal exercise, keeping the saved mode', croom(gx).hidden && gx.d.querySelectorAll('.tile').length > 0 && csaved(gx).mode === 'close');
    // the reading session's end must not open over the game
    gx = await boot({ storage: { 'leemos-v1': { name: 'Elsa', sessionLen: 5, world: 0, pathEs: 12, pathCa: 12 } }, manifest: cman });
    await playSession(gx, 4);
    gx.$('joinBtn').click(); gx.$('okBtn').click();
    gx.$('mClose').click(); await sleep(30);
    check('close: Cierra is ignored while the end of a reading session is on its way', croom(gx).hidden && csaved(gx).mode !== 'close' && !gx.$('reward').hidden);
    // screen readers and keyboard
    gx = await startC();
    check('close: the coda tile has a label that names the letter, and focus starts on it', action(gx).getAttribute('aria-label').includes('l') && gx.d.activeElement === action(gx));
    await finishScreen(gx); await finishScreen(gx); await finishScreen(gx);
    check('close: the "?" card has a label that says it covers the letter, and each new screen focuses the action', action(gx).classList.contains('close-card') && action(gx).getAttribute('aria-label').length > 3 && gx.d.activeElement === action(gx));
  }

  // review fixes: the whole word is not built for her, the base plays by itself, resting, Leo, the rescue pulse on every control
  {
    // the rescue models ONE syllable of a word and leaves the rest to her
    let fx = await boot({ storage: CR({ pathEs: 12 }), manifest: cman }); fx.w.__audioMode = 'auto'; fx.w.__leemosRescueMs = 9000;
    fx.$('mClose').click(); await until(() => !croom(fx).hidden);
    for (let i = 0; i < 4; i++) { action(fx).click(); await sleep(20); }
    fx.w.__leemosRescueMs = 150;
    fx.d.querySelector('.close-anchors').click(); await sleep(200);
    check('close: idle on a word screen docks one syllable, then the rest is hers (no second auto-dock, no Juntar)', fx.d.querySelectorAll('.close-chip').length === 1 && !fx.$('closeJoin'), `chips=${fx.d.querySelectorAll('.close-chip').length}`);
    check('close: the next syllable only pulses', !!fx.d.querySelector('.close-current .rescue'));
    // the base sound plays by itself from the second screen on (not on the first, where the instruction plays)
    fx = await boot({ storage: CR(), manifest: cman }); fx.w.__audioMode = 'auto'; fx.w.__leemosRescueMs = 9000;
    fx.$('mClose').click(); await until(() => !croom(fx).hidden);
    const first = base(fx);
    check('close: on the first screen the base waits for her tap (the instruction plays instead)', played(fx, 'c' + first) === 0);
    action(fx).click(); await sleep(20);
    const second = base(fx);
    check('close: from the second screen the base plays by itself', played(fx, 'c' + second) >= 1, `base=${second}`);
    // opening Cierra from the rest screen ends the rest: a Camino change then acts on the game
    fx = await boot({ storage: { 'leemos-v1': { name: 'Elsa', sessionLen: 5, world: 0, pathEs: 12, pathCa: 12 } }, manifest: cman });
    await playSession(fx, 5);
    if (!fx.$('end').hidden) fx.$('endStop').click();
    fx.$('mClose').click(); await until(() => !croom(fx).hidden);
    fx.d.querySelectorAll('#pathRow button')[1].click(); await sleep(30);
    check('close: after the rest screen, opening Cierra and closing the Camino to step 2 locks the mode and leaves the game', croom(fx).hidden && !fx.d.documentElement.classList.contains('close'));
    // Leo never gets the room, even with a saved mode
    fx = await boot({ storage: { ...LEO, 'leemos-v1:leo': { name: 'Leo', mode: 'close', pre: { es: 1, ca: 0 } } }, manifest: cman }); await sleep(40);
    check('close: a Leo profile with a saved Cierra mode does not get the Cierra room', !fx.d.documentElement.classList.contains('close') && croom(fx).hidden);
    // the pulse exists for every control the rescue marks, and a revealed card stops glowing
    const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
    check('close: the tiles are tight (a syllable reads as one block, never as letters apart), the vowel has its own colour token in both themes, the pop is dropped under reduced motion', /\.close-tile,[^{]*\.close-chip\{[^}]*letter-spacing:\.02em/.test(css) && !/\.close-tile,[^{]*\.close-chip\{[^}]*letter-spacing:\.1\d?em/.test(css) && /--vowel:/.test(css) && /\[data-theme="dark"\]\{[^}]*--vowel:/.test(css) && /\.close-pic\.pop\{[^}]*animation:closePop/.test(css) && /reduce\)\{[\s\S]*\.close-pic\.pop\{animation:none/.test(css));
    check('close: the rescue pulse is styled on the card, the tile and Juntar, and a revealed card stops glowing', /\.close-card\.rescue,[^{]*\.close-tile\.rescue,[^{]*#closeJoin\.rescue\{animation:closeGlow/.test(css) && /\.close-card\.docked\{[^}]*animation:none/.test(css));
  }

  // deferred minors of the Cierra review
  {
    // a synced game mode that arrives while the pool is locked replaces the exercise once, not twice
    let shows = 0;
    const { s: sp, app } = await signedBoot({ syncEvery: 120, onDom: (w) => { new w.MutationObserver((recs) => { if (recs.some((r) => r.target.id === 'tiles' && r.addedNodes.length)) shows++; }).observe(w.document.getElementById('tiles'), { childList: true }); } });
    const before = shows;
    const row = sp.rows.get(RID_A); row.data = { ...row.data, prefs: { ...(row.data.prefs || {}), mode: { v: 'close', at: Date.now() + 5000 }, pathEs: { v: 1, at: Date.now() + 5000 } } }; row.version++;
    await until(() => JSON.parse(app.w.localStorage.getItem('leemos-v1')).mode === 'close', 3000); await sleep(200);
    check('close: a synced Cierra that arrives while it is locked swaps the exercise once, not twice', shows - before === 1, `shows=${shows - before}`);

    // one data file failing does not lock the other language
    const fx = await boot({ storage: CR(), manifest: cman }); fx.w.__audioMode = 'auto'; fx.w.__leemosRescueMs = 9000;
    const f0 = fx.w.fetch; fx.w.fetch = (u, ...a) => (/closed\.ca\.json/.test(u) ? Promise.resolve({ ok: false, status: 404, json: async () => ({}) }) : f0(u, ...a));
    fx.$('mClose').click(); await until(() => !croom(fx).hidden);
    check('close: if the other language data fails to load Cierra still works in the current one', !croom(fx).hidden && !!action(fx));

    // rescue timing: later on the first screen (the instruction plays), reset by taps on Lumi and the bubble, and the base does not cut the stretched clip
    const gx = await boot({ storage: CR(), manifest: cman }); gx.w.__audioMode = 'auto'; gx.w.__leemosRescueMs = 5000;
    const ms = []; const st0 = gx.w.setTimeout; gx.w.setTimeout = (f, m, ...a) => { ms.push(m); return st0(f, m, ...a); };
    gx.$('mClose').click(); await until(() => !croom(gx).hidden);
    check('close: on the first screen the rescue waits longer, so it does not cut the instruction', ms.includes(8000), ms.join(',')); // 5000 (the rescue) + 3000 (the instruction clip)
    const n0 = ms.filter((v) => v === 5000).length;
    gx.$('hint').click();
    check('close: a tap on the bubble pushes the rescue back', ms.filter((v) => v === 5000).length === n0 + 1);
    gx.$('mascot').dispatchEvent(new gx.w.Event('click'));
    check('close: and so does a tap on Lumi', ms.filter((v) => v === 5000).length === n0 + 2);
    action(gx).click();
    const a0 = gx.audioCalls.length;
    gx.d.querySelector('.close-tile.base').click();
    check('close: tapping the base while the stretched sound is playing does not cut it', gx.audioCalls.length === a0);
  }

  // the base stays ONE block (a syllable); the coda has its own sound, then the stretched syllable
  {
    const exact = (y, f) => y.audioCalls.filter((u) => u === 'audio/es/' + f).length;
    const cx = await startC();
    check('close coda sound: the base is one block read as a syllable (no letter tiles), the coda is its own tile', cx.d.querySelectorAll('.close-tile.base').length === 1 && !cx.d.querySelector('.close-letter') && !!cx.d.querySelector('.close-coda'));
    const b = base(cx), coda = action(cx), cl = coda.textContent.replace('+', ''), syl = b + cl, tts0 = (cx.w.__tts || []).length, n0 = exact(cx, 'c' + cl + '.mp3');
    coda.click(); await sleep(30);
    const at = (f) => cx.audioCalls.lastIndexOf('audio/es/' + f);
    check('close coda sound: the coda says its own sound (the letter clip, not the browser voice) and THEN the stretched syllable, once each', exact(cx, 'c' + cl + '.mp3') === n0 + 1 && exact(cx, 'c~' + syl + '.mp3') === 1 && at('c' + cl + '.mp3') < at('c~' + syl + '.mp3') && (cx.w.__tts || []).length === tts0, cx.audioCalls.slice(-4).join(','));
    check('close coda sound: no errors', cx.errors.length === 0, cx.errors.join(' | '));
    // a coda with no letter clip: silent first part, the screen still closes and the stretched syllable still plays
    const nx = await startC({}, { manifest: { generated: 'test', clips: { es: new Proxy({}, { get: (_, k) => (typeof k === 'string' && k.length > 1 ? 'c' + k + '.mp3' : undefined) }), ca: {} } } });
    const tn = (nx.w.__tts || []).length;
    action(nx).click(); const dockedNow = !!nx.d.querySelector('.close-coda.docked'); await sleep(30);
    check('close coda sound: with no clip for the letter it says nothing (never the robot voice), still docks and plays the stretched syllable', dockedNow && nx.audioCalls.some((u) => /\/c~/.test(u)) && (nx.w.__tts || []).length === tn && nx.errors.length === 0, nx.errors.join(' | '));
    // a rescue (3 s without a tap) still closes the syllable for her, with the same two sounds
    const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
    check('close coda sound: the arc sits under the base (a grid) and spans both once docked', /\.close-unit\{[^}]*display:grid/.test(css) && /\.close-syl\{display:contents\}/.test(css) && /\.close-arc\.wide\{grid-column:1 \/ -1\}/.test(css));
  }

  // Leo never sees the mode
  x = await bootLeo();
  check('close: Leo is on his own screen where the modes row is hidden', x.d.documentElement.classList.contains('pre'));
}

// ---------- 45. Escucha / Escolta: a robot sounds a word out and she picks the picture ----------
{
  const LR = (extra = {}) => ({ 'leemos-v1': { name: 'Elsa', pathEs: 12, pathCa: 12, world: 0, ...extra } });
  const lman = { generated: 'test', clips: { es: new Proxy({}, { get: (_, k) => (typeof k === 'string' ? 'c' + k + '.mp3' : undefined) }), ca: {} } };
  const lroom = (y) => y.$('listenRoom');
  const cards = (y) => [...y.d.querySelectorAll('.listen-card')];
  const right = (y) => cards(y).find((c) => c.dataset.answer === 'true');
  const wrong = (y) => cards(y).find((c) => c.dataset.answer !== 'true');
  const lsaved = (y) => JSON.parse(y.w.localStorage.getItem('leemos-v1'));
  const lstart = async (extra, opts = {}) => { const y = await boot({ storage: LR(extra), manifest: lman, ...opts }); y.w.__audioMode = 'auto'; y.w.__leemosRescueMs = 9000; y.$('mListen').click(); await until(() => !lroom(y).hidden); return y; };
  const sylCalls = (y) => y.audioCalls.filter((u) => /audio\/es\/c/.test(u)).map((u) => decodeURIComponent(u.split('/').pop()).replace(/^c|\.mp3.*$/g, '').replace('~', ''));
  check('listen: the game ctx has a syllable player (part)', /part:\s*partSound/.test(appJs));

  let x = await lstart();
  check('listen: the fifth button opens the room, hides the reading screen and is pressed; the mode is saved', !lroom(x).hidden && x.d.documentElement.classList.contains('listen') && x.$('mListen').getAttribute('aria-pressed') === 'true' && lsaved(x).mode === 'listen');
  check('listen: the robot screen shows the robot and 3 picture cards, and never prints the word', !!x.d.querySelector('.listen-robot') && cards(x).length === 3 && !!right(x) && !lroom(x).textContent.includes(right(x).dataset.w));
  check('listen: the hint says the instruction', x.$('hint').textContent === 'Escucha al robot y toca el dibujo.');
  await sleep(50);
  const wordParts = right(x).dataset.parts.split('-');
  const order = sylCalls(x);
  check('listen: the robot says the syllables of the word in order', order.indexOf(wordParts[0]) >= 0 && wordParts.every((p, i) => order[order.indexOf(wordParts[0]) + i] === p), order.join(',') + ' / ' + wordParts.join('-'));
  const before = lsaved(x).total, st = JSON.stringify(lsaved(x).stats);
  const wc = wrong(x), rc0 = right(x); wc.click(); const wobbled = wc.classList.contains('wobble'); await sleep(20);
  check('listen: a wrong tap only wobbles: the screen stays and nothing is recorded', wobbled && x.d.contains(rc0) && !rc0.classList.contains('found') && lsaved(x).total === before && JSON.stringify(lsaved(x).stats) === st);
  const rc = right(x), rw = rc.dataset.w;
  rc.click(); const lit = rc.classList.contains('found'); await sleep(20);
  check('listen: the right card lights up and the whole word is said', lit && x.audioCalls.some((u) => u.includes('audio/es/c' + rw + '.mp3')));
  for (let i = 0; i < 12 && !x.d.getElementById('listenAgain'); i++) { await sleep(1700); const r = right(x); if (r) { r.click(); await sleep(20); } }
  await sleep(2000);
  check('listen: finishing the session shows "again" and touches no stats', !!x.d.getElementById('listenAgain') && JSON.stringify(lsaved(x).stats) === st);
  check('listen: no errors', x.errors.length === 0, x.errors.join(' | '));

  // locked while too few words are open
  x = await boot({ storage: LR({ pathEs: 1 }), manifest: lman });
  x.$('mListen').click(); await sleep(30);
  check('listen: with too few words open the button says so, the room stays closed and the saved mode does not change', lroom(x).hidden && x.$('hint').textContent === 'Escucha se abre con más palabras.' && (lsaved(x).mode || 'syl') === 'syl');

  // muted device: silent robot, but the screen works
  x = await boot({ storage: LR(), manifest: lman }); x.w.__audioMode = 'auto'; x.w.__leemosRescueMs = 9000;
  x.$('muteBtn').click(); await sleep(5);
  const c0 = x.audioCalls.length; x.$('mListen').click(); await until(() => !lroom(x).hidden); await sleep(60);
  const mparts = right(x).dataset.parts.split('-');
  check('listen: muted, the robot says no syllable, the cards are there and a right tap still advances', sylCalls(x).filter((p) => mparts.includes(p)).length === 0 && cards(x).length === 3 && x.audioCalls.length >= c0);
  const dotOn = () => x.d.querySelectorAll('.listen-dots i.on').length;
  right(x).click(); await sleep(1800);
  check('listen: muted, the right tap goes to the next screen', dotOn() === 1);

  // leaving mid-sequence: the sounding-out stops
  x = await lstart();
  x.$('mSyl').click(); await sleep(3000);
  const n1 = x.audioCalls.length; await sleep(3000);
  check('listen: leaving the mode stops the sounding-out and the idle repeat', x.audioCalls.length === n1 && lroom(x).hidden && !x.d.documentElement.classList.contains('listen'));

  // tapping the robot twice quickly: one sequence, the first is cancelled
  x = await lstart(); await sleep(60);
  const r0 = sylCalls(x).length; x.d.querySelector('.listen-robot').click(); x.d.querySelector('.listen-robot').click(); await sleep(60);
  check('listen: tapping the robot again restarts the sounding-out once, never two at the same time', sylCalls(x).length - r0 <= right(x).dataset.parts.split('-').length * 2);

  // final review: Lumi's intro is not cut off, the idle repeat waits for the end of the sounding-out, and the words follow the level ceiling
  {
    const tx = await boot({ storage: LR(), manifest: lman }); tx.w.__audioMode = 'auto'; tx.w.__leemosRescueMs = 9000;
    const ms = []; const st0 = tx.w.setTimeout; tx.w.setTimeout = (f, m, ...a) => { ms.push(m); return st0(f, m, ...a); };
    tx.$('mListen').click(); await until(() => !lroom(tx).hidden); await sleep(60);
    check('listen: on the first screen the sounding-out waits for Lumi\'s intro (a 2-3 s pause before the first syllable)', ms.some((m) => m >= 2000 && m <= 3000), ms.join(','));
    check('listen: the idle repeat is armed after the last syllable and its pause, not at the start of the screen', ms.includes(9000) && ms.indexOf(9000) > ms.lastIndexOf(600), ms.join(','));
    const lv0 = new Set(JSON.parse(readFileSync(join(ROOT, 'src/data/levels.es.json'), 'utf8'))[0].words.map((w) => w.w.replace(/-/g, '').toLowerCase()));
    check('listen: the robot only uses words of the levels up to the one she is on (level 1 here)', cards(tx).length === 3 && cards(tx).every((c) => lv0.has(c.dataset.w)), cards(tx).map((c) => c.dataset.w).join(','));
  }

  // deferred minors of the final review
  const reachPairs0 = async (y) => { for (let i = 0; i < 8 && !y.d.querySelector('.listen-word'); i++) { const r = right(y); if (!r) break; r.click(); await sleep(30); } return !!y.d.querySelector('.listen-word'); };
  {
    // the cards appear after the sounding-out (the spec), not before she has heard the word
    const hx = await boot({ storage: LR(), manifest: lman }); hx.w.__audioMode = 'auto'; hx.w.__leemosRescueMs = 9000;
    let seenHidden = null;
    new hx.w.MutationObserver(() => { const g = hx.d.querySelector('.listen-cards'); if (g && seenHidden === null) seenHidden = g.hidden; }).observe(lroom(hx), { childList: true });
    hx.$('mListen').click(); await until(() => !lroom(hx).hidden); await sleep(80);
    check('listen: the picture cards are hidden while the robot is still to speak and shown once it has said the word', seenHidden === true && hx.d.querySelector('.listen-cards').hidden === false, 'hiddenAtBuild=' + seenHidden);
    // leaving stops the syllable that is playing
    hx.d.querySelector('.listen-robot').click(); const la = lastAudio(hx); hx.$('mSyl').click(); await sleep(5);
    check('listen: leaving the mode pauses the clip that is playing', la.paused === true);
    // the syllable guard is longer than the longest stretched clip (1.53 s)
    const gms = []; const gst = hx.w.setTimeout; hx.w.setTimeout = (f, m, ...a) => { gms.push(m); return gst(f, m, ...a); };
    hx.$('mListen').click(); await until(() => !lroom(hx).hidden); await sleep(60);
    check('listen: the guard that frees a syllable that never ends is 3.5 s (the longest stretched clip lasts 1.53 s)', gms.includes(3500) && !gms.includes(1800), gms.join(','));
  }
  {
    // Lumi on a pair screen says the pair sentence; the Aa switch changes the printed word at once; the end gives a sticker
    const px = await lstart({ pathEs: 12 });
    const st0 = lsaved(px).stickers || 0;
    await reachPairs0(px);
    const c0 = px.audioCalls.length; px.$('hint').click(); await sleep(5);
    check('listen pairs: tapping Lumi on a pair screen says the pair sentence, not the robot one', px.audioCalls.slice(c0).some((u) => decodeURIComponent(u).includes('lee la palabra')) && !px.audioCalls.slice(c0).some((u) => decodeURIComponent(u).includes('escucha al robot')));
    const up0 = lroom(px).classList.contains('upper'); px.$('caseBtn').click();
    check('listen pairs: the Aa switch changes the case of the printed word at once', lroom(px).classList.contains('upper') === !up0);
    for (let i = 0; i < 6 && !px.d.getElementById('listenAgain'); i++) { await sleep(60); const r = right(px); if (r) { r.click(); await sleep(30); } }
    check('listen: finishing a session gives a sticker', !!px.d.getElementById('listenAgain') && (lsaved(px).stickers || 0) === st0 + 1, `stickers ${st0} -> ${lsaved(px).stickers}`);
  }
  {
    // a saved listen mode that cannot open (too few words) falls back to the reading screen and keeps the preference
    const fx = await boot({ storage: LR({ pathEs: 1, mode: 'listen' }), manifest: lman }); await sleep(60);
    check('listen: a saved mode that cannot open falls back to the reading screen and the saved preference stays', lroom(fx).hidden && !fx.d.documentElement.classList.contains('listen') && lsaved(fx).mode === 'listen');
    const css2 = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
    check('listen: game mode hides the reading chrome for the room (same rule as Busca and Cierra)', /html\.listen \.session[^{]*\{display:none!important\}/.test(css2) && /\.listen-room\{[^}]*width:100%/.test(css2));
  }

  // pair screens: after the robot screens, read the printed word and pick its picture
  const reachPairs = async (y) => { for (let i = 0; i < 8 && !y.d.querySelector('.listen-word'); i++) { const r = right(y); if (!r) break; r.click(); await sleep(30); } return !!y.d.querySelector('.listen-word'); };
  x = await lstart({ pathEs: 12 });
  check('listen pairs: at Camino step 12 the session reaches pair screens', await reachPairs(x));
  const pword = x.d.querySelector('.listen-word').textContent;
  check('listen pairs: the printed word is shown, with two picture cards, and the card of the printed word is the right one', cards(x).length === 2 && !x.d.querySelector('.listen-robot') && right(x).dataset.w === pword && wrong(x).dataset.w !== pword && x.$('hint').textContent === 'Lee la palabra y toca su dibujo.');
  const pst = JSON.stringify(lsaved(x).stats), wcp = wrong(x), rcp = right(x); wcp.click(); const pw = wcp.classList.contains('wobble');
  check('listen pairs: a wrong picture only wobbles, nothing is recorded, and she may try the other', pw && x.d.contains(rcp) && !rcp.classList.contains('found') && JSON.stringify(lsaved(x).stats) === pst);
  const pc = x.audioCalls.length; rcp.click(); const plit = rcp.classList.contains('found'); await sleep(20);
  check('listen pairs: the right picture lights up and the printed word is said', plit && x.audioCalls.slice(pc).some((u) => u.includes('audio/es/c' + pword + '.mp3')));
  for (let i = 0; i < 6 && !x.d.getElementById('listenAgain'); i++) { await sleep(60); const r = right(x); if (r) { r.click(); await sleep(30); } }
  check('listen pairs: the session ends with "again" after the pair screens', !!x.d.getElementById('listenAgain') && JSON.stringify(lsaved(x).stats) === pst);
  // one open pair is not enough: all robot
  x = await lstart({ pathEs: 6 });
  check('listen pairs: with fewer than 2 pairs open (step 6) every screen is a robot screen', !(await reachPairs(x)) && !x.d.querySelector('.listen-word'));
  x = await boot({ storage: LR({ lang: 'ca' }), manifest: lman }); x.w.__audioMode = 'auto'; x.w.__leemosRescueMs = 9000; x.$('mListen').click(); await until(() => !lroom(x).hidden);
  check('listen pairs: Catalan has one pair, so its session is all robot screens', !(await reachPairs(x)) && !x.d.querySelector('.listen-word'));
  check('listen pairs: no errors', x.errors.length === 0, x.errors.join(' | '));

  // test gaps of the review: a clip held open mid-play (manual audio mode), a held 500 ms timer, and the room in the game-mode fit
  {
    const sylOf = (u) => decodeURIComponent(String(u).split('/').pop()).replace(/^c|\.mp3.*$/g, '').replace('~', '');
    const startManual = async () => { const y = await boot({ storage: LR(), manifest: lman }); y.w.__leemosRescueMs = 9000; const stg = y.w.setTimeout; y.w.setTimeout = (fn, m, ...r) => (m === 3500 ? 0 : stg(fn, m, ...r)); /* the harness runs 100-4000 ms timers at once: hold the syllable guard so a clip really stays open */ y.$('mListen').click(); await until(() => !lroom(y).hidden); await sleep(40); return y; };
    const sylAudios = (y) => { const ps = right(y).dataset.parts.split('-'); return (y.w.__audios || []).filter((a) => ps.includes(sylOf(a.src))); };

    // a tap on Lumi while the robot speaks cuts the sounding-out, and the cards are never left hidden
    let y = await startManual();
    const first = sylAudios(y)[0];
    check('listen gaps: with a clip held open the robot is on its first syllable and the cards are still hidden', !!first && y.d.querySelector('.listen-cards').hidden === true && y.d.querySelector('.listen-robot').classList.contains('say'));
    y.$('hint').click(); first.onended(); await sleep(30);
    check('listen gaps: a tap on Lumi cuts the sounding-out (no second syllable), clears the pulse and shows the cards', sylAudios(y).length === 1 && !y.d.querySelector('.listen-robot').classList.contains('say') && y.d.querySelector('.listen-cards').hidden === false, 'syllable clips=' + sylAudios(y).length);

    // a sequence that was replaced must not take the pulse off the one that replaced it
    y = await startManual();
    const a1 = sylAudios(y)[0], n1 = sylAudios(y).length;
    y.d.querySelector('.listen-robot').click(); await sleep(5);
    check('listen gaps: tapping the robot while it speaks starts a new sounding-out (a second first-syllable clip)', sylAudios(y).length === n1 + 1 && y.d.querySelector('.listen-robot').classList.contains('say'));
    a1.onended(); await sleep(20);
    check('listen gaps: the replaced sounding-out ending late leaves the pulse of the new one on', y.d.querySelector('.listen-robot').classList.contains('say'));

    // the sticker overlay must not open over another mode when she leaves before its 500 ms timer
    const rx = await boot({ storage: LR(), manifest: lman }); rx.w.__audioMode = 'auto'; rx.w.__leemosRescueMs = 9000;
    const held = []; const st1 = rx.w.setTimeout; rx.w.setTimeout = (f, m, ...a) => (m === 500 ? (held.push(f), 0) : st1(f, m, ...a));
    rx.$('mListen').click(); await until(() => !lroom(rx).hidden);
    for (let i = 0; i < 12 && !rx.d.getElementById('listenAgain'); i++) { await sleep(40); const r = right(rx); if (r) { r.click(); await sleep(20); } }
    check('listen gaps: the end of the session holds a 500 ms reward timer', !!rx.d.getElementById('listenAgain') && held.length >= 1, 'held=' + held.length);
    rx.$('mSyl').click(); await sleep(10); held.forEach((f) => f()); await sleep(10);
    check('listen gaps: the sticker overlay does not open over the reading screen when she left before the timer', rx.$('reward').hidden === true && rx.errors.length === 0, rx.errors.join(' | '));

    // the pairs file fails to load (offline, 404): the session is still 6 robot screens and nothing breaks
    const fx = await boot({ storage: LR({ pathEs: 12 }), manifest: lman, onDom: (w) => { const f0 = w.fetch; w.fetch = (u, ...r) => (/pairs\.es\.json$/.test(String(u)) ? Promise.resolve({ ok: false, status: 404, json: async () => ({}) }) : f0(u, ...r)); } });
    fx.w.__audioMode = 'auto'; fx.w.__leemosRescueMs = 9000; fx.$('mListen').click(); await until(() => !lroom(fx).hidden);
    let sawPair = false, screens = 0;
    for (let i = 0; i < 8 && !fx.d.getElementById('listenAgain'); i++) { if (fx.d.querySelector('.listen-word')) sawPair = true; const r = right(fx); if (!r) break; screens++; r.click(); await sleep(30); }
    check('listen gaps: with the pairs file failing to load the session is robot-only and ends normally', !sawPair && screens === 6 && !!fx.d.getElementById('listenAgain') && fx.errors.length === 0, `pair=${sawPair} screens=${screens} ${fx.errors.join('|')}`);

    // the room is part of the game-mode fit: a taller card lowers the zoom, and leaving the mode gives it back
    const lx = await boot({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 12, pathCa: 12, world: 0 }, 'leemos-game': '1' }, manifest: lman }); lx.w.__audioMode = 'auto'; lx.w.__leemosRescueMs = 9000;
    lx.w.Element.prototype.getBoundingClientRect = function () { const z = 1; return { width: 0, height: this.classList && this.classList.contains('stage') ? (lroom(lx).hidden ? 430 : 700) * z : 0, top: 0, left: 0, right: 0, bottom: 0 }; };
    const gz = (z) => Number(z.d.documentElement.style.getPropertyValue('--gz') || 0), air = (h) => h * 1.03 + 2;
    const pad = (() => { const cs = lx.w.getComputedStyle(lx.d.querySelector('main')); return (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0); })();
    Object.defineProperty(lx.w, 'innerWidth', { value: 1194, configurable: true }); Object.defineProperty(lx.w, 'innerHeight', { value: 834, configurable: true }); lx.w.dispatchEvent(new lx.w.Event('resize'));
    const z0 = gz(lx);
    lx.$('mListen').click(); await until(() => !lroom(lx).hidden); await sleep(80);
    check('listen gaps: in game mode the room takes part in the fit: a taller card lowers the zoom so it still fits the height', Math.abs(z0 - Math.min(1194 / 560, 834 / air(430 + pad))) < 0.01 && Math.abs(gz(lx) - 834 / air(700 + pad)) < 0.01 && gz(lx) < z0, `${z0} -> ${gz(lx)}`);
    lx.$('mSyl').click(); await sleep(80);
    check('listen gaps: and leaving the room gives the zoom back', Math.abs(gz(lx) - z0) < 0.01 && lx.errors.length === 0, `${gz(lx)} ${lx.errors.join('|')}`);
  }

  // Leo never gets the mode
  x = await bootLeo();
  check('listen: Leo is on his own screen where the modes row is hidden', x.d.documentElement.classList.contains('pre'));
}

// ---------- 46. Lumi: the 2.5D owl and his idle life ----------
{
  const LUM = () => ({ storage: { 'leemos-v1': { name: 'Elsa', pathEs: 12, world: 0 } }, manifest: { generated: 'test', clips: { es: new Proxy({}, { get: (_, k) => (typeof k === 'string' ? 'c' + k + '.mp3' : undefined) }), ca: {} } } });
  const lx = await boot(LUM()); await sleep(80); // manual audio: the clip never ends by itself, so his big copy stays open to inspect
  const m = lx.$('mascot');
  check('lumi art: the small Lumi has the layers the animations use (rig, head, ears, eyes with lids, brows, beak with jaw and mouth, wings, belly star, shadow)', ['.rig', '.head-lag .head', '.ear.el', '.ear.er', '.eyes .eye-open', '.lid', '.eye-happy', '.brow.bl', '.beak .jaw', '.beak .mouth', '.wing.wl', '.wing.wr', '.bstar', '.shadow'].every((s) => m.querySelector(s)), ['.rig', '.head-lag .head', '.ear.el', '.eyes .eye-open', '.lid', '.beak .jaw', '.beak .mouth', '.wing.wl', '.bstar', '.shadow'].filter((s) => !m.querySelector(s)).join(','));
  const ids = [...m.outerHTML.matchAll(/url\(#([A-Za-z]+)\)/g)].map((x) => x[1]);
  check('lumi art: every gradient he uses is defined once, in a shared svg that is hidden by size (display:none would drop the gradients in Safari)', ids.length > 5 && ids.every((id) => lx.d.querySelectorAll(`[id="${id}"]`).length === 1) && !!lx.$('lumiDefs') && lx.$('lumiDefs').getAttribute('aria-hidden') === 'true' && lx.$('lumiDefs').getAttribute('width') === '0' && !/display:\s*none/.test(lx.$('lumiDefs').getAttribute('style') || ''), ids.join(','));
  check('lumi art: he keeps his name for screen readers', m.getAttribute('role') === 'img' && m.getAttribute('aria-label') === 'Lumi, el búho');
  // the big copy has no duplicate ids anywhere and still finds the gradients
  m.dispatchEvent(new lx.w.MouseEvent('click', { bubbles: true })); await sleep(40);
  const all = [...lx.d.querySelectorAll('[id]')].map((e) => e.id), dup = all.filter((x, i) => all.indexOf(x) !== i);
  check('lumi art: the big copy opens without duplicating any id, and its gradients are the shared ones', !lx.$('lumiBig').hidden && !!lx.$('lumiBigArt').querySelector('svg .rig') && dup.length === 0, dup.join(','));
  lx.d.dispatchEvent(new lx.w.MouseEvent('click', { bubbles: true })); await sleep(20);

  // life: a tap on him makes him giggle; a tap anywhere is glanced at; nothing breaks if the module cannot load
  const gx = await boot(LUM()); gx.w.__audioMode = 'auto'; await sleep(80);
  gx.d.dispatchEvent(new gx.w.MouseEvent('pointerdown', { clientX: 300, clientY: 0, bubbles: true }));
  check('lumi life: a tap anywhere makes him look towards it (his gaze custom property is set)', gx.$('mascot').style.getPropertyValue('--lx') !== '' && Number(gx.$('mascot').style.getPropertyValue('--lx')) > 0.5, gx.$('mascot').style.getPropertyValue('--lx'));
  gx.$('mascot').dispatchEvent(new gx.w.MouseEvent('click', { bubbles: true }));
  check('lumi life: a tap on him makes him giggle', gx.$('mascot').classList.contains('act-giggle'));
  const rx = await boot({ ...LUM(), reduced: true }); await sleep(80);
  rx.$('mascot').dispatchEvent(new rx.w.MouseEvent('click', { bubbles: true }));
  check('lumi life: with reduced motion he does not giggle or act', ![...rx.$('mascot').classList].some((c) => c.startsWith('act-')));
  const fx = await boot({ ...LUM(), importFails: true }); await sleep(80);
  fx.$('mascot').dispatchEvent(new fx.w.MouseEvent('click', { bubbles: true })); await sleep(20);
  check('lumi life: if the module cannot load he still shows and works, just without the idle acts', !!fx.$('mascot') && ![...fx.$('mascot').classList].some((c) => c.startsWith('act-')) && fx.errors.length === 0, fx.errors.join(' | '));

  // calm: no acts while she is tapping, while he talks, or while a screen is over him
  const calm = () => gx.w.__leemosCalm();
  check('lumi calm: right after a tap he stays calm (she is playing)', calm() === false);
  await sleep(2600);
  check('lumi calm: after 2.5 s without a tap he may act', calm() === true);
  gx.$('mascot').classList.add('talking'); const talk = calm(); gx.$('mascot').classList.remove('talking');
  gx.$('reward').hidden = false; const rew = calm(); gx.$('reward').hidden = true;
  gx.$('end').hidden = false; const end = calm(); gx.$('end').hidden = true;
  gx.$('lumiBig').hidden = false; const big = calm(); gx.$('lumiBig').hidden = true;
  check('lumi calm: not while he talks, nor with the reward, the end screen or his big copy on screen', talk === false && rew === false && end === false && big === false && calm() === true, `${talk} ${rew} ${end} ${big}`);
  // the old three-move antics are gone, and the module is cached for offline
  const swJs = readFileSync(join(ROOT, 'sw.js'), 'utf8'), cssL = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
  check('lumi: the old antics are gone (code and css) and src/lumi.js is cached for offline', !/antic-/.test(appJs) && !/antic/.test(cssL) && /'src\/lumi\.js'/.test(swJs));
  check('lumi: no errors anywhere', lx.errors.length === 0 && gx.errors.length === 0 && rx.errors.length === 0, [...lx.errors, ...gx.errors, ...rx.errors].join(' | '));
}

// ---------- teachers and classes: role at sign-in, linked-only linking, tablet cleanup (spec 2026-11-13-teachers-classes-design.md §6) ----------
{
  const T_EMAIL = 'profe@example.com';
  // a teacher who is also the parent of RID_A (linked) and teaches a class holding RID_B (Mateo, nobody's link)
  const teacherWorld = async ({ signed = true } = {}) => {
    const s = createFakeSupabase();
    const { auth, uid } = await signedAuth(s, T_EMAIL);
    s.setRole(T_EMAIL, 'teacher', { ack: true });
    const cls = s.addClass('3A'); s.addTeacher(cls, T_EMAIL);
    s.rows.set(RID_A, { id: RID_A, owner: uid, class_id: null, name: 'Elsa', kind: 'reader', data: dat({ total: 4, name: 'Elsa', modAt: 2 }), version: 1 });
    s.links.set(RID_A, new Set([uid]));
    s.rows.set(RID_B, { id: RID_B, owner: null, class_id: cls, name: 'Mateo', kind: 'reader', data: dat({ total: 5, name: 'Mateo', modAt: 2 }), version: 1 });
    return { s, uid, auth: signed ? auth : null, cls };
  };
  const CLASS_PROFILES = (extra = {}) => ({ 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader', rid: RID_A }, { id: 'mateo', name: 'Mateo', kind: 'reader', rid: RID_B, via: 'class' }, { id: 'ana', name: 'Ana', kind: 'reader' }], ...extra } });
  const stOf = (app, id) => JSON.parse(app.w.localStorage.getItem(id === 'elsa' ? 'leemos-v1' : 'leemos-v1:' + id) || 'null');
  const signedTeacherBoot = async (storage = {}) => {
    const t = await teacherWorld();
    const app = await boot({ supa: t.s, syncConfig: CFG, storage: { 'leemos-auth': t.auth, 'leemos-auth-user': t.uid, ...CLASS_PROFILES(), 'leemos-v1': { name: 'Elsa', total: 4, modAt: 2 }, 'leemos-v1:mateo': { name: 'Mateo', total: 5, modAt: 2 }, 'leemos-v1:ana': { name: 'Ana', total: 3 }, ...storage } });
    await until(() => t.s.log.filter((l) => l.startsWith('GET /rest/v1/child_profiles')).length >= 2, 3000); await sleep(80); // the start-up sync read both linked rows
    return { ...t, app };
  };

  // linking: the class child is neither a candidate nor auto-added
  {
    const t = await teacherWorld({ signed: false });
    const app = await boot({ supa: t.s, syncConfig: CFG });
    await signInUi(app, T_EMAIL);
    await until(() => !app.$('link').hidden, 3000);
    const opts = linkButtons(app).map((b) => b.textContent);
    check('sign-in: a teacher with a local profile is not offered a class child in askLink', !app.$('link').hidden && opts.length === 2 && opts.some((x) => /Elsa/.test(x)) && !opts.some((x) => /Mateo/.test(x)), opts.join('|'));
    linkButtons(app)[0].click();
    await until(() => profList(app).some((p) => p.rid === RID_A), 3000); await sleep(60);
    check('sign-in: class children are not auto-added', !profList(app).some((p) => p.rid === RID_B || p.name === 'Mateo') && profList(app).length === 1, JSON.stringify(profList(app)));
  }

  // sign-out: final sync, then only the via:'class' profiles go
  {
    const { s, app } = await signedTeacherBoot();
    app.w.localStorage.setItem('leemos-v1:mateo', JSON.stringify({ ...stOf(app, 'mateo'), total: 9, modAt: Date.now() + 1000 })); // played just before signing out
    app.$('acctOutBtn').click();
    await until(() => app.w.localStorage.getItem('leemos-auth') === null, 3000); await sleep(40);
    const ids = profList(app).map((p) => p.id);
    check('sign-out: removes only via:class profiles and their state, keeps linked and unmarked ones',
      ids.join(',') === 'elsa,ana' && stOf(app, 'mateo') === null && stOf(app, 'elsa').total === 4 && stOf(app, 'ana').total === 3 && profList(app)[0].rid === RID_A && s.rows.get(RID_B).data.total === 9 && app.errors.length === 0,
      JSON.stringify({ ids, server: s.rows.get(RID_B).data.total, e: app.errors }));
  }

  // sign-out offline with unsent progress: asks; "stay" keeps everything, "sign out anyway" purges
  {
    const { s, app } = await signedTeacherBoot();
    app.w.localStorage.setItem('leemos-v1:mateo', JSON.stringify({ ...stOf(app, 'mateo'), total: 9, modAt: Date.now() + 1000 }));
    s.setOffline(true);
    app.$('acctOutBtn').click();
    await until(() => !app.$('link').hidden, 3000);
    const asked = !app.$('link').hidden && app.$('linkAsk').textContent === ies.acctUnsentAsk && linkButtons(app).length === 2;
    (linkButtons(app)[1] || app.$('linkCancel')).click(); // stay signed in
    await sleep(60);
    check('sign-out: offline with unsent progress asks and keeps everything on "stay"',
      asked && app.$('link').hidden && app.w.localStorage.getItem('leemos-auth') !== null && profList(app).some((p) => p.id === 'mateo') && stOf(app, 'mateo').total === 9,
      JSON.stringify({ asked, ask: app.$('linkAsk').textContent, list: profList(app).map((p) => p.id) }));
    app.$('acctOutBtn').click();
    await until(() => !app.$('link').hidden, 3000);
    (linkButtons(app)[0] || app.$('linkCancel')).click(); // sign out anyway
    await until(() => app.w.localStorage.getItem('leemos-auth') === null, 3000); await sleep(40);
    check('sign-out: offline, "sign out anyway" then removes the class profiles', !profList(app).some((p) => p.id === 'mateo') && stOf(app, 'mateo') === null && stOf(app, 'ana').total === 3);
  }

  // fix round 1: a final sync that never ran (another round hangs) is not "everything sent"
  {
    const t = await teacherWorld();
    let hang = false;
    const s = { ...t.s, fetch: async (u, o) => { if (hang && String(u).includes('/rest/v1/')) await new Promise(() => {}); return t.s.fetch(u, o); } };
    const app = await boot({ supa: s, syncConfig: CFG, storage: { 'leemos-auth': t.auth, 'leemos-auth-user': t.uid, ...CLASS_PROFILES(), 'leemos-v1:mateo': { name: 'Mateo', total: 5, modAt: 2 } } });
    await until(() => t.s.log.filter((l) => l.startsWith('GET /rest/v1/child_profiles')).length >= 2, 3000); await sleep(80);
    app.w.__leemosSignOutWait = 150;
    app.w.localStorage.setItem('leemos-v1:mateo', JSON.stringify({ ...stOf(app, 'mateo'), total: 9, modAt: Date.now() + 1000 }));
    hang = true; // slow school wifi: a background round never finishes
    Object.defineProperty(app.d, 'hidden', { value: true, configurable: true });
    app.d.dispatchEvent(new app.w.Event('visibilitychange'));
    await sleep(20);
    app.$('acctOutBtn').click();
    await until(() => !app.$('link').hidden, 3000);
    const asked = !app.$('link').hidden && app.$('linkAsk').textContent === ies.acctUnsentAsk;
    (linkButtons(app)[1] || app.$('linkCancel')).click(); await sleep(40);
    check('sign-out: a final sync that could not run (another round hangs) asks instead of purging', asked && profList(app).some((p) => p.id === 'mateo') && stOf(app, 'mateo').total === 9 && app.w.localStorage.getItem('leemos-auth') !== null, JSON.stringify({ asked, list: profList(app).map((p) => p.id) }));
  }

  // destructive buttons (Borrar mi cuenta, Eliminar…): text at 18px bold needs 4.5:1 on the panel in both themes
  {
    const css = readFileSync(join(ROOT, 'src/styles.css'), 'utf8');
    const block = (sel) => (new RegExp(sel.replace(/[[\]"()]/g, '\\$&') + '\\{([^}]*)\\}').exec(css) || [])[1] || '';
    const tok = (b, n) => (new RegExp('--' + n + ':(#[0-9A-Fa-f]{6})').exec(b) || [])[1];
    const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const light = block(':root'), dark = block(':root[data-theme="dark"]');
    const rl = tok(light, 'danger-text') && ratio(tok(light, 'danger-text'), tok(light, 'panel')), rd = tok(dark, 'danger-text') && ratio(tok(dark, 'danger-text'), tok(dark, 'panel'));
    check('contrast: danger buttons use --danger-text (≥ 4.5:1 on the panel in light and dark) and keep --retry for the border',
      /\.icon-btn\.danger\{border-color:var\(--retry\);color:var\(--danger-text\)\}/.test(css) && rl >= 4.5 && rd >= 4.5, `${rl} ${rd}`);
  }

  // the teacher's roster bar and the child's own bar use one mastery rule (Dominado = ok >= 2 && ok > fail)
  check('mastery: one predicate (isMastered) serves the level bars and the roster percentage (pctOfData)',
    (appJs.match(/ok>=2&&\w+\.ok>\w+\.fail/g) || []).length === 1 && /const mastered=k=>isMastered\(S\.stats\[k\]\)/.test(appJs) && /function pctOfData[\s\S]{0,300}isMastered\(st\[x\.key\]\)/.test(appJs));

  // a class profile without rid can never send anything: signing out removes it without asking
  {
    const { app } = await signedTeacherBoot({ 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader', rid: RID_A }, { id: 'mateo', name: 'Mateo', kind: 'reader', via: 'class' }] } });
    app.$('acctOutBtn').click();
    await until(() => app.w.localStorage.getItem('leemos-auth') === null, 3000); await sleep(40);
    check('sign-out: a class profile without rid (nothing to send) is removed without asking', app.$('link').hidden && !profList(app).some((p) => p.id === 'mateo') && stOf(app, 'mateo') === null, JSON.stringify({ list: profList(app) }));
  }

  // revoked class child (the family took it out of the class or deleted it, or the teacher lost the class): it leaves this tablet at once
  for (const active of ['elsa', 'mateo']) {
    const t = await teacherWorld();
    t.s.hideRow(RID_B); // the policy no longer lets this teacher have Mateo
    const app = await boot({ supa: t.s, syncConfig: CFG, storage: { 'leemos-auth': t.auth, 'leemos-auth-user': t.uid, ...CLASS_PROFILES({ active }), 'leemos-v1': { name: 'Elsa', total: 4, modAt: 2 }, 'leemos-v1:mateo': { name: 'Mateo', total: 5, modAt: 2 }, 'leemos-v1:ana': { name: 'Ana', total: 3 } } });
    await until(() => !profList(app).some((p) => p.id === 'mateo'), 3000); await sleep(60);
    const pf = JSON.parse(app.w.localStorage.getItem('leemos-profiles'));
    check(`sync revoked: a class profile is removed from the device with its saved state (open profile: ${active})`,
      !pf.list.some((p) => p.id === 'mateo') && stOf(app, 'mateo') === null && pf.active === 'elsa' && pf.list.find((p) => p.id === 'elsa').rid === RID_A && stOf(app, 'ana').total === 3
      && app.$('acctMsg').textContent === ies.acctRevokedClass.replace('{n}', 'Mateo') && app.errors.length === 0, JSON.stringify({ pf, msg: app.$('acctMsg').textContent, e: app.errors }));
  }

  // fix iteration 3 (F001): a class child revoked in the final sign-out round must not make the round skip the next class child
  {
    const RID_L = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const t = await teacherWorld();
    t.s.rows.set(RID_L, { id: RID_L, owner: null, class_id: t.cls, name: 'Lucía', kind: 'reader', data: dat({ total: 2, name: 'Lucía', modAt: 2 }), version: 1 });
    const profiles = { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader', rid: RID_A }, { id: 'lucia', name: 'Lucía', kind: 'reader', rid: RID_L, via: 'class' }, { id: 'mateo', name: 'Mateo', kind: 'reader', rid: RID_B, via: 'class' }] } };
    const app = await boot({ supa: t.s, syncConfig: CFG, storage: { 'leemos-auth': t.auth, 'leemos-auth-user': t.uid, ...profiles, 'leemos-v1': { name: 'Elsa', total: 4, modAt: 2 }, 'leemos-v1:lucia': { name: 'Lucía', total: 2, modAt: 2 }, 'leemos-v1:mateo': { name: 'Mateo', total: 5, modAt: 2 } } });
    await until(() => t.s.log.filter((l) => l.startsWith('GET /rest/v1/child_profiles')).length >= 3, 3000); await sleep(80); // the start-up sync read the three linked rows
    t.s.hideRow(RID_L); // the family takes Lucía out of the class just before the teacher signs out
    app.w.localStorage.setItem('leemos-v1:mateo', JSON.stringify({ ...stOf(app, 'mateo'), total: 9, modAt: Date.now() + 1000 })); // played just before signing out
    app.$('acctOutBtn').click();
    await until(() => app.w.localStorage.getItem('leemos-auth') === null || !app.$('link').hidden, 3000); await sleep(40);
    check('sign-out: a class child revoked in the final round does not skip the next one (its progress is sent before the purge)',
      t.s.rows.get(RID_B).data.total === 9 && !profList(app).some((p) => p.id === 'lucia' || p.id === 'mateo') && app.errors.length === 0,
      JSON.stringify({ server: t.s.rows.get(RID_B).data.total, list: profList(app).map((p) => p.id), e: app.errors }));
  }

  // fix iteration 4 (F001): the OPEN class child is revoked in the final sign-out round. The page reloads (switch to another profile)
  // only after signOut and the purge: a reload inside the round would unload it before signing out, leaving the session and the class children.
  {
    const RID_L = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const t = await teacherWorld();
    t.s.rows.set(RID_L, { id: RID_L, owner: null, class_id: t.cls, name: 'Lucía', kind: 'reader', data: dat({ total: 2, name: 'Lucía', modAt: 2 }), version: 1 });
    const profiles = { 'leemos-profiles': { active: 'lucia', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader', rid: RID_A }, { id: 'lucia', name: 'Lucía', kind: 'reader', rid: RID_L, via: 'class' }, { id: 'mateo', name: 'Mateo', kind: 'reader', rid: RID_B, via: 'class' }] } };
    const app = await boot({ supa: t.s, syncConfig: CFG, storage: { 'leemos-auth': t.auth, 'leemos-auth-user': t.uid, ...profiles, 'leemos-v1': { name: 'Elsa', total: 4, modAt: 2 }, 'leemos-v1:lucia': { name: 'Lucía', total: 2, modAt: 2 }, 'leemos-v1:mateo': { name: 'Mateo', total: 5, modAt: 2 } } });
    await until(() => t.s.log.filter((l) => l.startsWith('GET /rest/v1/child_profiles')).length >= 3, 3000); await sleep(80);
    t.s.hideRow(RID_L); // Lucía, open on the tablet, is taken out of the class just before the teacher signs out
    app.$('acctOutBtn').click();
    await until(() => app.navs.length > 0 || !app.$('link').hidden, 3000); await sleep(60);
    const nav = app.navs[0] || {};
    const logoutAt = (nav.log || []).indexOf('POST /auth/v1/logout');
    check('sign-out: an open class child revoked in the final round reloads only after signOut and the purge',
      app.navs.length >= 1 && nav.auth === null && logoutAt >= 0 && !!nav.profiles && !nav.profiles.list.some((p) => p.via === 'class') && nav.profiles.active === 'elsa' && app.errors.length === 0,
      JSON.stringify({ navs: app.navs.map((n) => ({ auth: !!n.auth, logoutAt: n.log.indexOf('POST /auth/v1/logout'), list: n.profiles && n.profiles.list.map((p) => p.id) })), e: app.errors }));
  }

  // fix iteration 4 (F001): an open class child revoked in a normal round: the page reloads after the round, and the message survives the reload
  {
    const t = await teacherWorld();
    t.s.hideRow(RID_B);
    const profiles = { 'leemos-profiles': { active: 'mateo', list: [{ id: 'mateo', name: 'Mateo', kind: 'reader', rid: RID_B, via: 'class' }, { id: 'elsa', name: 'Elsa', kind: 'reader', rid: RID_A }] } };
    const app = await boot({ supa: t.s, syncConfig: CFG, storage: { 'leemos-auth': t.auth, 'leemos-auth-user': t.uid, ...profiles, 'leemos-v1': { name: 'Elsa', total: 4, modAt: 2 }, 'leemos-v1:mateo': { name: 'Mateo', total: 5, modAt: 2 } } });
    await until(() => app.navs.length > 0, 3000); await sleep(60);
    const nav = app.navs[0] || {};
    const msg = ies.acctRevokedClass.replace('{n}', 'Mateo');
    const elsaSynced = (nav.log || []).some((l) => l.includes('child_profiles') && l.includes(RID_A));
    check('sync revoked: the open class child reloads the page only after the round (the profiles after it are synced first)',
      app.navs.length === 1 && elsaSynced && nav.profiles.active === 'elsa' && !nav.profiles.list.some((p) => p.id === 'mateo') && app.errors.length === 0,
      JSON.stringify({ navs: app.navs.length, elsaSynced, e: app.errors }));
    check('sync revoked: the message is kept for the reloaded page', nav.note === msg, JSON.stringify(nav.note));
    const again = await boot({ supa: t.s, syncConfig: CFG, storage: { 'leemos-auth': t.auth, 'leemos-auth-user': t.uid, 'leemos-profiles': nav.profiles, 'leemos-v1': { name: 'Elsa', total: 4, modAt: 2 } }, onDom: (w) => w.sessionStorage.setItem('leemos-acct-note', nav.note || '') });
    await sleep(60);
    check('sync revoked: the reloaded page shows the message once', again.$('acctMsg').textContent === msg && again.w.sessionStorage.getItem('leemos-acct-note') === null, again.$('acctMsg').textContent);
  }

  // fix round 1: the session dies during the final sync and the adult stays: the class profiles are hidden
  {
    const { s, app } = await signedTeacherBoot();
    app.w.localStorage.setItem('leemos-v1:mateo', JSON.stringify({ ...stOf(app, 'mateo'), total: 9, modAt: Date.now() + 1000 }));
    s.expireAccessTokens(); s.revokeRefreshTokens();
    app.$('acctOutBtn').click();
    await until(() => !app.$('link').hidden, 3000);
    (linkButtons(app)[1] || app.$('linkCancel')).click(); await sleep(40);
    const m = profList(app).find((p) => p.id === 'mateo');
    app.$('profileBtn').click();
    const listed = [...app.d.querySelectorAll('#profileList .wbtn')].map((b) => b.textContent);
    app.$('profilesClose').click();
    check('sign-out: an auth error on the final sync plus "stay" hides the class profiles', !!m && m.hidden === true && !listed.some((x) => /Mateo/.test(x)) && stOf(app, 'mateo').total === 9, JSON.stringify({ m, listed }));
  }

  // fix round 1: another account cancels at the link question: the class profiles are not purged
  {
    const s = await withAccount([[RID_A, 'Elsa', 'reader', dat({ total: 1, name: 'Elsa' })]]);
    const app = await boot({ supa: s, syncConfig: CFG, storage: { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader' }, { id: 'mateo', name: 'Mateo', kind: 'reader', rid: RID_B, via: 'class' }] }, 'leemos-auth-user': 'user-of-the-teacher', 'leemos-v1:mateo': { name: 'Mateo', total: 5 } } });
    await signInUi(app, 'mama@example.com');
    await until(() => !app.$('link').hidden, 3000);
    app.$('linkCancel').click(); await sleep(60);
    const m = profList(app).find((p) => p.id === 'mateo');
    check('a different account that cancels the sign-in does not purge the class profiles', !!m && m.rid === RID_B && m.via === 'class' && stOf(app, 'mateo').total === 5 && app.w.localStorage.getItem('leemos-auth') === null, JSON.stringify(profList(app)));
  }

  // revoked: the server no longer lets this account have the child
  {
    const s = createFakeSupabase(); const { auth, uid } = await signedAuth(s);
    s.rows.set(RID_A, { id: RID_A, owner: null, class_id: null, name: 'Elsa', kind: 'reader', data: dat({ total: 1, name: 'Elsa' }), version: 1 });
    s.hideRow(RID_A);
    const app = await boot({ supa: s, syncConfig: CFG, storage: { 'leemos-auth': auth, 'leemos-auth-user': uid, ...PROF_A, 'leemos-v1': { name: 'Elsa', total: 6, modAt: 10 } } });
    await until(() => !profList(app)[0].rid, 3000); await sleep(40);
    check('sync revoked: keeps local data and drops the rid',
      !profList(app)[0].rid && JSON.parse(app.w.localStorage.getItem('leemos-v1')).total === 6 && app.$('acctMsg').textContent === ies.acctRevoked.replace('{n}', 'Elsa') && s.rows.size === 1 && s.rows.get(RID_A).data.total === 1,
      JSON.stringify({ list: profList(app), msg: app.$('acctMsg').textContent }));
  }

  // auth error: the class profiles are hidden until the same account signs in again
  {
    const t = await teacherWorld();
    t.s.expireAccessTokens(); t.s.revokeRefreshTokens(); // the session is dead (revoked or expired refresh token)
    const app = await boot({ supa: t.s, syncConfig: CFG, storage: { 'leemos-auth': t.auth, 'leemos-auth-user': t.uid, ...CLASS_PROFILES(), 'leemos-v1:mateo': { name: 'Mateo', total: 5 } } });
    await until(() => (profList(app).find((p) => p.id === 'mateo') || {}).hidden === true, 3000);
    app.$('profileBtn').click();
    const listed = [...app.d.querySelectorAll('#profileList .wbtn')].map((b) => b.textContent);
    app.$('profilesClose').click();
    const hiddenOk = (profList(app).find((p) => p.id === 'mateo') || {}).hidden === true && !listed.some((x) => /Mateo/.test(x)) && listed.length === 2 && stOf(app, 'mateo').total === 5;
    await signInUi(app, T_EMAIL);
    await until(() => !(profList(app).find((p) => p.id === 'mateo') || {}).hidden, 3000); await sleep(60);
    const m = profList(app).find((p) => p.id === 'mateo');
    check('auth error: marked profiles are hidden, and unhidden after the same account signs in again', hiddenOk && !!m && !m.hidden && m.rid === RID_B && m.via === 'class' && stOf(app, 'mateo').total === 5, JSON.stringify({ hiddenOk, listed, m }));
    const h = await boot({ storage: { 'leemos-profiles': { active: 'mateo', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader' }, { id: 'mateo', name: 'Mateo', kind: 'reader', rid: RID_B, via: 'class', hidden: true }] }, 'leemos-v1:mateo': { name: 'Mateo', total: 5 } } });
    check('auth error: a hidden profile cannot be opened (the app starts on a visible one)', h.$('hello').textContent === '¡Hola, Elsa!' && JSON.parse(h.w.localStorage.getItem('leemos-profiles')).active === 'elsa', h.$('hello').textContent);
  }

  // another account signs in on the tablet: the hidden class profiles go
  {
    const s = createFakeSupabase();
    const app = await boot({ supa: s, syncConfig: CFG, storage: { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader', rid: RID_A }, { id: 'mateo', name: 'Mateo', kind: 'reader', rid: RID_B, via: 'class', hidden: true }] }, 'leemos-auth-user': 'user-of-the-teacher', 'leemos-v1:mateo': { name: 'Mateo', total: 5 } } });
    await signInUi(app, 'mama@example.com');
    await until(() => s.rows.size === 1, 3000); await sleep(40);
    check('a different account signing in purges the hidden ones', profList(app).map((p) => p.id).join(',') === 'elsa' && stOf(app, 'mateo') === null && profList(app)[0].rid !== RID_A && !s.rows.has(RID_B), JSON.stringify(profList(app)));
  }

  // the purge removes the active profile: the app moves to a remaining one
  {
    const { app } = await signedTeacherBoot({ ...CLASS_PROFILES({ active: 'mateo' }) });
    app.$('acctOutBtn').click();
    await until(() => app.w.localStorage.getItem('leemos-auth') === null, 3000); await sleep(60);
    const pf = JSON.parse(app.w.localStorage.getItem('leemos-profiles'));
    const ok1 = pf.active === 'elsa' && !pf.list.some((p) => p.id === 'mateo') && stOf(app, 'mateo') === null;
    app.$('joinBtn').click(); app.$('okBtn').click(); await sleep(20); // the old screen keeps running until the reload: it must not write the state back
    const t2 = await teacherWorld();
    const only = await boot({ supa: t2.s, syncConfig: CFG, storage: { 'leemos-auth': t2.auth, 'leemos-auth-user': t2.uid, 'leemos-profiles': { active: 'mateo', list: [{ id: 'mateo', name: 'Mateo', kind: 'reader', rid: RID_B, via: 'class' }] }, 'leemos-v1:mateo': { name: 'Mateo', total: 5 } } });
    await sleep(80);
    only.$('acctOutBtn').click();
    await until(() => only.w.localStorage.getItem('leemos-auth') === null, 3000); await sleep(60);
    const pf2 = JSON.parse(only.w.localStorage.getItem('leemos-profiles'));
    check('purging the active profile switches to a remaining one', ok1 && stOf(app, 'mateo') === null && pf2.list.length === 1 && pf2.active === pf2.list[0].id && !pf2.list[0].via && pf2.list[0].kind === 'reader' && stOf(only, 'mateo') === null, JSON.stringify({ pf, pf2 }));
  }

  // the kind: pushed once when switched here, adopted from the server otherwise
  {
    const s = createFakeSupabase(); const { auth, uid } = await signedAuth(s);
    s.rows.set(RID_A, { id: RID_A, owner: uid, class_id: null, name: 'Elsa', kind: 'reader', data: dat({ total: 1, name: 'Elsa' }), version: 1 });
    s.links.set(RID_A, new Set([uid]));
    let app = await boot({ supa: s, syncConfig: CFG, storage: { 'leemos-auth': auth, 'leemos-auth-user': uid, ...PROF_A, 'leemos-v1': { name: 'Elsa', total: 1, modAt: 10 } } });
    await until(() => s.log.some((l) => l.startsWith('GET /rest/v1/child_profiles')), 3000); await sleep(60);
    app.$('pfSwitch').click(); // the adult switches Elsa to the pre-reader screen; the page reloads
    const dirty = profList(app)[0].kindDirty === true;
    app = await boot({ supa: s, syncConfig: CFG, storage: dump(app.w) });
    await until(() => s.rows.get(RID_A).kind === 'pre' && !profList(app)[0].kindDirty, 3000);
    const pushed = s.rows.get(RID_A).kind === 'pre' && !profList(app)[0].kindDirty;
    const r = s.rows.get(RID_A); r.kind = 'reader'; r.version++; // another device switches it back
    Object.defineProperty(app.d, 'hidden', { value: true, configurable: true });
    app.d.dispatchEvent(new app.w.Event('visibilitychange'));
    await until(() => profList(app)[0].kind === 'reader', 3000); await sleep(40);
    check('kind switched here is pushed once (kindDirty) and then adopted from the server', dirty && pushed && profList(app)[0].kind === 'reader' && s.rows.get(RID_A).kind === 'reader' && app.errors.length === 0, JSON.stringify({ dirty, pushed, list: profList(app), server: s.rows.get(RID_A).kind }));
  }

  // upgrade: before this version the kind was local only, so the server row may still hold the creation kind. The device's kind is
  // pushed once on the first sync of this version, never replaced by that stale value.
  {
    const s = createFakeSupabase(); const { auth, uid } = await signedAuth(s);
    s.rows.set(RID_A, { id: RID_A, owner: uid, class_id: null, name: 'Elsa', kind: 'reader', data: dat({ total: 1, name: 'Elsa' }), version: 1 });
    s.links.set(RID_A, new Set([uid]));
    const app = await boot({ supa: s, syncConfig: CFG, storage: { 'leemos-auth': auth, 'leemos-auth-user': uid, 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'pre', rid: RID_A }] }, 'leemos-v1': { name: 'Elsa', total: 1, modAt: 10 } } });
    await until(() => s.log.some((l) => l.startsWith('GET /rest/v1/child_profiles')), 3000); await sleep(80);
    const after = profList(app)[0], sealed = JSON.parse(dump(app.w)['leemos-profiles']).kindSynced === true;
    const r = s.rows.get(RID_A); r.kind = 'reader'; r.version++; // another device switches it back before this one starts again
    const again = await boot({ supa: s, syncConfig: CFG, storage: dump(app.w) }); // a later start: the migration must not run again
    await until(() => profList(again)[0].kind === 'reader', 3000); await sleep(80);
    check('upgrade: a kind switched before this version is pushed once, not replaced by the server\'s stale kind; a later start adopts a switch made elsewhere',
      after.kind === 'pre' && !after.kindDirty && sealed && profList(again)[0].kind === 'reader' && !profList(again)[0].kindDirty && s.rows.get(RID_A).kind === 'reader' && app.errors.length === 0 && again.errors.length === 0, JSON.stringify({ after, sealed, server: s.rows.get(RID_A).kind, again: profList(again) }));
  }

  // the role is read at start when a session is stored (whoami also claims a pending teacher invitation)
  {
    const s = createFakeSupabase(); const { auth, uid } = await signedAuth(s, T_EMAIL);
    s.inviteTeacher(T_EMAIL);
    s.log.length = 0;
    await boot({ supa: s, syncConfig: CFG, storage: { 'leemos-auth': auth, 'leemos-auth-user': uid, ...PROF_A } });
    await until(() => s.accounts.get(uid).role === 'teacher', 3000);
    check('role is read at app start with a stored session', s.log.includes('POST /rest/v1/rpc/whoami') && s.accounts.get(uid).role === 'teacher', s.log.join(' | '));
  }

  // final review 1: the session dies outside syncAll (a request from the panel refreshes and fails): the next round hides the class profiles
  {
    const { s, app } = await signedTeacherBoot();
    s.expireAccessTokens(); s.revokeRefreshTokens();
    app.$('parents').open = true; app.$('parents').dispatchEvent(new app.w.Event('toggle')); // the panel's first request refreshes, gets a 400, clears the session
    await until(() => app.w.localStorage.getItem('leemos-auth') === null, 3000);
    const cleared = app.w.localStorage.getItem('leemos-auth') === null;
    Object.defineProperty(app.d, 'hidden', { value: true, configurable: true });
    app.d.dispatchEvent(new app.w.Event('visibilitychange'));
    await until(() => (profList(app).find((p) => p.id === 'mateo') || {}).hidden === true, 2000);
    const m = profList(app).find((p) => p.id === 'mateo');
    check('final review: a session cleared outside syncAll makes the next round hide the class profiles', cleared && !!m && m.hidden === true && stOf(app, 'mateo').total === 5 && profList(app).some((p) => p.id === 'ana' && !p.hidden), JSON.stringify({ cleared, m }));
  }
  // final review 1: no stored session at start (expired before the reload, or the admin page's "Salir" on the same origin): hidden, not listed, not opened
  {
    const app = await boot({ supa: createFakeSupabase(), syncConfig: CFG, storage: { ...CLASS_PROFILES({ active: 'mateo' }), 'leemos-auth-user': 'user-1', 'leemos-v1:mateo': { name: 'Mateo', total: 5 } } });
    app.$('profileBtn').click();
    const listed = [...app.d.querySelectorAll('#profileList .wbtn')].map((b) => b.textContent);
    app.$('profilesClose').click();
    const m = profList(app).find((p) => p.id === 'mateo');
    check('final review: with no stored session at start the class profiles are hidden, not listed and not opened', !!m && m.hidden === true && !listed.some((x) => /Mateo/.test(x)) && app.$('hello').textContent === '¡Hola, Elsa!' && stOf(app, 'mateo').total === 5 && !profList(app).find((p) => p.id === 'ana').hidden, JSON.stringify({ m, listed, hello: app.$('hello').textContent }));
  }
  // final review: another account's session replaced A's (the admin page signed in on this origin): A's class profiles are hidden, not deleted
  {
    const t = await teacherWorld();
    const adm = await signedAuth(t.s, 'admin@example.com');
    const app = await boot({ supa: t.s, syncConfig: CFG, storage: { 'leemos-auth': adm.auth, 'leemos-auth-user': t.uid, ...CLASS_PROFILES(), 'leemos-v1:mateo': { name: 'Mateo', total: 5 } } });
    await until(() => (profList(app).find((p) => p.id === 'mateo') || {}).hidden === true, 3000);
    app.$('profileBtn').click();
    const listed = [...app.d.querySelectorAll('#profileList .wbtn')].map((b) => b.textContent);
    app.$('profilesClose').click();
    const m = profList(app).find((p) => p.id === 'mateo');
    const hiddenOk = !!m && m.hidden === true && m.rid === RID_B && !listed.some((x) => /Mateo/.test(x)) && stOf(app, 'mateo').total === 5 && !t.s.log.some((l) => /child_profiles/.test(l));
    await signInUi(app, T_EMAIL);
    await until(() => !(profList(app).find((p) => p.id === 'mateo') || {}).hidden, 3000); await sleep(60);
    const back = profList(app).find((p) => p.id === 'mateo');
    check('final review: a session of another account (admin page on this origin) hides the class profiles, and A signing in again unhides them', hiddenOk && !!back && !back.hidden && back.via === 'class' && stOf(app, 'mateo').total === 5, JSON.stringify({ m, listed, back }));
  }
  // final review 3: a new profile never adopts a leftover saved state whose id it would take
  {
    const app = await boot({ storage: { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader' }] }, 'leemos-v1:ana': { name: 'Ana', total: 7 } } });
    app.$('pfName').value = 'Ana'; app.$('pfKind').value = 'reader'; app.$('pfAdd').click();
    const a = profList(app).find((p) => p.name === 'Ana');
    check('final review: adding "Ana" next to a leftover leemos-v1:ana takes another id', !!a && a.id !== 'ana' && JSON.parse(app.w.localStorage.getItem('leemos-v1:ana')).total === 7, JSON.stringify(profList(app)));
  }

  const ies2 = readJSON('src/data/i18n.es.json'), ica2 = readJSON('src/data/i18n.ca.json');
  check('i18n parity still holds', Object.keys(ies2).length === Object.keys(ica2).length && Object.keys(ies2).every((k) => k in ica2) && ['acctRevoked', 'acctRevokedClass', 'acctUnsentAsk', 'acctUnsentOut', 'acctUnsentStay'].every((k) => typeof ies2[k] === 'string' && typeof ica2[k] === 'string'));
  { // one Catalan term per role in the account and class strings: «mestre» and «infant» (as in teachShare, teachClasses…)
    const mixed = Object.entries(ica2).filter(([k, v]) => /^(teach|acct)/.test(k) && /\b(professors?|nens?)\b/i.test(v)).map(([k]) => k);
    check('i18n ca: the account and class strings say «mestre» and «infant», never «professor» or «nen»', !mixed.length, mixed.join()); }
}

// ---------- parent and teacher UI (src/teach.js): sharing, code redeem, class panel ----------
{
  const P_EMAIL = 'mama@example.com', T_EMAIL = 'profe@example.com';
  const RID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const rpcAs = async (s, auth, name, args) => (await s.fetch('https://x/rest/v1/rpc/' + name, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.access_token }, body: JSON.stringify(args) })).json();
  // a project with a class 3A (teacher T), Mateo (RID_B, in 3A, nobody's link) and Elsa (RID_A, linked to the parent, in no class)
  const world = async ({ who = 'parent', ack = true, teacher = true } = {}) => {
    const s = createFakeSupabase();
    const par = await signedAuth(s, P_EMAIL);
    const tea = await signedAuth(s, T_EMAIL);
    if (teacher) s.setRole(T_EMAIL, 'teacher', { ack });
    const cls = s.addClass('3A'); if (teacher) s.addTeacher(cls, T_EMAIL);
    s.rows.set(RID_A, { id: RID_A, owner: par.uid, class_id: null, name: 'Elsa', kind: 'reader', data: dat({ total: 4, name: 'Elsa', modAt: 2 }), version: 1 });
    s.links.set(RID_A, new Set([par.uid]));
    s.rows.set(RID_B, { id: RID_B, owner: null, class_id: cls, name: 'Mateo', kind: 'reader', data: dat({ total: 5, name: 'Mateo', modAt: 2, stats: { 's:ma': { ok: 3, fail: 0 }, 's:me': { ok: 2, fail: 0 } } }), version: 1 });
    const me = who === 'parent' ? par : tea;
    return { s, par, tea, me, cls };
  };
  const bootWorld = async (w, storage = {}, extra = {}) => {
    const app = await boot({ supa: w.s, syncConfig: CFG, storage: { 'leemos-auth': w.me.auth, 'leemos-auth-user': w.me.uid, ...(w.me === w.par ? PROF_A : { 'leemos-profiles': { active: 'ana', list: [{ id: 'ana', name: 'Ana', kind: 'reader' }] } }), ...storage }, ...extra });
    app.$('parents').open = true; app.$('parents').dispatchEvent(new app.w.Event('toggle'));
    await until(() => !app.$('teach').hidden && app.$('teach').querySelector('[data-block]'), 4000);
    await sleep(60);
    return app;
  };
  const qs = (app, sel) => app.$('teach').querySelector(sel), qsa = (app, sel) => [...app.$('teach').querySelectorAll(sel)];
  const msgOf = (app) => (app.$('teachMsg') || { textContent: '' }).textContent;
  const confirmWith = async (app, yes) => { await until(() => !app.$('link').hidden, 2000); const ask = app.$('linkAsk').textContent; const b = [...app.$('linkOpts').querySelectorAll('button')]; (yes ? b[0] : b[1]).click(); await sleep(40); return ask; };
  const type = (app, id, v) => { const i = app.$(id); i.value = v; i.dispatchEvent(new app.w.Event('input', { bubbles: true })); };
  const imports = (w) => { const o = w.__leemosImport; w.__leemosImport = (p) => { (w.__imps ||= []).push(p); return o(p); }; };

  {
    const supa0 = createFakeSupabase();
    const app = await boot({ supa: supa0, onDom: imports });
    app.$('parents').open = true; app.$('parents').dispatchEvent(new app.w.Event('toggle')); await sleep(80);
    check('teach: panels hidden with empty config', app.$('teach').hidden && app.$('teach').children.length === 0 && supa0.log.length === 0 && !(app.w.__imps || []).some((p) => /teach/.test(p)) && app.errors.length === 0, JSON.stringify(app.w.__imps));
  }

  {
    const w = await world();
    const app = await bootWorld(w, {}, { onDom: imports });
    check('teach: a parent session sees the parent block and not the teacher block',
      !!qs(app, '[data-block=parent]') && !!qs(app, '[data-act=share][data-child="' + RID_A + '"]') && !!app.$('teachRedeem') && !qs(app, '[data-block=teacher]') && !qs(app, '[data-act=open]') && (app.w.__imps || []).some((p) => /teach/.test(p)) && app.errors.length === 0, app.$('teach').textContent);
  }

  {
    const w = await world({ who: 'teacher', ack: false });
    const app = await bootWorld(w);
    const only = !!app.$('teachAck') && !qs(app, '[data-act=open]') && !qs(app, '[data-act=newchild]') && !qs(app, '[data-roster]') && app.$('teachAck').textContent.includes(ies.teachAckText);
    app.$('teachAckBtn').click();
    await until(() => !!qs(app, '[data-roster]'), 3000);
    check('teach: a teacher without acknowledgement sees only the acknowledgement', only && !!w.s.accounts.get(w.tea.uid).ack && !app.$('teachAck') && !!qs(app, '[data-act=open][data-child="' + RID_B + '"]'), app.$('teach').textContent);
  }

  {
    const w = await world();
    const app = await bootWorld(w);
    qs(app, '[data-act=share]').click();
    const askNo = await confirmWith(app, false);
    const none = w.s.invites.length === 0;
    qs(app, '[data-act=share]').click();
    await confirmWith(app, true);
    await until(() => !!qs(app, '[data-code]'), 3000);
    const code = qs(app, '[data-code]').textContent;
    const inv = w.s.invites[0];
    const exp = qs(app, '[data-expiry]').textContent;
    const day = new Date(inv.exp).toLocaleDateString('es', { day: 'numeric', month: 'long' });
    check('teach: sharing shows an 8-character code and its expiry after confirming',
      none && askNo.includes('Elsa') && /nombre|progreso/i.test(askNo) && /^[A-Z2-9]{8}$/.test(code) && inv.code === code && inv.kind === 'to_class' && exp.includes(day) && !!qs(app, '[data-act=copy]') && app.$('teach').querySelectorAll('button').length > 0,
      JSON.stringify({ askNo, code, exp, day }));
  }

  {
    const w = await world();
    const app = await bootWorld(w);
    type(app, 'teachCode', 'ZZZZ2222'); app.$('teachRedeem').click();
    await until(() => msgOf(app).length > 0, 3000);
    const m1 = msgOf(app);
    const own = await rpcAs(w.s, w.par.auth, 'create_invite', { p_child: RID_A, p_kind: 'to_class' });
    type(app, 'teachCode', own.code); app.$('teachRedeem').click();
    await until(() => w.s.log.filter((l) => /redeem_invite/.test(l)).length >= 2 && !app.$('teachRedeem').disabled, 3000); await sleep(40);
    const m2 = msgOf(app);
    const tried = async (c) => { const n = w.s.log.filter((l) => /redeem_invite/.test(l)).length; type(app, 'teachCode', c); app.$('teachRedeem').click(); await until(() => w.s.log.filter((l) => /redeem_invite/.test(l)).length > n && !app.$('teachRedeem').disabled, 3000); await sleep(40); return msgOf(app); };
    const other = await signedAuth(w.s, 'otro@example.com');
    const used = await rpcAs(w.s, w.tea.auth, 'create_invite', { p_child: RID_B, p_kind: 'to_parent' });
    await rpcAs(w.s, other.auth, 'redeem_invite', { p_code: used.code, p_class: null }); // somebody else already used it
    const m3 = await tried(used.code);
    const RID_X = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    w.s.rows.set(RID_X, { id: RID_X, owner: null, class_id: w.cls, name: 'Xavi', kind: 'reader', data: dat({ name: 'Xavi' }), version: 1 });
    const old = await rpcAs(w.s, w.tea.auth, 'create_invite', { p_child: RID_X, p_kind: 'to_parent' });
    w.s.advance(8 * 24 * 3600 * 1000); // the week is over
    const m4 = await tried(old.code);
    check('teach: redeeming a wrong code shows one generic message (wrong, own, used and expired alike)', [m1, m2, m3, m4].every((m) => m === ies.teachBadCode) && w.s.rows.get(RID_A).class_id === null && !(w.s.links.get(RID_X) || new Set()).size, JSON.stringify({ m1, m2, m3, m4 }));
  }

  {
    const w = await world({ who: 'teacher' });
    const app = await bootWorld(w);
    type(app, 'teachNewName-' + w.cls, 'Nuria');
    qs(app, '[data-act=newchild][data-class="' + w.cls + '"]').click();
    await until(() => [...w.s.rows.values()].some((r) => r.name === 'Nuria'), 3000); await sleep(100);
    const row = [...w.s.rows.values()].find((r) => r.name === 'Nuria');
    const local = profList(app).find((p) => p.rid === (row && row.id));
    check('teach: "New child in this class" creates the row with class_id and marks via:class',
      !!row && row.class_id === w.cls && !(w.s.links.get(row.id) || new Set()).size && !!local && local.via === 'class' && local.name === 'Nuria' && local.kind === 'reader' && !!qs(app, '[data-roster] [data-child="' + row.id + '"]') && w.s.log.some((l) => l === 'POST /rest/v1/child_profiles') && app.errors.length === 0,
      JSON.stringify({ row, local, errors: app.errors }));
  }

  {
    const w = await world({ who: 'teacher' });
    const app = await bootWorld(w);
    const leave = qs(app, '[data-act=leave][data-child="' + RID_B + '"]'), del = qs(app, '[data-act=delete][data-child="' + RID_B + '"]');
    leave.click(); const askLeave = await confirmWith(app, false);
    const intact1 = w.s.rows.get(RID_B).class_id === w.cls;
    const fa = app.d.activeElement;
    check('teach: after an action the focus returns to the same button (the panel is rebuilt)', !!fa && fa.dataset.act === 'leave' && fa.dataset.child === RID_B && app.$('teach').contains(fa) && app.$('teachMsg') && app.$('teachMsg').getAttribute('role') === 'status', fa && fa.outerHTML);
    qs(app, '[data-act=delete][data-child="' + RID_B + '"]').click(); const askDel = await confirmWith(app, false);
    const intact2 = w.s.rows.has(RID_B);
    qs(app, '[data-act=delete][data-child="' + RID_B + '"]').click(); await confirmWith(app, true);
    await until(() => !w.s.rows.has(RID_B), 3000); await sleep(60);
    check('teach: delete and take-out are different buttons and each asks to confirm',
      !!leave && !!del && leave !== del && leave.textContent !== del.textContent && askLeave !== askDel && /Mateo/.test(askLeave) && /Mateo/.test(askDel) && intact1 && intact2 && !w.s.rows.has(RID_B) && w.s.tombstones.has(RID_B) && !qs(app, '[data-roster] [data-child="' + RID_B + '"]'),
      JSON.stringify({ askLeave, askDel }));
  }

  {
    const w = await world({ who: 'teacher' });
    const cls2 = w.s.addClass('3B'); w.s.addTeacher(cls2, T_EMAIL); // two classes: the picker decides
    const own = await rpcAs(w.s, w.par.auth, 'create_invite', { p_child: RID_A, p_kind: 'to_class' });
    const app = await bootWorld(w);
    const opts = [...app.$('teachPick').options].map((o) => o.value);
    app.$('teachPick').value = cls2; app.$('teachPick').dispatchEvent(new app.w.Event('change', { bubbles: true }));
    type(app, 'teachClassCode', own.code); app.$('teachClassRedeem').click();
    await until(() => w.s.rows.get(RID_A).class_id, 3000); await sleep(100);
    check('teach: redeeming a valid to_class code as a teacher puts the child in the chosen class', opts.length === 2 && cls2 !== w.cls && w.s.rows.get(RID_A).class_id === cls2 && !!qs(app, '[data-class="' + cls2 + '"] [data-child="' + RID_A + '"]') && msgOf(app) === ies.teachRedeemedClass && !!qs(app, '[data-roster] [data-child="' + RID_A + '"]'), msgOf(app));
  }

  {
    const w = await world();
    const inv = await rpcAs(w.s, w.tea.auth, 'create_invite', { p_child: RID_B, p_kind: 'to_parent' });
    const app = await bootWorld(w);
    type(app, 'teachCode', inv.code.slice(0, 4).toLowerCase() + '-' + inv.code.slice(4)); app.$('teachRedeem').click();
    await until(() => w.s.links.get(RID_B) && w.s.links.get(RID_B).has(w.par.uid), 3000); await sleep(100);
    const local = profList(app).find((p) => p.rid === RID_B);
    check('teach: redeeming a valid to_parent code as a parent links the child', w.s.links.get(RID_B).has(w.par.uid) && msgOf(app) === ies.teachRedeemedParent && !!qs(app, '[data-block=parent] [data-child="' + RID_B + '"]') && !!local && !local.via, JSON.stringify({ msg: msgOf(app), local }));
  }

  {
    const w = await world({ who: 'teacher' });
    const app = await bootWorld(w);
    qs(app, '[data-act=open][data-child="' + RID_B + '"]').click();
    await until(() => profList(app).some((p) => p.rid === RID_B), 3000); await sleep(60);
    const p = profList(app).find((x) => x.rid === RID_B);
    const pf = JSON.parse(app.w.localStorage.getItem('leemos-profiles'));
    check('teach: Open here creates the local profile with rid and via:class',
      !!p && p.via === 'class' && p.name === 'Mateo' && p.kind === 'reader' && pf.active === p.id && JSON.parse(app.w.localStorage.getItem('leemos-v1:' + p.id)).total === 5, JSON.stringify(pf));
  }

  {
    const w = await world();
    w.s.rows.get(RID_A).class_id = w.cls;
    const app = await bootWorld(w);
    const label = qs(app, '[data-block=parent] [data-child="' + RID_A + '"]').textContent;
    qs(app, '[data-act=leave][data-child="' + RID_A + '"]').click();
    await confirmWith(app, true);
    await until(() => w.s.rows.get(RID_A).class_id === null, 3000); await sleep(100);
    check('teach: a parent takes the child out of the class and the roster updates', /3A/.test(label) && w.s.rows.get(RID_A).class_id === null && !qs(app, '[data-act=leave]') && !!qs(app, '[data-act=share][data-child="' + RID_A + '"]') && !/3A/.test(qs(app, '[data-block=parent]').textContent), label);
  }

  {
    const w = await world({ who: 'teacher' });
    const app = await bootWorld(w);
    qs(app, '[data-act=leave][data-child="' + RID_B + '"]').click();
    await confirmWith(app, true);
    await until(() => msgOf(app).length > 0, 3000); await sleep(40);
    check('teach: leaving a class with an unclaimed child shows the orphan message', msgOf(app) === ies.teachOrphan && w.s.rows.get(RID_B).class_id === w.cls && !!qs(app, '[data-roster] [data-child="' + RID_B + '"]'), msgOf(app));
  }

  {
    // the parents' code is offered only for a child nobody has claimed (has_parent comes from the server, not from the caller's own link)
    const w = await world({ who: 'teacher' });
    w.s.rows.get(RID_A).class_id = w.cls; // Elsa: in 3A and claimed by her parent
    const app = await bootWorld(w);
    check('teach: "Código para los padres" is absent for a claimed child and present for an unclaimed one', !!qs(app, '[data-act=parentcode][data-child="' + RID_B + '"]') && !qs(app, '[data-act=parentcode][data-child="' + RID_A + '"]') && !!qs(app, '[data-roster] [data-child="' + RID_A + '"]'), app.$('teach').textContent);
  }

  {
    // a parents' code typed into the teacher's class box is refused and stays valid for the family
    const w = await world({ who: 'teacher' });
    const inv = await rpcAs(w.s, w.tea.auth, 'create_invite', { p_child: RID_B, p_kind: 'to_parent' });
    const app = await bootWorld(w);
    app.$('teachPick').value = w.cls;
    type(app, 'teachClassCode', inv.code); app.$('teachClassRedeem').click();
    await until(() => msgOf(app).length > 0, 3000); await sleep(40);
    const refused = msgOf(app) === ies.teachBadCode && !(w.s.links.get(RID_B) || new Set()).size;
    const later = await rpcAs(w.s, w.par.auth, 'redeem_invite', { p_code: inv.code, p_class: null });
    check('teach: a to_parent code typed in the class box is refused, links nobody and still works for the family', refused && later.ok === true && w.s.links.get(RID_B).has(w.par.uid), JSON.stringify({ msg: msgOf(app), later }));
  }

  {
    const w = await world();
    const inv = await rpcAs(w.s, w.tea.auth, 'create_invite', { p_child: RID_B, p_kind: 'to_parent' });
    const app = await bootWorld(w);
    w.s.setOffline(true);
    const before = JSON.stringify(w.s.invites);
    type(app, 'teachCode', inv.code); app.$('teachRedeem').click();
    await until(() => msgOf(app).length > 0, 3000);
    const m1 = msgOf(app);
    qs(app, '[data-act=share]').click(); await confirmWith(app, true);
    await until(() => msgOf(app) === ies.acctNetwork && !qs(app, '[data-code]'), 3000); await sleep(40);
    const untouched = JSON.stringify(w.s.invites) === before && !qs(app, '[data-code]') && app.$('teachCode').value === inv.code; // nothing was consumed or created while offline, and the typed code is still in the box
    w.s.setOffline(false);
    type(app, 'teachCode', inv.code); app.$('teachRedeem').click();
    await until(() => w.s.links.get(RID_B) && w.s.links.get(RID_B).has(w.par.uid), 3000);
    check('teach: offline code actions show the network message and consume nothing', m1 === ies.acctNetwork && untouched && w.s.links.get(RID_B).has(w.par.uid), m1);
  }

  // final review: a fetch wrapper that holds the first GET of one child's row until release() (a slow round in flight)
  const holdRow = (s, rid) => {
    const h = { held: false, release: null };
    const gate = new Promise((r) => { h.release = r; });
    h.s = { ...s, fetch: async (u, o = {}) => { const r = await s.fetch(u, o); if (!h.held && (o.method || 'GET') === 'GET' && String(u).includes('child_profiles') && String(u).includes('id=eq.' + rid)) { h.held = true; await gate; } return r; } };
    return h;
  };

  {
    // final review 2: a teacher whose own child is in a colleague's class does not get that class as one of theirs
    const w = await world({ who: 'teacher' });
    w.s.setRole('colega@example.com', 'teacher', { ack: true });
    const k2 = w.s.addClass('4B'); w.s.addTeacher(k2, 'colega@example.com');
    w.s.rows.set(RID_C, { id: RID_C, owner: w.tea.uid, class_id: k2, name: 'Pau', kind: 'reader', data: dat({ total: 1, name: 'Pau', modAt: 2 }), version: 1 });
    w.s.links.set(RID_C, new Set([w.tea.uid]));
    const app = await bootWorld(w);
    const blocks = qsa(app, '[data-block=teacher] .teach-class').map((e) => e.dataset.class);
    const opts = [...app.$('teachPick').options].map((o) => o.value);
    const own = qs(app, '[data-block=parent] [data-child="' + RID_C + '"]');
    check('final review: a colleague\'s class (seen through the teacher\'s own child) is not in the teacher block nor in the picker, and still names the chip',
      blocks.join() === w.cls && opts.join() === w.cls && !qs(app, '[data-act=newchild][data-class="' + k2 + '"]') && !!own && /4B/.test(own.textContent) && app.errors.length === 0, JSON.stringify({ blocks, opts, k2, own: own && own.textContent }));
  }

  {
    // final review 3: a round that finishes after the child left this device writes nothing back
    const w = await world({ who: 'teacher' });
    const h = holdRow(w.s, RID_B);
    const profs = { 'leemos-profiles': { active: 'ana', list: [{ id: 'ana', name: 'Ana', kind: 'reader' }, { id: 'mateo', name: 'Mateo', kind: 'reader', rid: RID_B, via: 'class' }] }, 'leemos-v1:mateo': { name: 'Mateo', total: 5, modAt: 2 } };
    const app = await bootWorld({ ...w, s: h.s }, profs);
    await until(() => h.held, 3000); // the start-up round now waits on Mateo's read
    qs(app, '[data-act=delete][data-child="' + RID_B + '"]').click(); await confirmWith(app, true);
    await until(() => !profList(app).some((p) => p.id === 'mateo'), 3000);
    const gone = app.w.localStorage.getItem('leemos-v1:mateo') === null;
    h.release(); await sleep(200);
    check('final review: a sync round resolving after the class child was removed does not write its state back', h.held && gone && app.w.localStorage.getItem('leemos-v1:mateo') === null && !profList(app).some((p) => p.id === 'mateo') && app.errors.length === 0, JSON.stringify({ gone, after: app.w.localStorage.getItem('leemos-v1:mateo') }));
  }

  {
    // final review 6: "Volver a guardar" while a round is in flight syncs once that round ends
    const RID_C2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const w = await world();
    w.s.rows.delete(RID_A); w.s.links.delete(RID_A); // Elsa's server copy was deleted
    w.s.rows.set(RID_C2, { id: RID_C2, owner: w.par.uid, class_id: null, name: 'Ana', kind: 'reader', data: dat({ total: 2, name: 'Ana', modAt: 2 }), version: 1 });
    w.s.links.set(RID_C2, new Set([w.par.uid]));
    const h = holdRow(w.s, RID_C2);
    const profs = { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader', noSync: true }, { id: 'ana', name: 'Ana', kind: 'reader', rid: RID_C2 }] }, 'leemos-v1': { name: 'Elsa', total: 4, modAt: 5 }, 'leemos-v1:ana': { name: 'Ana', total: 2, modAt: 2 } };
    const app = await bootWorld({ ...w, s: h.s }, profs);
    await until(() => h.held, 3000); // a round is in flight (Elsa was already skipped: no rid yet)
    qs(app, '[data-act=resync][data-child="elsa"]').click();
    await until(() => !!profList(app).find((x) => x.id === 'elsa').rid, 2000); await sleep(40);
    const mark = w.s.log.length;
    h.release();
    await until(() => [...w.s.rows.values()].some((r) => r.name === 'Elsa'), 8000);
    const row = [...w.s.rows.values()].find((r) => r.name === 'Elsa');
    check('final review: "Volver a guardar" during a round in flight is synced when that round ends', !!row && row.data.total === 4 && row.id === profList(app).find((x) => x.id === 'elsa').rid && w.s.log.slice(mark).includes('POST /rest/v1/child_profiles') && app.errors.length === 0, JSON.stringify({ row: row && row.id, log: w.s.log.slice(mark) }));
  }

  // ---------- privacy: page, export, deletion (spec §8) ----------
  const captureDownloads = (w) => {
    w.__dl = []; w.__rev = [];
    w.URL.createObjectURL = (b) => { const u = 'blob:t' + w.__dl.length; w.__dl.push({ blob: b, url: u }); return u; };
    w.URL.revokeObjectURL = (u) => { w.__rev.push(u); };
    w.HTMLAnchorElement.prototype.click = function () { const d = w.__dl.find((x) => x.url === this.href || x.url === this.getAttribute('href')); if (d) d.name = this.download; };
  };
  const blobJSON = (w, b) => new Promise((res, rej) => { const f = new w.FileReader(); f.onload = () => { try { res(JSON.parse(f.result)); } catch (e) { rej(e); } }; f.onerror = () => rej(f.error); f.readAsText(b); });

  {
    const app = await boot({});
    const a1 = app.$('acctConsentLink'), a2 = app.$('acctPrivacy');
    const t1 = app.$('acctOut').contains(a1), t2 = app.$('acctIn').contains(a2);
    check('privacy: the consent line and the account block link to privacy.html',
      !!a1 && !!a2 && t1 && t2 && a1.getAttribute('href') === 'privacy.html' && a2.getAttribute('href') === 'privacy.html' && existsSync(join(ROOT, 'privacy.html')) && a1.textContent.length > 3 && a2.textContent.length > 3, [a1 && a1.outerHTML, a2 && a2.outerHTML].join(' '));
  }

  {
    const w = await world();
    const RID_Z = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const other = await signedAuth(w.s, 'otra@example.com');
    w.s.rows.set(RID_Z, { id: RID_Z, owner: other.uid, class_id: null, name: 'Zoe', kind: 'reader', data: dat({ total: 1, name: 'Zoe', modAt: 2 }), version: 1 });
    w.s.links.set(RID_Z, new Set([other.uid]));
    const app = await bootWorld(w, {}, { onDom: captureDownloads });
    const reqs = w.s.log.length;
    app.$('acctExport').click();
    await until(() => app.w.__dl.length === 1, 3000); await sleep(40);
    const dl = app.w.__dl[0], j = await blobJSON(app.w, dl.blob);
    const names = (j.children || []).map((c) => c.name);
    const after = w.s.log.slice(reqs);
    check('export: "Download my data" produces JSON with the account\'s children and no other account\'s',
      names.join(',') === 'Elsa' && !JSON.stringify(j).includes('Zoe') && !JSON.stringify(j).includes(RID_Z) && j.children[0].id === RID_A && dl.name === 'leemos-mis-datos.json' && /json/.test(dl.blob.type) && app.w.__rev.includes(dl.url) && after.filter((l) => /export_my_data/.test(l)).length === 1 && after.every((l) => !/^(PUT|PATCH|DELETE)/.test(l)) && app.errors.length === 0,
      JSON.stringify({ names, name: dl.name, rev: app.w.__rev, after }));
    // a child's own download: only that child
    const b = qs(app, '[data-act=download][data-child="' + RID_A + '"]');
    b.click(); await until(() => app.w.__dl.length === 2, 3000); await sleep(40);
    const j2 = await blobJSON(app.w, app.w.__dl[1].blob);
    check('export: a child\'s "Download" has that child only', !!b && j2.child && j2.child.id === RID_A && j2.child.name === 'Elsa' && !JSON.stringify(j2).includes('Zoe') && !/Elsa|Mateo/.test(app.w.__dl[1].name || ''), JSON.stringify(j2).slice(0, 200));
  }

  {
    const RID_C2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const w = await world();
    w.s.rows.set(RID_C2, { id: RID_C2, owner: w.par.uid, class_id: null, name: 'Ana', kind: 'reader', data: dat({ total: 2, name: 'Ana', modAt: 2 }), version: 1 });
    w.s.links.set(RID_C2, new Set([w.par.uid]));
    const profs = { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader', rid: RID_A }, { id: 'ana', name: 'Ana', kind: 'reader', rid: RID_C2 }] }, 'leemos-v1': { name: 'Elsa', total: 4 }, 'leemos-v1:ana': { name: 'Ana', total: 2 } };
    const app = await bootWorld(w, profs);
    qs(app, '[data-act=wipe][data-child="' + RID_A + '"]').click();
    const askNo = await confirmWith(app, false);
    const intact = w.s.rows.has(RID_A);
    qs(app, '[data-act=wipe][data-child="' + RID_A + '"]').click(); await confirmWith(app, true);
    await until(() => !w.s.rows.has(RID_A), 3000); await sleep(100);
    const list = profList(app);
    const elsa = list.find((p) => p.id === 'elsa'), ana = list.find((p) => p.id === 'ana');
    check('delete: deleting a child calls deleteChild and removes only its rid',
      /Elsa/.test(askNo) && intact && w.s.log.filter((l) => /delete_child/.test(l)).length === 1 && w.s.tombstones.has(RID_A) && w.s.rows.has(RID_C2) && !!elsa && elsa.rid === undefined && !!ana && ana.rid === RID_C2 && JSON.parse(app.w.localStorage.getItem('leemos-v1')).total === 4 && !qs(app, '[data-block=parent] [data-child="' + RID_A + '"]') && !!qs(app, '[data-block=parent] [data-child="' + RID_C2 + '"]') && app.errors.length === 0,
      JSON.stringify({ askNo, list, tomb: [...w.s.tombstones] }));
    // a child in a class gets a different question (the class teachers lose it too)
    w.s.rows.get(RID_C2).class_id = w.cls;
    app.$('acctSync').click(); await sleep(80);
    await app.$('parents').dispatchEvent(new app.w.Event('toggle')); await sleep(120);
    const wb = qs(app, '[data-act=wipe][data-child="' + RID_C2 + '"]');
    wb.click(); const askClass = await confirmWith(app, false);
    check('delete: a child in a class asks a different confirmation than a class-less one', !!wb && askClass !== askNo && /Ana/.test(askClass) && askClass.includes('3A') && w.s.rows.has(RID_C2), askClass);
  }

  {
    const w = await world();
    const profs = { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader', rid: RID_A }, { id: 'ana', name: 'Ana', kind: 'reader' }, { id: 'mateo', name: 'Mateo', kind: 'reader', rid: RID_B, via: 'class' }] }, 'leemos-v1': { name: 'Elsa', total: 4 }, 'leemos-v1:ana': { name: 'Ana', total: 3 }, 'leemos-v1:mateo': { name: 'Mateo', total: 5 }, 'leemos-sync-at': '123' };
    const app = await bootWorld(w, profs);
    const ls = app.w.localStorage;
    ls.setItem('leemos-sync-at', String(Date.now())); // a round has run
    const keysBefore = Object.keys(ls).filter((k) => !/^leemos-(auth|auth-user|sync-at)$/.test(k)).sort();
    const asks = [];
    const ask = async (yes) => { asks.push(await confirmWith(app, yes)); };
    app.$('acctDelete').click(); await ask(false); await sleep(60);
    const afterNo1 = w.s.log.filter((l) => /delete_my_account/.test(l)).length;
    app.$('acctDelete').click(); await ask(true); await ask(false); await sleep(60);
    const afterNo2 = w.s.log.filter((l) => /delete_my_account/.test(l)).length;
    const stillIn = ls.getItem('leemos-auth') !== null;
    app.$('acctDelete').click(); await ask(true); await ask(true);
    await until(() => ls.getItem('leemos-auth') === null, 3000); await sleep(100);
    const list = profList(app);
    const keysAfter = Object.keys(ls).filter((k) => !/^leemos-(auth|auth-user|sync-at)$/.test(k)).sort();
    check('delete account: asks twice, clears the auth keys and keeps local progress',
      afterNo1 === 0 && afterNo2 === 0 && stillIn && asks.length === 5 && asks[1] !== '' && asks[2] !== asks[1] && w.s.log.filter((l) => /delete_my_account/.test(l)).length === 1 && !w.s.accounts.has(w.par.uid)
      && ls.getItem('leemos-auth') === null && ls.getItem('leemos-auth-user') === null && ls.getItem('leemos-sync-at') === null
      && list.every((p) => p.rid === undefined) && list.map((p) => p.id).join(',') === 'elsa,ana' && JSON.parse(ls.getItem('leemos-v1')).total === 4 && JSON.parse(ls.getItem('leemos-v1:ana')).total === 3
      && app.$('acctOut').hidden === false && app.$('acctIn').hidden === true && app.$('teach').hidden && app.errors.length === 0,
      JSON.stringify({ afterNo1, afterNo2, asks, list, keys: Object.keys(ls) }));
    check('delete account: via:class profiles are purged', !profList(app).some((p) => p.id === 'mateo' || p.via === 'class') && ls.getItem('leemos-v1:mateo') === null && keysBefore.filter((k) => k !== 'leemos-v1:mateo').join() === keysAfter.join(), JSON.stringify({ keysBefore, keysAfter }));
  }

  {
    const w = await world();
    const app = await bootWorld(w, {}, {});
    w.s.setOffline(true);
    app.$('acctDelete').click(); await confirmWith(app, true); await confirmWith(app, true);
    await until(() => app.$('acctMsg').textContent.length > 0, 3000);
    check('delete account: offline keeps the session and says there is no connection', app.$('acctMsg').textContent === ies.acctNetwork && app.w.localStorage.getItem('leemos-auth') !== null && w.s.accounts.has(w.par.uid), app.$('acctMsg').textContent);
  }

  // ---------- fix round 1: a deletion the adult chose stays deleted (noSync) ----------
  {
    const RID_C2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const w = await world();
    w.s.rows.set(RID_C2, { id: RID_C2, owner: w.par.uid, class_id: null, name: 'Ana', kind: 'reader', data: dat({ total: 2, name: 'Ana', modAt: 2 }), version: 1 }); // a sibling of the same kind, not on this device
    w.s.links.set(RID_C2, new Set([w.par.uid]));
    const profs = { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader', rid: RID_A }] }, 'leemos-v1': { name: 'Elsa', total: 4 } };
    const app = await bootWorld(w, profs);
    qs(app, '[data-act=wipe][data-child="' + RID_A + '"]').click(); await confirmWith(app, true);
    await until(() => !w.s.rows.has(RID_A), 3000); await sleep(100);
    const marked = profList(app).find((x) => x.id === 'elsa');
    const resyncBtn = qs(app, '[data-act=resync][data-child="elsa"]');
    const rows0 = w.s.rows.size, mark = w.s.log.length;
    app.$('acctOutBtn').click();
    await until(() => app.w.localStorage.getItem('leemos-auth') === null, 3000); await sleep(60);
    await signInUi(app, P_EMAIL);
    await until(() => app.w.localStorage.getItem('leemos-auth') !== null && profList(app).some((x) => x.rid === RID_C2), 4000); await sleep(150);
    const after = w.s.log.slice(mark);
    const el = profList(app).find((x) => x.id === 'elsa');
    check('noSync: wiping a child, signing out and in again uploads nothing and asks nothing (no askLink for the wiped profile)',
      !!marked && marked.noSync === true && !marked.rid && !!resyncBtn && resyncBtn.getAttribute('aria-label').includes('Elsa') && app.$('link').hidden && !after.some((l) => l === 'POST /rest/v1/child_profiles') && w.s.rows.size === rows0 && !!el && !el.rid && el.noSync === true && JSON.parse(app.w.localStorage.getItem('leemos-v1')).total === 4 && app.errors.length === 0,
      JSON.stringify({ marked, el, rows0, rows: w.s.rows.size, linkHidden: app.$('link').hidden, post: after.filter((l) => /^POST/.test(l)) }));
  }

  {
    const w = await world();
    const profs = { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader', rid: RID_A }, { id: 'ana', name: 'Ana', kind: 'reader', rid: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }] }, 'leemos-v1': { name: 'Elsa', total: 4 }, 'leemos-v1:ana': { name: 'Ana', total: 3 } };
    const app = await bootWorld(w, profs);
    await sleep(100);
    app.$('acctDelete').click(); await confirmWith(app, true); await confirmWith(app, true);
    await until(() => app.w.localStorage.getItem('leemos-auth') === null, 3000); await sleep(100);
    const afterDel = profList(app);
    const rows0 = w.s.rows.size, mark = w.s.log.length;
    await signInUi(app, 'nueva@example.com');
    await until(() => app.w.localStorage.getItem('leemos-auth') !== null, 4000); await sleep(200);
    const after = w.s.log.slice(mark);
    const list = profList(app);
    check('noSync: after deleting the account, a new account does not receive the former profiles',
      afterDel.find((x) => x.id === 'elsa').noSync === true && !afterDel.find((x) => x.id === 'elsa').rid && !after.some((l) => l === 'POST /rest/v1/child_profiles') && w.s.rows.size === rows0 && list.find((x) => x.id === 'elsa').noSync === true && !list.find((x) => x.id === 'elsa').rid && app.errors.length === 0,
      JSON.stringify({ afterDel, list, post: after.filter((l) => /^POST/.test(l)) }));
  }

  {
    const w = await world();
    const profs = { 'leemos-profiles': { active: 'elsa', list: [{ id: 'elsa', name: 'Elsa', kind: 'reader', noSync: true }] }, 'leemos-v1': { name: 'Elsa', total: 4, modAt: 5 } };
    const app = await bootWorld(w, profs);
    w.s.rows.delete(RID_A); w.s.links.delete(RID_A);
    const btn = qs(app, '[data-act=resync][data-child="elsa"]');
    const kept = !!btn; // the marker survived the profile sanitizer on load
    const mark = w.s.log.length;
    btn.click();
    await until(() => profList(app).find((x) => x.id === 'elsa').rid, 3000);
    await until(() => [...w.s.rows.values()].some((r) => r.name === 'Elsa'), 4000); await sleep(100);
    const el = profList(app).find((x) => x.id === 'elsa');
    const row = [...w.s.rows.values()].find((r) => r.name === 'Elsa');
    check('noSync: the marker survives a reload and "Volver a guardar" clears it and syncs the profile again',
      kept && !el.noSync && el.rid === row.id && row.data.total === 4 && w.s.log.slice(mark).some((l) => l === 'POST /rest/v1/child_profiles') && !qs(app, '[data-act=resync]') && app.errors.length === 0,
      JSON.stringify({ kept, el, row: row && row.id }));
  }

  {
    const w = await world({ who: 'teacher' });
    const app = await bootWorld(w);
    qs(app, '[data-act=open][data-child="' + RID_B + '"]').click();
    await until(() => profList(app).some((p) => p.rid === RID_B), 3000); await sleep(60);
    const id = profList(app).find((p) => p.rid === RID_B).id;
    qs(app, '[data-act=delete][data-child="' + RID_B + '"]').click(); await confirmWith(app, true);
    await until(() => !w.s.rows.has(RID_B), 3000); await sleep(100);
    check('delete: a teacher deleting a class child drops its via:class profile from this device at once',
      !profList(app).some((p) => p.id === id) && app.w.localStorage.getItem('leemos-v1:' + id) === null && profList(app).some((p) => p.id === 'ana') && app.errors.length === 0, JSON.stringify(profList(app)));
  }

  {
    const w = await world();
    w.s.setRole(P_EMAIL, 'admin'); // the only admin
    const app = await bootWorld(w, { 'leemos-v1': { name: 'Elsa', total: 4 } });
    app.$('acctDelete').click(); await confirmWith(app, true); await confirmWith(app, true);
    await until(() => app.$('acctMsg').textContent.length > 0, 3000); await sleep(40);
    check('delete account: the only admin cannot delete: the session and local data stay and the message says why',
      app.$('acctMsg').textContent === ies.acctLastAdmin && app.w.localStorage.getItem('leemos-auth') !== null && w.s.accounts.has(w.par.uid) && JSON.parse(app.w.localStorage.getItem('leemos-v1')).total === 4 && !profList(app).some((p) => p.noSync) && profList(app).some((p) => p.rid === RID_A), app.$('acctMsg').textContent);
  }

  {
    const page = existsSync(join(ROOT, 'privacy.html')) ? readFileSync(join(ROOT, 'privacy.html'), 'utf8') : '';
    const text = page.replace(/<style[\s\S]*?<\/style>/g, '');
    const marks = ['responsable', 'correo', 'región'].map((w2) => new RegExp('PENDIENTE[^<]{0,80}' + w2, 'i').test(text));
    const marksCa = (text.match(/PENDENT|PENDIENTE/g) || []).length;
    check('privacy.html contains the PENDIENTE markers',
      page.length > 2000 && (text.match(/PENDIENTE/g) || []).length >= 6 && marks.every(Boolean) && /borrador sin revisi[oó]n legal/i.test(text) && /esborrany sense revisi[oó] legal/i.test(text) && !/borrador sense/i.test(text) && /lang="es"/.test(page) && /lang="ca"/.test(page) && /prefers-color-scheme:\s*dark/.test(page) && /name="viewport"/.test(page) && !new RegExp('service' + '_role').test(page) && !/[\w.-]+@[\w-]+\.[a-z]{2,}/i.test(text) && !/(href|src)="(\/|https?:)/.test(page.replace(/https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)[^"]*/g, '')) && marksCa >= 6,
      JSON.stringify({ n: (text.match(/PENDIENTE/g) || []).length, marks, len: page.length }));
  }

  {
    const es = readJSON('src/data/i18n.es.json'), ca = readJSON('src/data/i18n.ca.json');
    // every key the panel code names exists in both files (a literal key in teach.js is t('key') or a table value)
    const src = existsSync(join(ROOT, 'src/teach.js')) ? readFileSync(join(ROOT, 'src/teach.js'), 'utf8') : '';
    const ids = new Set(['teacher', 'teachCode', 'teachAck', 'teachAckBtn', 'teachPick', 'teachClassCode', 'teachClassRedeem', 'teachRedeem', 'teachMsg']); // element ids, not strings
    const named = [...new Set([...src.matchAll(/'((?:teach|acct)[A-Za-z]+)'/g)].map((m) => m[1]))].filter((k) => !ids.has(k));
    const esK = Object.keys(es), caK = Object.keys(ca);
    check('i18n: es and ca have the same keys', esK.length === caK.length && esK.every((k) => k in ca) && caK.every((k) => k in es) && named.length > 30 && named.every((k) => k in es && k in ca) && ['teachBadCode', 'teachOrphan', 'teachShareAsk', 'teachAckText'].every((k) => typeof es[k] === 'string' && typeof ca[k] === 'string' && es[k] !== ca[k]), named.filter((k) => !(k in es && k in ca)).join(','));
  }
}

console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
