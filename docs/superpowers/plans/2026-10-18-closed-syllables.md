# Closed syllables ("Cierra" / "Tanca") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fourth reader mode where Elsa builds closed syllables as "2 + 1" (CV base, then the s/r/l coda docks on, with a stretched sound), peeks at a covered coda, and builds 2-syllable words with the first syllable held as an anchor chip; a 3-second rescue never lets her stall; 6 screens per session and a sticker at the end.

**Architecture:** `src/close.js` holds the pure part (splitting a syllable into base + coda, which words qualify, the open syllables and words per Camino step, the session plan) and `createClose(ctx)`, the screen. `app.js` loads it with `import()` the first time it is needed. Because Busca la paraula already works this way, Task 3 first generalises that wiring into one registry used by both games (behaviour-preserving, the existing Busca tests are the safety net). A new `stretch` clip kind (key `~<syllable>`) carries the stretched audio.

**Tech Stack:** vanilla JS ES modules, jsdom smoke tests (`tests/smoke.mjs`), plain-Node unit tests, Azure SSML for audio, no build.

**Spec:** `docs/superpowers/specs/2026-10-18-closed-syllables-design.md`

## Global Constraints

- No frameworks, no bundler, no new dependency. `app.js` has no `import` statements; use `import()` through `window.__leemosImport || (p => import(p))`.
- Colours as tokens in `:root` with the dark variant; touch targets ≥ 44 px; focus visible; `prefers-reduced-motion` makes the slide, flip and arc growth instant.
- New interface text: key in `src/data/i18n.es.json` **and** `src/data/i18n.ca.json` (a test checks identical keys); the Catalan uses "síl·laba".
- Feedback is always kind: no error sound, no cross, no "try again"; the rescue is never recorded.
- Lumi speaks only from a clip or a recording, never the browser voice: stretched and phrase clips go through `lumiPlay` (silent without a clip). The base CV sound uses the existing `say()` as the syllable modes do.
- The mode never changes `S.stats`, `S.total`, `S.progress`, the session counters (`sDone`, `sOk`, `sStk`) or `S.level`; the only saved change a finished session makes is the sticker (`earnSticker()`).
- Never run `--kind phrase --force`. Generate audio with a plain `npm run audio -- --provider azure` (only missing clips). `--kind stretch --force` is allowed for the stretch clips only, and only when a recipe is being changed on purpose.
- If you change the `SHELL` list in `sw.js`, bump `VERSION`.
- Commits end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS`.
- Work on a branch `feature/closed-syllables` cut from `main`; merge and push only when Fran asks. Fran must listen to the generated stretch clips (`npm run dev`, `/tools/review.html`): nobody else can judge them. The final message says so.
- Tests that use timers: the smoke harness runs any `setTimeout` of 100–4000 ms immediately (as a microtask). Tests of this mode set `window.__leemosRescueMs = 9000` (a real timer that never fires) except the rescue tests, which set `150` (fires at the next `await`).

## Review Focus

1. A syllable that is open in `closed.<lang>.json` but whose base CV (`pa` for `pas`) has no syllable clip in the clip list: the base sound would fall back to the browser voice. A test must pin it.
2. Camino steps 1–2 (no coda letter open) must lock the mode; step 3 must open it with only the L coda; a saved `pathEs`/`pathCa` of 0, 13, NaN or a string must never crash `stepOf`/`pathPos` use.
3. A synced `mode: 'close'` arriving on a device where `close.js` or the closed data is not loaded, fails to load, stalls, or the pool is locked: fall back to a normal exercise without changing the preference; never an infinite loop or a blank stage.
4. Fast taps: double tap on the coda tile or "?" card, taps on the base during the pause, a tap on "Juntar" twice, taps while the screen is advancing — nothing may count twice, skip a screen or give a second sticker.
5. The rescue fires once per step, never after the step is done, never in the pause between screens, and a tap resets it; leaving the mode (or changing language/Camino) cancels every pending timer, including the rescue and the advance timer.
6. Stray `next()` calls (word-style change, stale reading timer, "Borrar progreso") must not restart a session; language and Camino changes (also pulled by sync) must.
7. Both modes (Busca and Cierra) active together: only one of them on screen at a time; the shared wiring (hints, Aa, `next`, `setPath`, sync pull) must treat both identically; Leo never sees either.
8. The stretched clip key `~pas` must not collide with any other clip or break the manifest, the review page, `saveClip`, or `recordList` (the key contains `~`).

---

### Task 1: Data and the pure logic (`src/close.js` part 1) with its tests

**Files:**
- Create: `src/data/closed.es.json`, `src/data/closed.ca.json`
- Create: `src/close.js`
- Create: `tests/close.mjs`
- Modify: `package.json` (add `node tests/close.mjs` to `test`, after `node tests/find.mjs`)

**Interfaces:**
- Consumes: `stepOf(text: string): number` from `src/levelrule.js` (works on a syllable or a hyphenated word; `pas` → 6, `pul-po` → 3); `buildClipList` from `scripts/lib/clips.mjs` (tests only).
- Produces (named exports of `src/close.js`): `CODAS = ['s','r','l']`, `MIN_SYL = 6`, `SCREENS = 6`, `splitClosed(part): {base, coda, onset, vowel} | null`, `qualifies(parts: string[]): boolean`, `wordsFrom(levels): {text, parts, emoji, step}[]` (deduplicated by `text`, only words with an emoji), `openSyllables(bank: string[], pos: number): {syl, base, coda}[]`, `openWords(words, pos): word[]`, `planSession(syls, words, rng): screen[]` where a screen is `{kind:'syl', syl, base, coda, peek: boolean}` or `{kind:'word', w: word}`.

- [ ] **Step 1: Write the failing tests**

Create `tests/close.mjs`:

```js
// Unit tests for the pure part of the closed-syllables mode (src/close.js). Plain Node, no DOM.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODAS, MIN_SYL, SCREENS, splitClosed, qualifies, wordsFrom, openSyllables, openWords, planSession } from '../src/close.js';
import { stepOf } from '../src/levelrule.js';
import { buildClipList } from '../scripts/lib/clips.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

check('constants: codas s r l, at least 6 syllables to play, 6 screens', CODAS.join('') === 'srl' && MIN_SYL === 6 && SCREENS === 6);
const sp = (s) => { const r = splitClosed(s); return r && `${r.base}+${r.coda}`; };
check('splitClosed: a CVC syllable gives its CV base and its coda', sp('pas') === 'pa+s' && sp('sol') === 'so+l' && sp('bar') === 'ba+r' && sp('tras') === 'tra+s' && sp('quar') === 'qua+r');
check('splitClosed: open syllables, no onset, and other codas are not closed syllables of this mode', ['pa', 'ar', 'ál', 'pan', 'tam', 'el', 'a', ''].every((s) => splitClosed(s) === null));
check('qualifies: exactly 2 syllables, exactly one closed, onset + vowel + s/r/l', qualifies(['pul', 'po']) && qualifies(['car', 'pa']) && qualifies(['ho', 'tel']) && qualifies(['fa', 'nal']) && qualifies(['mos', 'ca']));
check('qualifies: not a closing n/m, not without onset, not two closed, not 1 or 3 syllables', !qualifies(['tam', 'bor']) && !qualifies(['ár', 'bol']) && !qualifies(['del', 'fín']) && !qualifies(['dor', 'mir']) && !qualifies(['pa', 'ta']) && !qualifies(['sol']) && !qualifies(['pas', 'te', 'la']));

for (const lang of ['es', 'ca']) {
  const levels = readJSON(`src/data/levels.${lang}.json`);
  const words = wordsFrom(levels);
  const texts = words.map((w) => w.text);
  check(`[${lang}] wordsFrom: only qualifying words with a picture, once each, with their Camino step`, words.length > 0 && new Set(texts).size === texts.length && words.every((w) => w.emoji && qualifies(w.parts) && w.step === stepOf(w.parts.join('-'))));
  check(`[${lang}] wordsFrom: the examples of the spec are in and the excluded ones are out`, (lang === 'es' ? ['pulpo', 'carpa', 'barco'] : ['fanal', 'fusta', 'mosca']).every((x) => texts.includes(x)) && !texts.includes('tambor') && !texts.includes('cantar'));

  const bank = readJSON(`src/data/closed.${lang}.json`).syl;
  const bad = [];
  const clips = buildClipList({ langs: [lang] });
  bank.forEach((s) => {
    const r = splitClosed(s);
    if (!r) { bad.push(`${s}: not closed`); return; }
    if (!CODAS.includes(r.coda)) bad.push(`${s}: coda`);
    if (!clips.some((c) => c.kind === 'syllable' && c.key === r.base)) bad.push(`${s}: no clip for the base "${r.base}"`);
  });
  check(`[${lang}] the bank: ${bank.length} distinct CVC syllables, each with an existing clip for its CV base`, bank.length >= 30 && new Set(bank).size === bank.length && bad.length === 0, bad.slice(0, 4).join(' | '));
  const perStep = Array.from({ length: 12 }, (_, i) => openSyllables(bank, i + 1).length);
  check(`[${lang}] the bank: steps 1-2 lock the mode (no coda letter open), every step from 3 up has at least ${MIN_SYL} open`, perStep[0] < MIN_SYL && perStep[1] < MIN_SYL && perStep.slice(2).every((n) => n >= MIN_SYL), perStep.join(','));
  check(`[${lang}] the bank: step 3 only has the L coda`, openSyllables(bank, 3).every((x) => x.coda === 'l'));

  // sessions
  const problems = [];
  for (let pos = 3; pos <= 12; pos++) {
    const sy = openSyllables(bank, pos), wd = openWords(words, pos);
    for (let seed = 1; seed <= 60; seed++) {
      const plan = planSession(sy, wd, mulberry(seed * 7 + pos));
      const sylS = plan.filter((p) => p.kind === 'syl'), wordS = plan.filter((p) => p.kind === 'word');
      if (plan.length !== SCREENS) problems.push(`pos ${pos}: ${plan.length} screens`);
      if (wd.length >= 2 ? (wordS.length !== 2 || sylS.length !== 4) : (wordS.length !== 0 || sylS.length !== 6)) problems.push(`pos ${pos}: mix ${sylS.length}/${wordS.length}`);
      if (new Set(sylS.map((p) => p.syl)).size !== sylS.length || new Set(wordS.map((p) => p.w.text)).size !== wordS.length) problems.push(`pos ${pos}: repeat`);
      if (!plan.every((p, i) => (p.kind === 'syl') === (i < sylS.length))) problems.push(`pos ${pos}: order`);
      const half = sylS.length / 2;
      if (!sylS.every((p, i) => p.peek === (i >= half))) problems.push(`pos ${pos}: dock/peek split`);
      const codas = sylS.map((p) => p.coda), kinds = new Set(sy.map((x) => x.coda));
      if (kinds.size > 1 && codas.some((c, i) => i >= 2 && c === codas[i - 1] && c === codas[i - 2])) problems.push(`pos ${pos}: three same codas in a row`);
      if (!sylS.every((p) => sy.some((x) => x.syl === p.syl))) problems.push(`pos ${pos}: a syllable that is not open`);
    }
  }
  check(`[${lang}] planSession: 6 screens, 4 syllables + 2 words (or 6 syllables with fewer than 2 words), no repeats, dock first then peek, codas vary, only open items`, problems.length === 0, problems.slice(0, 3).join(' | '));
}
const es = readJSON('src/data/levels.es.json');
check('es: at step 3 only one qualifying word is open (pulpo), so the session is all syllables', openWords(wordsFrom(es), 3).map((w) => w.text).join() === 'pulpo');

console.log(failures ? `\n${failures} close test(s) FAILED` : '\nAll close tests passed');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/close.mjs`
Expected: FAIL at import: `Cannot find module '.../src/close.js'` (exit 1).

- [ ] **Step 3: Create the two bank files**

`src/data/closed.es.json` and `src/data/closed.ca.json` (same content; the two languages may diverge later):

```json
{
  "syl": [
    "mal", "mel", "mil", "mol", "mul", "pal", "pel", "pul", "tal", "sal", "sol", "bal",
    "mas", "mes", "mis", "pas", "pes", "pos", "tas", "tes", "nos", "nas", "los", "sus",
    "mar", "mor", "par", "per", "tor", "ter", "bar", "ber", "dar", "dor", "cor", "car"
  ]
}
```

- [ ] **Step 4: Implement the pure part**

Create `src/close.js`:

```js
// "Cierra / Tanca": closed syllables (CVC ending in s, r or l) built as 2 + 1, then words with the first syllable held as an anchor.
// Spec: docs/superpowers/specs/2026-10-18-closed-syllables-design.md
import { stepOf } from './levelrule.js';

export const CODAS = ['s', 'r', 'l'];
export const MIN_SYL = 6, SCREENS = 6;
const V = 'aeiouáéíóúàèòïü';
const CLOSED = new RegExp(`^([^${V}]+)([${V}]+)([srl])$`);
const ENDS_IN_VOWEL = new RegExp(`[${V}]$`);

// "pas" -> {onset: 'p', vowel: 'a', coda: 's', base: 'pa'}; anything else (open, no onset, another coda) -> null.
export function splitClosed(part) {
  const m = CLOSED.exec(String(part || ''));
  return m ? { onset: m[1], vowel: m[2], coda: m[3], base: m[1] + m[2] } : null;
}

// A word for a word screen: 2 syllables, exactly one of them closed, and that one is onset + vowel + s/r/l.
export function qualifies(parts) {
  if (!Array.isArray(parts) || parts.length !== 2) return false;
  const closed = parts.filter((p) => !ENDS_IN_VOWEL.test(p));
  return closed.length === 1 && !!splitClosed(closed[0]);
}

export function wordsFrom(levels) {
  const seen = new Set(), out = [];
  for (const L of levels) {
    for (const o of L.words) {
      const parts = o.w.toLowerCase().split('-'), text = parts.join('');
      if (!o.e || seen.has(text) || !qualifies(parts)) continue;
      seen.add(text);
      out.push({ text, parts, emoji: o.e, step: stepOf(parts.join('-')) });
    }
  }
  return out;
}

export const openSyllables = (bank, pos) => bank.filter((s) => stepOf(s) <= pos).map((s) => ({ syl: s, ...splitClosed(s) }));
export const openWords = (words, pos) => words.filter((w) => w.step <= pos);

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// n syllables, never the same coda three times in a row while another coda is available.
function pickVaried(list, n, rng) {
  const pool = shuffle(list, rng), out = [];
  while (out.length < n && pool.length) {
    const last = out.slice(-2).map((x) => x.coda);
    const ban = last.length === 2 && last[0] === last[1] ? last[0] : null;
    let i = pool.findIndex((x) => x.coda !== ban);
    if (i < 0) i = 0;
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

// 6 screens: 4 syllables then 2 words (6 syllables when fewer than 2 words are open). In the syllable screens the first half docks, the second half peeks.
export function planSession(syls, words, rng) {
  const nWords = words.length >= 2 ? 2 : 0, nSyl = SCREENS - nWords;
  const picked = pickVaried(syls, nSyl, rng);
  const screens = picked.map((s, i) => ({ kind: 'syl', syl: s.syl, base: s.base, coda: s.coda, peek: i >= picked.length / 2 }));
  shuffle(words, rng).slice(0, nWords).forEach((w) => screens.push({ kind: 'word', w }));
  return screens;
}
```

- [ ] **Step 5: Run the tests**

Run: `node tests/close.mjs`
Expected: all PASS, `All close tests passed`. If a bank syllable fails "no clip for the base", replace that syllable in both bank files by another syllable of the same coda whose base exists (the test names it); keep ≥ 30 and ≥ 6 open from step 3. If a spec example word is missing, read the failure and fix the data assumption, not the rule.

- [ ] **Step 6: Mutation-check**

Edit `src/close.js` (restore from `cp src/close.js /tmp/close.bak` after each), run `node tests/close.mjs`, expect at least one FAIL:
- remove `|| seen.has(text)` dedupe (duplicate words)
- `closed.length === 1` → `closed.length >= 1` (two closed accepted)
- `parts.length !== 2` → `parts.length < 2` (3-syllable accepted)
- `[srl]` → `[srln]` in `CLOSED` (other coda accepted)
- `i >= picked.length / 2` → `i > picked.length / 2` (wrong dock/peek split)
- remove the `ban` logic (`let i = pool.findIndex(...)` → `let i = 0`) (same coda three in a row)
- `nWords = words.length >= 2` → `>= 1` (a single word accepted)

- [ ] **Step 7: Chain the suite, run everything, commit**

Edit `package.json`: in `"test"`, insert `node tests/close.mjs && ` right after `node tests/find.mjs && `.

Run: `git checkout -b feature/closed-syllables && npm test > /tmp/c1.log 2>&1; tail -2 /tmp/c1.log; grep -c '^FAIL' /tmp/c1.log`
Expected: a passing last line and `0`.

```bash
git add src/close.js src/data/closed.es.json src/data/closed.ca.json tests/close.mjs package.json
git commit -m "feat(close): closed-syllable bank and the pure logic (split, qualify, open items, session plan)"
```

---

### Task 2: Audio and text plumbing: the `stretch` clip kind, record list, texts, sync value, service worker

**Files:**
- Modify: `scripts/lib/clips.mjs` (stretch clips, `closeIntro` phrase)
- Modify: `scripts/spoken.mjs` (the stretch recipe)
- Modify: `scripts/generate-audio.mjs` (the help line on line 9)
- Modify: `scripts/lib/clipstore.mjs` (`recordList`), `tools/record.js` (display of a stretch clip)
- Modify: `src/data/i18n.es.json`, `src/data/i18n.ca.json`
- Modify: `src/merge.js:40`, `sw.js`
- Modify: `tests/azure.mjs`, `tests/close.mjs`, `tests/find.mjs` (the version assertion), `tests/merge.mjs`, and `tests/clipstore.mjs` / `tests/record.mjs` if their counts change
- Create (generated): the stretch and `closeIntro` clips and manifest entries

**Interfaces:**
- Consumes: `closed.<lang>.json` (Task 1); `splitClosed` is NOT imported by the scripts (they repeat the one regex locally to stay independent of `src/`).
- Produces: clips `{kind:'stretch', key:'~pas', text:'pas', file: slug('~pas') + '.mp3'}` for every bank syllable in both languages; i18n keys `mClose`, `closeLocked`, `closeIntro`, `closeGoal` (`{i}`, `{n}`), `closeAgain`, `closeDone` (`{n}`), `closeCover`, `closeAnchor`, `closeAdd` (`{c}`); `mode: 'close'` accepted by the merge; `src/close.js` and the two data files in the service-worker shell, `VERSION` → `leemos-v7`; the recorder list contains the stretch clips (`shown: 'pas'`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/close.mjs` before the final `console.log` (it already imports `buildClipList`):

```js
import { spokenFor } from '../scripts/spoken.mjs';
import { recordList } from '../scripts/lib/clipstore.mjs';
for (const lang of ['es', 'ca']) {
  const bank = readJSON(`src/data/closed.${lang}.json`).syl;
  const clips = buildClipList({ langs: [lang] });
  const st = clips.filter((c) => c.kind === 'stretch');
  check(`[${lang}] clips: one stretch clip per bank syllable, keyed "~syllable" so it never collides with the normal clip`, st.length === bank.length && st.every((c) => c.key === '~' + c.text && c.file.startsWith('_7e')) && bank.every((s) => st.some((c) => c.text === s)) && !clips.some((c) => c.kind !== 'stretch' && c.key.startsWith('~')));
  check(`[${lang}] clips: the instruction closeIntro is in the phrase list`, clips.some((c) => c.kind === 'phrase' && c.text === readJSON(`src/data/i18n.${lang}.json`).closeIntro));
  const ssml = st.map((c) => spokenFor(c));
  check(`[${lang}] spoken: a stretch clip is SSML with a long vowel and a long coda, never the plain syllable`, ssml.every((s, i) => s.startsWith('<') && /<prosody/.test(s) && s !== st[i].text) && spokenFor(st.find((c) => c.text === 'pas')).includes('aa') && /s{2,}/.test(spokenFor(st.find((c) => c.text === 'pas'))));
  const rec = recordList({ lang }).filter((c) => c.kind === 'stretch');
  check(`[${lang}] record list: the stretch clips can be recorded, shown as the syllable`, rec.length === bank.length && rec.every((c) => c.key === '~' + c.shown));
}
const es18 = readJSON('src/data/i18n.es.json'), ca18 = readJSON('src/data/i18n.ca.json');
const CKEYS = ['mClose', 'closeLocked', 'closeIntro', 'closeGoal', 'closeAgain', 'closeDone', 'closeCover', 'closeAnchor', 'closeAdd'];
check('i18n: every closed-syllables key exists in both languages and is not empty', CKEYS.every((k) => typeof es18[k] === 'string' && es18[k] && typeof ca18[k] === 'string' && ca18[k]));
check('i18n: the Catalan instruction and the done text use "síl·laba" with the punt volat', /síl·laba/.test(ca18.closeIntro) && /síl·labes/.test(ca18.closeDone));
const swText = readFileSync(join(ROOT, 'sw.js'), 'utf8');
check('service worker: close.js and its data are cached with the shell and the version was bumped', /'src\/close\.js'/.test(swText) && /'src\/data\/closed\.es\.json'/.test(swText) && /'src\/data\/closed\.ca\.json'/.test(swText) && /VERSION = 'leemos-v7'/.test(swText));
```

In `tests/azure.mjs`: add `'closeIntro'` to both lists `['hintSyl', 'hintWord', 'hintWhole', 'hintJudge', 'findIntro']` (the phrase-list check and the manifest/disk check) and, in the disk/manifest block, add a second check: every bank syllable has its `~syllable` clip in `manifest.clips[lang]` and the file on disk (read the bank with `readFileSync`; name it `clips: every closed syllable has its stretched audio in the manifest and on disk`).

In `tests/find.mjs` change the service-worker assertion `/VERSION = 'leemos-v6'/` to `/VERSION = 'leemos-v\d+'/` (the version moves with every shell change; the find test only needs that one exists).

In `tests/merge.mjs` next to the `find` check add: `check('prefs: mode "close" (closed syllables) is a valid synced value', mergeData({ prefs: { mode: pf('close', 1) } }, {}).prefs.mode?.v === 'close');`

- [ ] **Step 2: Run and watch them fail**

Run: `node tests/close.mjs; node tests/azure.mjs; node tests/merge.mjs`
Expected: FAIL in each (no stretch clips, no `closeIntro`, no keys, `close` rejected).

- [ ] **Step 3: Implement**

`scripts/lib/clips.mjs`: inside the `for (const lang of langs)` loop after the levels loop, add (an inline push keeps `text` = the syllable and `key` = `~syllable`; `add()` would make them equal):

```js
    const closed = readJSON(`src/data/closed.${lang}.json`);
    closed.syl.forEach((s) => { const key = '~' + s; if (!out.has(lang + ':' + key)) out.set(lang + ':' + key, { lang, text: s, key, kind: 'stretch', file: slug(key) + '.mp3' }); });
```
and add `i18n.closeIntro` after `i18n.findIntro` in the phrase list.

`scripts/spoken.mjs`: in `spokenFor`, before `default`, add

```js
    case 'stretch': {
      // The CV base with a long vowel, then the coda held on (continuous, no stop): "pas" -> paaasss. The first recipe to listen to; per-clip fixes go in pronunciation.<lang>.json.
      const m = /^([^aeiouáéíóúàèòïü]+)([aeiouáéíóúàèòïü]+)([srl])$/.exec(clip.text);
      if (!m) return clip.text;
      return `<prosody rate="-35%">${m[1]}${m[2].repeat(3)}${m[3].repeat(3)}</prosody>`;
    }
```

`scripts/generate-audio.mjs` line 9: change `--kind phrase|word|syllable|sound` to `--kind phrase|word|syllable|sound|stretch`.

`scripts/lib/clipstore.mjs` `recordList`: add after the `words` entries (order: sounds, words, then stretch):

```js
    ...readJSON(`src/data/closed.${lang}.json`).syl.map((s) => entry('~' + s, 'stretch', { shown: s })),
```

`tools/record.js`: where it sets `$('big').textContent = c.text;` use `c.shown || c.text`; set the context line for a stretch clip: `c.kind === 'stretch' ? 'alarga la vocal y mantén la última letra, sin cortar: «' + c.shown + '» sonando como «paaas»' : …` (keep the existing sound/word branches); the status line that says `di «${c.text}»` uses `c.shown || c.text`.

i18n (add near `findDone`):

`es`: `"mClose": "Cierra"`, `"closeLocked": "Cierra se abre con la letra L."`, `"closeIntro": "Lee la sílaba en voz alta y toca para cerrarla."`, `"closeGoal": "Pantalla {i} de {n}"`, `"closeAgain": "Otra vez"`, `"closeDone": "¡Muy bien, {n}! Has cerrado todas las sílabas."`, `"closeCover": "Tapa: toca para ver la última letra"`, `"closeAnchor": "Escuchar otra vez"`, `"closeAdd": "Añadir {c}"`.
`ca`: `"mClose": "Tanca"`, `"closeLocked": "Tanca s'obre amb la lletra L."`, `"closeIntro": "Llegeix la síl·laba en veu alta i toca per tancar-la."`, `"closeGoal": "Pantalla {i} de {n}"`, `"closeAgain": "Una altra vegada"`, `"closeDone": "Molt bé, {n}! Has tancat totes les síl·labes."`, `"closeCover": "Tapa: toca per veure l'última lletra"`, `"closeAnchor": "Escoltar una altra vegada"`, `"closeAdd": "Afegir {c}"`.

`src/merge.js:40`: `mode: (v) => v === 'syl' || v === 'word' || v === 'find' || v === 'close',`

`sw.js`: `const VERSION = 'leemos-v7';` and add `'src/close.js'` after `'src/find.js'` and `'src/data/closed.es.json', 'src/data/closed.ca.json'` after `'src/data/sounds.ca.json'` in `SHELL`.

- [ ] **Step 4: Run the tests**

Run: `node tests/close.mjs && node tests/merge.mjs && node tests/find.mjs && node tests/sw.mjs && node tests/clipstore.mjs && node tests/record.mjs`
Expected: all pass. `clipstore`/`record` tests that count the recorder list may change by the number of stretch clips: read each failure; if a count assertion is only about letters/words, scope it to those kinds (`filter`), do not weaken it. `azure.mjs` fails the manifest/disk guard until Step 5.

- [ ] **Step 5: Generate the clips (only the missing ones)**

Run: `npm run audio:plan 2>&1 | tail -4`
Expected: exactly `2 × 36` stretch clips plus `2` `closeIntro` phrases to generate (74 clips); if the number is different, stop and report why.
Run: `npm run audio -- --provider azure 2>&1 | tail -5` (plain run: generates only missing files; never `--kind phrase --force`).
Expected: `Hecho: 74 generados, 0 con error`. Then `git status --short audio | wc -l` shows 74 new mp3 + the manifest; `git diff --numstat audio/manifest.json` shows only added lines (plus the comma/timestamp lines). If there is no Azure key in the environment, say so and leave Step 5 for Fran: the guard in `tests/azure.mjs` then names the missing files.

- [ ] **Step 6: Run the audio guard and commit**

Run: `node tests/azure.mjs`
Expected: pass.

```bash
git add scripts src/data/i18n.es.json src/data/i18n.ca.json src/merge.js sw.js tools/record.js tests audio
git commit -m "feat(close): stretch clip kind, record list, texts, sync value, service worker shell and the first generated clips"
```

- [ ] **Step 7: Mutation-check**

Restore after each: `clips.mjs` key `'~' + s` → `s` (collision: the key test must fail); `spoken.mjs` `.repeat(3)` → `.repeat(1)` on the vowel (the "aa" test must fail); remove `closeIntro` from the phrase list (azure test fails); `PREF_OK.mode` without `'close'` (merge test fails).

---

### Task 3: Generalise the game wiring in `app.js` (behaviour-preserving)

**Files:**
- Modify: `src/app.js` (the lines listed below), `src/find.js` (one return value)
- Modify: `tests/smoke.mjs` (one extra check in section 43, see Step 1)

**Interfaces:**
- Consumes: the existing Busca wiring (`find`, `findP`, `loadFind`, `$('mFind').onclick`, and the find-specific lines in `next`, `sayHint`, `introHint`, `renderMode`, `setPath`, `applyCase`, the sync-pull condition, and the boot line).
- Produces: `GAMEDEF` (`{find: {file, create, ms, lock}}` — Task 4 adds `close`), `G` (loaded modules by name), `GP` (pending loads by name), `isGame(m)`, `activeGame()`, `loadGame(name)`, `openGame(name)`; every game module exposes `canPlay()`, `begin()`, `leave()`, `active()` and an `intro` string (the i18n key of its instruction). Behaviour of Busca does not change.

- [ ] **Step 1: Pin today's behaviour with one extra test (it passes before and after)**

The existing Busca smoke section (43) already covers the game. Add to it, before the `// Leo never sees the mode` marker, one test that will keep guarding the refactor:

```js
  // the game wiring is generic: a saved game mode with the module unavailable keeps the mode and shows a normal exercise
  x = await boot({ storage: R({ mode: 'find' }), importFails: true });
  await sleep(30);
  check('find: (generic wiring) an unloadable game keeps the saved mode, the normal screen is shown, and no game class is on', saved(x).mode === 'find' && !x.d.documentElement.classList.contains('find') && x.d.querySelectorAll('.tile').length > 0);
```
Run `node tests/smoke.mjs` → all pass (it describes existing behaviour).

- [ ] **Step 2: Refactor**

In `src/app.js` make exactly these replacements (read each line first; the text below is the current text):

1. Line `let find=null,findP=null; // Busca la paraula (src/find.js), loaded the first time it is needed` →
```js
const GAMEDEF={find:{file:'find.js',create:'createFind',ms:'__leemosFindTimeout',lock:'findLocked'}}; // play modes loaded the first time they are used
const G={},GP={}; // loaded modules and pending loads, by game name
const activeGame=()=>Object.values(G).find(g=>g&&g.active())||null;
const isGame=m=>Object.prototype.hasOwnProperty.call(GAMEDEF,m);
```
2. `sayHint`: replace `if(find&&find.active())return lumiPlay(t('findIntro'),big); // …` with
```js
  const ag=activeGame();
  if(ag)return lumiPlay(t(ag.intro),big); // in a play mode the phase left over from a reading exercise must not pick the sentence
```
3. `introHint`: replace `if(S.mode==='find'&&(find?find.canPlay():!!findP))return;` with `if(isGame(S.mode)&&(G[S.mode]?G[S.mode].canPlay():!!GP[S.mode]))return;`
4. `next(fresh)`: replace the whole `if(S.mode==='find'){ … } if(find)find.leave();` block with
```js
  if(isGame(S.mode)){
    const g=G[S.mode];
    if(g&&g.canPlay()){
      if(g.active()&&!fresh)return;
      Object.entries(G).forEach(([k,o])=>{if(o&&k!==S.mode)o.leave()});
      g.begin();renderMode();return;
    }
    if(!g&&!GP[S.mode]){const m=S.mode;loadGame(m).then(f=>{if(f&&S.mode===m)next()})} // a synced game mode on a device that has not loaded it yet
  }
  Object.values(G).forEach(g=>g&&g.leave());
```
5. The sync-pull condition: replace `(pathPos()!==before.pos&&(S.mode==='find'||(cur&&!eligible(cur))))` with `(pathPos()!==before.pos&&(isGame(S.mode)||(cur&&!eligible(cur))))`.
6. `renderMode`: replace `fo=!!(find&&S.mode==='find'&&find.canPlay());` and the pressed lines so that, for every game name, its button (`'m'+Name`) is pressed when that game is the playable current mode:
```js
  const m=effMode(),ok=openItems('word').length>=MIN_WORDS,fo=!!(isGame(S.mode)&&G[S.mode]&&G[S.mode].canPlay());
  $('mSyl').setAttribute('aria-pressed',!fo&&m==='syl');$('mWord').setAttribute('aria-pressed',!fo&&m==='word');
  Object.keys(GAMEDEF).forEach(n=>$('m'+n[0].toUpperCase()+n.slice(1)).setAttribute('aria-pressed',fo&&S.mode===n));
```
7. Replace `loadFind` and the `$('mFind').onclick` handler by:
```js
// Loads a play mode's module on first use; a failure leaves it unloaded (the mode then says "locked" and the saved preference is kept).
function loadGame(name){
  if(G[name])return Promise.resolve(G[name]);
  const def=GAMEDEF[name];
  return GP[name]||(GP[name]=(async()=>{
    try{
      const imp=window.__leemosImport||(p=>import(p));
      const mod=await Promise.race([imp('./'+def.file),new Promise((_,no)=>setTimeout(()=>no(new Error('timeout')),window[def.ms]||5000))]); // a stalled network must not hold the first screen
      G[name]=mod[def.create]({doc:document,$,S,t,fmt,rnd,nm,say,lumiPlay,sayLumi,sfx,poke,sparkle:sparkleBurst,later:(f,ms)=>setTimeout(f,ms),
        earnSticker,showReward,refresh:()=>{renderLevels();renderHard();renderAlbum()},pathPos,levels:()=>LEVELS,save});
      return G[name];
    }catch(e){GP[name]=null;return null}
  })());
}
async function openGame(name){
  if(S.mode===name&&G[name]&&G[name].active())return; // already playing: do not throw the page away
  if(pendingEnd)return; // the end of a reading session is on its way: it must not open over the game
  const g=await loadGame(name);
  if(!g||!g.canPlay()){$('hint').textContent=t(GAMEDEF[name].lock);return}
  S.mode=name;save();renderMode();next();
}
$('mFind').onclick=()=>openGame('find');
```
8. `setPath`: replace `S.mode==='find'&&find&&find.active()` with `activeGame()`.
9. `applyCase`: keep `$('findRoom').classList.toggle('upper',S.upper);` (Task 4 adds `closeRoom`).
10. Boot line `if(S.mode==='find')await loadFind();` → `if(isGame(S.mode))await loadGame(S.mode);`
11. In `src/find.js`, make `createFind` return `{ canPlay, begin, leave, active: () => !!game, intro: 'findIntro' }`.

- [ ] **Step 3: Run everything**

Run: `node tests/smoke.mjs > /tmp/c3.log 2>&1; echo "exit $?"; grep -c '^FAIL' /tmp/c3.log; npm test > /tmp/c3f.log 2>&1; tail -1 /tmp/c3f.log; grep -c '^FAIL' /tmp/c3f.log`
Expected: exit 0, `0`, passing, `0`. Every Busca test passes unchanged.

- [ ] **Step 4: Mutation-check the generic wiring**

Restore after each: `sayHint` without the `activeGame()` branch; `introHint` guard removed; `renderMode` pressed line removed; `openGame`'s `if(pendingEnd)return;` removed; `loadGame`'s `Promise.race` removed. Each must fail an existing Busca test; if one survives, add the missing check to section 43. (`next` without the `Object.entries(G).forEach(... leave())` line is only visible with two games: note it in the ledger and re-check it in Task 4.)

- [ ] **Step 5: Commit**

```bash
git add src/app.js src/find.js tests/smoke.mjs
git commit -m "refactor: one registry for the play modes (Busca la paraula uses it; behaviour unchanged)"
```

---

### Task 4: The closed-syllable screen (syllable screens, session, sticker) and its wiring

**Files:**
- Modify: `src/close.js` (append `createClose`), `src/app.js` (`GAMEDEF.close`, data loading, `applyCase`), `index.html`, `src/styles.css`, `tests/smoke.mjs` (new section 44)

**Interfaces:**
- Consumes: Task 1 exports; Task 3 registry; i18n keys from Task 2; from `app.js` the same ctx as `find.js` plus `data: () => CLOSED[S.lang]` (the loaded `closed.<lang>.json`).
- Produces: `createClose(ctx): {canPlay, begin, leave, active, intro: 'closeIntro'}`; DOM: `#closeRoom`, `.close-dots i`, `.close-unit` (`.close-syl` row with `.close-tile.base`, `.close-coda` or `.close-card`, `.close-arc` / `.wide`), `.docked`, `.glow`, `.rescue`, `#closeAgain`; class `close` on `<html>`; the button `#mClose`.

- [ ] **Step 1: Write the failing smoke tests**

Append a new section to `tests/smoke.mjs` before the final `console.log`:

```js
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
  check('close: a syllable screen shows the CV base and a glowing coda tile (+l at step 3), never three letters at once', /^[a-z]{2}$/.test(b0) && a0.classList.contains('close-coda') && a0.textContent === '+l' && !!x.d.querySelector('.close-arc') && !x.d.querySelector('.close-arc').classList.contains('wide'));
  check('close: the first screen of the session says the instruction text and shows 6 dots', x.$('hint').textContent === 'Lee la sílaba en voz alta y toca para cerrarla.' && x.d.querySelectorAll('.close-dots i').length === 6);
  const st0 = cprogress(x), tts0 = (x.w.__tts || []).length;
  x.d.querySelector('.close-tile.base').click();
  check('close: tapping the base plays the base sound', (x.w.__tts || []).length > tts0 || played(x, 'c' + b0) > 0);
  action(x).click();
  const syl0 = b0 + 'l';
  check('close: tapping the coda docks it, grows the arc and plays the STRETCHED clip (~syllable)', x.d.querySelector('.close-coda.docked')?.textContent === 'l' && x.d.querySelector('.close-arc').classList.contains('wide') && played(x, 'c~' + syl0) === 1, `plays=${played(x, 'c~' + syl0)} ${syl0}`);
  action(x)?.click(); action(x)?.click();
  check('close: tapping the docked coda again does nothing (the stretched clip plays once)', played(x, 'c~' + syl0) === 1);
  await sleep(20);
  check('close: the next screen starts by itself with one dot filled', x.d.querySelectorAll('.close-dots i.on').length === 1 && !x.d.querySelector('.close-coda.docked'));
  check('close: nothing is recorded (stats, total, level, session) and there is no sticker yet', cprogress(x) === st0 && (csaved(x).stickers | 0) === 0);
  // the second half of the syllable screens peeks
  await finishScreen(x); await finishScreen(x);
  const card = x.d.querySelector('.close-card');
  check('close: from the 4th screen the coda is hidden behind a "?" card, and tapping it reveals the letter with the stretched clip', !!card && card.textContent === '?' && (() => { const bs = base(x); card.click(); return card.textContent === 'l' && played(x, 'c~' + bs + 'l') === 1; })());
  await sleep(20);
  await finishScreen(x); await finishScreen(x);
  check('close: after 6 screens a sticker is given once, the reward shows and the again button appears', csaved(x).stickers === 1 && !x.$('reward').hidden && !!x.$('closeAgain'), `stickers=${csaved(x).stickers}`);
  check('close: the whole session left stats, total and the session counters untouched', cprogress(x) === st0);
  x.$('rewardOk').click(); x.$('closeAgain').click(); await sleep(10);
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
  // Leo never sees the mode
  x = await bootLeo();
  check('close: Leo is on his own screen where the modes row is hidden', x.d.documentElement.classList.contains('pre'));
}
```

Run: `node tests/smoke.mjs > /tmp/c4.log 2>&1; grep -c '^FAIL' /tmp/c4.log; grep -E '^FAIL|Error' /tmp/c4.log | head -3 | cut -c1-160`
Expected: a crash or FAILs from the first `x.$('mClose').click()` (no `#mClose` yet).

- [ ] **Step 2: Markup, styles**

`index.html`: add after the `#mFind` button: `    <button class="mode" id="mClose" data-i="mClose" aria-pressed="false">Cierra</button>` and after `<div class="find-room" id="findRoom" hidden></div>`: `    <div class="close-room" id="closeRoom" hidden></div>`.

`src/styles.css`: change line 37 to `.modes{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:6px 0 14px}` and add `@media (max-width:480px){.modes{grid-template-columns:1fr 1fr}}` right after it. Then append before the reduced-motion block:

```css
/* Cierra / Tanca */
html.close .session,html.close #goal,html.close #tiles,html.close #pic,html.close #stage .actions{display:none!important}
.close-room{display:flex;flex-direction:column;align-items:center;gap:18px;width:100%}
.close-dots{display:flex;gap:7px}
.close-dots i{width:16px;height:16px;border-radius:50%;background:color-mix(in srgb,var(--ink) 14%,transparent)}
.close-dots i.on{background:var(--c1)}
.close-stage{display:flex;flex-direction:column;align-items:center;gap:14px;width:100%;min-height:220px}
.close-unit{display:flex;flex-direction:column;align-items:stretch;gap:6px}
.close-syl{display:flex;gap:10px;justify-content:center}
.close-tile,.close-coda,.close-card,.close-chip{font:inherit;font-weight:700;color:var(--ink);background:var(--panel);border:3px solid var(--c2);border-radius:18px;cursor:pointer;touch-action:manipulation}
.close-tile,.close-coda,.close-card{font-size:clamp(48px,14vw,88px);min-width:72px;min-height:88px;padding:4px 18px}
.close-chip{font-size:1.4rem;min-height:48px;min-width:56px;padding:4px 14px}
.close-coda{border-style:dashed;color:var(--c2)}
.close-coda.glow,.close-card{animation:closeGlow 1.6s ease-in-out infinite}
.close-coda.rescue{animation-duration:.6s;background:color-mix(in srgb,var(--c1) 35%,var(--panel))}
.close-coda.docked{border-style:solid;color:var(--ink);animation:none}
.close-card{background:color-mix(in srgb,var(--c2) 18%,var(--panel))}
.close-arc{height:14px;border:5px solid var(--c2);border-top:none;border-radius:0 0 40px 40px;transform-origin:left;transform:scaleX(.5);transition:transform .35s ease}
.close-arc.wide{transform:scaleX(1)}
.close-anchors{display:flex;gap:8px;min-height:48px}
.close-current{display:flex;flex-direction:column;align-items:center;gap:10px}
.close-pic{font-size:72px;line-height:1}
.close-tile:focus-visible,.close-coda:focus-visible,.close-card:focus-visible,.close-chip:focus-visible{outline:3px solid var(--c1);outline-offset:3px}
.close-room.upper .close-tile,.close-room.upper .close-coda,.close-room.upper .close-card,.close-room.upper .close-chip{text-transform:uppercase}
.close-done{font-size:1.3rem;font-weight:700;text-align:center}
@keyframes closeGlow{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--c1) 0%,transparent)}50%{box-shadow:0 0 0 8px color-mix(in srgb,var(--c1) 55%,transparent)}}
```
and inside the existing `@media (prefers-reduced-motion: reduce){` block add: `.close-coda.glow,.close-card,.close-coda.rescue{animation:none}.close-arc{transition:none}`.

- [ ] **Step 3: `createClose` (syllable screens only; words are a stub until Task 5)**

Append to `src/close.js`:

```js
// The screen. ctx: { doc, $, S, t, fmt, rnd, nm, say, lumiPlay, sayLumi, sfx, poke, sparkle, later, earnSticker, showReward, refresh, pathPos, levels, data, save, rng }
export function createClose(ctx) {
  const { doc, $, S, t, fmt, rnd, nm, say, lumiPlay, sayLumi, sfx, poke, sparkle, later, earnSticker, showReward, refresh, pathPos, levels, data, save, rng = Math.random } = ctx;
  const room = $('closeRoom'), html = doc.documentElement;
  let plan = null, idx = 0, over = false, gen = 0, advancing = false;
  const bank = () => ((data() || {}).syl) || [];
  const canPlay = () => openSyllables(bank(), pathPos()).length >= MIN_SYL;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  function leave() { gen++; plan = null; room.hidden = true; room.innerHTML = ''; html.classList.remove('close'); }

  function begin() {
    gen++;
    if (!canPlay()) { leave(); return false; }
    const pos = pathPos();
    plan = planSession(openSyllables(bank(), pos), openWords(wordsFrom(levels()), pos), rng);
    idx = 0; over = false;
    html.classList.add('close'); room.hidden = false; room.classList.toggle('upper', !!S.upper);
    screen(true);
    return true;
  }

  // One 2+1 unit: the CV base, then the coda (a glowing tile to dock, or a "?" card to turn over). onDone runs once, after the stretched sound starts.
  function unit(parent, u, onDone) {
    const wrap = el('div', 'close-unit'), row = el('div', 'close-syl'), arc = el('div', 'close-arc');
    const base = el('button', 'close-tile base', u.base); base.onclick = () => say(u.base);
    const coda = u.peek ? el('button', 'close-card', '?') : el('button', 'close-coda glow', '+' + u.coda);
    coda.setAttribute('aria-label', u.peek ? t('closeCover') : t('closeAdd', { c: u.coda }));
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      coda.classList.remove('glow', 'rescue'); coda.classList.add('docked'); coda.textContent = u.coda; coda.setAttribute('aria-label', u.coda);
      arc.classList.add('wide'); sfx.ok(); lumiPlay('~' + u.text, false); // only a clip: without one it is silent
      onDone();
    };
    coda.onclick = finish;
    row.append(base, coda); wrap.append(row, arc); parent.appendChild(wrap);
    return { finish, coda, base, isDone: () => done };
  }

  function complete() {
    if (advancing) return;
    advancing = true;
    $('hint').textContent = fmt(rnd(t('oks')));
    poke('cheer', 900);
    const g = gen;
    later(() => { if (g !== gen) return; idx++; idx < plan.length ? screen(false) : finishSession(); }, 1600);
  }

  function screen(first) {
    gen++; advancing = false;
    const p = plan[idx];
    room.innerHTML = '';
    const dots = el('div', 'close-dots'); dots.setAttribute('role', 'img'); dots.setAttribute('aria-label', t('closeGoal', { i: idx + 1, n: plan.length }));
    for (let i = 0; i < plan.length; i++) dots.appendChild(el('i', i < idx ? 'on' : ''));
    const stage = el('div', 'close-stage');
    room.append(dots, stage);
    $('hint').textContent = t('closeIntro');
    if (p.kind === 'syl') {
      const c = unit(stage, { text: p.syl, base: p.base, coda: p.coda, peek: p.peek }, complete);
      c.coda.focus();
    } else {
      complete(); // replaced by the word screen in the next task
    }
    if (first && S.sound) lumiPlay(t('closeIntro'), false);
  }

  function finishSession() {
    over = true;
    const reward = earnSticker(); save(); refresh();
    const msg = t('closeDone', { n: nm() });
    room.innerHTML = '';
    const again = el('button', 'btn primary', t('closeAgain')); again.id = 'closeAgain'; again.onclick = () => begin();
    room.append(el('p', 'close-done', msg), again);
    $('hint').textContent = msg;
    if (reward) later(() => showReward(reward), 500);
    else { again.focus(); sfx.win(); if (S.sound) sayLumi(msg); }
  }

  return { canPlay, begin, leave, active: () => !!plan, intro: 'closeIntro' };
}
```

- [ ] **Step 4: Wire it in `app.js`**

1. `GAMEDEF`: add `close:{file:'close.js',create:'createClose',ms:'__leemosCloseTimeout',lock:'closeLocked',data:'closed'}` and declare `const CLOSED={}; // closed.<lang>.json, loaded with the close module` next to `G`/`GP`.
2. In `loadGame`, replace `const mod=await Promise.race([imp('./'+def.file), …timeout…]);` by
```js
      const load=Promise.all([imp('./'+def.file),def.data?Promise.all(['es','ca'].map(l=>loadJSON('src/data/'+def.data+'.'+l+'.json').then(d=>{CLOSED[l]=d}))):null]).then(r=>r[0]);
      const mod=await Promise.race([load,new Promise((_,no)=>setTimeout(()=>no(new Error('timeout')),window[def.ms]||5000))]);
```
   and pass `data:()=>CLOSED[S.lang]` in the ctx object (harmless for Busca).
3. `$('mClose').onclick=()=>openGame('close');` next to the Busca one.
4. `applyCase`: add `$('closeRoom').classList.toggle('upper',S.upper);`.
5. `renderMode`'s generic line already presses `mClose` (the button id derives from the game name: `'m'+'Close'`).

- [ ] **Step 5: Run the tests**

Run: `node tests/smoke.mjs > /tmp/c4.log 2>&1; echo "exit $?"; grep -c '^FAIL' /tmp/c4.log; grep -E '^FAIL|Error' /tmp/c4.log | head -6 | cut -c1-190`
Expected: exit 0, `0`. If a check fails because of a harness detail (a regex on the base text, the way a timer ran, `Proxy` file names), fix the observation in the test and say so in the commit message; fix production code only for real defects.

- [ ] **Step 6: Mutation-check**

Restore after each, expect a FAIL: `unit`: remove `if (done) return; done = true;` (double play); `complete`: remove `if (advancing) return;`; `finishSession` called early (`idx < plan.length - 1`); `leave`: remove `gen++`; `finishSession`: add `S.total++`; `unit`: remove `lumiPlay('~' + u.text, false)`; `next` (app.js) without the `Object.entries(G)…leave()` line (the Busca/Cierra overlap check must fail). A sound-effect-on-error check is not needed here (there is no wrong answer in this mode).

- [ ] **Step 7: Full suite and commit**

Run: `npm test > /tmp/c4f.log 2>&1; tail -1 /tmp/c4f.log; grep -c '^FAIL' /tmp/c4f.log`
Expected: passing and `0`.

```bash
git add src/close.js src/app.js index.html src/styles.css tests/smoke.mjs
git commit -m "feat(close): the closed-syllable screen (2+1 docking, peek-a-boo, session, sticker) and its wiring"
```

---

### Task 5: Word screens (anchor chips, closed syllable built 2+1, join, picture after reading)

**Files:**
- Modify: `src/close.js` (replace the word stub), `tests/smoke.mjs` (section 44, new block)

**Interfaces:**
- Consumes: `unit()`, `complete()`, `screen()` from Task 4; `planSession` word screens `{kind:'word', w:{text, parts, emoji, step}}`.
- Produces: DOM `.close-anchors` (with `.close-chip` per finished syllable), `.close-current`, `#closeJoin`, `.close-pic`; `openUnit` for open syllables.

- [ ] **Step 1: Write the failing tests**

Append inside section 44 before the `// Leo never sees the mode` check:

```js
  // word screens: Spanish at step 12 has 2+ qualifying words, so a session is 4 syllables + 2 words
  {
    const wx = await startC({ pathEs: 12 });
    const act = () => wx.d.querySelector('.close-current .close-coda') || wx.d.querySelector('.close-current .close-tile.base'); // the coda to dock if there is one, else the open syllable
    for (let i = 0; i < 4; i++) { await finishScreen(wx); }
    check('close: after the 4 syllable screens the word screens come, with an empty anchor row and the first syllable', !!wx.d.querySelector('.close-anchors') && wx.d.querySelectorAll('.close-chip').length === 0 && !!wx.d.querySelector('.close-current'));
    const picBefore = wx.d.querySelector('.close-pic');
    check('close: the picture is hidden until the word is read (the app rule)', !picBefore || picBefore.hidden || !picBefore.textContent);
    act().click(); await sleep(20);
    check('close: a finished syllable docks into the anchor chip', wx.d.querySelectorAll('.close-chip').length === 1);
    const chip = wx.d.querySelector('.close-chip');
    const before = wx.audioCalls.length + (wx.w.__tts || []).length;
    chip.click();
    check('close: tapping the anchor chip plays that syllable again (a stretched clip for the closed one)', wx.audioCalls.length + (wx.w.__tts || []).length > before);
    check('close: the anchor chip has a screen-reader label', chip.getAttribute('aria-label').length > 0);
    act().click(); await sleep(20);
    const join = wx.$('closeJoin');
    check('close: when every syllable is done a Juntar button appears (not before)', !!join && wx.d.querySelectorAll('.close-chip').length === 2);
    check('close: the picture is still hidden before Juntar', !wx.d.querySelector('.close-pic') || wx.d.querySelector('.close-pic').hidden);
    join.click(); join.click(); await sleep(5);
    check('close: Juntar plays the word and only then shows the picture (a double tap counts once)', wx.d.querySelector('.close-pic') && !wx.d.querySelector('.close-pic').hidden && wx.d.querySelector('.close-pic').textContent.length > 0);
    await sleep(20);
    check('close: the second word screen starts with an empty anchor row', wx.d.querySelectorAll('.close-chip').length === 0 && wx.d.querySelectorAll('.close-dots i.on').length === 5);
    for (let k = 0; k < 2; k++) { act()?.click(); await sleep(20); }
    const j2 = wx.$('closeJoin'); if (j2) { j2.click(); await sleep(30); }
    check('close: after the second word the session ends with one sticker, nothing else recorded', csaved(wx).stickers === 1 && !csaved(wx).total && !wx.$('reward').hidden && wx.errors.length === 0, `stickers=${csaved(wx).stickers} ${wx.errors.join('|')}`);
  }
```

Run `node tests/smoke.mjs` → the new checks FAIL (the stub completes word screens at once).

- [ ] **Step 2: Implement**

In `src/close.js`, add before `function complete()`:

```js
  // An open syllable has nothing to close: a tile she reads and taps to dock it.
  function openUnit(parent, u, onDone) {
    const wrap = el('div', 'close-unit'), row = el('div', 'close-syl'), arc = el('div', 'close-arc wide');
    const tile = el('button', 'close-tile base', u.text);
    let done = false;
    const finish = () => { if (done) return; done = true; say(u.text); onDone(); };
    tile.onclick = finish;
    row.appendChild(tile); wrap.append(row, arc); parent.appendChild(wrap);
    return { finish, coda: tile, base: tile, isDone: () => done };
  }

  // A word: its syllables one at a time; a closed one is built 2+1; each finished syllable docks into an anchor chip she can tap to hear it again.
  function wordFlow(stage, w) {
    const units = w.parts.map((p) => { const c = splitClosed(p); return c ? { text: p, closed: true, base: c.base, coda: c.coda } : { text: p, closed: false }; });
    const anchors = el('div', 'close-anchors'), cur = el('div', 'close-current'), pic = el('div', 'close-pic'); pic.hidden = true;
    stage.append(anchors, cur, pic);
    const g0 = gen;
    let i = 0, joined = false, ctl = null;
    const dock = (u) => {
      const chip = el('button', 'close-chip', u.text); chip.setAttribute('aria-label', t('closeAnchor') + ': ' + u.text);
      chip.onclick = () => (u.closed ? lumiPlay('~' + u.text, false) : say(u.text));
      anchors.appendChild(chip);
      i++; step();
    };
    const step = () => {
      if (g0 !== gen) return;
      cur.innerHTML = '';
      if (i >= units.length) {
        const j = el('button', 'btn primary', t('join')); j.id = 'closeJoin';
        j.onclick = () => { if (joined) return; joined = true; sfx.join(); say(w.text); pic.textContent = w.emoji || ''; pic.hidden = !w.emoji; j.hidden = true; complete(); };
        cur.appendChild(j); j.focus();
        return;
      }
      const u = units[i];
      const after = () => { const g = gen; later(() => { if (g === gen) dock(u); }, u.closed ? 900 : 0); };
      ctl = u.closed ? unit(cur, { text: u.text, base: u.base, coda: u.coda, peek: false }, after) : openUnit(cur, u, after);
      ctl.coda.focus();
    };
    step();
  }
```
and replace the stub in `screen()`:
```js
    } else {
      wordFlow(stage, p.w);
    }
```
(remove the `complete(); // replaced…` line). `openUnit` calls `after` immediately (a 0 ms timer, real in the harness): the tests `await sleep(20)` after each tap.

- [ ] **Step 3: Run the tests**

Run: `node tests/smoke.mjs > /tmp/c5.log 2>&1; echo "exit $?"; grep -c '^FAIL' /tmp/c5.log; grep -E '^FAIL|Error' /tmp/c5.log | head -5 | cut -c1-190`
Expected: exit 0, `0`.

- [ ] **Step 4: Mutation-check**

Restore after each, expect a FAIL: remove `if (joined) return;` (double Juntar); show the picture at `step()` start; remove `anchors.appendChild(chip)`; remove `if (g0 !== gen) return;` in `step` (a stale dock after leaving — add a test that leaves mid-word and checks `errors` if it survives); make `Juntar` appear one syllable early (`i >= units.length - 1`).

- [ ] **Step 5: Full suite and commit**

Run: `npm test > /tmp/c5f.log 2>&1; tail -1 /tmp/c5f.log; grep -c '^FAIL' /tmp/c5f.log`
Expected: passing and `0`.

```bash
git add src/close.js tests/smoke.mjs
git commit -m "feat(close): word screens with the anchor chip, a closed syllable built 2+1, join and the picture after reading"
```

---

### Task 6: The 3-second rescue, stray-call guards and fallbacks

**Files:**
- Modify: `src/close.js` (rescue timer), `src/app.js` only if a guard is missing, `tests/smoke.mjs` (the `boot` harness and section 44, new block)

**Interfaces:**
- Consumes: `unit()`, `openUnit()`, `wordFlow()`, `complete()`, `screen()`; `window.__leemosRescueMs`.
- Produces: the rescue (`arm`, `disarm`, `rescueFn`, class `rescue`), once per step, reset by any tap, cancelled by `leave()`/`complete()`.

- [ ] **Step 1: Write the failing tests**

In the `boot` harness change the line `if (hangImport) w.__leemosFindTimeout = 150;` to `if (hangImport) { w.__leemosFindTimeout = 150; w.__leemosCloseTimeout = 150; }`.

Append inside section 44 before the Leo check:

```js
  // the 3-second rescue: once per step, never an error signal, nothing recorded
  {
    const spoken = (rx, s) => played(rx, 'c' + s) + (rx.w.__tts || []).filter((v) => v === s).length;
    let rx = await boot({ storage: CR(), manifest: cman }); rx.w.__audioMode = 'auto'; rx.w.__leemosRescueMs = 150;
    rx.$('mClose').click(); await until(() => !croom(rx).hidden); await sleep(40);
    const b1 = base(rx);
    check('close: after 3 s without a tap Lumi plays the base and the coda tile pulses harder; the child still has the last tap', action(rx).classList.contains('rescue') && !action(rx).classList.contains('docked') && spoken(rx, b1) >= 1);
    const n1 = spoken(rx, b1);
    await sleep(60);
    check('close: the rescue fires once per step (no repeated nagging)', spoken(rx, b1) === n1);
    check('close: the rescue shows or plays no error signal and records nothing', !rx.d.querySelector('.wobble, .error, .wrong') && (csaved(rx).stickers | 0) === 0 && !csaved(rx).total && JSON.stringify(csaved(rx).stats || {}) === '{}');
    action(rx).click(); await sleep(60);
    check('close: after the tap the next screen has its own fresh rescue (it does not carry over)', !!action(rx) && action(rx).classList.contains('rescue') && rx.errors.length === 0, rx.errors.join('|'));
    // word screen: the syllable on screen is modelled and docked for her, the rest is hers
    rx = await boot({ storage: CR({ pathEs: 12 }), manifest: cman }); rx.w.__audioMode = 'auto'; rx.w.__leemosRescueMs = 9000;
    rx.$('mClose').click(); await until(() => !croom(rx).hidden);
    for (let i = 0; i < 4; i++) { action(rx).click(); await sleep(20); }
    rx.w.__leemosRescueMs = 150;
    rx.d.querySelector('.close-anchors').click(); await sleep(60); // a tap in the room re-arms the rescue with the short time
    check('close: on a word screen the rescue docks the syllable on screen into the anchor chip, once, and the join is left to her', rx.d.querySelectorAll('.close-chip').length >= 1 && !rx.$('closeJoin')?.hidden === !!rx.$('closeJoin') && rx.errors.length === 0, `chips=${rx.d.querySelectorAll('.close-chip').length} ${rx.errors.join('|')}`);
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
```

Run `node tests/smoke.mjs` → the rescue checks FAIL (no rescue yet); the guard checks pass or fail by what exists.

- [ ] **Step 2: Implement the rescue**

In `src/close.js`, add the state and helpers after `let plan = …`:

```js
  let rescueT = 0, rescued = false, rescueFn = null;
  const rescueMs = () => doc.defaultView.__leemosRescueMs || 3000;
  const disarm = () => { clearTimeout(rescueT); rescueT = 0; };
  // 3 seconds with no tap: model the hard part and leave the rest to her. Once per step; any tap pushes it back; nothing is shown or recorded as a failure.
  const arm = () => {
    disarm();
    if (rescued || advancing || over || !plan || !rescueFn) return;
    const g = gen;
    rescueT = later(() => { if (g !== gen || rescued || advancing || over) return; rescued = true; rescueFn(); }, rescueMs());
  };
  room.addEventListener('click', () => { if (!rescued) arm(); }, true);
```
Wire it:
- `leave()`: add `disarm(); rescueFn = null;`
- `screen()`: at the start `disarm();`; after building, for a syllable screen `rescued = false; rescueFn = () => { say(p.base); c.coda.classList.add('rescue'); }; arm();` (declare `c` outside the `if` or set `rescueFn` inside the syllable branch).
- `wordFlow` `step()`: at the start `rescued = false;`; for a unit `rescueFn = () => { if (ctl && !ctl.isDone()) ctl.finish(); };` (finishing a unit plays its sound and, through `after`, docks it into the anchor: "Lumi models it and docks it for her"); for the join step `rescueFn = () => { j.classList.add('rescue'); };`; call `arm()` at the end of `step()` (both branches).
- `complete()`: add `disarm();` before the `later`.
- `finishSession()`: `disarm();`.

- [ ] **Step 3: Run the tests**

Run: `node tests/smoke.mjs > /tmp/c6.log 2>&1; echo "exit $?"; grep -c '^FAIL' /tmp/c6.log; grep -E '^FAIL|Error' /tmp/c6.log | head -6 | cut -c1-190`
Expected: exit 0, `0`. Fix test observations only for harness reasons; fix a real defect in the code if a guard fails.

- [ ] **Step 4: Mutation-check**

Restore after each, expect a FAIL: remove `rescued = true` (repeats); remove `disarm()` in `complete` (rescue after the step is done); remove `gen++` in `leave`; remove the capture click listener (a tap does not reset); `rescueFn` for the syllable screen without `say(p.base)`; the word rescue without `ctl.finish()`.

- [ ] **Step 5: Full suite and commit**

Run: `npm test > /tmp/c6f.log 2>&1; tail -1 /tmp/c6f.log; grep -c '^FAIL' /tmp/c6f.log`
Expected: passing and `0`.

```bash
git add src/close.js src/app.js tests/smoke.mjs
git commit -m "feat(close): the 3-second rescue, and the guards for stray calls, stalled imports and the reading end screen"
```

---

### Task 7: Docs, real-browser check, final review

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `docs/superpowers/specs/2026-10-18-closed-syllables-design.md` (only to correct what the code taught)

**Interfaces:** none new.

- [ ] **Step 1: Docs**

`CLAUDE.md`: in the architecture list add `src/close.js`, `src/data/closed.{es,ca}.json`, `tests/close.mjs`; add a pedagogy bullet "**Cierra / Tanca**" (fourth mode, `S.mode==="close"`; spec path): sílabas cerradas CVC con s/r/l armadas como 2+1 (base, la coda se acopla, sonido alargado `~sílaba` de tipo `stretch`), carta «?» (peek-a-boo), palabras de 2 sílabas con una cerrada y la primera sílaba en una ficha ancla, rescate a los 3 s sin error, 6 pantallas y una pegatina, sin estadísticas; se abre con la L (paso 3); las monosílabas no se usan como pantallas de palabra. Audio: «Cierra» usa clips `stretch` generados con Azure (receta en `scripts/spoken.mjs`, `case 'stretch'`); **Fran debe escucharlos** en `/tools/review.html` y regrabar los malos con «Grabar mi voz» (la lista incluye los `stretch`). Mention the registry (`GAMEDEF`, `loadGame`, `openGame`) in the "Ojo" section so a third game uses it. `README.md`: one line in the content list.

Spec corrections: if anything differs from what the code does (for example the wording of `closeIntro`, the 4-column row on wide screens and 2×2 under 480 px), update the spec.

- [ ] **Step 2: Full suite**

Run: `npm test > /tmp/c7.log 2>&1; tail -1 /tmp/c7.log; grep -c '^FAIL' /tmp/c7.log`
Expected: passing and `0`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md docs
git commit -m "docs(close): Cierra / Tanca in CLAUDE.md and README, spec synced with the code"
```

- [ ] **Step 4: Real-browser check**

With `npm run dev` running on 127.0.0.1:5173, open Chrome, clear site data (storage, service worker, caches), set `pathEs` to 3 (tap the third letter in the parents' panel) and tap Cierra: play a whole session in Spanish; then set the Camino to the last step and play one with word screens; then Catalan. Check: the four mode buttons fit (2×2 on a narrow window), tiles are large and fit a phone width, the arc grows, the coda docks, the "?" card turns over, the anchor chip replays, the picture appears only after Juntar, the rescue shows after 3 s of doing nothing, the sticker appears at the end and the console has no errors. Report what you saw; leave no tab open and clear the test storage.

- [ ] **Step 5: Final whole-branch review**

Dispatch one fresh reviewer on the most capable model over `git diff main...HEAD`, giving it the spec, this plan and the Review Focus list verbatim; read-only. Fix Critical and Important findings with a test that fails first; list Minor ones for Fran. Then stop: merging and pushing wait for Fran, and so does the listening to the stretched clips.
