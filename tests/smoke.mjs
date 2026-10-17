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

async function boot({ manifest = null, lang = 'en-US', storage = {}, swMock = null, importFails = false, mic = null, levelsPatch = null, reduced = false, voice = null, syncConfig = null, supa = null, syncEvery = 0 } = {}) {
  const errors = [];
  const audioCalls = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented: navigation/.test(e.message)) console.error(e.message); });
  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/', virtualConsole: vc,
    beforeParse(w) {
      Object.defineProperty(w.navigator, 'language', { value: lang });
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      w.__leemosImport = importFails ? () => Promise.reject(new Error('offline')) : (p) => import(pathToFileURL(join(ROOT, 'src', p)).href);
      w.matchMedia = (q) => ({ matches: reduced && /reduced-motion/.test(q), addEventListener() {}, removeListener() {} });
      w.speechSynthesis = { getVoices: () => [{ name: 'Joana Online (Natural)', lang: 'ca-ES', voiceURI: 'j' }, { name: 'Google español', lang: 'es-ES', voiceURI: 'g' }], cancel() {}, speak(u) { (w.__tts ||= []).push(u.text); } };
      w.SpeechSynthesisUtterance = function (t) { this.text = t; };
      w.Audio = function (src) { audioCalls.push(src); (w.__audios ||= []).push(this); this.play = () => Promise.resolve(); this.pause = () => { this.paused = true; }; };
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
  const w = dom.window;
  const p = w.eval(`(async()=>{'use strict';${appJs}\n})()`);
  p.catch((e) => errors.push('boot: ' + e.message));
  for (let i = 0; i < 100 && !w.document.getElementById('hello').textContent.startsWith('¡Hola') && !w.document.getElementById('hello').textContent.startsWith('Hola,'); i++) await sleep(20);
  await sleep(30);
  return { w, d: w.document, $: (id) => w.document.getElementById(id), errors, audioCalls };
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

// ---------- 4. themed words ----------
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
check('word mode prefers the current world (Granja, level 3)', themed / N >= 0.55, `${themed}/${N} themed`);

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
const bootLeo = async (extra = {}) => { const x = await boot({ storage: LEO, ...extra }); await until(() => x.$('prePlay')); return x; };
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
check('minor: Leo has no profile chip; the parents panel has a switch button', a.$('profileBtn').hidden && !!a.$('profileOpen'));
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
a.$('recBtn').click(); await sleep(30);
check('recorder: a recording with sound is saved', a.$('recStatus').textContent === 'Guardada ✓' && /ya grabada/.test(a.$('recCount').textContent), a.$('recStatus').textContent);
check('recorder: the level bar hides when recording stops', a.$('recMeter').hidden);
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
  rows.forEach(([id, name, kind, d]) => s.rows.set(id, { id, owner: uid, name, kind, data: d, version: 1 }));
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

console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
