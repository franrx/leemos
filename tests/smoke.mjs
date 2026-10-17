// Smoke tests: loads index.html + src/app.js in jsdom (no browser needed) and drives the real UI.
// jsdom does not run ES modules, so app.js is evaluated inside an async wrapper (top-level await) in strict mode.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8').replace(/<script type="module"[^>]*><\/script>/, '');
const appJs = readFileSync(join(ROOT, 'src/app.js'), 'utf8');
const readJSON = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot({ manifest = null, lang = 'en-US', storage = {}, swMock = null, importFails = false, mic = null, levelsPatch = null, reduced = false, voice = null } = {}) {
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
      if (swMock) {
        Object.defineProperty(w.navigator, 'serviceWorker', { value: { controller: {}, register: () => Promise.resolve() } });
        w.caches = { match: async () => (swMock.cached ? {} : undefined) };
      }
      w.fetch = async (u) => {
        w.__fetched.push(u);
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

console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
