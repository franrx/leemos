# Camino de Elsa Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Practice follows the school book letter by letter: an item appears only when all its letters are open; letters open automatically after mastery or by a parent tap; the pool is cumulative across levels and avoids recent repeats.

**Architecture:** Pure rule in `src/levelrule.js` (`stepOf`). The position per language and an auto switch are three new synced **preferences** (`pathEs`, `pathCa`, `pathAuto`), whitelisted in `src/merge.js` and mirrored in `src/app.js`. `app.js` loads the rule through the existing import seam, filters the pool, picks an effective mode, advances the path at the end of a session, and adds a Camino block to the parent panel.

**Tech Stack:** vanilla JS ES modules, no bundler; jsdom smoke tests (`npm test`).

**Spec:** `docs/superpowers/specs/2026-10-17-elsas-path-design.md` (read it first).

## Global Constraints

- No framework, no bundler. `src/app.js` has **no static `import`** (the smoke test evaluates it as text): the rule module is loaded with the `window.__leemosImport || (p=>import(p))` seam, and a failed load must leave the app working with the path off.
- Every UI text: key in `src/data/i18n.es.json` **and** `src/data/i18n.ca.json`; HTML text carries `data-i="key"`, attributes `data-ia="attr:key"`.
- `PREF_KEYS` in `src/app.js` must equal `PREF_KEYS` of `src/merge.js` (Task 2 adds a test).
- The path defaults and any correction run **before** the sync baselines (`lastPref=prefSnap()`), so loading stamps nothing. Only a parent tap or an automatic advance (through `setPath` → `save()`) stamps a preference.
- Leo (`kind:'pre'`) is untouched: no path logic in `src/sounds.js`.
- Changing the `SHELL` list in `sw.js` means bumping `VERSION`.
- Code comments in English, `CLAUDE.md` in Spanish. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and the `Claude-Session:` URL given by the harness. Do not touch `src/data/sync.config.json`.

## Review Focus

- Elsa's existing profile after the update: she must still get exercises (the pool can never be empty), and nothing locks because her state has progress (defaults to all letters open).
- The rule module failing to load (offline, stale cache): the app must still start, with every item eligible.
- Switching language: the position is per language; the Camino block, Palabras availability and level bars follow the new language.
- Sync: an automatic advance or a parent tap stamps once; applying a pull must not stamp or loop; a hostile `pathEs` (0, 13, 2.5, "3") never reaches the app.
- `S.mode` stored as `word` while too few words are open: the exercise is a syllable, the stored preference is untouched and a later change on another device is not lost.

---

### Task 1: The path rule in `levelrule.js`

**Files:**
- Modify: `src/levelrule.js`
- Modify: `tests/levels.mjs`

**Interfaces:**
- Produces (exports of `src/levelrule.js`): `STEPS` (`['m','p','l','n','t','s','f','b','d','r','c','*']`), `unitsOf(hyphenated) → string[]`, `stepOfUnit(unit) → 1..12`, `stepOf(hyphenated) → 0..12` (0 for a bare vowel).

- [ ] **Step 1: Write the failing tests** — in `tests/levels.mjs` change the import line to
`import { sylLevel, minLevel, letterOf, STEPS, unitsOf, stepOfUnit, stepOf } from '../src/levelrule.js';`
and add above the final `console.log(failures ? ...`:

```js
// ---------- Camino de Elsa: the letter path (spec: 2026-10-17-elsas-path-design.md) ----------
check('path: STEPS has the 11 book letters and a last step for the rest', STEPS.length === 12 && STEPS.slice(0, 11).join('') === 'mplntsfbdrc' && STEPS[11] === '*');
check('path: units skip vowels and keep digraphs whole', eq((s) => unitsOf(s).join(','), [['ma', 'm'], ['ca-sa', 'c,s'], ['car-ro', 'c,rr'], ['xi-ca', 'x,c'], ['mus-sol', 'm,ss,l'], ['nyo', 'ny'], ['ñu', 'ny'], ['ço', 'ss'], ['que', 'qu'], ['guí', 'gu'], ['txa', 'tx'], ['chi', 'ch'], ['calle', 'c,ll'], ['a', '']]));
check('path: each book letter opens at its own step, rr is an R, everything else opens last', eq(stepOfUnit, [['m', 1], ['p', 2], ['l', 3], ['n', 4], ['t', 5], ['s', 6], ['f', 7], ['b', 8], ['d', 9], ['r', 10], ['c', 11], ['rr', 10], ['v', 12], ['ch', 12], ['ny', 12], ['x', 12], ['*', 12], ['zz', 12], ['·', 12]]));
check('path: an item needs its hardest letter; a bare vowel needs none', eq(stepOf, [['ma', 1], ['mapa', 2], ['mesa', 6], ['mono', 4], ['ca-sa', 11], ['car-ro', 11], ['a', 0], ['va', 12], ['ñu', 12], ['cha', 12], ['pa-ta', 5]]));
for (const l of ['es', 'ca']) {
  const lv = readJSON(`src/data/levels.${l}.json`);
  const items = lv.flatMap((L) => [...L.syl, ...L.words.map((o) => o.w)]);
  check(`[${l}] path: every syllable and word gets a step from 0 to 12`, items.every((h) => Number.isInteger(stepOf(h)) && stepOf(h) >= 0 && stepOf(h) <= 12));
  check(`[${l}] path: at step 12 everything is open and at step 1 only m-items and bare vowels are`, items.filter((h) => stepOf(h) <= 12).length === items.length && items.filter((h) => stepOf(h) <= 1).every((h) => unitsOf(h).every((u) => u === 'm')));
  const syl1 = new Set(lv.flatMap((L) => L.syl).filter((h) => stepOf(h) <= 1));
  check(`[${l}] path: step 1 still has at least 5 syllables to practice`, syl1.size >= 5, String(syl1.size));
  const counts = Array.from({ length: 12 }, (_, i) => items.filter((h) => stepOf(h) <= i + 1).length);
  check(`[${l}] path: each step opens at least as many items as the one before`, counts.every((c, i) => i === 0 || c >= counts[i - 1]), counts.join(' '));
}
```

- [ ] **Step 2: Run to see it fail**

Run: `node tests/levels.mjs`
Expected: fails to load (`STEPS` / `unitsOf` not exported) — the SyntaxError is the RED.

- [ ] **Step 3: Implement** — append to `src/levelrule.js` (after `letterOf`):

```js
// ---------- Camino de Elsa: the letter path (spec: docs/superpowers/specs/2026-10-17-elsas-path-design.md) ----------
// Step n (1-based) means the first n entries are open; the last step opens every other letter.
export const STEPS=['m','p','l','n','t','s','f','b','d','r','c','*'];
// Consonant units of a word or syllable: vowels are skipped and ch ll ny qu tx rr gu ss count as one unit.
export function unitsOf(hyphenated){
  return norm(hyphenated.replace(/-/g,'')).match(/ch|ll|ny|qu|tx|rr|gu|ss|[^aeiou]/g)||[];
}
// The step that opens one unit: the book letters 1..11 (rr is an R); every other unit, known or not, opens with the last step.
export function stepOfUnit(u){
  if(u==='rr')return STEPS.indexOf('r')+1;
  const i=STEPS.indexOf(u);
  return i>=0&&i<STEPS.length-1?i+1:STEPS.length;
}
// The step an item needs: its hardest unit; 0 when it has no consonant (a bare vowel).
export function stepOf(hyphenated){
  return unitsOf(hyphenated).reduce((m,u)=>Math.max(m,stepOfUnit(u)),0);
}
```

- [ ] **Step 4: Run to see it pass**

Run: `node tests/levels.mjs`
Expected: all PASS. If a data check fails (for example step 1 has fewer than 5 syllables in a language), print the counts, fix the test's expectation only if the data truly cannot support it, and ledger a `Ruling:`.

- [ ] **Step 5: Run the whole suite, commit**

Run: `npm test 2>&1 | grep -E "FAIL|passed|FAILED"` — all pass.

```bash
git add src/levelrule.js tests/levels.mjs
git commit -m "feat(path): the letter path rule - units, steps and the step each item needs"
```

---

### Task 2: The three preferences in the merge whitelist

**Files:**
- Modify: `src/merge.js` (`PREF_OK`)
- Modify: `src/app.js` (the `PREF_KEYS` line)
- Modify: `tests/merge.mjs`, `tests/sync.mjs`

**Interfaces:**
- Produces: `PREF_KEYS` (exported from `merge.js`) now also contains `pathEs`, `pathCa`, `pathAuto`; `mergeData`/`applySynced` carry them like every other preference (no other change).

- [ ] **Step 1: Write the failing tests**

In `tests/merge.mjs` (a) in the test named `'prefs: invalid values are dropped (wrong type, out of range, unknown)'` add to the object literal passed to `mergeData`: `pathEs: pf(0, 9), pathCa: pf(13, 9), pathAuto: pf('yes', 9)`; also add a second statement inside that arrow function before `return`: `const bad2 = mergeData({ prefs: { pathEs: pf(2.5, 9), pathCa: pf('3', 9) } }, {}).prefs; if (Object.keys(bad2).length) return false;`
(b) in the test `'prefs: the valid values are accepted'` add to its object: `pathEs: pf(5, 1), pathCa: pf(12, 1), pathAuto: pf(false, 1)`.
(c) add above the final `console.log(...)`:

```js
// the app keeps its own copy of the list (it cannot import merge.js): they must stay identical
const appSrc = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const appKeys = (appSrc.match(/const PREF_KEYS=\[([^\]]*)\]/) || [, ''])[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
check('prefs: the app and the merge list the same preference keys', appKeys.join() === PREF_KEYS.join(), appKeys.join() + ' vs ' + PREF_KEYS.join());
check('prefs: the letter path is a synced preference, latest change wins', PREF_KEYS.includes('pathEs') && PREF_KEYS.includes('pathCa') && PREF_KEYS.includes('pathAuto') && mergeData({ prefs: { pathEs: pf(3, 100) } }, { prefs: { pathEs: pf(1, 200) } }).prefs.pathEs.v === 1 && mergeData({ prefs: { pathEs: pf(1, 200) } }, { prefs: { pathEs: pf(3, 100) } }).prefs.pathEs.v === 1);
```
(`readFileSync` is already imported in this file by the stickers block; `pf` exists.)

In `tests/sync.mjs`, add above the final `console.log(...)`:

```js
{
  const { srv, sync } = await signedIn();
  const wp = (over = {}) => data({ prefs: { pathEs: { v: 4, at: 500 }, pathAuto: { v: false, at: 500 } }, ...over });
  await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: wp() });
  check('path: the letter path and its switch are uploaded with the profile', srv.rows.get(RID).data.prefs.pathEs.v === 4 && srv.rows.get(RID).data.prefs.pathAuto.v === false);
  const r = await sync.syncProfile({ rid: RID, name: 'Elsa', kind: 'reader', data: data({ prefs: { pathEs: { v: 7, at: 900 } } }) });
  check('path: a later change on another device wins and keeps the other key', r.data.prefs.pathEs.v === 7 && r.data.prefs.pathAuto.v === false);
}
```

- [ ] **Step 2: Run to see it fail**

Run: `node tests/merge.mjs 2>&1 | grep FAIL; node tests/sync.mjs 2>&1 | grep FAIL`
Expected: FAILs for the valid-values test, the two new `prefs:` tests and the two `path:` sync tests (the keys are not whitelisted yet; the app-list test also fails).

- [ ] **Step 3: Implement** — in `src/merge.js` add three entries to `PREF_OK` (after `theme:`):

```js
  pathEs: (v) => Number.isInteger(v) && v >= 1 && v <= 12, // letters open in Spanish (Camino de Elsa)
  pathCa: (v) => Number.isInteger(v) && v >= 1 && v <= 12,
  pathAuto: (v) => typeof v === 'boolean',
```

And in `src/app.js` change the `PREF_KEYS` line to
`const PREF_KEYS=['mode','world','sessionLen','upper','lang','rate','sound','theme','pathEs','pathCa','pathAuto']; // keep identical to merge.js; never the voice`

- [ ] **Step 4: Run to see it pass**

Run: `node tests/merge.mjs | tail -2; node tests/sync.mjs | tail -2`
Expected: both pass. Then `npm test`: every suite passes (the smoke tests still pass because `S.pathEs` etc. are not read yet; the new keys are just undefined in `S`, and `prefSnap` snapshots `undefined`).

- [ ] **Step 5: Commit**

```bash
git add src/merge.js src/app.js tests/merge.mjs tests/sync.mjs
git commit -m "feat(path): pathEs, pathCa and pathAuto are synced preferences"
```

---

### Task 3: The app uses the path: defaults, pool, effective mode, recent window

**Files:**
- Modify: `src/app.js` (rule loading, defaults, items, pool, `pick`, `show`, `hintFor`, level bars, level-up, `renderMode`, `setMode`)
- Modify: `sw.js` (`SHELL` + `VERSION`), `src/styles.css`, `src/data/i18n.es.json`, `src/data/i18n.ca.json`
- Modify: `tests/smoke.mjs` (harness default + new section)

**Interfaces:**
- Consumes: Task 1 (`stepOf`, `STEPS`) and Task 2 (`PREF_KEYS`).
- Produces in `app.js`: `LR` (the rule module or the fallback `{stepOf:()=>0,STEPS:[...]}`), `pathPos()`, `eligible(item)`, `openItems(mode,lv?)`, `poolFor(mode)`, `effMode()`, `renderMode()`, `MIN_WORDS=4`; items now carry `h` (the hyphenated text) and `mode` (`'syl'|'word'`).

- [ ] **Step 1: Make the test harness neutral, then write the failing tests**

In `tests/smoke.mjs`, in `boot({...})` add the parameter `openPath = true` to the destructured options, and replace the line
`for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));`
with:

```js
      // Most tests were written before the letter path: unless a test asks for the real defaults (openPath:false) the saved
      // reader states start with every letter open, which is what an existing profile gets.
      const withPath = (k, v) => (openPath && typeof v !== 'string' && /^leemos-v1(:|$)/.test(k) && v.pathEs === undefined ? { ...v, pathEs: 12, pathCa: 12 } : v);
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(withPath(k, v)));
      if (openPath && !('leemos-profiles' in storage) && !('leemos-v1' in storage)) w.localStorage.setItem('leemos-v1', JSON.stringify({ pathEs: 12, pathCa: 12 }));
```

Append above the final `console.log(failures ? ...` a new section:

```js
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
  let x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', level: 4, sessionLen: 20, pathEs: 1, pathCa: 1 } } });
  let seen = await drawn(x, 40);
  check('path: with only M open every exercise needs no other letter (even at level 5)', seen.every((s) => stepOf(s) <= 1), seen.filter((s) => stepOf(s) > 1).join(','));
  x = await boot({ storage: { 'leemos-v1': { name: 'Elsa', level: 2, sessionLen: 20, pathEs: 12, pathCa: 12 } } });
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
```

- [ ] **Step 2: Run to see it fail**

Run: `node tests/smoke.mjs 2>&1 | grep -E "FAIL|path:" | head -30`
Expected: the `path:` checks FAIL (the app ignores the path). Other existing sections still pass (the harness opens the path).

- [ ] **Step 3: Implement in `src/app.js`**

(a) Right after the top-level `await Promise.all([...])` statement that loads `LV_ES, LV_CA, WORLDS, STICKERS, T_ES, T_CA` add:

```js
// The letter path rule (src/levelrule.js, pure; spec: docs/superpowers/specs/2026-10-17-elsas-path-design.md). Loaded through the
// same import seam as the other modules; if it cannot load, the path is simply off (every item is open), never a blank app.
const LR=await (async()=>{try{return await (window.__leemosImport||(p=>import(p)))('./levelrule.js')}catch(e){return {stepOf:()=>0,STEPS:['m','p','l','n','t','s','f','b','d','r','c','*']}}})();
```

(b) After the line `if(!S.pre)S.pre={es:0,ca:0};` add:

```js
// Camino de Elsa: how many letters are open per language. A profile that already has progress keeps every letter open (nothing
// changes until a parent closes some); a new one starts at M. Runs before the baselines (lastPref), so it stamps nothing.
{const started=S.total>0||Object.keys(S.stats).length>0,okPos=v=>Number.isInteger(v)&&v>=1&&v<=12;
 if(!okPos(S.pathEs))S.pathEs=started?12:1;if(!okPos(S.pathCa))S.pathCa=started?12:1;if(typeof S.pathAuto!=='boolean')S.pathAuto=true}
```

(c) Replace the whole `itemsFor` definition and `pick()` with:

```js
const MIN_WORDS=4; // Palabras needs at least this many open words
const pathPos=()=>S.lang==='ca'?S.pathCa:S.pathEs;
const itemsFor=(lv,mode)=>{
  const L=LEVELS[lv];
  return mode==='syl'
    ? L.syl.map(s=>({key:(S.lang==='ca'?'ca:':'')+'s:'+s,parts:splitSyl(s),text:s,emoji:null,h:s,mode:'syl'}))
    : L.words.map(o=>({key:(S.lang==='ca'?'ca:':'')+'w:'+o.w,parts:o.w.split('-'),text:o.w.replace(/-/g,''),emoji:o.e,h:o.w,mode:'word'}));
};
const eligible=i=>LR.stepOf(i.h)<=pathPos();
// Items of levels 0..lv (cumulative) that the open letters allow; may be empty.
const openItems=(mode,lv=S.level)=>{const out=[];for(let l=0;l<=lv;l++)out.push(...itemsFor(l,mode).filter(eligible));return out};
// What the next exercise is drawn from; with nothing open it ignores the letters rather than stall.
const poolFor=mode=>{
  const o=openItems(mode);if(o.length)return o;
  const all=[];for(let l=0;l<=S.level;l++)all.push(...itemsFor(l,mode));return all;
};
const effMode=()=>S.mode==='word'&&openItems('word').length>=MIN_WORDS?'word':'syl'; // the stored preference S.mode is never changed by this
const recent=[]; // keys of the last exercises (not saved)
function pick(){
  const all=poolFor(effMode());
  const k=Math.min(6,Math.floor(all.length/2));
  const skip=new Set(recent.slice(-k));if(last)skip.add(last);
  let pool=all.filter(i=>!skip.has(i.key));
  if(!pool.length)pool=all.filter(i=>!last||i.key!==last||all.length<2);
  if(!pool.length)pool=all;
  const wts=pool.map(i=>{const s=S.stats[i.key]||{ok:0,fail:0};return Math.max(.25,1+s.fail*2.5-s.ok*.35+(s.ok+s.fail===0?1.5:0))});
  let r=Math.random()*wts.reduce((a,b)=>a+b,0),it=pool[0];
  for(let i=0;i<pool.length;i++){r-=wts[i];if(r<=0){it=pool[i];break}}
  recent.push(it.key);if(recent.length>12)recent.shift();
  return it;
}
```
(`splitSyl`, `mastered` and `last` already exist; keep their definitions where they are.)

(d) `hintFor`: replace `S.mode==='syl'?'hintSyl':'hintWord'` with `((cur&&cur.mode)||effMode())==='syl'?'hintSyl':'hintWord'`.

(e) `show()`: replace `(S.mode==='syl'?' static':'')` with `(it.mode==='syl'?' static':'')`, `if(S.mode==='word') b.onclick=()=>say(p);` with `if(it.mode==='word') b.onclick=()=>say(p);`, and `pic.hidden=S.mode!=='word'||!it.emoji;` with `pic.hidden=it.mode!=='word'||!it.emoji;`.

(f) `renderLevels`: change the two lines computing `all`/`pct` to
`const all=[...itemsFor(i,'syl'),...itemsFor(i,'word')].filter(eligible);` and `const pct=all.length?Math.round(100*all.filter(x=>mastered(x.key)).length/all.length):0;` (only open items count).

(g) `showEnd`: replace the `const all=...; const pct=...; canLevelUp=pct>=90&&S.level<LEVELS.length-1;` lines with
```js
    const all=[...itemsFor(S.level,'syl'),...itemsFor(S.level,'word')].filter(eligible);
    const pct=all.length?Math.round(100*all.filter(x=>mastered(x.key)).length/all.length):0;
    canLevelUp=pathPos()>=12&&pct>=90&&S.level<LEVELS.length-1; // the next level only when every letter is open
```

(h) Mode buttons: add this function next to `setMode` and replace the three places that set `aria-pressed` on `mSyl`/`mWord` (in `applyMerged`, in `setMode`, and the two lines near the end of the file that initialise them) with `renderMode();`:

```js
function renderMode(){
  const m=effMode(),ok=openItems('word').length>=MIN_WORDS;
  $('mSyl').setAttribute('aria-pressed',m==='syl');$('mWord').setAttribute('aria-pressed',m==='word');
  $('mWord').setAttribute('aria-disabled',!ok);$('mWord').classList.toggle('dim',!ok);$('mWord').title=ok?'':t('wordsLocked');
}
```
and make `setMode(m)` start with `if(m==='word'&&openItems('word').length<MIN_WORDS)return;`.

(i) `src/styles.css`: add `.mode.dim{opacity:.45}`.
`src/data/i18n.es.json` add `"wordsLocked": "Palabras se abre cuando hay más letras abiertas.",` and `src/data/i18n.ca.json` add `"wordsLocked": "Paraules s'obre quan hi ha més lletres obertes.",` (keep JSON valid).

(j) `sw.js`: add `'src/levelrule.js'` to `SHELL` (next to `'src/merge.js'`) and change `VERSION` to `'leemos-v5'`.

- [ ] **Step 4: Run to see it pass**

Run: `node tests/smoke.mjs 2>&1 | grep -E "FAIL|path:"`
Expected: every `path:` check PASS. Fix test pacing (a second click needs `await sleep(5)`), not code, if a click is swallowed.

- [ ] **Step 5: Whole suite**

Run: `npm test 2>&1 | grep -E "FAIL|passed|FAILED"`
Expected: all pass. If an older smoke test fails because the pool is now cumulative or the recent window changes what appears (for example a test that expects only words of one level), fix the test's expectation to the new rule and ledger a `Ruling:`; never weaken a check just to pass.

- [ ] **Step 6: Commit**

```bash
git add src/app.js sw.js src/styles.css src/data/i18n.es.json src/data/i18n.ca.json tests/smoke.mjs
git commit -m "feat(path): the pool follows the open letters, cumulative across levels, with a recent window and an effective mode"
```

---

### Task 4: Opening letters — automatic advance, the Camino block and the end-screen line

**Files:**
- Modify: `src/app.js`, `index.html`, `src/styles.css`, `src/data/i18n.es.json`, `src/data/i18n.ca.json`, `tests/smoke.mjs`

**Interfaces:**
- Consumes: Task 3 (`pathPos`, `openItems`, `mastered`, `renderMode`, `LR.STEPS`).
- Produces: `setPath(n)`, `advancePath()`, `renderPath()`; i18n keys `pathTitle`, `pathHelp`, `pathAuto`, `pathRest`, `pathOpen`, `pathClosed`, `endNewLetter`, `endAllLetters`; DOM ids `path`, `pathRow`, `pathAuto`, `endPath`.

- [ ] **Step 1: Write the failing tests** — append above the final `console.log(failures ? ...` in `tests/smoke.mjs`:

```js
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
```

- [ ] **Step 2: Run to see it fail**

Run: `node tests/smoke.mjs 2>&1 | grep -E "FAIL|path:" | head -20`
Expected: the new `path:` checks FAIL (no `#pathRow`, no `#endPath`, no advance).

- [ ] **Step 3: Implement**

`index.html`:
- in the end overlay, after `<p id="endInfo"></p>` add `    <p id="endPath" class="small" hidden></p>`
- in the parent panel, between the `profileOpen` row and `<div class="acct" id="acct" hidden>` add:

```html
    <div class="path" id="path">
      <div class="row"><strong data-i="pathTitle">Camino de letras</strong></div>
      <p class="small" data-i="pathHelp">Las letras abiertas son las que practica. Toca una letra para abrir hasta ella y cerrar las siguientes, según el libro del cole.</p>
      <div class="path-row" id="pathRow" role="group" data-ia="aria-label:pathTitle"></div>
      <label class="row path-auto"><input type="checkbox" id="pathAuto"> <span data-i="pathAuto">Abrir letras solas cuando domine las de ahora</span></label>
    </div>
```

`src/styles.css` (next to the `.acct` rules):

```css
.path{margin-top:14px;padding-top:12px;border-top:2px dashed var(--line)}
.path-row{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.path-row button{min-width:44px;min-height:44px;border:2px solid var(--line);background:var(--panel);border-radius:12px;font-weight:700;font-size:1rem;color:inherit;padding:0 8px}
.path-row button[aria-pressed="true"]{background:var(--c2);border-color:var(--c2);color:#fff}
.path-row button.closed{opacity:.45}
.path-auto{min-height:44px}
.path-auto input{width:24px;height:24px;flex:none}
```

`src/data/i18n.es.json` (valid JSON, commas):
```
  "pathTitle": "Camino de letras",
  "pathHelp": "Las letras abiertas son las que practica. Toca una letra para abrir hasta ella y cerrar las siguientes, según el libro del cole.",
  "pathAuto": "Abrir letras solas cuando domine las de ahora",
  "pathRest": "Resto",
  "pathOpen": "abierta",
  "pathClosed": "cerrada",
  "endNewLetter": "¡Nueva letra: {l}!",
  "endAllLetters": "¡Ya están todas las letras!",
```
`src/data/i18n.ca.json`:
```
  "pathTitle": "Camí de lletres",
  "pathHelp": "Les lletres obertes són les que practica. Toca una lletra per obrir fins a ella i tancar les següents, segons el llibre de l'escola.",
  "pathAuto": "Obre lletres soles quan domini les d'ara",
  "pathRest": "Resta",
  "pathOpen": "oberta",
  "pathClosed": "tancada",
  "endNewLetter": "Nova lletra: {l}!",
  "endAllLetters": "Ja hi són totes les lletres!",
```

`src/app.js` — add near `renderMode`:

```js
// The parent's block and the automatic rule (spec: 2026-10-17-elsas-path-design.md). Both go through setPath, which saves (and so stamps) the preference.
function renderPath(){
  const row=$('pathRow');row.innerHTML='';const pos=pathPos();
  LR.STEPS.forEach((l,i)=>{
    const name=l==='*'?t('pathRest'):l.toUpperCase();
    const b=document.createElement('button');
    b.textContent=name;b.className=i<pos?'':'closed';b.setAttribute('aria-pressed',i===pos-1);
    b.setAttribute('aria-label',name+', '+t(i<pos?'pathOpen':'pathClosed'));
    b.onclick=()=>setPath(i+1);
    row.appendChild(b);
  });
  $('pathAuto').checked=!!S.pathAuto;
}
function setPath(n){
  n=Math.max(1,Math.min(12,n|0));
  if(S.lang==='ca')S.pathCa=n;else S.pathEs=n;
  save();renderPath();renderMode();renderLevels();
}
$('pathAuto').onchange=()=>{S.pathAuto=$('pathAuto').checked;save()};
// After a session: the next letter opens when at least 75% of the items the current letter just made available are mastered (or there are none).
function advancePath(){
  const pos=pathPos();
  if(!S.pathAuto||pos>=12)return 0;
  const fresh=[...openItems('syl'),...openItems('word')].filter(i=>LR.stepOf(i.h)===pos);
  if(fresh.length&&fresh.filter(i=>mastered(i.key)).length/fresh.length<.75)return 0;
  setPath(pos+1);return pos+1;
}
```
In `showEnd`, in the `else{` branch (not Leo), as its first statement add:
```js
    const opened=advancePath();
    $('endPath').hidden=!opened;
    if(opened)$('endPath').textContent=opened>=12?t('endAllLetters'):t('endNewLetter',{l:LR.STEPS[opened-1].toUpperCase()});
```
and for Leo make sure the line stays hidden: right after `let canLevelUp;` add `$('endPath').hidden=true;`.

Call `renderPath();renderMode();` in the start-up render sequence (the line that already calls `renderLevels();renderHard();renderSession();renderAlbum();renderWorlds();updateRecInfo();`), and `renderPath();renderMode();` next to the existing `renderLevels()` call inside `applyLang()` (so a language switch redraws the block, the dimmed Palabras and the texts). In `applyMerged` add `renderPath();renderMode();` right after its `renderLevels();renderHard();renderAlbum();updateHello();` line and add `pos:pathPos()` to its `before` object, and extend the final re-pick condition from `(S.mode!==before.mode&&!resting)` to `((S.mode!==before.mode||pathPos()!==before.pos)&&!resting)`.

- [ ] **Step 4: Run to see it pass**

Run: `node tests/smoke.mjs 2>&1 | grep -E "FAIL|path:"`
Expected: every `path:` check PASS.

- [ ] **Step 5: Whole suite**

Run: `npm test 2>&1 | grep -E "FAIL|passed|FAILED"`
Expected: all pass (the i18n parity check included). If the harness-neutral default hides a bug, also run a couple of sections by hand with `openPath:false` and ledger what you saw.

- [ ] **Step 6: Commit**

```bash
git add src/app.js index.html src/styles.css src/data/i18n.es.json src/data/i18n.ca.json tests/smoke.mjs
git commit -m "feat(path): letters open after mastery or by a parent tap; the Camino block and the end-screen line"
```

---

### Task 5: Docs

**Files:**
- Modify: `CLAUDE.md`, `README.md`

- [ ] **Step 1: Update the docs** — run this once (it asserts every replacement matched):

```bash
python3 - <<'EOF'
def sub(path, old, new, all_=False):
    s = open(path, encoding='utf-8').read()
    assert s.count(old) >= 1, (path, old[:60])
    open(path, 'w', encoding='utf-8').write(s.replace(old, new) if all_ else s.replace(old, new, 1))
sub('CLAUDE.md', 'sessionLen, upper, lang, rate, sound, theme', 'sessionLen, upper, lang, rate, sound, theme, pathEs, pathCa, pathAuto', True)
sub('CLAUDE.md', 'src/levelrule.js        regla de colocación por nivel (sylLevel, minLevel, letterOf); módulo puro, lo usan tests y scripts',
    'src/levelrule.js        regla de colocación por nivel (sylLevel, minLevel, letterOf) y del Camino de letras (STEPS, unitsOf, stepOf); módulo puro, lo usan tests, scripts y app.js (por import())')
s = open('CLAUDE.md', encoding='utf-8').read()
i = s.index('- **Mundos:**')
note = ("- **Camino de Elsa (letras en el orden del libro):** 12 pasos = M P L N T S F B D R C y «el resto» (todas las demás letras de golpe). Un ítem (sílaba o palabra) sale solo si TODAS sus consonantes están abiertas (`stepOf` en `levelrule.js`; las vocales siempre; `rr` cuenta como R; cualquier letra desconocida abre con el último paso). El nivel sigue siendo el techo de estructura y el banco es acumulativo (niveles 1..actual). No se repiten los últimos `min(6, mitad del banco)` ejercicios (en memoria). Palabras necesita ≥4 palabras abiertas; si no, el botón se atenúa y salen sílabas (la preferencia guardada no se toca). Las letras se abren solas al dominar ≥75% de lo que acaba de abrir la letra actual (un paso por sesión, mensaje en la pantalla final) y el adulto puede abrir o cerrar tocando el bloque «Camino de letras» del panel; un interruptor apaga la apertura automática. La oferta de subir de nivel solo sale con todas las letras abiertas. Posición por idioma (`pathEs`, `pathCa`, 1..12) y `pathAuto` son preferencias sincronizadas (la última gana). Un perfil con progreso empieza con todo abierto; uno nuevo en M. Spec: `docs/superpowers/specs/2026-10-17-elsas-path-design.md`.\n")
s = s[:i] + note + s[i:]
open('CLAUDE.md', 'w', encoding='utf-8').write(s)
sub('CLAUDE.md', '(a) «Camino de Elsa»: desbloqueo letra a letra en el orden del libro, banco acumulativo entre niveles y ventana de repetición reciente', '(a) ~~«Camino de Elsa»~~ **hecho** (letras en el orden del libro, banco acumulativo y ventana de repetición reciente)')
sub('README.md', '- Textos de interfaz:', '- Camino de letras: el orden está en `STEPS` de `src/levelrule.js` (M P L N T S F B D R C y «el resto»); el adulto lo ajusta en «Para papá y mamá».\n- Textos de interfaz:')
print('ok')
EOF
```

- [ ] **Step 2: Run the suite and commit**

Run: `npm test 2>&1 | grep -E "FAIL|passed|FAILED"` — all pass.

```bash
git add CLAUDE.md README.md
git commit -m "docs: Camino de Elsa"
```
