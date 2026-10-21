# Escucha / Escolta mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fifth play mode where a robot sounds a word out syllable by syllable and Elsa picks the picture (part B), plus screens where she reads a word and picks between two minimal-pair pictures like *pata/pasta* (part C).

**Architecture:** New lazy-loaded module `src/listen.js` (pure logic + `createListen(ctx)`), registered in `GAMEDEF` like Busca and Cierra. Syllable sequencing is one new audio helper in `app.js` (`partSound`), passed through the game ctx. Pairs live in `src/data/pairs.{es,ca}.json`, loaded through a generalised per-game data store.

**Tech Stack:** Vanilla JS ES modules, no build; jsdom smoke tests (`tests/smoke.mjs`), plain-Node unit tests (`tests/listen.mjs`); Azure TTS via `scripts/generate-audio.mjs` for new clips.

**Spec:** `docs/superpowers/specs/2026-10-21-listen-mode-design.md` (this plan corrects its pair examples: *pala/palma* and *sala/salsa* do not satisfy "remove the coda, get the open twin"; Task C1 fixes the spec).

## Global Constraints

- No frameworks, no bundler, no `import` statements in `app.js` (tests evaluate it as text); `listen.js` is loaded with `import()` through `loadGame`.
- Same i18n keys in `i18n.es.json` and `i18n.ca.json` (a test checks parity); texts via `data-i` / `t('key')`.
- Reading sounds (syllables, words) go through `readingMuted()`; Lumi's phrases and effects do not.
- A wrong tap is a silent wobble. No punishment sound, no mistake counter, no stats, no `total`, no Camino change.
- Leo never gets the mode (`isGame` already excludes `kind:'pre'`).
- Touch targets ≥ 44 px; `prefers-reduced-motion` keeps everything static and visible; animation only transform/opacity.
- Catalan is central standard Catalan; new Catalan words need native review before they are trusted.
- Every deploy: bump `VERSION` in `sw.js` and the matching assertion in `tests/close.mjs`; new shell files go in `SHELL`.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS`.
- Run tests as `node tests/smoke.mjs > /tmp/smoke.txt 2>&1` style (no `timeout` on this Mac); `npm test` runs all.

## Review Focus

- Robot tapped repeatedly or screen left mid-sequence (mode switch, language change): a stale sounding-out must not keep playing or advance the screen → `gen`/`talking` token test (Task B3).
- Device muted: the robot is silent but the screen must still work, with no wait for audio that never plays → mute test (Task B3).
- A syllable with no clip: the sequence continues at once instead of hanging → `partSound` resolves false (Task B2/B3 test with a key the manifest lacks).
- Distractors sharing the target's emoji or text (two words drawing the same picture): never two identical cards → pure-logic test on real data (Task B1).
- Fewer than 2 open pairs, or a language with no pairs file: session degrades to 6 robot screens, never a pair screen without data → Task C3 tests.

---

## Part B: robot screen

### Task B1: Pure logic for the robot (`src/listen.js`)

**Files:**
- Create: `src/listen.js`
- Modify: `src/find.js:32` (export `closer`)
- Test: `tests/listen.mjs`
- Modify: `package.json` (add `node tests/listen.mjs` after `node tests/close.mjs` in the `test` script)

**Interfaces:**
- Consumes: `stepOf(hyphenated)` from `levelrule.js`; `similarity`, `shuffle`, `closer` from `find.js`; `splitClosed` from `close.js`.
- Produces (for B3): `MIN_OPEN = 4`, `SCREENS = 6`, `GAP = 600`; `listenWords(levels) → [{text, parts, emoji, step}]`; `openWords(words, pos)`; `robotTargets(words) → words with 2–3 parts`; `makeRobot(words, rng, exclude) → {kind:'robot', target, cards}|null`; `partKeys(part) → string[]` (clip keys to try in order); `makeSession(words, rng) → screens[]`.

- [ ] **Step 1: Write the failing test** — create `tests/listen.mjs`:

```js
// Unit tests for the pure part of the listen mode (src/listen.js). Plain Node, no DOM.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_OPEN, SCREENS, GAP, listenWords, openWords, robotTargets, makeRobot, partKeys, makeSession } from '../src/listen.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

check('constants: 4 open words to unlock, 6 screens, 600 ms between syllables', MIN_OPEN === 4 && SCREENS === 6 && GAP === 600);
check('partKeys: a closed syllable tries its stretched clip first, anything else only itself', JSON.stringify(partKeys('pas')) === '["~pas","pas"]' && JSON.stringify(partKeys('pa')) === '["pa"]' && JSON.stringify(partKeys('tras')) === '["~tras","tras"]');
check('listenWords: a word without a picture, and a repeat of the same text, are left out', listenWords([{ words: [{ w: 'pa-ta', e: '🐾' }, { w: 'pa-ta', e: '🐾' }, { w: 'ma-no' }] }]).length === 1);

for (const lang of ['es', 'ca']) {
  const words = listenWords(readJSON(`src/data/levels.${lang}.json`));
  const all = openWords(words, 12);
  const targets = robotTargets(all);
  check(`[${lang}] listenWords: every word has a picture, parts joined are its text, and a Camino step`, words.length > 50 && words.every((w) => w.emoji && w.parts.join('') === w.text && w.step >= 1));
  check(`[${lang}] robotTargets: only words of 2 or 3 syllables`, targets.length >= MIN_OPEN && targets.every((w) => w.parts.length >= 2 && w.parts.length <= 3));
  let ok = true, why = '';
  for (let seed = 1; seed <= 200 && ok; seed++) {
    const r = makeRobot(all, mulberry(seed), new Set());
    if (!r) { ok = false; why = 'null'; break; }
    const t = r.cards.map((c) => c.text), e = r.cards.map((c) => c.emoji);
    if (r.cards.length !== 3 || new Set(t).size !== 3 || new Set(e).size !== 3 || !t.includes(r.target.text)) { ok = false; why = `seed ${seed}: ${t}`; }
  }
  check(`[${lang}] makeRobot: 3 cards, the target once, no repeated word or picture`, ok, why);
  const again = (s) => makeRobot(all, mulberry(s), new Set()).cards.map((c) => c.text).join();
  check(`[${lang}] makeRobot: deterministic for a seed`, again(7) === again(7));
  check(`[${lang}] makeRobot: a target in exclude is never chosen`, (() => { const ex = new Set(targets.slice(1).map((w) => w.text)); return makeRobot(all, mulberry(3), ex).target.text === targets[0].text; })());
  check(`[${lang}] makeRobot: null when no free target or fewer than 3 distinct pictures`, makeRobot(all, mulberry(1), new Set(targets.map((w) => w.text))) === null && makeRobot(all.slice(0, 2), mulberry(1)) === null);
  const open3 = openWords(words, 3);
  const ses = makeSession(open3, mulberry(5));
  check(`[${lang}] makeSession: up to 6 robot screens with distinct targets`, ses.length >= 1 && ses.length <= SCREENS && ses.every((s) => s.kind === 'robot') && new Set(ses.map((s) => s.target.text)).size === ses.length);
}
console.log(failures ? `\n${failures} FAILED` : '\nall listen tests passed');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run it to see it fail**

Run: `node tests/listen.mjs`
Expected: FAIL / crash with `Cannot find module '../src/listen.js'`.

- [ ] **Step 3: Implement** — export `closer` in `src/find.js` (change line 32 `const closer =` to `export const closer =`), then create `src/listen.js`:

```js
// "Escucha / Escolta": a robot sounds a word out syllable by syllable and she picks the picture (and, below, minimal pairs).
// Spec: docs/superpowers/specs/2026-10-21-listen-mode-design.md
import { stepOf } from './levelrule.js';
import { similarity, shuffle, closer } from './find.js';
import { splitClosed } from './close.js';

export const MIN_OPEN = 4, SCREENS = 6, GAP = 600; // GAP: milliseconds between two syllables

// Every word with a picture, once per text, with the Camino step it needs.
export function listenWords(levels) {
  const seen = new Set(), out = [];
  for (const L of levels) {
    for (const o of L.words) {
      const parts = o.w.toLowerCase().split('-'), text = parts.join('');
      if (!o.e || seen.has(text)) continue;
      seen.add(text);
      out.push({ text, parts, emoji: o.e, step: stepOf(parts.join('-')) });
    }
  }
  return out;
}
export const openWords = (words, pos) => words.filter((w) => w.step <= pos);
export const robotTargets = (words) => words.filter((w) => w.parts.length >= 2 && w.parts.length <= 3); // one syllable has nothing to blend

// The clip keys to try, in order, for one syllable: a closed syllable has a stretched clip ("~pas") for some words.
export const partKeys = (part) => (splitClosed(part) ? ['~' + part, part] : [part]);

// One robot screen: a target not in `exclude` and the 2 open words most like it, never the same text or picture. null when there is no free target or fewer than 3 pictures.
export function makeRobot(words, rng, exclude = new Set()) {
  const free = robotTargets(words).filter((w) => !exclude.has(w.text));
  if (!free.length) return null;
  const target = free[Math.floor(rng() * free.length)];
  const others = shuffle(words.filter((w) => w.text !== target.text && w.emoji !== target.emoji), rng) // the shuffle breaks ties
    .map((w) => ({ w, s: similarity(target, w) })).sort((a, b) => closer(a.s, b.s)).map((x) => x.w);
  const picked = [];
  for (const w of others) { if (!picked.some((p) => p.emoji === w.emoji)) picked.push(w); if (picked.length === 2) break; }
  if (picked.length < 2) return null;
  return { kind: 'robot', target, cards: shuffle([target, ...picked], rng) };
}

// Up to 6 robot screens with distinct targets (fewer when the open words run out).
export function makeSession(words, rng) {
  const used = new Set(), screens = [];
  while (screens.length < SCREENS) {
    const r = makeRobot(words, rng, used);
    if (!r) break;
    used.add(r.target.text); screens.push(r);
  }
  return screens;
}
```

- [ ] **Step 4: Run to verify pass, add to `npm test`**

Run: `node tests/listen.mjs` → Expected: `all listen tests passed`. Then edit the `test` script in `package.json` to run `node tests/listen.mjs` right after `node tests/close.mjs`. Run `node tests/find.mjs` (the `closer` export must not break it).

- [ ] **Step 5: Commit**

```bash
git add src/listen.js src/find.js tests/listen.mjs package.json
git commit -m "feat(listen): pure logic for the robot screens (words, cards, session)"
```

### Task B2: `partSound` in app.js (sequenced syllable audio)

**Files:**
- Modify: `src/app.js` (add `partSound` after `letterSound`, ~line 476; pass `part:partSound` in the `loadGame` ctx, ~line 1028)
- Test: `tests/smoke.mjs` (new block 45, appended after the Cierra blocks, before the final summary)

**Interfaces:**
- Consumes: `hintURL`, `newAudio`, `readingMuted`, `curAudio` (all in app.js).
- Produces (for B3): ctx function `part(keys: string[]) → Promise<boolean>`: plays the first key that has a clip, resolves true when it ended, resolves false at once when muted or no key has a clip.

- [ ] **Step 1: Failing test** — `partSound` is internal, so the red test here is the loader ctx check; behaviour is covered through the screen in B3. Add to `tests/smoke.mjs`:

```js
// ---------- 45. Escucha / Escolta ----------
{
  const LR = (extra = {}) => ({ 'leemos-v1': { name: 'Elsa', pathEs: 12, pathCa: 12, world: 0, ...extra } });
  const lman = { generated: 'test', clips: { es: new Proxy({}, { get: (_, k) => (typeof k === 'string' && !k.startsWith('nope') ? 'c' + k + '.mp3' : undefined) }), ca: {} } };
  const lroom = (x) => x.$('listenRoom');
  let x = await boot({ storage: LR(), manifest: lman });
  check('listen: the game ctx has a syllable player (part)', /part:\s*partSound/.test(appSource));
}
```
(`appSource` stands for the variable the harness uses for the app text: find it in the existing "no import statements" check near the top of `smoke.mjs` and use that name.)

- [ ] **Step 2: Run** `node tests/smoke.mjs > /tmp/smoke.txt 2>&1; grep FAIL /tmp/smoke.txt` → the new check FAILs.

- [ ] **Step 3: Implement** — in `src/app.js` after `letterSound`:

```js
// One syllable of the robot's sounding-out: the first of `keys` that has a clip (a closed syllable tries its stretched clip first). Resolves true when it has ended, and false at once
// when muted or when no key has a clip, so the sequence never waits for nothing.
function partSound(keys){
  return new Promise(res=>{
    const u=readingMuted()?null:keys.map(hintURL).find(Boolean);if(!u){res(false);return}
    let over=false,guard=0;
    const fin=v=>{if(!over){over=true;clearTimeout(guard);res(v)}};
    try{
      const a=newAudio(u);if(curAudio&&curAudio!==a)curAudio.pause();curAudio=a;
      guard=setTimeout(()=>fin(true),1800);
      a.onended=()=>fin(true);a.onerror=()=>fin(false);
      const p=a.play();if(p&&p.catch)p.catch(()=>fin(false));
    }catch(e){fin(false)}
  });
}
```

and in the `loadGame` ctx object add `part:partSound,` next to `letter:letterSound,`.

- [ ] **Step 4: Run** the smoke test: the new check PASSES and nothing earlier regressed (`grep FAIL /tmp/smoke.txt` empty).

- [ ] **Step 5: Commit**

```bash
git add src/app.js tests/smoke.mjs
git commit -m "feat(listen): partSound plays one syllable (stretched when there is a clip) and resolves when it ends"
```

### Task B3: Robot screen, mode wiring, i18n, CSS, tests

**Files:**
- Modify: `src/listen.js` (append `createListen`)
- Modify: `index.html` (button after `#mClose` line 41; room after `#closeRoom` line 75)
- Modify: `src/app.js` (`GAMEDEF` line 132, handler after line 1043)
- Modify: `src/merge.js:40` (`mode` validator accepts `'listen'`)
- Modify: `src/data/i18n.es.json`, `src/data/i18n.ca.json` (keys below)
- Modify: `src/styles.css` (modes grid line 39-40; new `html.listen` rules after the close rules ~line 290; reduced-motion block ~line 292)
- Modify: `scripts/lib/clips.mjs` (add `i18n.listenIntro` to the Lumi phrase list, line ~46)
- Modify: `sw.js` (`SHELL` + `src/listen.js`; VERSION `leemos-v23`), `tests/close.mjs` (assert `leemos-v23`)
- Test: `tests/smoke.mjs` block 45

**Interfaces:**
- Consumes: Task B1 exports and B2 `ctx.part`; ctx fields documented in `createClose`.
- Produces (for Part C): `createListen(ctx)` returning `{canPlay, begin, leave, active, intro}`; `screen()` dispatches on `plan[idx].kind` (Part C adds `'pair'`); room `#listenRoom`, root class `html.listen`.

i18n keys (es / ca):
- `mListen`: "Escucha" / "Escolta"
- `listenLocked`: "Escucha se abre con más palabras." / "Escolta s'obre amb més paraules."
- `listenIntro`: "Escucha al robot y toca el dibujo." / "Escolta el robot i toca el dibuix."
- `listenGoal`: copy the `closeGoal` wording and placeholders exactly
- `listenRobot`: "Oír otra vez" / "Torna a escoltar"
- `listenDone`: copy `closeDone` wording (uses `{n}`)
- `listenAgain`: copy `closeAgain` wording

- [ ] **Step 1: Failing tests** — extend block 45 in `tests/smoke.mjs`:

```js
  const lstart = async (extra, opts = {}) => { const y = await boot({ storage: LR(extra), manifest: lman, ...opts }); y.w.__audioMode = 'auto'; y.w.__leemosRescueMs = 9000; y.$('mListen').click(); await until(() => !lroom(y).hidden); return y; };
  const cards = (y) => [...y.d.querySelectorAll('.listen-card')];
  const right = (y) => cards(y).find((c) => c.dataset.answer === 'true');
  const wrong = (y) => cards(y).find((c) => c.dataset.answer !== 'true');
  const lsaved = (y) => JSON.parse(y.w.localStorage.getItem('leemos-v1'));

  x = await lstart();
  check('listen: the fifth button opens the room, hides the reading screen and is pressed; the mode is saved', !lroom(x).hidden && x.d.documentElement.classList.contains('listen') && x.$('mListen').getAttribute('aria-pressed') === 'true' && lsaved(x).mode === 'listen');
  check('listen: the robot screen shows the robot and 3 picture cards, and never prints the word', !!x.d.querySelector('.listen-robot') && cards(x).length === 3 && !!right(x) && !lroom(x).textContent.includes(right(x).dataset.w));
  check('listen: the hint says the instruction', x.$('hint').textContent === 'Escucha al robot y toca el dibujo.');
  await sleep(50);
  const wordParts = right(x).dataset.parts.split('-');
  const order = x.audioCalls.filter((u) => /audio\/es\/c/.test(u)).map((u) => decodeURIComponent(u.split('/').pop()).replace(/^c|\.mp3.*$/g, '').replace('~', ''));
  check('listen: the robot says the syllables of the word in order', wordParts.every((p, i) => order[order.indexOf(wordParts[0]) + i] === p));
  const before = lsaved(x).total, st = JSON.stringify(lsaved(x).stats);
  wrong(x).click(); await sleep(20);
  check('listen: a wrong tap only wobbles: the screen stays and nothing is recorded', wrong(x).classList.contains('wobble') && !!right(x) && !right(x).classList.contains('found') && lsaved(x).total === before && JSON.stringify(lsaved(x).stats) === st);
  const rw = right(x).dataset.w;
  right(x).click(); await sleep(20);
  check('listen: the right card lights up and the whole word is said', right(x).classList.contains('found') && x.audioCalls.some((u) => u.includes('audio/es/c' + rw + '.mp3')));
  for (let i = 0; i < 12 && !x.d.getElementById('listenAgain'); i++) { await sleep(1700); const r = right(x); if (r) { r.click(); await sleep(20); } }
  await sleep(2000);
  check('listen: finishing the session shows "again" and touches no stats', !!x.d.getElementById('listenAgain') && JSON.stringify(lsaved(x).stats) === st);
```
Also add (same block): muted device (`leemos-mute` set in storage before boot) → screen opens and a right tap advances with no audio call for syllables; Leo profile (`kind:'pre'`) cannot open the mode; `mListen` at `pathEs: 1` shows `listenLocked` in the hint and `mode` stays `syl`; leaving mid-sequence (`x.$('mSyl').click()`) adds no `audioCalls` after 3000 ms; tapping the robot twice quickly plays one sequence (the first is cancelled).

- [ ] **Step 2: Run** → FAIL (`mListen` missing).

- [ ] **Step 3: Implement** — wiring first:

`index.html`: after line 41 add `<button class="mode" id="mListen" data-i="mListen" aria-pressed="false">Escucha</button>`; after line 75 add `<div class="listen-room" id="listenRoom" hidden></div>`.

`src/app.js` line 132: add to `GAMEDEF` `,listen:{file:'listen.js',create:'createListen',ms:'__leemosListenTimeout',lock:'listenLocked'}`; after line 1043 add `$('mListen').onclick=()=>openGame('listen');`.

`src/merge.js:40`: `v === 'syl' || v === 'word' || v === 'find' || v === 'close' || v === 'listen'`.

`sw.js`: add `'src/listen.js'` after `'src/close.js'` in `SHELL`; `VERSION` to `leemos-v23`; `tests/close.mjs` assertion to `leemos-v23`.

`scripts/lib/clips.mjs`: add `i18n.listenIntro` to the Lumi phrase array next to `i18n.closeIntro`.

`src/styles.css`: line 39 `repeat(5,1fr)`, line 40 `repeat(3,1fr)`; then

```css
html.listen .session,html.listen #goal,html.listen #tiles,html.listen #pic,html.listen #stage .actions{display:none!important}
.listen-room{display:flex;flex-direction:column;align-items:center;gap:18px;width:100%}
.listen-dots{display:flex;gap:7px}
.listen-dots i{width:16px;height:16px;border-radius:50%;background:color-mix(in srgb,var(--ink) 14%,transparent)}
.listen-dots i.on{background:var(--c1)}
.listen-robot{font-size:64px;line-height:1;min-width:88px;min-height:88px;border-radius:24px;border:2px solid color-mix(in srgb,var(--ink) 18%,transparent);background:var(--card,transparent);cursor:pointer}
.listen-robot.say{animation:listenPulse .5s ease-in-out}
.listen-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;width:100%;max-width:520px}
.listen-card{font-size:56px;min-height:96px;border-radius:20px;border:2px solid color-mix(in srgb,var(--ink) 18%,transparent);background:var(--card,transparent);cursor:pointer}
.listen-card.found{border-color:var(--c1);box-shadow:0 0 0 4px color-mix(in srgb,var(--c1) 35%,transparent)}
.listen-card.wobble{animation:findWobble .4s ease-in-out}
.listen-done{font-size:1.3rem;font-weight:700;text-align:center}
@keyframes listenPulse{0%{transform:scale(1)}50%{transform:scale(1.12)}100%{transform:scale(1)}}
```
and add `.listen-robot.say,.listen-card.wobble{animation:none}` inside the existing `prefers-reduced-motion` block (line ~292).

Then append to `src/listen.js`:

```js
// The screen. ctx: { doc, $, S, t, fmt, rnd, nm, say, part, lumiPlay, sayLumi, sfx, poke, sparkle, later, earnSticker, showReward, refresh, pathPos, levels, save, rng }
export function createListen(ctx) {
  const { doc, $, S, t, fmt, rnd, nm, say, part, lumiPlay, sayLumi, sfx, poke, sparkle, later, earnSticker, showReward, refresh, pathPos, levels, save, rng = Math.random } = ctx;
  const room = $('listenRoom'), html = doc.documentElement;
  let plan = null, idx = 0, over = false, gen = 0, advancing = false, talking = 0, idleT = 0, repeated = false;
  const idleMs = () => doc.defaultView.__leemosRescueMs || 3000;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const open = () => openWords(listenWords(levels()), pathPos());
  const canPlay = () => { const o = open(); return o.length >= MIN_OPEN && robotTargets(o).length >= MIN_OPEN; };

  function leave() { gen++; talking++; clearTimeout(idleT); plan = null; room.hidden = true; room.innerHTML = ''; html.classList.remove('listen'); }

  function begin() {
    gen++;
    if (!canPlay()) { leave(); return false; }
    plan = makeSession(open(), rng);
    if (!plan.length) { leave(); return false; }
    idx = 0; over = false;
    html.classList.add('listen'); room.hidden = false; room.classList.toggle('upper', !!S.upper);
    screen(true);
    return true;
  }

  // The robot says the syllables one after the other with a pause. Each call starts a new sounding-out and cancels the one still running (`talking` is its token).
  async function sound(parts, robot) {
    const my = ++talking, g = gen;
    for (let i = 0; i < parts.length; i++) {
      if (my !== talking || g !== gen) return;
      robot.classList.add('say');
      await part(partKeys(parts[i]));
      robot.classList.remove('say');
      if (my !== talking || g !== gen) return;
      await new Promise((r) => later(r, GAP));
    }
  }

  function armIdle(robot, parts) { // 3 s with no tap: the robot says it once more (once per screen, nothing recorded)
    clearTimeout(idleT);
    if (repeated || advancing || over) return;
    const g = gen;
    idleT = later(() => { if (g !== gen || repeated || advancing || over) return; repeated = true; sound(parts, robot); }, idleMs());
  }

  function screen(first) {
    gen++; advancing = false; repeated = false; clearTimeout(idleT);
    const p = plan[idx];
    room.innerHTML = '';
    const dots = el('div', 'listen-dots'); dots.setAttribute('role', 'img'); dots.setAttribute('aria-label', t('listenGoal', { i: idx + 1, n: plan.length }));
    for (let i = 0; i < plan.length; i++) dots.appendChild(el('i', i < idx ? 'on' : ''));
    const robot = el('button', 'listen-robot', '🤖'); robot.setAttribute('aria-label', t('listenRobot'));
    const grid = el('div', 'listen-cards');
    p.cards.forEach((w) => {
      const b = el('button', 'listen-card', w.emoji);
      b.dataset.w = w.text; b.dataset.parts = w.parts.join('-'); b.dataset.answer = String(w === p.target);
      b.onclick = () => tap(b, w, p, robot);
      grid.appendChild(b);
    });
    room.append(dots, robot, grid);
    $('hint').textContent = t('listenIntro');
    robot.onclick = () => { sound(p.target.parts, robot); armIdle(robot, p.target.parts); };
    if (first && S.sound) lumiPlay(t('listenIntro'), false); // only a clip: without one it is silent
    sound(p.target.parts, robot);
    armIdle(robot, p.target.parts);
  }

  function tap(b, w, p, robot) {
    if (!plan || over || advancing || b.classList.contains('found')) return;
    armIdle(robot, p.target.parts);
    if (w === p.target) {
      advancing = true; clearTimeout(idleT); talking++;
      b.classList.add('found'); sfx.ok(); say(w.text); poke('cheer', 900); sparkle(b, 10);
      $('hint').textContent = fmt(rnd(t('oks')));
      const g = gen;
      later(() => { if (g !== gen) return; idx++; idx < plan.length ? screen(false) : finishSession(); }, 1600);
    } else {
      b.classList.add('wobble'); later(() => b.classList.remove('wobble'), 500);
    }
  }

  function finishSession() {
    over = true; clearTimeout(idleT);
    const reward = earnSticker(); save(); refresh();
    const msg = t('listenDone', { n: nm() });
    room.innerHTML = '';
    const again = el('button', 'btn primary', t('listenAgain')); again.id = 'listenAgain'; again.onclick = () => begin();
    room.append(el('p', 'listen-done', msg), again);
    $('hint').textContent = msg;
    if (reward) later(() => showReward(reward), 500);
    else { again.focus(); sfx.win(); if (S.sound) sayLumi(msg); }
  }

  $('rewardOk').addEventListener('click', () => { if (!over) return; const g = gen; later(() => { const a = $('listenAgain'); if (g === gen && a) a.focus(); }, 0); }); // the reward closes: focus goes to "again"

  return { canPlay, begin, leave, active: () => !!plan, intro: 'listenIntro' };
}
```

- [ ] **Step 4: Run** `node tests/smoke.mjs > /tmp/smoke.txt 2>&1; grep FAIL /tmp/smoke.txt` → empty, then `node tests/listen.mjs`, `node tests/close.mjs`, `node tests/sw.mjs`, `node tests/merge.mjs`. Fix any harness-name mismatch in the new test block (the selectors above are the contract; adjust the test, not the markup).

- [ ] **Step 5: Audio, docs, commit.** Run `node scripts/generate-audio.mjs --provider azure --dry-run` and confirm the only new clip is the `listenIntro` phrase in both languages, then `node scripts/generate-audio.mjs --provider azure` (no `--kind`). Update `CLAUDE.md` (a bullet "Escucha / Escolta" next to Cierra, file-table rows for `src/listen.js` and `tests/listen.mjs`, the `GAMEDEF` note, `sw.js` v23). Then

```bash
git add -A
git commit -m "feat(listen): the robot sounds a word out and she picks the picture (fifth play mode)"
```
Ask Fran before pushing.

---

## Part C: minimal pairs

### Task C1: Pair data, validation, spec fix

**Files:**
- Create: `src/data/pairs.es.json`, `src/data/pairs.ca.json`
- Modify: `src/listen.js` (add `validPair`, `openPairs`)
- Modify: `docs/superpowers/specs/2026-10-21-listen-mode-design.md` (section 3 pair examples)
- Test: `tests/listen.mjs`

**Interfaces:**
- Consumes: `splitClosed`, `stepOf`.
- Produces (for C3): `validPair(p) → string[]` (problems; empty when valid); `openPairs(pairs, pos) → [{id, a, b}]` where `a`/`b` are `{text, parts, emoji, step}`.

Pair rule (replaces the spec's examples): `b` has exactly one closed syllable `x` (`splitClosed`), and replacing `x` with its `base` in `b.parts` gives exactly `a.parts` (*pas-ta* → *pa-ta*; *pala/palma* and *sala/salsa* are NOT pairs).

Initial data (Spanish): `pa-ta 🐾 / pas-ta 🍝`, `ca-pa 🦸 / car-pa 🎪`, `da-do 🎲 / dar-do 🎯`. Catalan: `ca-pa 🦸 / car-pa 🎪` only. Fran supplies more (the plan does not invent words he has not seen); Catalan needs a native check.

- [ ] **Step 1: Failing test** — append to `tests/listen.mjs` before the summary line (and add `validPair, openPairs` to the import at the top):

```js
check('validPair: pata/pasta is a pair; pala/palma and sala/salsa are not (no coda to drop)', validPair({ a: 'pa-ta', ea: '🐾', b: 'pas-ta', eb: '🍝' }).length === 0 && validPair({ a: 'pa-la', ea: '🪏', b: 'pal-ma', eb: '🌴' }).length > 0 && validPair({ a: 'sa-la', ea: '🏠', b: 'sal-sa', eb: '🥫' }).length > 0);
check('validPair: same picture twice, a missing picture, or a trill/geminate coda is rejected', validPair({ a: 'pa-ta', ea: '🐾', b: 'pas-ta', eb: '🐾' }).length > 0 && validPair({ a: 'pa-ta', ea: '', b: 'pas-ta', eb: '🍝' }).length > 0 && validPair({ a: 'go-ro', ea: '🧢', b: 'gor-ro', eb: '👒' }).length > 0);
for (const lang of ['es', 'ca']) {
  const pairs = readJSON(`src/data/pairs.${lang}.json`);
  check(`[${lang}] pairs file: every pair is valid`, Array.isArray(pairs) && pairs.length >= 1 && pairs.every((p) => validPair(p).length === 0), pairs.map((p) => validPair(p).join(';')).join('|'));
  check(`[${lang}] openPairs: none open at step 1, all of them at step 12`, openPairs(pairs, 1).length === 0 && openPairs(pairs, 12).length === pairs.length);
}
```

- [ ] **Step 2: Run** `node tests/listen.mjs` → FAIL (`validPair` not exported).

- [ ] **Step 3: Implement** — create the two JSON files:

`src/data/pairs.es.json`:
```json
[
  { "a": "pa-ta", "ea": "🐾", "b": "pas-ta", "eb": "🍝" },
  { "a": "ca-pa", "ea": "🦸", "b": "car-pa", "eb": "🎪" },
  { "a": "da-do", "ea": "🎲", "b": "dar-do", "eb": "🎯" }
]
```
`src/data/pairs.ca.json`:
```json
[
  { "a": "ca-pa", "ea": "🦸", "b": "car-pa", "eb": "🎪" }
]
```
Append to `src/listen.js`:

```js
// The problems of a pair {a, ea, b, eb} (hyphenated words and their pictures); an empty list means it can be used.
export function validPair(p) {
  const bad = [];
  const a = String(p.a || '').toLowerCase().split('-'), b = String(p.b || '').toLowerCase().split('-');
  if (!p.ea || !p.eb) bad.push('missing picture');
  if (p.ea && p.ea === p.eb) bad.push('same picture');
  const closed = b.filter((x) => splitClosed(x));
  if (closed.length !== 1) bad.push('b needs exactly one closed syllable');
  else {
    const c = splitClosed(closed[0]), i = b.indexOf(closed[0]);
    if (b[i + 1] && b[i + 1][0] === c.coda) bad.push('coda starts a trill or geminate');
    if (b.map((x, j) => (j === i ? c.base : x)).join('-') !== a.join('-')) bad.push('removing the coda does not give a');
  }
  return bad;
}

// Pairs whose two words are both open at Camino step `pos`, as {id, a, b} with a = the open twin.
export function openPairs(pairs, pos) {
  const mk = (h, e) => { const parts = h.toLowerCase().split('-'); return { text: parts.join(''), parts, emoji: e, step: stepOf(parts.join('-')) }; };
  return pairs.filter((p) => validPair(p).length === 0).map((p) => ({ id: p.a, a: mk(p.a, p.ea), b: mk(p.b, p.eb) })).filter((p) => p.a.step <= pos && p.b.step <= pos);
}
```
Edit spec section 3: replace the candidate sentence with the rule above and the starting pairs; state that the list grows only with words Fran has approved.

- [ ] **Step 4: Run** `node tests/listen.mjs` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/data/pairs.es.json src/data/pairs.ca.json src/listen.js tests/listen.mjs docs/superpowers/specs/2026-10-21-listen-mode-design.md
git commit -m "feat(listen): minimal-pair data with a rule that checks the coda"
```

### Task C2: Clips for the pair words

**Files:**
- Modify: `scripts/lib/clips.mjs` (pair words and syllables after the stretched-clips block; `i18n.listenPairHint` into the phrase array)
- Modify: `src/data/i18n.es.json`, `src/data/i18n.ca.json` (`listenPairHint`)
- Modify: `tests/listen.mjs` (clip coverage check)

**Interfaces:**
- Consumes: Task C1 pairs files.
- Produces: every pair word (full text, `word` kind) and each syllable (`syllable` kind) in the clip list; the `listenPairHint` phrase clip.

`listenPairHint`: "Lee la palabra y toca su dibujo." / "Llegeix la paraula i toca el seu dibuix."

- [ ] **Step 1: Failing test** — append to `tests/listen.mjs` (import `buildClipList` from `../scripts/lib/clips.mjs` at the top):

```js
for (const lang of ['es', 'ca']) {
  const keys = new Set(buildClipList({ langs: [lang] }).map((c) => c.key));
  const need = readJSON(`src/data/pairs.${lang}.json`).flatMap((p) => [p.a, p.b]).flatMap((h) => [h.replace(/-/g, ''), ...h.split('-')]);
  check(`[${lang}] clip list: every pair word and syllable has a clip`, need.every((k) => keys.has(k.toLowerCase())), need.filter((k) => !keys.has(k.toLowerCase())).join(','));
  const i18n = readJSON(`src/data/i18n.${lang}.json`);
  check(`[${lang}] clip list: Lumi's listen sentences are clips`, ['listenIntro', 'listenPairHint'].every((k) => i18n[k] && keys.has(i18n[k].toLowerCase())));
}
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — in `scripts/lib/clips.mjs`, after the stretched-clips `forEach`:

```js
    for (const p of readJSON(`src/data/pairs.${lang}.json`)) {
      for (const h of [p.a, p.b]) { add(lang, h.split('-').join(''), 'word'); h.split('-').forEach((s) => add(lang, s, 'syllable')); }
    }
```
and add `i18n.listenPairHint` to the phrase array. Add the key to both i18n files.

- [ ] **Step 4: Run** `node tests/listen.mjs` → pass; `node tests/close.mjs` still passes (clip counts).

- [ ] **Step 5: Generate and commit.** `node scripts/generate-audio.mjs --provider azure --dry-run` — expect only the new words, syllables and the phrase (skip-existing keeps the rest); then run without `--dry-run` (no `--kind`). The new clips must be listened to in `/tools/review.html` (Fran decides; the Catalan ones need a native). Commit:

```bash
git add scripts/lib/clips.mjs src/data/i18n.es.json src/data/i18n.ca.json tests/listen.mjs audio
git commit -m "feat(listen): clips for the pair words and Lumi's pair sentence"
```

### Task C3: Pair screen, session mix, data loading

**Files:**
- Modify: `src/listen.js` (`makePair`, `makeSession` signature, pair screen in `createListen`)
- Modify: `src/app.js` (`loadGame` data store `GDATA`; `GAMEDEF.listen.data='pairs'`; Cierra keeps `data:'closed'`)
- Modify: `src/styles.css` (pair rules), `sw.js` (both pairs files in `SHELL`; VERSION `leemos-v24`), `tests/close.mjs` (assert v24)
- Modify: `CLAUDE.md`
- Test: `tests/listen.mjs`, `tests/smoke.mjs` block 45

**Interfaces:**
- Consumes: C1 `openPairs`; B3 `createListen`; ctx `data()` returning the loaded JSON for the current language.
- Produces: `makePair(pairs, rng, exclude) → {kind:'pair', pair, printed, cards:[a,b], answer}|null`; `makeSession(words, rng, pairs = [])` (4 robot + 2 pair, pairs last; 6 robot when fewer than 2 open pairs).

Data store change (`app.js`): replace the shared `CLOSED` store by `const GDATA={}; // <data>.<lang>.json of each play mode, by game name`; in `loadGame` write `(GDATA[name]=GDATA[name]||{})[l]=d`; the ctx gets `data:()=>(GDATA[name]||{})[S.lang]`. Replace every other use of `CLOSED` (grep it: the ctx getter is the only reader).

- [ ] **Step 1: Failing tests** — `tests/listen.mjs` (add `makePair` to the import):

```js
{
  const pairs = openPairs(readJSON('src/data/pairs.es.json'), 12);
  const words = openWords(listenWords(readJSON('src/data/levels.es.json')), 12);
  let ok = true;
  for (let s = 1; s <= 100 && ok; s++) { const r = makePair(pairs, mulberry(s), new Set()); ok = !!r && r.cards.length === 2 && r.cards.every((c) => c.emoji) && r.cards[0].emoji !== r.cards[1].emoji && r.cards.some((c) => c.text === r.printed.text) && r.answer.text === r.printed.text; }
  check('makePair: two pictures, one of them is the printed word, never the same picture', ok);
  const sides = new Set(); for (let s = 1; s <= 60; s++) sides.add(makePair(pairs, mulberry(s), new Set()).cards[0].text);
  check('makePair: which twin is printed and which side it is on both vary', sides.size > 1);
  check('makePair: null when every pair is excluded', makePair(pairs, mulberry(1), new Set(pairs.map((p) => p.id))) === null);
  const full = makeSession(words, mulberry(2), pairs);
  check('makeSession: with 2+ open pairs, 4 robot then 2 pair screens (distinct pairs)', full.length === 6 && full.slice(0, 4).every((s) => s.kind === 'robot') && full.slice(4).every((s) => s.kind === 'pair') && new Set(full.slice(4).map((s) => s.pair.id)).size === 2);
  check('makeSession: with fewer than 2 open pairs, all robot', makeSession(words, mulberry(2), pairs.slice(0, 1)).every((s) => s.kind === 'robot') && makeSession(words, mulberry(2)).every((s) => s.kind === 'robot'));
}
```
and in `tests/smoke.mjs` block 45: a Spanish session at `pathEs: 12` ends with 2 pair screens (`.listen-word` visible, 2 cards, the printed word in the DOM, the card of the printed word has `data-answer="true"`); a wrong pair tap wobbles, a right tap says the word and advances; at `pathEs: 3` (no pair open: *pasta* needs S and R) all 6 screens are robot; Catalan at `pathCa: 12` with its single pair is robot-only; a language whose pairs data fails to load still plays 6 robot screens.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — `src/listen.js`:

```js
// One pair screen: a pair not in `exclude`, one twin printed at random, the two pictures in random order. null when no pair is free.
export function makePair(pairs, rng, exclude = new Set()) {
  const free = pairs.filter((p) => !exclude.has(p.id));
  if (!free.length) return null;
  const pair = free[Math.floor(rng() * free.length)];
  const printed = rng() < 0.5 ? pair.a : pair.b;
  return { kind: 'pair', pair, printed, cards: shuffle([pair.a, pair.b], rng), answer: printed };
}
```
and replace `makeSession` with:

```js
// 4 robot screens then 2 pair screens (6 robot when fewer than 2 pairs are open). Targets and pairs are distinct.
export function makeSession(words, rng, pairs = []) {
  const nPairs = pairs.length >= 2 ? 2 : 0, used = new Set(), screens = [];
  while (screens.length < SCREENS - nPairs) {
    const r = makeRobot(words, rng, used);
    if (!r) break;
    used.add(r.target.text); screens.push(r);
  }
  const usedPairs = new Set();
  for (let i = 0; i < nPairs; i++) {
    const q = makePair(pairs, rng, usedPairs);
    if (!q) break;
    usedPairs.add(q.pair.id); screens.push(q);
  }
  return screens;
}
```
In `createListen`: add `data` to the ctx destructure and doc comment; `const pairs = () => openPairs(Array.isArray(data()) ? data() : [], pathPos());`; `begin()` calls `makeSession(open(), rng, pairs())` and resets `pairHinted = false` (declare `let pairHinted = false;` with the other state). In `screen()`, right after the dots are built: `if (p.kind === 'pair') { room.append(dots); pairScreen(p); return; }`. Add:

```js
  function pairScreen(p) {
    const word = el('div', 'listen-word', p.printed.text);
    const grid = el('div', 'listen-cards two');
    p.cards.forEach((w) => {
      const b = el('button', 'listen-card', w.emoji);
      b.dataset.w = w.text; b.dataset.answer = String(w === p.answer);
      b.onclick = () => {
        if (!plan || over || advancing || b.classList.contains('found')) return;
        if (w === p.answer) {
          advancing = true; b.classList.add('found'); sfx.ok(); say(p.printed.text); poke('cheer', 900); sparkle(b, 10);
          $('hint').textContent = fmt(rnd(t('oks')));
          const g = gen; later(() => { if (g !== gen) return; idx++; idx < plan.length ? screen(false) : finishSession(); }, 1600);
        } else { b.classList.add('wobble'); later(() => b.classList.remove('wobble'), 500); }
      };
      grid.appendChild(b);
    });
    room.append(word, grid);
    $('hint').textContent = t('listenPairHint');
    if (S.sound && !pairHinted) { pairHinted = true; lumiPlay(t('listenPairHint'), false); } // only a clip: without one it is silent
  }
```
`canPlay` is unchanged: pairs are optional. CSS: `.listen-word{font-size:3rem;font-weight:700;letter-spacing:.02em}`, `.listen-room.upper .listen-word{text-transform:uppercase}`, `.listen-cards.two{grid-template-columns:repeat(2,1fr)}`.

Data wiring: `GAMEDEF.listen` gets `data:'pairs'`; `loadGame` change as described (a missing file for a language leaves `data()` undefined → robot only). `sw.js`: both pairs files in `SHELL`, VERSION `leemos-v24`, `tests/close.mjs` assertion `leemos-v24`.

- [ ] **Step 4: Run** `node tests/smoke.mjs > /tmp/smoke.txt 2>&1; grep FAIL /tmp/smoke.txt`, then `npm test > /tmp/all.txt 2>&1; grep -c FAIL /tmp/all.txt` → 0 failures.

- [ ] **Step 5: Docs and commit.** Update `CLAUDE.md` (pairs, rule, `GDATA`, v24) and the spec status line to "implemented". Commit:

```bash
git add -A
git commit -m "feat(listen): minimal-pair screens (read the word, pick the picture) after the robot screens"
```
Ask Fran before pushing; after the push `curl -s https://franrx.github.io/leemos/sw.js | grep VERSION` must show `leemos-v24`, and the new clips need a listen in `/tools/review.html`.

---

## Self-review notes

- **Spec coverage:** structure and `GAMEDEF` (B3), robot logic and screen (B1, B3), `partSound` sequencing with stretched fallback (B2), idle repeat and robot tap (B3), pairs data and rule (C1), clips and phrases (B3, C2), pair screen and session mix (C3), robot-only fallback (C3), mute (B2 `partSound` plus the mute test in B3), Leo excluded (B3 test), `PREF` acceptance (B3 `merge.js`), `sw.js` and docs (B3, C3).
- **Spec deviations (to confirm with Fran):** *pala/palma* and *sala/salsa* are dropped; the pair list starts at 3 Spanish pairs and 1 Catalan pair, so Catalan pair screens will rarely open until more pairs are approved. The spec's "fewer than 4 open words" lock is implemented through `canPlay` (4 open words and 4 robot targets).
- **Known risk:** test code in block 45 assumes the harness helpers used by block 44 (`boot`, `until`, `sleep`, `audioCalls`, the app-source variable); adjust the test code to the harness, not the markup.
