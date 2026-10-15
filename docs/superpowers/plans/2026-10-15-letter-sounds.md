# Letter Sounds for Leo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second, pre-reader profile (Leo, 4) with a letter-to-sound activity (intro card, then hear-the-sound-tap-the-letter game) in Spanish and Catalan, next to Elsa's untouched syllable app.

**Architecture:** Profiles are separate `localStorage` states (`leemos-v1` stays Elsa's, `leemos-v1:<id>` for others) chosen at boot; switching reloads the page. The pre-reader flow lives in `src/sounds.js`: pure helpers (selection, weights, unlocking) plus `createSounds(ctx)`, which receives everything it needs from `app.js` through `ctx` and has no globals. `app.js` loads it with a dynamic `import()` only for `kind: 'pre'` profiles.

**Tech Stack:** Vanilla ES modules, no build, jsdom smoke tests (`tests/smoke.mjs`), plain-Node unit tests (`tests/sounds.mjs`), existing audio pipeline (`scripts/`).

**Spec:** `docs/superpowers/specs/2026-10-15-letter-sounds-design.md`

## Global Constraints

- No framework, no bundler, no new dependencies. No tracking, ads or data leaving the device.
- Elsa's `localStorage['leemos-v1']` is never renamed or migrated; a missing `leemos-profiles` key must behave exactly as today.
- `src/app.js` must contain no `import` statements: `tests/smoke.mjs` evaluates it as a string inside an async function. `sounds.js` is loaded with `import()` behind the `window.__leemosImport` seam.
- `src/sounds.js` must not touch `window`, `document`, `localStorage` or global `setTimeout`; all of that comes through `ctx` (`ctx.later` is the timer).
- Stats keys: `snd:<letter>` (es) and `ca:snd:<letter>` (ca). Clip keys are the lowercase text, `ca:` prefix only in IndexedDB.
- New UI text: key in `src/data/i18n.es.json` **and** `src/data/i18n.ca.json` (same keys, `npm test` checks), `data-i="key"` in HTML or `t('key')` in JS.
- Touch targets at least 44 px, visible focus, colors as tokens from `:root`, `prefers-reduced-motion` disables animation. Lumi is the only mascot.
- Mastered = `ok >= 2 && ok > fail`. Weight = `max(.25, 1 + fail*2.5 - ok*.35 + (ok+fail===0 ? 1.5 : 0))`.
- Any change to the `SHELL` list in `sw.js` bumps `VERSION` (here `leemos-v2` to `leemos-v3`).
- Code comments in English (as in the existing code), UI strings in Spanish/Catalan. Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Decisions made while planning (deviations and additions to the spec)

- **`h` is left out of the game.** It has no sound to hear, so there is nothing to match. Everything else from the spec's group 5 is kept; groups 5 and 6 differ per language (`ny`, `tx`, `x` only exist in Catalan; `qu`, `ñ`, `ch`, `z` follow Spanish).
- **Homophones are modelled with an optional `ph` field** (`v` has `ph: "b"`, `qu` has `ph: "c"`). Two letters with the same `ph` are never offered together, because the answer would be ambiguous (b/v sound identical in Spanish and in Mallorcan Catalan).
- **Intro card does not chain "M de mano".** The sound plays when the card opens or the letter is tapped; the picture word is spoken when its button is tapped. Chaining two clips needs `ended` events that `say()` does not expose; not worth changing `say()` for this.
- **At most 2 brand-new letters per session** (`NEW_PER_SESSION`). Without it, a 5-exercise session could introduce 5 letters and never repeat one.
- **`#preChoices` carries `data-answer`** as a test hook (the child cannot read the DOM).

## Review Focus

Inputs and conditions the spec implies but no feature task would otherwise pin; each has a test in the task named.

1. **b and v (and c and qu) sound the same.** They must never be shown as the two options for one sound. (Task 1)
2. **Almost nothing seen yet.** The very first exercise has no seen letters to use as distractors; it must still show 2 distinct choices including the answer, never 1 and never a duplicate. (Tasks 1 and 4)
3. **Corrupt or hostile profile store.** Invalid JSON, `active` not in the list, empty list, non-string ids, and a profile name containing HTML must fall back to Elsa or render as plain text, never throw. (Task 3)
4. **A 4-year-old mashing the screen.** Tapping the right answer 3 times counts once; tapping several wrong options counts one fail; taps after the answer do nothing. (Task 4)
5. **Language switch mid-way and the last group.** Switching es/ca keeps stats and unlocked group per language; a fully mastered last group offers no unlock and does not overflow. (Task 5)

Not testable here: with no recording and no generated clip, the browser voice reads a lone "m" as "eme". The game still works; fixing it is what Task 2's audio checkpoint and the recorder are for.

---

### Task 1: Letter data and selection logic

**Files:**
- Create: `src/data/sounds.es.json`, `src/data/sounds.ca.json`, `src/sounds.js`, `tests/sounds.mjs`
- Modify: `package.json` (test script)

**Interfaces:**
- Produces (all exported from `src/sounds.js`): `sKey(lang,l)`, `phOf(x)`, `isMastered(s)`, `weightFor(s)`, `choiceCount(s)`, `lettersUpTo(groups,g)`, `shuffle(a,rand?)`, `pickTarget(pool,stats,lang,last,rand?)`, `pickDistractors(target,pool,stats,lang,n,rand?)`, `canUnlockNext(groups,g,stats,lang)`, `totals(groups,stats,lang)`, `CONFUSABLE`, `NEW_PER_SESSION`.
- Data shape: `{"groups":[{"letters":[{"l":"m","w":"mano","e":"✋","ph":"optional"}]}]}`.

- [ ] **Step 1: Write the failing tests**

Create `tests/sounds.mjs`:

```js
// Unit tests for the letter-sound data and pure selection logic. Plain Node, no DOM.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sKey, phOf, isMastered, weightFor, choiceCount, lettersUpTo, shuffle,
  pickTarget, pickDistractors, canUnlockNext, totals,
} from '../src/sounds.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };

const DATA = { es: readJSON('src/data/sounds.es.json'), ca: readJSON('src/data/sounds.ca.json') };

// ---------- data integrity ----------
for (const lang of ['es', 'ca']) {
  const groups = DATA[lang].groups;
  const all = groups.flatMap((g) => g.letters);
  const problems = [];
  if (!groups.length) problems.push('no groups');
  groups.forEach((g, i) => { if (g.letters.length < 3 || g.letters.length > 5) problems.push(`group ${i} has ${g.letters.length} letters`); });
  const seen = new Set();
  all.forEach((x) => {
    if (seen.has(x.l)) problems.push('dup ' + x.l);
    seen.add(x.l);
    if (!x.w || !x.w.toLowerCase().startsWith(x.l)) problems.push(`word "${x.w}" must start with "${x.l}"`);
    if (!x.e) problems.push('no emoji for ' + x.l);
    if (x.ph !== undefined && typeof x.ph !== 'string') problems.push('bad ph on ' + x.l);
  });
  check(`[${lang}] sounds data is well formed`, problems.length === 0, problems.slice(0, 4).join(' | '));
}

// ---------- keys, weights, mastery ----------
check('keys: es has no prefix, ca has ca:', sKey('es', 'm') === 'snd:m' && sKey('ca', 'm') === 'ca:snd:m');
const near = (a, b) => Math.abs(a - b) < 1e-9;
check('weight: unseen 2.5, two ok 0.3, two fails 6', near(weightFor(undefined), 2.5) && near(weightFor({ ok: 2, fail: 0 }), 0.3) && near(weightFor({ ok: 0, fail: 2 }), 6));
check('weight: never below 0.25', near(weightFor({ ok: 50, fail: 0 }), 0.25));
check('mastered: ok>=2 and ok>fail', isMastered({ ok: 2, fail: 0 }) && !isMastered({ ok: 2, fail: 2 }) && !isMastered({ ok: 1, fail: 0 }) && !isMastered(undefined));
check('choices: 2 until mastered, then 3', choiceCount(undefined) === 2 && choiceCount({ ok: 1, fail: 0 }) === 2 && choiceCount({ ok: 2, fail: 0 }) === 3);

// ---------- pools and targets ----------
const gEs = DATA.es.groups;
check('pool grows with the unlocked group', lettersUpTo(gEs, 0).length === gEs[0].letters.length && lettersUpTo(gEs, 1).length === gEs[0].letters.length + gEs[1].letters.length);
const tiny = [{ l: 'a' }, { l: 'e' }, { l: 'i' }];
let repeat = 0;
for (let i = 0; i < 300; i++) if (pickTarget(tiny, {}, 'es', 'a').l === 'a') repeat++;
check('target: never repeats the last letter when others exist', repeat === 0);
check('target: a one-letter pool may repeat', pickTarget([{ l: 'a' }], {}, 'es', 'a').l === 'a');
check('target: rand=0 picks the first candidate, rand~1 the last', pickTarget(tiny, {}, 'es', null, () => 0).l === 'a' && pickTarget(tiny, {}, 'es', null, () => 0.999999).l === 'i');
const stats = { 'snd:a': { ok: 0, fail: 5 }, 'snd:e': { ok: 9, fail: 0 }, 'snd:i': { ok: 9, fail: 0 } };
let hard = 0;
for (let i = 0; i < 600; i++) if (pickTarget(tiny, stats, 'es', null).l === 'a') hard++;
check('target: a letter that keeps failing comes back much more often', hard > 450, `${hard}/600`);

// ---------- distractors ----------
// Review Focus 1: homophones (b/v, c/qu) are never offered together.
for (const lang of ['es', 'ca']) {
  const pool = DATA[lang].groups.flatMap((g) => g.letters);
  let clash = 0;
  for (const target of pool) {
    for (let i = 0; i < 100; i++) {
      pickDistractors(target, pool, {}, lang, 2).forEach((d) => { if (phOf(d) === phOf(target) || d.l === target.l) clash++; });
    }
  }
  check(`[${lang}] distractors never share the target's sound`, clash === 0, `${clash} clashes`);
}
check('b and v exist as homophones in es and ca', ['es', 'ca'].every((l) => { const p = DATA[l].groups.flatMap((g) => g.letters); return phOf(p.find((x) => x.l === 'v')) === phOf(p.find((x) => x.l === 'b')); }));
// Review Focus 2: enough distractors at every stage, in both languages.
for (const lang of ['es', 'ca']) {
  let short = 0;
  DATA[lang].groups.forEach((_, gi) => {
    const pool = lettersUpTo(DATA[lang].groups, gi);
    pool.forEach((target) => { if (pickDistractors(target, pool, {}, lang, 2).length < 2) short++; });
  });
  check(`[${lang}] every target has 2 distractors at every unlocked group`, short === 0, `${short} short`);
}
const vowels = [{ l: 'a' }, { l: 'e' }, { l: 'i' }, { l: 'o' }, { l: 'u' }];
let notSeen = 0;
for (let i = 0; i < 200; i++) if (pickDistractors({ l: 'a' }, vowels, { 'snd:a': { ok: 0, fail: 0 }, 'snd:e': { ok: 1, fail: 0 } }, 'es', 1)[0].l !== 'e') notSeen++;
check('distractors: letters already seen are preferred', notSeen === 0);
const bd = [{ l: 'b' }, { l: 'd' }, { l: 'p' }];
check('distractors: confusable pairs stay apart until both are mastered', pickDistractors({ l: 'b' }, [...bd, { l: 'x' }], {}, 'es', 1)[0].l === 'x');
const mast = { 'snd:b': { ok: 3, fail: 0 }, 'snd:d': { ok: 3, fail: 0 } };
let withD = 0;
for (let i = 0; i < 200; i++) if (pickDistractors({ l: 'b' }, [{ l: 'b' }, { l: 'd' }], mast, 'es', 1)[0]?.l === 'd') withD++;
check('distractors: mastered confusable pair may appear together', withD === 200);
check('distractors: confusable pair is used as a last resort, not skipped', pickDistractors({ l: 'b' }, [{ l: 'b' }, { l: 'd' }], {}, 'es', 1)[0]?.l === 'd');
const order = [1, 2, 3, 4];
const sh = shuffle(order, () => 0.5);
check('shuffle: keeps the elements and does not mutate', sh.length === 4 && [...sh].sort().join() === '1,2,3,4' && order.join() === '1,2,3,4');

// ---------- unlocking and progress ----------
const grp = (n) => ({ letters: Array.from({ length: n }, (_, i) => ({ l: 'abcde'[i] })) });
const four = [grp(4), grp(4)];
const m = (ls) => Object.fromEntries(ls.map((l) => ['snd:' + l, { ok: 3, fail: 0 }]));
check('unlock: 2 of 4 mastered is not enough', !canUnlockNext(four, 0, m(['a', 'b']), 'es'));
check('unlock: 3 of 4 mastered offers the next group', canUnlockNext(four, 0, m(['a', 'b', 'c']), 'es'));
check('unlock: never past the last group', !canUnlockNext(four, 1, m(['a', 'b', 'c', 'd']), 'es'));
check('unlock: uses the language prefix', !canUnlockNext(four, 0, m(['a', 'b', 'c']), 'ca'));
const tt = totals(four, m(['a', 'b']), 'es');
check('totals: counts mastered letters over all groups', tt.done === 2 && tt.total === 8);

console.log(failures ? `\n${failures} sounds test(s) FAILED` : '\nAll sounds tests passed');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/sounds.mjs`
Expected: FAIL with an error like `Cannot find module '.../src/sounds.js'` (or the JSON files).

- [ ] **Step 3: Create the data files**

Create `src/data/sounds.es.json`:

```json
{
  "groups": [
    { "letters": [
      { "l": "a", "w": "avión", "e": "✈️" },
      { "l": "e", "w": "elefante", "e": "🐘" },
      { "l": "i", "w": "iglesia", "e": "⛪" },
      { "l": "o", "w": "oso", "e": "🐻" },
      { "l": "u", "w": "uva", "e": "🍇" }
    ] },
    { "letters": [
      { "l": "m", "w": "mano", "e": "✋" },
      { "l": "s", "w": "sol", "e": "☀️" },
      { "l": "l", "w": "luna", "e": "🌙" },
      { "l": "p", "w": "pato", "e": "🦆" }
    ] },
    { "letters": [
      { "l": "t", "w": "tomate", "e": "🍅" },
      { "l": "n", "w": "nube", "e": "☁️" },
      { "l": "d", "w": "dedo", "e": "👆" },
      { "l": "c", "w": "casa", "e": "🏠" }
    ] },
    { "letters": [
      { "l": "r", "w": "rana", "e": "🐸" },
      { "l": "b", "w": "barco", "e": "⛵" },
      { "l": "f", "w": "foca", "e": "🦭" },
      { "l": "g", "w": "gato", "e": "🐱" }
    ] },
    { "letters": [
      { "l": "v", "w": "vaca", "e": "🐮", "ph": "b" },
      { "l": "j", "w": "jirafa", "e": "🦒" },
      { "l": "z", "w": "zapato", "e": "👟" },
      { "l": "ñ", "w": "ñoquis", "e": "🍝" }
    ] },
    { "letters": [
      { "l": "ch", "w": "chocolate", "e": "🍫" },
      { "l": "ll", "w": "lluvia", "e": "🌧️" },
      { "l": "qu", "w": "queso", "e": "🧀", "ph": "c" }
    ] }
  ]
}
```

Create `src/data/sounds.ca.json` (words are first guesses; they need the native review already listed as a pending item in CLAUDE.md):

```json
{
  "groups": [
    { "letters": [
      { "l": "a", "w": "avió", "e": "✈️" },
      { "l": "e", "w": "elefant", "e": "🐘" },
      { "l": "i", "w": "illa", "e": "🏝️" },
      { "l": "o", "w": "ocell", "e": "🐦" },
      { "l": "u", "w": "ull", "e": "👁️" }
    ] },
    { "letters": [
      { "l": "m", "w": "mà", "e": "✋" },
      { "l": "s", "w": "sol", "e": "☀️" },
      { "l": "l", "w": "lupa", "e": "🔍" },
      { "l": "p", "w": "pera", "e": "🍐" }
    ] },
    { "letters": [
      { "l": "t", "w": "tomàquet", "e": "🍅" },
      { "l": "n", "w": "nas", "e": "👃" },
      { "l": "d", "w": "dit", "e": "👆" },
      { "l": "c", "w": "casa", "e": "🏠" }
    ] },
    { "letters": [
      { "l": "r", "w": "rata", "e": "🐀" },
      { "l": "b", "w": "barca", "e": "⛵" },
      { "l": "f", "w": "foca", "e": "🦭" },
      { "l": "g", "w": "gat", "e": "🐱" }
    ] },
    { "letters": [
      { "l": "v", "w": "vaca", "e": "🐮", "ph": "b" },
      { "l": "j", "w": "joguina", "e": "🧸" },
      { "l": "z", "w": "zebra", "e": "🦓" },
      { "l": "x", "w": "xocolata", "e": "🍫" }
    ] },
    { "letters": [
      { "l": "ll", "w": "lluna", "e": "🌙" },
      { "l": "ny", "w": "nyu", "e": "🐃" },
      { "l": "tx", "w": "txec", "e": "🇨🇿" }
    ] }
  ]
}
```

- [ ] **Step 4: Create `src/sounds.js` with the pure logic**

```js
// Leemos letter sounds (pre-reader profile). ES module with no globals: everything the app owns
// comes in through ctx (see createSounds). The pure helpers below are unit-tested in tests/sounds.mjs.

export const NEW_PER_SESSION=2;
// Letters children mix up; only offered together once both are mastered.
export const CONFUSABLE=[['m','n'],['b','d'],['p','b']];

export const sKey=(lang,l)=>(lang==='ca'?'ca:':'')+'snd:'+l;
export const phOf=x=>x.ph||x.l;
export const isMastered=s=>!!s&&s.ok>=2&&s.ok>s.fail;
export const weightFor=s=>{s=s||{ok:0,fail:0};return Math.max(.25,1+s.fail*2.5-s.ok*.35+(s.ok+s.fail===0?1.5:0))};
export const choiceCount=s=>isMastered(s)?3:2;
export const lettersUpTo=(groups,g)=>groups.slice(0,g+1).flatMap(x=>x.letters);
export const shuffle=(a,rand=Math.random)=>a.map(v=>[rand(),v]).sort((p,q)=>p[0]-q[0]).map(p=>p[1]);

export function pickTarget(pool,stats,lang,last,rand=Math.random){
  const cands=pool.length>1?pool.filter(x=>x.l!==last):pool;
  const wts=cands.map(x=>weightFor(stats[sKey(lang,x.l)]));
  let r=rand()*wts.reduce((a,b)=>a+b,0);
  for(let i=0;i<cands.length;i++){r-=wts[i];if(r<=0)return cands[i]}
  return cands[cands.length-1];
}

const confusable=(a,b)=>CONFUSABLE.some(([x,y])=>(x===a&&y===b)||(x===b&&y===a));
// Distractors: never the same sound as the target; seen letters first; confusable pairs only as a last resort.
export function pickDistractors(target,pool,stats,lang,n,rand=Math.random){
  const st=l=>stats[sKey(lang,l)];
  const cands=pool.filter(x=>x.l!==target.l&&phOf(x)!==phOf(target));
  const apart=x=>!confusable(target.l,x.l)||(isMastered(st(target.l))&&isMastered(st(x.l)));
  const good=cands.filter(apart),risky=cands.filter(x=>!apart(x));
  const seen=good.filter(x=>st(x.l)),fresh=good.filter(x=>!st(x.l));
  return [...shuffle(seen,rand),...shuffle(fresh,rand),...shuffle(risky,rand)].slice(0,n);
}

// The next group is offered when at least 3 of every 4 letters of the current one are mastered.
export const canUnlockNext=(groups,g,stats,lang)=>{
  if(g>=groups.length-1)return false;
  const ls=groups[g].letters;
  return ls.filter(x=>isMastered(stats[sKey(lang,x.l)])).length/ls.length>=.75;
};
export function totals(groups,stats,lang){
  const all=groups.flatMap(g=>g.letters);
  return {done:all.filter(x=>isMastered(stats[sKey(lang,x.l)])).length,total:all.length};
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node tests/sounds.mjs`
Expected: every line `PASS`, ending with `All sounds tests passed`.

- [ ] **Step 6: Hook it into `npm test`**

In `package.json` change the test script to:

```json
"test": "node tests/smoke.mjs && node tests/sounds.mjs",
```

Run: `npm test`
Expected: both suites pass.

- [ ] **Step 7: Commit (spec and plan travel with the first commit)**

```bash
git add docs/superpowers src/data/sounds.es.json src/data/sounds.ca.json src/sounds.js tests/sounds.mjs package.json
git commit -m "feat(sounds): letter data and pure selection logic for pre-reader mode" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Audio pipeline for letter sounds (with a go/no-go checkpoint)

**Files:**
- Modify: `scripts/lib/clips.mjs`, `scripts/spoken.mjs`, `tests/sounds.mjs`
- Create (generated, after the checkpoint): `audio/es/*.mp3`, `audio/ca/*.mp3`, updated `audio/manifest.json`; overrides in `src/data/pronunciation.<lang>.json` as needed

**Interfaces:**
- Consumes: `src/data/sounds.<lang>.json` (Task 1).
- Produces: clips with `kind: 'sound'` (key = the letter, lowercase) and `kind: 'word'` for each picture word, so `say('m')` and `say('mano')` find them. `spokenFor` handles `kind: 'sound'`.

- [ ] **Step 1: Write the failing tests**

In `tests/sounds.mjs`, add this import next to the others:

```js
import { buildClipList } from '../scripts/lib/clips.mjs';
```

and this block immediately above the final `console.log(failures ? ...` line:

```js
// ---------- audio clip list ----------
const clips = buildClipList({ name: 'Leo' });
const hasClip = (lang, key, kind) => clips.some((c) => c.lang === lang && c.key === key && (!kind || c.kind === kind));
for (const lang of ['es', 'ca']) {
  const all = DATA[lang].groups.flatMap((g) => g.letters);
  check(`[${lang}] every letter sound is a clip of kind "sound"`, all.every((x) => hasClip(lang, x.l, 'sound')), all.filter((x) => !hasClip(lang, x.l, 'sound')).map((x) => x.l).join(','));
  check(`[${lang}] every picture word is a clip`, all.every((x) => hasClip(lang, x.w.toLowerCase())));
}
const fileSeen = new Set(); let fileDup = 0;
clips.forEach((c) => { const k = c.lang + '/' + c.file; if (fileSeen.has(k)) fileDup++; fileSeen.add(k); });
check('clips: no two clips share a file name', fileDup === 0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/sounds.mjs`
Expected: FAIL on the "every letter sound is a clip" lines (the clip list does not know about sounds yet).

- [ ] **Step 3: Add the sounds to the clip list**

In `scripts/lib/clips.mjs`, inside `for (const lang of langs) {`, add this right after the opening line and before `const levels = ...` (sounds are added first so that a one-letter key such as `a` is classified as a sound, not a syllable):

```js
    const sounds = readJSON(`src/data/sounds.${lang}.json`);
    for (const g of sounds.groups) {
      for (const x of g.letters) {
        add(lang, x.l, 'sound');
        add(lang, x.w, 'word');
      }
    }
```

- [ ] **Step 4: Tell the generator what to send for a sound**

In `scripts/spoken.mjs`, add a case before `default`:

```js
    case 'sound':
      return clip.text; // experiment here: a lone "m" is often read as the letter name "eme"
```

Also extend the header comment's list of ideas with one line: `//   - for sounds: try "mmm", a doubled vowel, or IPA on Azure/Google: <phoneme alphabet='ipa' ph='m'>m</phoneme>`.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: all pass. Then run `npm run audio:plan` and note that the `es/sound` and `ca/sound` counts appear (24 and 24 plus the new picture words).

- [ ] **Step 6: Commit the code**

```bash
git add scripts/lib/clips.mjs scripts/spoken.mjs tests/sounds.mjs
git commit -m "feat(audio): include letter sounds and picture words in the clip list" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: CHECKPOINT: generate a first batch and listen (human in the loop)**

This is the spec's main risk. Do it before building any screen.

```bash
npm run audio -- --provider edge --lang es --only "a,e,i,o,u,m,s,l,p"
npm run audio -- --provider edge --lang ca --only "a,e,i,o,u,m,s,l,p"
npm run dev
```

Open `http://localhost:5173/tools/review.html`, search each letter, listen, mark the bad ones. For each bad clip try, in this order: (1) a `pronunciation.<lang>.json` override such as `{"m": "mmm"}` and regenerate with `--only m --force`; (2) a different override; (3) give up on it and add it to the "needs Fran's voice" list.

Record the result as a table in your report: letter, language, OK / fixed with override `X` / needs recording. Expect vowels to pass and many consonants to fail on `edge`. Azure, Google and ElevenLabs support IPA/SSML but have never been tried with real keys here.

**Stop here and report to Fran** if more than half of the 18 clips need recordings. The screens (Tasks 3 to 5) and the recorder do not change, but he should decide whether to try a paid provider first. If he says go on, continue.

- [ ] **Step 8: Commit the audio and overrides**

```bash
git add audio src/data/pronunciation.es.json src/data/pronunciation.ca.json
git commit -m "feat(audio): first batch of letter-sound clips and overrides" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

(Generating the remaining groups is `npm run audio -- --provider edge` once the first batch is settled; do it at the end, in Task 6.)

---

### Task 3: Profiles (Elsa untouched, add and switch children)

**Files:**
- Modify: `src/app.js`, `index.html`, `src/styles.css`, `src/data/i18n.es.json`, `src/data/i18n.ca.json`, `tests/smoke.mjs`

**Interfaces:**
- Produces in `app.js`: `PROFILES` (`{active, list:[{id,name,kind}]}`), `PROFILE` (the active entry), `keyFor(id)`, `switchProfile(id)`, `addProfile(name,kind)`, `updateProfileChip()`; state field `S.pre` (`{es:0,ca:0}`, unlocked group index per language); `S.name` defaults to the profile's name; `S.sessionLen` defaults to 5 for `pre` profiles.
- Produces in `tests/smoke.mjs`: `boot({storage})` seeds `localStorage` before the app runs; helper `dump(w)`.

- [ ] **Step 1: Extend the test harness and write the failing tests**

In `tests/smoke.mjs`:

1. Change the first import to `import { JSDOM, VirtualConsole } from 'jsdom';`
2. Change the `boot` signature and add a virtual console that ignores jsdom's "navigation not implemented" message (raised by `location.reload()`):

```js
async function boot({ manifest = null, lang = 'en-US', storage = {} } = {}) {
  const errors = [];
  const audioCalls = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented: navigation/.test(e.message)) console.error(e.message); });
  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/', virtualConsole: vc,
    beforeParse(w) {
      Object.defineProperty(w.navigator, 'language', { value: lang });
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
```

(keep the rest of `beforeParse` and of `boot` exactly as it is.)

3. Add this helper next to `playSession`:

```js
const dump = (w) => Object.fromEntries(Array.from({ length: w.localStorage.length }, (_, i) => w.localStorage.key(i)).map((k) => [k, w.localStorage.getItem(k)]));
```

4. Insert this block immediately above the final `console.log(failures ? ...` line:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/smoke.mjs`
Expected: the new profile checks FAIL (`profileName` / `profileBtn` do not exist; some lines may throw on `null`). The earlier checks still pass.

- [ ] **Step 3: Add the i18n keys**

In `src/data/i18n.es.json` replace the last two lines

```
  "sample": "masa"
}
```

with

```
  "sample": "masa",
  "aProfile": "Cambiar de niño o niña",
  "profilesTitle": "¿Quién juega?",
  "profilesSub": "Cada niño o niña tiene su propio progreso y sus pegatinas.",
  "pfKind": "Tipo",
  "pfKindReader": "Ya lee sílabas",
  "pfKindPre": "Aprende letras y sonidos",
  "pfAdd": "Añadir"
}
```

In `src/data/i18n.ca.json` replace

```
  "sample": "casa"
}
```

with

```
  "sample": "casa",
  "aProfile": "Canviar de nen o nena",
  "profilesTitle": "Qui juga?",
  "profilesSub": "Cada nen o nena té el seu propi progrés i les seves enganxines.",
  "pfKind": "Tipus",
  "pfKindReader": "Ja llegeix síl·labes",
  "pfKindPre": "Aprèn lletres i sons",
  "pfAdd": "Afegir"
}
```

- [ ] **Step 4: HTML: chip and overlay**

In `index.html`, add as the first child of `<div class="hdr-actions">`:

```html
      <button class="icon-btn" id="profileBtn" data-ia="title:aProfile;aria-label:aProfile" title="Cambiar de niño o niña" aria-label="Cambiar de niño o niña">🧒 <span id="profileName"></span></button>
```

and add this overlay right after the `worlds` overlay (the block ending with `worldsClose`):

```html
<div class="overlay" id="profiles" hidden>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="profilesTitle">
    <h2 id="profilesTitle" data-i="profilesTitle">¿Quién juega?</h2>
    <p class="small" data-i="profilesSub">Cada niño o niña tiene su propio progreso y sus pegatinas.</p>
    <div class="worlds" id="profileList"></div>
    <div class="pf-row">
      <label for="pfName" data-i="lName">Nombre</label>
      <input type="text" id="pfName" maxlength="20" autocomplete="off">
    </div>
    <div class="pf-row">
      <select id="pfKind" data-ia="aria-label:pfKind" aria-label="Tipo">
        <option value="reader" data-i="pfKindReader">Ya lee sílabas</option>
        <option value="pre" data-i="pfKindPre">Aprende letras y sonidos</option>
      </select>
      <button class="icon-btn" id="pfAdd" data-i="pfAdd">Añadir</button>
    </div>
    <div class="actions"><button class="btn primary" id="profilesClose" data-i="close">Cerrar</button></div>
  </div>
</div>
```

- [ ] **Step 5: CSS**

Append to `src/styles.css`, above the final `@media (prefers-reduced-motion: reduce)` block:

```css
.hdr-actions{flex-wrap:wrap}
.pf-row{display:flex;align-items:center;gap:10px;margin:12px 0}
.pf-row input,.pf-row select{flex:1;min-height:44px;font:inherit;border:2px solid var(--line);border-radius:12px;padding:6px 10px;background:var(--panel);color:var(--ink)}
```

- [ ] **Step 6: `app.js`: profiles block, state defaults**

Replace the single line `const KEY='leemos-v1';` (line 34) with:

```js
// ---------- profiles (one saved state per child; Elsa keeps the original key) ----------
const PKEY='leemos-profiles';
const loadProfiles=()=>{
  try{
    const p=JSON.parse(localStorage.getItem(PKEY));
    if(p&&Array.isArray(p.list)&&p.list.length&&p.list.every(x=>x&&typeof x.id==='string'&&x.id)&&p.list.some(x=>x.id===p.active))return p;
  }catch(e){}
  return {active:'elsa',list:[{id:'elsa',name:'Elsa',kind:'reader'}]};
};
const PROFILES=loadProfiles();
const PROFILE=PROFILES.list.find(x=>x.id===PROFILES.active);
const saveProfiles=()=>{try{localStorage.setItem(PKEY,JSON.stringify(PROFILES))}catch(e){}};
const keyFor=id=>id==='elsa'?'leemos-v1':'leemos-v1:'+id;
const profileSlug=n=>n.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
function switchProfile(id){PROFILES.active=id;saveProfiles();location.reload()}
function addProfile(name,kind){
  const base=profileSlug(name)||'nino';let id=base,i=2;
  while(PROFILES.list.some(x=>x.id===id))id=base+'-'+i++;
  PROFILES.list.push({id,name:name.trim(),kind:kind==='pre'?'pre':'reader'});
  switchProfile(id);
}
const KEY=keyFor(PROFILE.id);
```

Then make three small edits to the state lines that follow:
- In the `const S=Object.assign({...},load());` line change `name:'Elsa',total:0` to `name:PROFILE.name,total:0`.
- In the same line change `sessionLen:10},load());` to `sessionLen:PROFILE.kind==='pre'?5:10,pre:{es:0,ca:0}},load());`
- After the line `if(!S.voiceURIs)S.voiceURIs={es:'',ca:''};` add `if(!S.pre)S.pre={es:0,ca:0};`

- [ ] **Step 7: `app.js`: overlay wiring, chip, rename sync**

- In `closeOverlays`, change `$('worlds').hidden=true;closeRec();` to `$('worlds').hidden=true;$('profiles').hidden=true;closeRec();`
- Change `['album','reward','worlds'].forEach(` to `['album','reward','worlds','profiles'].forEach(`
- Right after the line `$('worldsClose').onclick=closeOverlays;` add:

```js
function updateProfileChip(){$('profileName').textContent=PROFILE.name}
function renderProfiles(){
  const g=$('profileList');g.innerHTML='';
  PROFILES.list.forEach(p=>{
    const b=document.createElement('button');
    b.className='wbtn';b.setAttribute('aria-pressed',p.id===PROFILES.active);
    const ic=document.createElement('span');ic.textContent=p.kind==='pre'?'🔤':'📖';
    b.append(ic,document.createTextNode(p.name));
    b.onclick=()=>{if(p.id!==PROFILES.active)switchProfile(p.id);else closeOverlays()};
    g.appendChild(b);
  });
}
$('profileBtn').onclick=()=>{renderProfiles();$('profiles').hidden=false;$('profilesClose').focus()};
$('profilesClose').onclick=closeOverlays;
$('pfAdd').onclick=()=>{const n=$('pfName').value.trim();if(n)addProfile(n,$('pfKind').value)};
```

- In the `$('nm').oninput` handler, after `S.name=e.target.value;save();updateHello();` add:

```js
  const pn=S.name.trim();if(pn){PROFILE.name=pn;saveProfiles();updateProfileChip()}
```

- On the last-but-two line `applyTheme();applyCase();applySound();applyLang();loadClips();` append `updateProfileChip();`

- [ ] **Step 8: Run the tests**

Run: `npm test`
Expected: all PASS, including the new profile checks and every earlier one (Elsa's flows unchanged).

- [ ] **Step 9: Commit**

```bash
git add src/app.js index.html src/styles.css src/data/i18n.es.json src/data/i18n.ca.json tests/smoke.mjs
git commit -m "feat(profiles): per-child saved state with switcher; Elsa's key untouched" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Note: until Task 4 lands, a `pre` profile still shows the reader screen. Do not release between Tasks 3 and 5.

---

### Task 4: Sounds home, intro card and game

**Files:**
- Modify: `src/sounds.js` (append `createSounds`), `src/app.js`, `index.html`, `src/styles.css`, `sw.js`, `src/data/i18n.es.json`, `src/data/i18n.ca.json`, `tests/smoke.mjs`

**Interfaces:**
- Consumes (Task 1): `sKey, isMastered, choiceCount, lettersUpTo, shuffle, pickTarget, pickDistractors, totals, NEW_PER_SESSION`. (Task 3): `PROFILE`, `S.pre`.
- Produces: `createSounds(ctx)` returning `{ refresh, begin, next }` (Task 5 extends it). `ctx` fields: `doc, $, S, save, t, say, sfx, poke, burst, sparkle, rnd, fmt, nm, later, data:{es,ca}, stickers, sess:{reset(),inc(ok),done,addSticker()}, renderSession, renderGoal, renderAlbum, renderHard, end, reward(emoji)`.
- DOM ids produced: `pre` (container), `prePlay`, `preLetter`, `preWord`, `preNext`, `preHear`, `preChoices` (with `data-answer`), `.pre-choice` (with `data-l`), `prePic`.
- In `app.js`: `let pre=null` (the sounds instance, `null` for readers).

- [ ] **Step 1: Extend the harness and write the failing tests**

In `tests/smoke.mjs`:

1. Change `import { fileURLToPath } from 'node:url';` to `import { fileURLToPath, pathToFileURL } from 'node:url';`
2. In `boot`'s `beforeParse`, after the `Object.defineProperty(w.navigator, ...)` / storage lines, add the import seam:

```js
      w.__leemosImport = (p) => import(pathToFileURL(join(ROOT, 'src', p)).href);
```

3. Insert this block immediately above the final `console.log(failures ? ...` line:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/smoke.mjs`
Expected: the new `sounds:` checks FAIL (no `prePlay`; `bootLeo` times out after 2 s per boot). Earlier checks pass.

- [ ] **Step 3: i18n keys**

In `src/data/i18n.es.json`, replace the last key line `  "pfAdd": "Añadir"` with:

```
  "pfAdd": "Añadir",
  "prePlay": "Jugar",
  "preHello": "¡Hola, {n}! ¿Jugamos con los sonidos?",
  "preProgress": "{d} de {n} letras dominadas",
  "preIntroHint": "Toca la letra para oír cómo suena.",
  "preNext": "Siguiente",
  "preGameHint": "Escucha el sonido y toca su letra.",
  "preHear": "Escuchar",
  "preNos": ["Casi, {n}. Escucha otra vez.", "Casi. Escucha con atención, {n}.", "Poco a poco, {n}. Escucha otra vez."],
  "prePIntro": "Primero escucha el sonido de la letra y toca la letra que corresponde. Si falla, no pasa nada: se lo repetimos. Lo que le cuesta vuelve más a menudo."
```

In `src/data/i18n.ca.json`, replace `  "pfAdd": "Afegir"` with:

```
  "pfAdd": "Afegir",
  "prePlay": "Jugar",
  "preHello": "Hola, {n}! Juguem amb els sons?",
  "preProgress": "{d} de {n} lletres dominades",
  "preIntroHint": "Toca la lletra per sentir com sona.",
  "preNext": "Següent",
  "preGameHint": "Escolta el so i toca la seva lletra.",
  "preHear": "Escoltar",
  "preNos": ["Gairebé, {n}. Escolta un altre cop.", "Gairebé. Escolta amb atenció, {n}.", "Poc a poc, {n}. Escolta un altre cop."],
  "prePIntro": "Primer escolta el so de la lletra i toca la lletra que correspon. Si falla, no passa res: li ho repetim. El que li costa torna més sovint."
```

- [ ] **Step 4: Append `createSounds` to `src/sounds.js`**

```js

const face=l=>l.toUpperCase()+l;

// The pre-reader flow. ctx supplies state, audio and rewards from app.js (see the "letter sounds" block at the end of app.js).
export function createSounds(ctx){
  const {doc,$,S,save,t,say,sfx}=ctx;
  const lang=()=>S.lang;
  const groups=()=>(ctx.data[lang()]||ctx.data.es).groups;
  const gi=()=>Math.min(S.pre[lang()]||0,groups().length-1);
  const pool=()=>lettersUpTo(groups(),gi());
  const key=l=>sKey(lang(),l);
  const seen=l=>!!S.stats[key(l)];
  const stat=l=>S.stats[key(l)]||(S.stats[key(l)]={ok:0,fail:0});
  const el=(tag,cls,txt)=>{const e=doc.createElement(tag);if(cls)e.className=cls;if(txt!==undefined)e.textContent=txt;return e};
  const room=()=>$('pre');
  let cur=null,last=null,wrong=false,busy=false,fresh=0;

  function home(){
    cur=null;busy=false;
    doc.body.classList.add('pre-home');
    const {done,total}=totals(groups(),S.stats,lang());
    const play=el('button','btn primary pre-play',t('prePlay'));play.id='prePlay';
    play.onclick=begin;
    room().replaceChildren(play,el('p','small',t('preProgress',{d:done,n:total})));
    $('hint').textContent=t('preHello',{n:ctx.nm()});
  }
  function begin(){
    doc.body.classList.remove('pre-home');
    fresh=0;last=null;
    ctx.sess.reset();
    next();
  }
  function next(){
    let cands=pool();
    if(fresh>=NEW_PER_SESSION){const known=cands.filter(x=>seen(x.l));if(known.length)cands=known}
    const x=pickTarget(cands,S.stats,lang(),last);
    last=x.l;
    if(seen(x.l))game(x);else{fresh++;intro(x)}
  }
  // Intro card: the picture is shown on purpose here (the goal is sound-letter linking, not reading).
  function intro(x){
    cur=null;busy=false;
    stat(x.l);save();
    const letter=el('button','pre-letter');letter.id='preLetter';
    letter.setAttribute('aria-label',x.l);
    letter.append(el('span','up',x.l.toUpperCase()),el('span','lo',x.l));
    letter.onclick=()=>say(x.l);
    const word=el('button','pre-word');word.id='preWord';
    word.append(el('span','pre-pic',x.e),el('span','',x.w));
    word.onclick=()=>say(x.w);
    const go=el('button','btn primary',t('preNext'));go.id='preNext';
    go.onclick=()=>game(x);
    const card=el('div','pre-card');card.append(letter,word,go);
    room().replaceChildren(card);
    $('hint').textContent=t('preIntroHint');
    say(x.l);
  }
  function game(x){
    cur=x;wrong=false;busy=false;
    const n=choiceCount(S.stats[key(x.l)]);
    const opts=shuffle([x,...pickDistractors(x,pool(),S.stats,lang(),n-1)]);
    const hear=el('button','btn pre-hear','🔊 '+t('preHear'));hear.id='preHear';
    hear.onclick=()=>say(x.l);
    const row=el('div','pre-choices');row.id='preChoices';
    row.dataset.answer=x.l; // test hook; the child cannot read the DOM
    opts.forEach(o=>{
      const b=el('button','pre-choice',face(o.l));
      b.dataset.l=o.l;b.setAttribute('aria-label',o.l);
      b.onclick=()=>choose(o,b,x);
      row.appendChild(b);
    });
    room().replaceChildren(hear,row);
    $('hint').textContent=t('preGameHint');
    say(x.l);
  }
  function choose(o,b,x){
    if(busy||cur!==x)return;
    if(o.l===x.l){correct(x,b);return}
    sfx.retry();ctx.poke('tilt',800);
    b.classList.add('gone');b.disabled=true;
    if(!wrong){wrong=true;stat(x.l).fail++;save();ctx.renderHard()}
    $('hint').textContent=ctx.fmt(ctx.rnd(t('preNos')));
    say(x.l); // replay the sound so the next try is informed
  }
  function correct(x,b){
    busy=true;
    b.classList.add('right');
    if(!wrong)stat(x.l).ok++;
    S.total++;
    ctx.burst();sfx.ok();ctx.poke('cheer',900);ctx.sparkle($('mascot'),10);
    const pic=el('div','pre-pic big',x.e);pic.id='prePic';
    room().appendChild(pic);
    $('hint').textContent=ctx.fmt(ctx.rnd(t('oks')));
    ctx.sess.inc(!wrong);
    const finished=ctx.sess.done>=S.sessionLen;
    let reward=null;
    if(finished&&S.stickers<ctx.stickers.length){S.stickers++;reward=ctx.stickers[S.stickers-1];ctx.sess.addSticker()}
    save();
    ctx.renderSession();ctx.renderGoal();ctx.renderAlbum();ctx.renderHard();
    if(reward)ctx.reward(reward);
    else if(finished)ctx.later(ctx.end,1100);
    else ctx.later(next,1300);
  }

  return {refresh:home,begin,next};
}
```

- [ ] **Step 5: `app.js`: the `pre` variable, hard-list label, and the loader block**

- On the line `let cur=null,last=null,phase='read',resetArmed=false;` add a new line right after it: `let pre=null;`
- In `renderHard`, change `c.textContent=k.replace(/^ca:/,'').slice(2);` to `c.textContent=k.replace(/^ca:/,'').replace(/^(snd|s|w):/,'');`
- Replace the last line of the file `if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});` with itself followed by:

```js

// ---------- letter sounds (pre-reader profile; spec in docs/superpowers/specs) ----------
if(PROFILE.kind==='pre'){
  document.documentElement.classList.add('pre');
  cur=null;phase='wait';
  const imp=window.__leemosImport||(p=>import(p));
  const [mod,dEs,dCa]=await Promise.all([imp('./sounds.js'),loadJSON('src/data/sounds.es.json'),loadJSON('src/data/sounds.ca.json')]);
  const sess={reset(){sDone=sOk=sStk=0;renderSession();renderGoal()},inc(ok){sDone++;if(ok)sOk++},get done(){return sDone},addSticker(){sStk++}};
  pre=mod.createSounds({doc:document,$,S,save,t,say,sfx,poke,burst,sparkle:sparkleBurst,rnd,fmt,nm,later:(f,ms)=>setTimeout(f,ms),
    data:{es:dEs,ca:dCa},stickers:STICKERS,sess,renderSession,renderGoal,renderAlbum,renderHard,end:showEnd,
    reward:e=>{pendingEnd=true;setTimeout(()=>showReward(e),500)}});
  $('pre').hidden=false;
  document.querySelector('[data-i="pIntro"]').setAttribute('data-i','prePIntro');
  applyLang();
  pre.refresh();
}
```

- [ ] **Step 6: HTML**

In `index.html`:
- Add the container inside the stage, right after the `<div class="goal" ...></div>` line:

```html
    <div class="pre-room" id="pre" hidden></div>
```

- Add this inline script right after `<link rel="stylesheet" href="src/styles.css">` in `<head>` (it prevents a flash of the reader screen for pre profiles):

```html
<script>try{var p=JSON.parse(localStorage.getItem('leemos-profiles')),a=p&&p.list.find(function(x){return x.id===p.active});if(a&&a.kind==='pre')document.documentElement.classList.add('pre')}catch(e){}</script>
```

- [ ] **Step 7: CSS**

Append to `src/styles.css` above the final `@media (prefers-reduced-motion: reduce)` block:

```css
/* ---------- Letter sounds (pre-reader profile) ---------- */
html.pre #levels,html.pre .modes,html.pre #tiles,html.pre #pic,html.pre #stage .actions,html.pre #worldBtn,html.pre #caseBtn{display:none!important}
body.pre-home .session,body.pre-home .goal{display:none!important}
.pre-room{display:flex;flex-direction:column;align-items:center;gap:18px;width:100%}
.pre-card{display:flex;flex-direction:column;align-items:center;gap:16px;width:100%}
.pre-play{font-size:2rem;padding:22px 56px;min-height:72px}
.pre-letter{display:flex;gap:.12em;align-items:baseline;font:700 clamp(84px,26vw,150px)/1 "Andika","Comic Sans MS",sans-serif;border:0;border-radius:.2em;padding:.1em .22em;min-height:44px;background:var(--c2);color:var(--t2);box-shadow:0 6px 0 var(--edge);cursor:pointer}
.pre-letter:active{transform:translateY(3px);box-shadow:0 3px 0 var(--edge)}
.pre-word{display:flex;align-items:center;gap:12px;font:700 1.6rem/1.1 "Andika","Comic Sans MS",sans-serif;border:2px solid var(--line);background:var(--panel);color:var(--ink);border-radius:20px;padding:10px 20px;min-height:56px;cursor:pointer}
.pre-pic{font-size:56px;line-height:1}
.pre-pic.big{font-size:84px;animation:pop .5s cubic-bezier(.3,1.6,.5,1)}
.pre-choices{display:flex;gap:16px;justify-content:center;flex-wrap:wrap;width:100%}
.pre-choice{font:700 clamp(56px,18vw,96px)/1 "Andika","Comic Sans MS",sans-serif;min-width:110px;min-height:110px;border:0;border-radius:.24em;color:#fff;background:var(--c4);box-shadow:0 6px 0 var(--edge);cursor:pointer;transition:opacity .3s,transform .3s}
.pre-choice:nth-child(2){background:var(--c3)}
.pre-choice:nth-child(3){background:var(--c0)}
.pre-choice.gone{opacity:.15;transform:scale(.85);pointer-events:none}
.pre-choice.right{background:var(--ok);color:#06251A;animation:pop .5s cubic-bezier(.3,1.6,.5,1)}
.pre-letter:focus-visible,.pre-word:focus-visible,.pre-choice:focus-visible{outline:4px solid var(--ink);outline-offset:3px}
```

and add this rule inside the existing `@media (prefers-reduced-motion: reduce){ ... }` block:

```css
  .pre-choice,.pre-choice.right,.pre-pic.big{transition:none;animation:none}
```

- [ ] **Step 8: Service worker**

In `sw.js` change `const VERSION = 'leemos-v2';` to `const VERSION = 'leemos-v3';` and add to the `SHELL` array, after `'src/app.js',`: `'src/sounds.js',` and, after `'src/data/levels.es.json', 'src/data/levels.ca.json',`: `'src/data/sounds.es.json', 'src/data/sounds.ca.json',`.

- [ ] **Step 9: Run the tests**

Run: `npm test`
Expected: all PASS (smoke and sounds suites), including every earlier Elsa check.

- [ ] **Step 10: Commit**

```bash
git add src/sounds.js src/app.js index.html src/styles.css sw.js src/data/i18n.es.json src/data/i18n.ca.json tests/smoke.mjs
git commit -m "feat(sounds): pre-reader home, intro card and tap game" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Session end, group unlock, language switch, recorder, reset

**Files:**
- Modify: `src/sounds.js`, `src/app.js`, `src/data/i18n.es.json`, `src/data/i18n.ca.json`, `tests/smoke.mjs`

**Interfaces:**
- Consumes: everything from Task 4.
- Produces: `createSounds` now also returns `showEnd() -> boolean` (sets the end overlay's unlock prompt, returns whether it is offered), `unlockNext()`, `rest()`, `recItems()`. `app.js` dispatches to them when `pre` is set.

- [ ] **Step 1: Write the failing tests**

Insert this block immediately above the final `console.log(failures ? ...` line of `tests/smoke.mjs`:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/smoke.mjs`
Expected: the new checks FAIL (the end screen shows reader texts, `endLevelUpBtn` handler is the reader's, the recorder lists syllables, and so on).

- [ ] **Step 3: i18n keys**

In `src/data/i18n.es.json` replace the last line `  "prePIntro": "..."` (the full line from Task 4) by the same line followed by the new keys; i.e. change its trailing end so the object ends with:

```
  "prePIntro": "Primero escucha el sonido de la letra y toca la letra que corresponde. Si falla, no pasa nada: se lo repetimos. Lo que le cuesta vuelve más a menudo.",
  "preEndInfo": "Has acertado {o} de {n}.",
  "preGroupUp": "¡Ya conoces casi todas estas letras! ¿Probamos letras nuevas?",
  "preGroupUpBtn": "Sí, letras nuevas",
  "preRest": "¡Hasta mañana, {n}! Si quieres seguir, toca Jugar.",
  "preRecWorld": "Sonidos de las letras. Di solo el sonido, sin el nombre de la letra."
}
```

In `src/data/i18n.ca.json` the same, ending with:

```
  "prePIntro": "Primer escolta el so de la lletra i toca la lletra que correspon. Si falla, no passa res: li ho repetim. El que li costa torna més sovint.",
  "preEndInfo": "Has encertat {o} de {n}.",
  "preGroupUp": "Ja coneixes gairebé totes aquestes lletres! Provem lletres noves?",
  "preGroupUpBtn": "Sí, lletres noves",
  "preRest": "Fins demà, {n}! Si vols continuar, toca Jugar.",
  "preRecWorld": "Sons de les lletres. Digues només el so, sense el nom de la lletra."
}
```

- [ ] **Step 4: Extend `createSounds`**

In `src/sounds.js`, replace the line `  return {refresh:home,begin,next};` with:

```js
  // End of session: offer the next group when most of this one is mastered. Returns whether it is offered.
  function showEnd(){
    const up=canUnlockNext(groups(),gi(),S.stats,lang());
    $('endLevelUp').hidden=!up;$('endLevelUpBtn').hidden=!up;
    if(up){$('endLevelUp').textContent=t('preGroupUp');$('endLevelUpBtn').textContent=t('preGroupUpBtn')}
    return up;
  }
  function unlockNext(){S.pre[lang()]=Math.min(gi()+1,groups().length-1);save()}
  function rest(){home();$('hint').textContent=t('preRest',{n:ctx.nm()})}
  // Everything the parent can record: all letter sounds first, then the picture words.
  function recItems(){
    const set=new Set();
    groups().forEach(g=>g.letters.forEach(x=>set.add(x.l)));
    groups().forEach(g=>g.letters.forEach(x=>set.add(x.w)));
    return [...set];
  }

  return {refresh:home,begin,next,showEnd,unlockNext,rest,recItems};
```

- [ ] **Step 5: `app.js`: dispatch to `pre`**

Make these exact edits (each `old` string is unique in the file):

1. `showEnd`: change `$('endInfo').textContent=t('endInfo',{o:sOk,n:n})+` to `$('endInfo').textContent=t(pre?'preEndInfo':'endInfo',{o:sOk,n:n})+`. Then replace these six lines

```js
  const all=[...itemsFor(S.level,'syl'),...itemsFor(S.level,'word')];
  const pct=Math.round(100*all.filter(x=>mastered(x.key)).length/all.length);
  const canLevelUp=pct>=90&&S.level<LEVELS.length-1;
  $('endLevelUp').hidden=!canLevelUp;
  $('endLevelUpBtn').hidden=!canLevelUp;
  if(canLevelUp)$('endLevelUp').textContent=t('endLevelUp',{n:S.level+2,t:LEVELS[S.level+1].name});
```

with

```js
  let canLevelUp;
  if(pre)canLevelUp=pre.showEnd();
  else{
    const all=[...itemsFor(S.level,'syl'),...itemsFor(S.level,'word')];
    const pct=Math.round(100*all.filter(x=>mastered(x.key)).length/all.length);
    canLevelUp=pct>=90&&S.level<LEVELS.length-1;
    $('endLevelUp').hidden=!canLevelUp;
    $('endLevelUpBtn').hidden=!canLevelUp;
    if(canLevelUp)$('endLevelUp').textContent=t('endLevelUp',{n:S.level+2,t:LEVELS[S.level+1].name});
  }
```

2. `restState`: after the line `$('hint').textContent=t('rest',{n:nm()});` add `  if(pre)pre.rest();`
3. Replace the two handlers

```js
$('endMore').onclick=()=>{$('end').hidden=true;sDone=sOk=sStk=0;newWorld();renderSession();next()};
$('endLevelUpBtn').onclick=()=>{S.level++;save();renderLevels();$('end').hidden=true;sDone=sOk=sStk=0;newWorld();renderSession();next()};
```

with

```js
$('endMore').onclick=()=>{$('end').hidden=true;sDone=sOk=sStk=0;newWorld();renderSession();pre?pre.begin():next()};
$('endLevelUpBtn').onclick=()=>{if(pre)pre.unlockNext();else{S.level++;save();renderLevels()}$('end').hidden=true;sDone=sOk=sStk=0;newWorld();renderSession();pre?pre.begin():next()};
```

4. `setLang`: change `save();applyLang();renderSession();next();` to `save();applyLang();renderSession();pre?pre.refresh():next();`
5. Reset button: change `e.target.textContent=t('resetBtn');renderLevels();renderHard();next();` to `e.target.textContent=t('resetBtn');renderLevels();renderHard();pre?pre.refresh():next();`
6. Recorder: change `RS.list=recItems(S.level);` to `RS.list=pre?pre.recItems():recItems(S.level);` and change `$('recWorld').textContent=t('recWorld',{w:LEVELS[S.level].name});` to `$('recWorld').textContent=pre?t('preRecWorld'):t('recWorld',{w:LEVELS[S.level].name});`

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/sounds.js src/app.js src/data/i18n.es.json src/data/i18n.ca.json tests/smoke.mjs
git commit -m "feat(sounds): session end, group unlock, language switch, recorder and reset" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Docs, remaining audio, real-browser pass

**Files:**
- Modify: `CLAUDE.md`, `README.md`
- Create (generated): remaining `audio/es/*.mp3`, `audio/ca/*.mp3`, updated `audio/manifest.json`

- [ ] **Step 1: Update `CLAUDE.md`**

1. In the architecture tree add, under `src/app.js`, the lines:

```
src/sounds.js           modo pre-lector (Leo): lógica pura + createSounds(ctx); app.js lo carga con import() solo si el perfil es kind:'pre'
src/data/sounds.{es,ca}.json   grupos de letras: l, w (palabra), e (emoji), ph opcional (mismo sonido: b/v, c/qu)
tests/sounds.mjs        pruebas unitarias de la lógica pura y del listado de clips
```

2. In the "Pedagogía" section add a bullet:

```
- **Leo (4 años, pre-lector):** perfil aparte (`kind:'pre'`). Asocia letra con SONIDO (fonema, no nombre). Tarjeta de presentación (letra grande, sonido, dibujo+palabra) y luego juego: suena el sonido, toca la letra entre 2 opciones (3 si ya la domina). El dibujo sale en la tarjeta a propósito (aquí no se lee). Máximo 2 letras nuevas por sesión. Grupos: vocales, m s l p, t n d c, r b f g, v j z ñ, ch ll qu (en catalán x, ll ny tx). La `h` no entra (no tiene sonido). Dos letras con el mismo `ph` nunca salen juntas. Siguiente grupo cuando ≥75% del actual está dominado.
```

3. In "Persistencia" add: `Perfiles: localStorage['leemos-profiles'] = {active, list:[{id,name,kind}]}. Elsa sigue en 'leemos-v1' (no renombrar); los demás en 'leemos-v1:<id>'. Cambiar de perfil recarga la página. Claves de estadísticas del modo sonidos: 'snd:<letra>' y 'ca:snd:<letra>'. S.pre = {es:n, ca:n} es el grupo desbloqueado por idioma.`

4. In "Audio" add: `Los sonidos de letras son clips de tipo 'sound' (clave = la letra). Un TTS suele leer una "m" suelta como "eme": ajustar con scripts/spoken.mjs, pronunciation.*.json, o grabarlos con «Grabar mi voz» (para Leo la lista empieza por los sonidos). Frases de ánimo de Leo: npm run audio -- --provider <p> --name Leo.`

5. In "Ojo con esto" add: `tests/smoke.mjs inyecta window.__leemosImport para cargar src/sounds.js (jsdom no ejecuta import dinámico). app.js no puede tener sentencias import.`

6. In "Pendientes" add as new item: `Revisar con nativo las palabras de sounds.ca.json (txec, ull, mà, lupa…) y comprobar en el catálogo de Leo si el sonido de e/o en catalán (abierta/cerrada) es el que se quiere.`

- [ ] **Step 2: Update `README.md`**

Add a short section "Modo Leo (letras y sonidos)": how to add a profile (chip 🧒 in the header, "Ya lee sílabas" vs "Aprende letras y sonidos"), that progress is separate, and the `--name Leo` command. Keep it to about 8 lines in the README's existing tone.

- [ ] **Step 3: Generate the rest of the audio**

```bash
npm run audio:plan
npm run audio -- --provider edge
npm run audio -- --provider edge --name Leo
```

Then listen to the new clips in `http://localhost:5173/tools/review.html` (search each remaining letter and picture word), fix with overrides and `--only <text> --force`, and list in the report which letter sounds still need Fran's recordings.

- [ ] **Step 4: Full test run and real-browser pass**

Run: `npm test`
Expected: all PASS.

Then `npm run dev` and, in a real browser (CLAUDE.md warns this has never been done): create Leo with "Aprende letras y sonidos"; play a full session in Spanish and in Catalan; confirm sounds play, wrong taps are gentle, the sticker and end screen appear, "Grabar mi voz" opens on the letter sounds; switch back to Elsa and confirm her progress and the syllable screens are unchanged; turn on `prefers-reduced-motion` and confirm no animation. Note anything that differs from jsdom.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md audio
git commit -m "docs+audio: document Leo's letter-sound mode and generate remaining clips" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage**
- Own profile, Elsa untouched, `leemos-v1:leo`, `leemos-profiles` shape, default when missing: Task 3.
- Switcher chip and no login: Task 3 (chip, overlay, add form).
- Shared IndexedDB recordings, praise-name fallback and `NAME=Leo` set: unchanged `say()`; `--name Leo` in Task 6.
- Content files, `{l, w, e, ph?}`, es/ca, stats keys: Task 1.
- Home, session of 5, intro card, game with 2 then 3 choices, retry rules, replay button: Tasks 4 and 5 (`#preHear` is always on screen during the game).
- Weight formula and mastery: Task 1 (`weightFor`, `isMastered`), tested against the formula.
- Distractors from seen letters, confusable pairs: Task 1.
- Next group offered at 75%, last group: Tasks 1 and 5.
- Stickers at session end with the existing album: Task 4 (`correct`), Task 5 tests.
- Audio priority unchanged, `sound` clip type, `spoken.mjs`, overrides, review tool, regenerate with `--only`: Task 2. Spec's "pipeline first, measure, then screens": Task 2 Step 7 checkpoint before Tasks 3 to 5.
- `sounds.js` module with `app.js` limited to profile selection plus dispatch lines: Tasks 3 to 5. i18n parity and `sw.js` bump: Tasks 3 to 5.
- Testing list in the spec (profile creation and switching, Elsa untouched, data loads, intro then game, retry, weighting, unlock, i18n parity, audio keys): Tasks 1 to 5. Audio priority for `snd:` keys is covered by the "tapping the letter plays its sound" check with a manifest, plus the unchanged `say()`.
- Out-of-scope items are not built.

**Placeholder scan:** none (no TBD/TODO in steps; the one "experiment here" comment is a code comment, as in the existing `spoken.mjs`). The Catalan words are real data, flagged for native review as the spec's open item 2 says.

**Type consistency:** `sKey/phOf/isMastered/weightFor/choiceCount/lettersUpTo/shuffle/pickTarget/pickDistractors/canUnlockNext/totals/NEW_PER_SESSION` have the same names and signatures in Task 1 (definition and tests) and Task 4 (use). `createSounds` returns `{refresh,begin,next}` in Task 4 and `{refresh,begin,next,showEnd,unlockNext,rest,recItems}` in Task 5; `app.js` calls `pre.refresh/begin/showEnd/unlockNext/rest/recItems` only after Task 5 defines them, except `pre.refresh()` and the loader, which Task 4 defines. `ctx` keys listed in Task 4 match what `createSounds` destructures and uses (`later`, `renderAlbum`, `renderHard`, `end`, `reward` included).

**Review Focus:** all five lines have a named test (Task 1: homophones; Tasks 1 and 4: first exercise; Task 3: corrupt store and HTML names; Task 4: mashing; Task 5: last group and language isolation).

**Known risk the plan cannot remove:** Task 2's checkpoint may show that most consonant sounds need Fran's recordings.
