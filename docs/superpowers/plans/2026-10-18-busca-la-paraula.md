# "Busca la paraula" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third reader mode where Elsa finds the 3 copies of a target word among 12 look-alike words of the current Camino letter, 5 pages per game, with a sticker at the end.

**Architecture:** `src/find.js` (new) holds the pure tile choice (`pool`, `similarity`, `makePage`, `makeGame`) and `createFind(ctx)`, the game screen. `app.js` loads it with `import()` the first time it is needed (same pattern as `sounds.js`), adds the `#mFind` button and routes `next()` to the game while `S.mode === 'find'`. The game never touches stats, `S.total` or the session counters; it only calls `earnSticker()` once per finished game.

**Tech Stack:** vanilla JS ES modules, jsdom smoke tests (`tests/smoke.mjs`), plain-Node unit tests, no build.

**Spec:** `docs/superpowers/specs/2026-10-18-busca-la-paraula-design.md`

## Global Constraints

- No frameworks, no bundler, no new dependency. `app.js` has no `import` statements (it is evaluated as text by the smoke test); use `import()` through `window.__leemosImport || (p => import(p))`.
- Colours as tokens in `:root` with the dark variant; touch targets ≥ 44 px; focus visible; `prefers-reduced-motion` turns off the wobble and any transition.
- New interface text: key in `src/data/i18n.es.json` **and** `src/data/i18n.ca.json` (a test checks identical keys), `data-i="key"` in HTML or `t('key')` in JS.
- Feedback is always kind: a wrong tap is a soft silent wobble, never a punishment sound.
- Lumi speaks only from a clip or a recording, never the browser voice, **except** `sayLumi` for praise (existing behaviour). Never run `--kind phrase --force` (it regenerates the approved clips); generate the new phrase with a plain `npm run audio -- --provider azure`.
- If you change the `SHELL` list in `sw.js`, bump `VERSION` (`leemos-v5` → `leemos-v6`).
- The game never changes `S.stats`, `S.total`, `S.progress`, the session counters (`sDone`, `sOk`, `sStk`) or the stored `S.level`; the only saved change a finished game makes is the sticker (`earnSticker()`).
- Commits end with:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS`.
- Work on a branch `feature/busca-la-paraula` cut from `main`; merge and push only when Fran asks.

## Review Focus

1. A pool of exactly 10 words (target + 9) must still make a page, and 9 must refuse (guard), not crash or loop.
2. The last Camino step (12, "el resto") has no single letter: each page draws one of the 11 book letters; a saved `pathEs`/`pathCa` of 12 must never index past `STEPS`.
3. A stale or offline client: `src/find.js` fails to load (offline before the service worker cached it, or `levelrule.js` stub). The mode button must say "locked" and leave the saved `S.mode` alone; no blank stage.
4. A synced `mode: 'find'` arriving on a device that has not loaded the module: the device must load it and start the game, not show a normal exercise forever; and with the module unavailable must fall back to syllables without changing the preference.
5. Tapping fast: double taps on one copy, taps during the 1.1 s pause after the third copy, a tap on a look-alike after a copy was found; none may count twice, skip a page or give a second sticker.
6. Leaving mid-game (mode, language, profile, pull) must cancel the pending "next page" timer so it cannot start a page on the wrong screen.

---

### Task 1: Pure tile choice (`src/find.js` part 1) and its tests

**Files:**
- Create: `src/find.js`
- Create: `tests/find.mjs`
- Modify: `package.json` (add `node tests/find.mjs` to the `test` script, after `node tests/levels.mjs`)

**Interfaces:**
- Consumes: `letterOf(word: string): string` and `STEPS: string[]` (12 entries, last is `'*'`) from `src/levelrule.js`.
- Produces (named exports of `src/find.js`): `COPIES = 3`, `OTHERS = 9`, `PAGES = 5`, `BOOK` (the first 11 of `STEPS`), `wordsOf(levels): {text, parts}[]` (all words of all levels; `text` lower-case without hyphens, `parts` the lower-case syllables), `pool(words, letter): {text, parts}[]` (distinct by `text`, first grapheme equals `letter`), `editDistance(a, b): number`, `similarity(a, b): number[]` (tuple compared lexicographically, higher = closer), `shuffle(arr, rng): array` (copy), `makePage(words, rng, exclude = new Set()): {target, tiles} | null` (`tiles` = 12 × `{id, text, parts, copy}`), `makeGame(getPool, rng, n = PAGES): page[]`.

- [ ] **Step 1: Write the failing tests**

Create `tests/find.mjs`:

```js
// Unit tests for the pure part of "Busca la paraula" (src/find.js). Plain Node, no DOM.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COPIES, OTHERS, PAGES, BOOK, wordsOf, pool, editDistance, similarity, shuffle, makePage, makeGame } from '../src/find.js';
import { STEPS } from '../src/levelrule.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const W = (s) => ({ text: s.replace(/-/g, ''), parts: s.split('-') });

check('constants: 3 copies, 9 others, 5 pages, 11 book letters, 12 Camino steps', COPIES === 3 && OTHERS === 9 && PAGES === 5 && BOOK.join('') === 'mplntsfbdrc' && STEPS.length === 12);
check('editDistance: identical 0, one substitution 1, insertion 1, empty to word = its length', editDistance('mano', 'mano') === 0 && editDistance('mano', 'mono') === 1 && editDistance('mano', 'manos') === 1 && editDistance('', 'casa') === 4);

const SYN = ['ma-no', 'ma-pa', 'ma-ta', 'me-sa', 'mo-no', 'mi-ra', 'mu-la', 'ma-le-ta', 'mo-ne-da', 'ma-ri-po-sa', 'me-lo-co-tón', 'mu-ñe-ca'].map(W);
const onlyMano = new Set(SYN.map((w) => w.text).filter((x) => x !== 'mano')); // forces the target
const pg = makePage(SYN, mulberry(1), onlyMano);
const texts = pg.tiles.map((x) => x.text);
check('page: 12 tiles, exactly 3 copies of the target and 9 other distinct words', pg.tiles.length === 12 && pg.target.text === 'mano' && texts.filter((x) => x === 'mano').length === 3 && new Set(texts.filter((x) => x !== 'mano')).size === 9);
check('page: only the copies are flagged as copies, and every tile has a different id', pg.tiles.every((x) => x.copy === (x.text === 'mano')) && new Set(pg.tiles.map((x) => x.id)).size === 12);
check('page: the closest words are chosen (same first syllable and length first) and the farthest is left out', ['mapa', 'mata', 'mono'].every((x) => texts.includes(x)) && !texts.includes('melocotón'));
const a1 = JSON.stringify(makePage(SYN, mulberry(5)));
check('page: the same seed gives the same page', a1 === JSON.stringify(makePage(SYN, mulberry(5))));
check('page: a different seed shuffles the tiles differently', JSON.stringify(makePage(SYN, mulberry(5)).tiles.map((x) => x.text)) !== JSON.stringify(makePage(SYN, mulberry(6)).tiles.map((x) => x.text)));
check('page: a pool of exactly 10 still makes a page', makePage(SYN.slice(0, 10), mulberry(2)) !== null);
check('page: a pool of 9 is refused', makePage(SYN.slice(0, 9), mulberry(2)) === null);
check('page: a target already used is not drawn again, and with none left there is no page', makePage(SYN.slice(0, 10), mulberry(2), new Set(SYN.slice(0, 10).map((x) => x.text))) === null);
check('similarity: a word sharing the first syllable ranks above one that does not', similarity(W('ma-no'), W('ma-pa'))[0] > similarity(W('ma-no'), W('mo-no'))[0]);

let calls = 0;
const game = makeGame(() => { calls++; return SYN.slice(0, 12); }, mulberry(3));
check('game: 5 pages with 5 different targets, the pool asked once per page', game.length === 5 && new Set(game.map((p) => p.target.text)).size === 5 && calls === 5);
check('game: a pool that cannot make a page gives an empty game', makeGame(() => SYN.slice(0, 9), mulberry(3)).length === 0);
check('shuffle: keeps the same items and does not touch the input', (() => { const a = [1, 2, 3, 4, 5]; const s = shuffle(a, mulberry(1)); return a.join() === '1,2,3,4,5' && s.slice().sort().join() === '1,2,3,4,5'; })());

// the real data, both languages, every letter of the book
for (const lang of ['es', 'ca']) {
  const words = wordsOf(readJSON(`src/data/levels.${lang}.json`));
  const bad = [];
  for (const L of BOOK) {
    const p = pool(words, L);
    if (p.length < 10) { bad.push(`${L}: pool ${p.length}`); continue; }
    if (new Set(p.map((x) => x.text)).size !== p.length) bad.push(`${L}: duplicates in the pool`);
    for (let seed = 1; seed <= 20; seed++) {
      const g = makePage(p, mulberry(seed));
      const xs = g.tiles.map((x) => x.text);
      if (g.tiles.length !== 12 || xs.filter((x) => x === g.target.text).length !== 3 || new Set(xs).size !== 10) bad.push(`${L}/${seed}: wrong shape`);
      if (!g.tiles.every((x) => p.some((q) => q.text === x.text))) bad.push(`${L}/${seed}: a tile is not from the pool`);
    }
  }
  check(`[${lang}] every book letter has a pool of at least 10 and makes valid pages`, bad.length === 0, bad.slice(0, 3).join(' | '));
  check(`[${lang}] a pool holds only words that start with its letter`, pool(words, 'm').every((x) => x.text[0] === 'm') && pool(words, 'p').every((x) => x.text[0] === 'p'));
}

console.log(failures ? `\n${failures} find test(s) FAILED` : '\nAll find tests passed');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/find.mjs`
Expected: FAIL at import: `Cannot find module '.../src/find.js'` (exit 1).

- [ ] **Step 3: Implement the pure part**

Create `src/find.js`:

```js
// "Busca la paraula": the pure choice of the tiles and (below) the game screen.
// Spec: docs/superpowers/specs/2026-10-18-busca-la-paraula-design.md
import { letterOf, STEPS } from './levelrule.js';

export const COPIES = 3, OTHERS = 9, PAGES = 5;
export const BOOK = STEPS.slice(0, 11); // the 11 letters of the school book (the last step, "el resto", has no letter)

export const wordsOf = (levels) => levels.flatMap((l) => l.words.map((o) => ({ text: o.w.replace(/-/g, '').toLowerCase(), parts: o.w.toLowerCase().split('-') })));

// Every word that starts with `letter`, from every level, once per text. The Camino's "open" filter is not applied: finding a copy is matching, not decoding.
export function pool(words, letter) {
  const seen = new Set(), out = [];
  for (const w of words) {
    if (letterOf(w.text) !== letter || seen.has(w.text)) continue;
    seen.add(w.text); out.push(w);
  }
  return out;
}

export function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// Higher = easier to confuse with `a`. Compared lexicographically: same first syllable, same length, then the fewest letter differences.
export const similarity = (a, b) => [a.parts[0] === b.parts[0] ? 1 : 0, a.text.length === b.text.length ? 1 : 0, -editDistance(a.text, b.text)];
const closer = (x, y) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; };

export function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// One page: a target not in `exclude` and the 9 closest other words, as 12 shuffled tiles (3 copies of the target). null when the pool is too small or has no free target.
export function makePage(words, rng, exclude = new Set()) {
  if (words.length < OTHERS + 1) return null;
  const free = words.filter((w) => !exclude.has(w.text));
  if (!free.length) return null;
  const target = free[Math.floor(rng() * free.length)];
  const others = shuffle(words.filter((w) => w.text !== target.text), rng) // the shuffle breaks ties between equally close words
    .map((w) => ({ w, s: similarity(target, w) })).sort((a, b) => closer(a.s, b.s)).slice(0, OTHERS).map((x) => x.w);
  const tiles = shuffle([...Array(COPIES).fill(target), ...others], rng).map((w, i) => ({ id: i, text: w.text, parts: w.parts, copy: w.text === target.text }));
  return { target, tiles };
}

// getPool(rng) is asked once per page (the last Camino step draws a different letter each time). Pages with a target already used are skipped by `exclude`.
export function makeGame(getPool, rng, n = PAGES) {
  const used = new Set(), pages = [];
  for (let i = 0; i < n; i++) {
    const p = makePage(getPool(rng), rng, used);
    if (!p) break;
    used.add(p.target.text); pages.push(p);
  }
  return pages;
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `node tests/find.mjs`
Expected: all lines PASS, `All find tests passed`.

- [ ] **Step 5: Mutation-check the guarantees**

For each, edit `src/find.js` (restore from `cp src/find.js /tmp/find.bak` after), run `node tests/find.mjs`, expect at least one FAIL:
- `COPIES` loop: change `Array(COPIES)` to `Array(COPIES - 1)` (copies).
- `slice(0, OTHERS)` → `slice(0, OTHERS - 1)` (9 others).
- remove `.filter((w) => w.text !== target.text)` (target among the others).
- change `closer` to `x[i] - y[i]` (farthest chosen instead of closest).
- remove `seen.has(w.text)` in `pool` (duplicates).
- change `words.length < OTHERS + 1` to `words.length < OTHERS` (pool of 9 accepted).

- [ ] **Step 6: Add to the test chain, run everything, commit**

Edit `package.json`: in `"test"`, insert `node tests/find.mjs && ` right after `node tests/levels.mjs && `.

Run: `git checkout -b feature/busca-la-paraula && npm test > /tmp/t1.log 2>&1; tail -2 /tmp/t1.log`
Expected: ends with the last suite's "All ... passed" and no line starting `FAIL`.

```bash
git add src/find.js tests/find.mjs package.json
git commit -m "feat(find): pure tile choice for Busca la paraula (pool, similarity, pages, game)"
```

---

### Task 2: Plumbing: sync value, text, audio phrase, service worker

**Files:**
- Modify: `src/merge.js:40` (`PREF_OK.mode`)
- Modify: `tests/merge.mjs` (the `bad` and `ok` preference cases around lines 96-101)
- Modify: `src/data/i18n.es.json`, `src/data/i18n.ca.json`
- Modify: `scripts/lib/clips.mjs:44`
- Modify: `tests/azure.mjs` (phrase lists at lines ~65 and ~74)
- Modify: `sw.js` (`VERSION`, `SHELL`)
- Modify: `tests/find.mjs` (service worker check)

**Interfaces:**
- Consumes: nothing from Task 1 except that `src/find.js` exists.
- Produces: i18n keys `mFind`, `findLocked`, `findIntro`, `findGoal` (`{i}`, `{n}`), `findAgain`, `findDone` (`{n}`), `findHear`; the phrase clip text for `findIntro`; `mode: 'find'` accepted by the merge; `src/find.js` in the service worker shell.

- [ ] **Step 1: Write the failing tests**

In `tests/merge.mjs`, find the `ok` object (line ~101, `mode: pf('word', 1)`) and add a separate check right after the existing `ok` checks:

```js
  const findPref = mergeData({ prefs: { mode: pf('find', 1) } }, { prefs: {} });
  check('prefs: mode "find" (Busca la paraula) is a valid synced value', findPref.prefs.mode && findPref.prefs.mode.v === 'find');
```

Use the same `mergeData(a, b)` argument order and result shape that the neighbouring `ok` check uses (read the 6 lines above it and copy their call form exactly). The existing `bad` case (`mode: pf('x', 9)`) already proves an invalid value is still dropped.

In `tests/find.mjs` append before the final `console.log`:

```js
const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
check('service worker: src/find.js is cached with the shell and the version was bumped', /'src\/find\.js'/.test(sw) && /VERSION = 'leemos-v6'/.test(sw));
const es = readJSON('src/data/i18n.es.json'), ca = readJSON('src/data/i18n.ca.json');
const KEYS = ['mFind', 'findLocked', 'findIntro', 'findGoal', 'findAgain', 'findDone', 'findHear'];
check('i18n: every Busca la paraula key exists in both languages and is not empty', KEYS.every((k) => typeof es[k] === 'string' && es[k] && typeof ca[k] === 'string' && ca[k]));
```

In `tests/azure.mjs` add `'findIntro'` to both lists `['hintSyl', 'hintWord', 'hintWhole', 'hintJudge']` (lines ~65 and ~74) and extend the test names' wording only if they list the keys.

- [ ] **Step 2: Run and watch them fail**

Run: `node tests/merge.mjs; node tests/find.mjs; node tests/azure.mjs`
Expected: FAIL in `merge` ("mode find"), `find` (service worker, i18n) and `azure` (findIntro missing).

- [ ] **Step 3: Implement**

`src/merge.js:40`: `mode: (v) => v === 'syl' || v === 'word' || v === 'find',`

`src/data/i18n.es.json` (add near `mWord`/`wordsLocked`):
```json
  "mFind": "Busca",
  "findLocked": "Busca la palabra se abre cuando hay palabras suficientes de la letra.",
  "findIntro": "Busca la palabra y toca las 3 copias.",
  "findGoal": "Página {i} de {n}",
  "findAgain": "Otra partida",
  "findDone": "¡Muy bien, {n}! Has encontrado todas las palabras.",
  "findHear": "Escuchar la palabra",
```
`src/data/i18n.ca.json`:
```json
  "mFind": "Busca",
  "findLocked": "Busca la paraula s'obre quan hi ha prou paraules de la lletra.",
  "findIntro": "Busca la paraula i toca les 3 còpies.",
  "findGoal": "Pàgina {i} de {n}",
  "findAgain": "Una altra partida",
  "findDone": "Molt bé, {n}! Has trobat totes les paraules.",
  "findHear": "Escoltar la paraula",
```
`scripts/lib/clips.mjs:44`: add `i18n.findIntro` after `i18n.hintJudge` in the list.

`sw.js`: `const VERSION = 'leemos-v6';` and add `'src/find.js'` after `'src/sounds.js'` in `SHELL`.

- [ ] **Step 4: Run and see them pass**

Run: `node tests/merge.mjs && node tests/find.mjs && node tests/azure.mjs && node tests/sw.mjs`
Expected: all pass. (`azure.mjs` may also fail a "manifest/disk guard" for the new phrase until the clip exists: it is generated in Task 4; if that guard fails now, note it and continue, do not weaken it.)

- [ ] **Step 5: Commit**

```bash
git add src/merge.js tests/merge.mjs tests/find.mjs tests/azure.mjs src/data/i18n.es.json src/data/i18n.ca.json scripts/lib/clips.mjs sw.js
git commit -m "feat(find): sync value, texts, instruction phrase in the clip list, service worker shell"
```

---

### Task 3: The game screen and its wiring

**Files:**
- Modify: `src/find.js` (append `createFind`)
- Modify: `index.html` (button `#mFind`; `#findRoom` after `#pre`)
- Modify: `src/styles.css`
- Modify: `src/app.js` (state, `loadFind`, `next()`, `renderMode`, button, init)
- Modify: `tests/smoke.mjs` (new section 43 before the final `console.log`)

**Interfaces:**
- Consumes: Task 1 exports; i18n keys from Task 2; from `app.js`: `$`, `S`, `t`, `fmt`, `rnd`, `nm`, `say(text)`, `lumiPlay(text, big): boolean`, `sayLumi(text)`, `sfx.ok()`, `sfx.win()`, `poke(name, ms)`, `sparkleBurst(el, n)`, `earnSticker(): string|null`, `showReward(emoji)`, `save()`, `pathPos()`, `LEVELS`, `renderLevels()`, `renderHard()`, `renderAlbum()`.
- Produces: `createFind(ctx): {canPlay(): boolean, begin(): boolean, leave(): void, active(): boolean}`; DOM: `#findRoom`, `.find-dots`, `.find-target`, `.find-grid`, `.find-tile` (`.found`, `.wobble`), `.find-done`, `#findAgain`; class `find` on `<html>` while a game is on screen.

- [ ] **Step 1: Write the failing smoke tests**

Append to `tests/smoke.mjs` before the final `console.log(failures ? ...`:

```js
// ---------- 43. Busca la paraula: find the 3 copies among 12 look-alikes ----------
{
  const R = (extra = {}) => ({ 'leemos-v1': { name: 'Elsa', pathEs: 3, pathCa: 12, world: 0, ...extra } });
  const room = (x) => x.$('findRoom');
  const tiles = (x) => [...x.d.querySelectorAll('.find-tile')];
  const target = (x) => x.d.querySelector('.find-target').textContent;
  const copies = (x) => tiles(x).filter((b) => b.textContent === target(x));
  const others = (x) => tiles(x).filter((b) => b.textContent !== target(x));
  const saved = (x) => JSON.parse(x.w.localStorage.getItem('leemos-v1'));
  const start = async (extra, opts = {}) => { const x = await boot({ storage: R(extra), ...opts }); x.w.__audioMode = 'auto'; x.$('mFind').click(); await until(() => !room(x).hidden); return x; };

  let x = await start();
  check('find: the third mode button exists and a tap opens the game', !!x.$('mFind') && !room(x).hidden && x.d.documentElement.classList.contains('find') && x.$('mFind').getAttribute('aria-pressed') === 'true');
  check('find: a page has 12 tiles, 3 copies of the target, and 5 dots', tiles(x).length === 12 && copies(x).length === 3 && x.d.querySelectorAll('.find-dots i').length === 5);
  check('find: the target is a word of the current letter M (Camino step 3 = letters m p l)', /^[mpl]/.test(target(x)));
  check('find: the saved preference is the mode', saved(x).mode === 'find');
  const before = JSON.stringify({ s: saved(x).stats, t: saved(x).total, p: saved(x).progress, lv: saved(x).level, m: saved(x).modAt, sess: saved(x).session });
  const tts0 = (x.w.__tts || []).length;
  others(x)[0].click();
  check('find: a wrong tap wobbles, says nothing and counts nothing', others(x)[0].classList.contains('wobble') && (x.w.__tts || []).length === tts0 && x.w.__plays === (x.w.__plays || 0) && JSON.stringify({ s: saved(x).stats, t: saved(x).total, p: saved(x).progress, lv: saved(x).level, m: saved(x).modAt, sess: saved(x).session }) === before);
  const c = copies(x);
  c[0].click();
  check('find: a copy lights up and is read aloud', c[0].classList.contains('found') && (x.w.__tts || []).length > tts0);
  const tts1 = (x.w.__tts || []).length;
  c[0].click();
  check('find: tapping a found copy again does nothing', (x.w.__tts || []).length === tts1 && x.d.querySelectorAll('.find-tile.found').length === 1);
  c[1].click(); c[2].click();
  check('find: after the third copy a tap on a look-alike does not wobble (the page is closing)', (() => { others(x)[0].click(); return !others(x)[0].classList.contains('wobble'); })());
  await sleep(20);
  check('find: the next page starts by itself with a new target and one dot filled', x.d.querySelectorAll('.find-dots i.on').length === 1 && tiles(x).length === 12);
  check('find: no sticker and no session progress before the end', (saved(x).stickers | 0) === 0 && (saved(x).session.done | 0) === 0);
  for (let p = 1; p < 5; p++) { copies(x).forEach((b) => b.click()); await sleep(20); }
  check('find: after 5 pages the game ends with a sticker, the reward and the again button', saved(x).stickers === 1 && !x.$('reward').hidden && !!x.$('findAgain') && tiles(x).length === 0);
  check('find: the whole game left the stats, total and the session untouched', JSON.stringify(saved(x).stats || {}) === '{}' && !saved(x).total && (saved(x).session.done | 0) === 0);
  x.$('rewardOk').click(); x.$('findAgain').click(); await sleep(10);
  check('find: again starts a new game from page 1', tiles(x).length === 12 && x.d.querySelectorAll('.find-dots i.on').length === 0 && saved(x).stickers === 1);
  check('find: the whole run raised no errors', x.errors.length === 0, x.errors.join(' | '));

  // leaving mid-game gives nothing and cancels the pending page
  x = await start();
  copies(x).forEach((b) => b.click());
  x.$('mSyl').click(); await sleep(30);
  check('find: changing mode mid-game closes it, no sticker, and the stale page timer does not reopen it', room(x).hidden && !x.d.documentElement.classList.contains('find') && (saved(x).stickers | 0) === 0 && x.d.querySelectorAll('.find-tile').length === 0 && saved(x).mode === 'syl');

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
  check('find (ca): works in Catalan with the current letter', tiles(x).length === 12 && /^[mp]/.test(target(x)));

  // a pool that is too small: locked, preference untouched
  x = await boot({ storage: R(), levelsPatch: (d) => d.map((l) => ({ ...l, words: l.words.slice(0, 3) })) });
  x.$('mFind').click(); await sleep(30);
  check('find: with too few words the button says so and the saved mode does not change', room(x).hidden && x.$('hint').textContent === 'Busca la palabra se abre cuando hay palabras suficientes de la letra.' && (saved(x).mode || 'syl') === 'syl');

  // the module cannot load (offline): locked, normal exercises, preference untouched
  x = await boot({ storage: R({ mode: 'find' }), importFails: true });
  await sleep(30);
  check('find: if the module cannot load the app still shows a normal exercise and keeps the saved mode', room(x).hidden && x.d.querySelectorAll('.tile').length > 0 && saved(x).mode === 'find');

  // Leo never sees the mode
  x = await bootLeo();
  check('find: Leo has no Busca button on screen (the modes row is hidden for him)', x.d.documentElement.classList.contains('pre'));
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `node tests/smoke.mjs > /tmp/s43.log 2>&1; grep -c '^FAIL' /tmp/s43.log; grep '^FAIL' /tmp/s43.log | head -5`
Expected: several `FAIL  find: ...` lines (no `#mFind`), earlier sections still PASS.

- [ ] **Step 3: Add the game screen to `src/find.js`**

Append:

```js
// The screen. ctx: { doc, $, S, t, fmt, rnd, nm, say, lumiPlay, sayLumi, sfx, poke, sparkle, later, earnSticker, showReward, refresh, pathPos, levels, save, rng }
export function createFind(ctx) {
  const { doc, $, S, t, fmt, rnd, nm, say, lumiPlay, sayLumi, sfx, poke, sparkle, later, earnSticker, showReward, refresh, pathPos, levels, save, rng = Math.random } = ctx;
  const room = $('findRoom'), html = doc.documentElement;
  let game = null, page = 0, found = 0, over = false, gen = 0; // gen: a pending "next page" from a game that was left must not act
  const letters = () => (pathPos() >= 12 ? BOOK : [STEPS[pathPos() - 1]]);
  const canPlay = () => { const w = wordsOf(levels()); return letters().every((l) => pool(w, l).length > OTHERS); };
  const getPool = (r) => pool(wordsOf(levels()), pathPos() >= 12 ? BOOK[Math.floor(r() * BOOK.length)] : STEPS[pathPos() - 1]);
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  function leave() { gen++; game = null; room.hidden = true; room.innerHTML = ''; html.classList.remove('find'); }

  function begin() {
    gen++;
    if (!canPlay()) { leave(); return false; }
    game = makeGame(getPool, rng); page = 0; over = false;
    if (!game.length) { leave(); return false; }
    html.classList.add('find'); room.hidden = false; room.classList.toggle('upper', !!S.upper);
    render(true);
    return true;
  }

  function render(first) {
    found = 0;
    const p = game[page];
    room.innerHTML = '';
    const dots = el('div', 'find-dots'); dots.setAttribute('role', 'img'); dots.setAttribute('aria-label', t('findGoal', { i: page + 1, n: game.length }));
    for (let i = 0; i < game.length; i++) dots.appendChild(el('i', i < page ? 'on' : ''));
    const target = el('button', 'find-target', p.target.text); target.setAttribute('aria-label', t('findHear')); target.onclick = () => say(p.target.text);
    const grid = el('div', 'find-grid');
    p.tiles.forEach((tile) => { const b = el('button', 'find-tile', tile.text); b.onclick = () => tap(b, tile); grid.appendChild(b); });
    room.append(dots, target, grid);
    $('hint').textContent = t('findIntro');
    if (first && S.sound) lumiPlay(t('findIntro'), false); // only a clip: without one it is silent
  }

  function tap(b, tile) {
    if (!game || over || found >= 3 || b.classList.contains('found')) return;
    if (tile.copy) {
      b.classList.add('found'); b.setAttribute('aria-pressed', 'true');
      sfx.ok(); say(tile.text); found++;
      if (found === 3) {
        const g = gen;
        poke('cheer', 900); sparkle(b, 10);
        $('hint').textContent = fmt(rnd(t('oks')));
        later(() => { if (g !== gen) return; page++; page < game.length ? render(false) : finish(); }, 1100);
      }
    } else {
      b.classList.add('wobble'); later(() => b.classList.remove('wobble'), 500);
    }
  }

  function finish() {
    over = true;
    const reward = earnSticker(); save(); refresh();
    const msg = t('findDone', { n: nm() });
    room.innerHTML = '';
    const again = el('button', 'btn primary', t('findAgain')); again.id = 'findAgain'; again.onclick = () => begin();
    room.append(el('p', 'find-done', msg), again);
    $('hint').textContent = msg;
    if (reward) later(() => showReward(reward), 500);
    else { sfx.win(); if (S.sound) sayLumi(msg); }
  }

  return { canPlay, begin, leave, active: () => !!game };
}
```

Note the explicit `found >= 3` and `over` guards: they are what stop a second count and a second sticker.

- [ ] **Step 4: Markup, styles, wiring**

`index.html`: add after the `#mWord` button:
```html
    <button class="mode" id="mFind" data-i="mFind" aria-pressed="false">Busca</button>
```
and after `<div class="pre-room" id="pre" hidden></div>`:
```html
    <div class="find-room" id="findRoom" hidden></div>
```

`src/styles.css` (append before the `prefers-reduced-motion` block, and add the reduced-motion line inside it):
```css
/* Busca la paraula */
html.find .session,html.find #goal,html.find #tiles,html.find #pic,html.find #stage .actions{display:none!important}
.find-room{display:flex;flex-direction:column;align-items:center;gap:16px;width:100%}
.find-dots{display:flex;gap:7px}
.find-dots i{width:16px;height:16px;border-radius:50%;background:color-mix(in srgb,var(--ink) 14%,transparent)}
.find-dots i.on{background:var(--c1)}
.find-target{font:inherit;font-size:clamp(40px,11vw,72px);font-weight:700;color:var(--ink);background:var(--panel);border:3px solid var(--c2);border-radius:18px;padding:6px 28px;min-height:64px;cursor:pointer}
.find-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;width:100%;max-width:560px}
.find-tile{font:inherit;font-size:clamp(20px,5.2vw,32px);font-weight:600;color:var(--ink);background:var(--panel);border:2px solid var(--line);border-radius:14px;min-height:56px;padding:10px 6px;cursor:pointer;touch-action:manipulation}
.find-tile:focus-visible,.find-target:focus-visible{outline:3px solid var(--c2);outline-offset:2px}
.find-tile.found{background:var(--ok);border-color:var(--ok);color:#fff}
.find-tile.wobble{animation:findWobble .4s ease-in-out}
.find-room.upper .find-tile,.find-room.upper .find-target{text-transform:uppercase}
.find-done{font-size:1.3rem;font-weight:700;text-align:center}
@keyframes findWobble{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}
```
Inside the existing `@media (prefers-reduced-motion: reduce){` block add: `.find-tile.wobble{animation:none}`.

`src/app.js`:
1. Next to `let pre=null;` (line ~131) add: `let find=null,findP=null; // Busca la paraula (src/find.js), loaded the first time it is needed`
2. After `renderMode` (line ~909), add `loadFind`:
```js
// Loads src/find.js on first use; a failure leaves find null (the mode then says "locked" and the saved preference is kept).
function loadFind(){
  if(find)return Promise.resolve(find);
  return findP||(findP=(async()=>{
    try{
      const imp=window.__leemosImport||(p=>import(p));
      const mod=await imp('./find.js');
      find=mod.createFind({doc:document,$,S,t,fmt,rnd,nm,say,lumiPlay,sayLumi,sfx,poke,sparkle:sparkleBurst,later:(f,ms)=>setTimeout(f,ms),
        earnSticker,showReward,refresh:()=>{renderLevels();renderHard();renderAlbum()},pathPos,levels:()=>LEVELS,save});
      return find;
    }catch(e){findP=null;return null}
  })());
}
$('mFind').onclick=async()=>{
  const f=await loadFind();
  if(!f||!f.canPlay()){$('hint').textContent=t('findLocked');return}
  S.mode='find';save();renderMode();next();
};
```
3. `renderMode`: replace its body's first line and the two pressed lines with:
```js
  const m=effMode(),ok=openItems('word').length>=MIN_WORDS,fo=!!(find&&S.mode==='find'&&find.canPlay());
  $('mSyl').setAttribute('aria-pressed',!fo&&m==='syl');$('mWord').setAttribute('aria-pressed',!fo&&m==='word');$('mFind').setAttribute('aria-pressed',fo);
```
(keep the following `mWord` aria-disabled/dim/title line unchanged).
4. `next()`: insert as the first lines:
```js
  if(S.mode==='find'){
    if(find&&find.canPlay()){find.begin();return}
    if(!find&&!findP)loadFind().then(f=>{if(f&&S.mode==='find')next()}); // a synced "find" on a device that has not loaded it yet
  }
  if(find)find.leave();
```
5. Before the line `renderGoal();next();` (line ~1173): `if(S.mode==='find')await loadFind();`

- [ ] **Step 5: Run and see them pass**

Run: `node tests/smoke.mjs > /tmp/s43.log 2>&1; grep -c '^FAIL' /tmp/s43.log; tail -2 /tmp/s43.log`
Expected: `0` and `All tests passed`.

If a check in section 43 fails because of a harness detail (for example `x.w.__tts` holds objects instead of arrays, or a timer runs earlier than the test expects), fix the test's observation, not the production guard, and say what changed in the commit message.

- [ ] **Step 6: Mutation-check each guarantee**

Edit, run `node tests/smoke.mjs | grep '^FAIL'`, expect a FAIL, restore from a `.bak` copy:
- `tap`: delete `found >= 3 ||` (taps during the pause).
- `tap`: delete `|| b.classList.contains('found')` (copy counted twice).
- `finish`: call `earnSticker()` at `found === 3` of every page (sticker early).
- `finish`: add `S.total++` (stats touched).
- `leave`: remove `gen++` (stale page timer).
- `tap` wrong branch: add `sfx.retry()` (punishment sound; the sfx mock must record it or the audio call count check must catch it: if no assertion fails, add one).
- `next()`: remove `if(find)find.leave();` (the game stays open when the mode changes).

- [ ] **Step 7: Full suite and commit**

Run: `npm test > /tmp/t3.log 2>&1; tail -2 /tmp/t3.log; grep -c '^FAIL' /tmp/t3.log`
Expected: ends with a passing suite line and `0`.

```bash
git add src/find.js index.html src/styles.css src/app.js tests/smoke.mjs
git commit -m "feat(find): Busca la paraula game screen, mode button and wiring"
```

---

### Task 4: Audio clip, docs, spec sync, final review

**Files:**
- Modify: `audio/manifest.json` + 2 new mp3 (generated)
- Modify: `CLAUDE.md`, `README.md`
- Modify: `docs/superpowers/specs/2026-10-18-busca-la-paraula-design.md`

**Interfaces:**
- Consumes: `i18n.findIntro` in the clip list (Task 2).
- Produces: the clips for `findIntro` in `es` and `ca`; documentation.

- [ ] **Step 1: See what would be generated**

Run: `npm run audio:plan 2>&1 | tail -5`
Expected: exactly the 2 `findIntro` phrases are missing. If more than 2 clips would be generated, stop and tell Fran: something else changed.

- [ ] **Step 2: Generate only the missing clips**

Run: `npm run audio -- --provider azure 2>&1 | tail -6` (plain run: never `--kind phrase --force`).
Expected: 2 generated (one per language), manifest updated. If there is no Azure key in the environment, say so and leave the clip for Fran (`tests/azure.mjs` guard will name the two missing files); do not weaken the guard.

- [ ] **Step 3: Check nothing else in `audio/` changed**

Run: `git status --short audio | head; git diff --stat audio/manifest.json | tail -2`
Expected: 2 new mp3 files and only added lines in the manifest.

- [ ] **Step 4: Docs and spec sync**

`CLAUDE.md` (Pedagogía section, after the Camino bullet): one bullet "**Busca la paraula**" with: third mode `S.mode==='find'`, 5 pages of 12 tiles (3 copies + 9 look-alikes) of the words starting with the Camino's current letter (not filtered by open letters; on step 12 a random book letter per page), right copy lights up and is read aloud, wrong tap is a silent wobble, no effect on stats/total/session, sticker per finished game, `src/find.js` loaded with `import()`, spec path, `findIntro` clip. Add `src/find.js` and `tests/find.mjs` to the architecture list. `README.md`: one line in the features list.

Spec corrections (the code facts found while planning): in section 3 replace "Validation in `app.js` (`S.mode`) and `PREF_OK.mode` in `merge.js` accept `find`" with "`PREF_OK.mode` in `merge.js` accepts `find` (`app.js` has no validation of `S.mode`; an unknown value already behaves as syllables)"; replace "the button is dimmed" with "the button says it is locked when tapped (it cannot be dimmed beforehand because the module is only loaded on first use)"; in the Goal/decisions table add that a finished game's sticker changes `modAt` like any sticker, and the stats, total and session do not.

- [ ] **Step 5: Full suite**

Run: `npm test > /tmp/t4.log 2>&1; tail -2 /tmp/t4.log; grep -c '^FAIL' /tmp/t4.log`
Expected: passing, `0`.

- [ ] **Step 6: Commit**

```bash
git add audio CLAUDE.md README.md docs/superpowers/specs/2026-10-18-busca-la-paraula-design.md
git commit -m "feat(find): instruction clip, docs and spec sync for Busca la paraula"
```

- [ ] **Step 7: Real-browser check (Fran's habit: not only jsdom)**

With `npm run dev` already running on 127.0.0.1:5173, open the page in Chrome, clear site data first, tap Busca, play one full game in Spanish and one page in Catalan, check: 12 tiles fit a phone width (390 px) without horizontal scroll, the wobble is soft, the copy is read aloud, the sticker appears at the end, and game mode (full screen) still shows only the game. Report what you saw; leave the tabs closed after.

- [ ] **Step 8: Final whole-branch review**

Dispatch one fresh reviewer on the most capable model over `git diff main...HEAD`, giving it the spec, this plan, and the Review Focus list verbatim. Fix Critical and Important findings with a test that fails first; list Minor ones for Fran. Then stop: merging and pushing wait for Fran.
