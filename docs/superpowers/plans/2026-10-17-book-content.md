# Content Aligned to the School Book (Project 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the school reading book's vocabulary and syllable coverage into Elsa's app, in Catalan and Spanish, with optional emoji, a tested level-placement rule, and capitals by default.

**Architecture:** A pure rule module (`src/levelrule.js`) says which level a word or syllable belongs to; a test fails if any word sits below its minimum. The words and syllables are added to the existing `levels.*.json` by a one-off script that has been proven on copies (it reproduces the files byte for byte before changing anything). The app gets two small changes: the "?" picture slot is hidden for picture-less words, and capitals become the default with a one-time switch for existing reader profiles.

**Tech Stack:** Vanilla ES modules (no build), jsdom smoke tests, plain-Node unit tests, existing Azure audio pipeline.

**Spec:** `docs/superpowers/specs/2026-10-17-book-content-design.md`

## Global Constraints

- No framework, no bundler, no new dependencies. No tracking.
- `src/app.js` must contain no `import` statements (the smoke test evaluates it as a string). `src/levelrule.js` is imported only by tests and scripts for now.
- Existing progress is untouched: stats are keyed by the hyphenated word (`w:ni-not`, `ca:w:ni-not`) and by syllable; moving a word between levels must not change its text.
- Mastered = `ok >= 2 && ok > fail`; no change to any weight or threshold formula. Level bars will drop after the words are added (accepted in the spec).
- Never overwrite an existing audio clip: audio generation runs **without `--force`**, and the only `--force` allowed is on keys that did not exist before this plan.
- Never print or commit `.env`. Check the Azure key only through `npm run azure:voices`.
- `npm test` is green at every commit. Commit trailer on every commit:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS` (one `-m` block, two lines).
- `sw.js` `SHELL` is unchanged (no new file is loaded by the app), so `VERSION` is not bumped.
- UI text: none is added, so no i18n key changes.
- Work on a branch, not on `main`: `feature/book-content`.

## Review Focus

Conditions the spec implies but the feature tests would not otherwise pin; each has a test in the task named.

1. **Moved words keep their identity.** The 7 existing words that move up keep their exact text (so Elsa's stats keys still match) and end in the right level. (Task 1)
2. **The capitals switch is one-time, reader-only, and survives odd state.** It must not re-fire after she toggles back to lowercase, must not touch Leo's profile, and must not break on a saved state without the flag. (Task 6)
3. **Picture-less words work in every flow.** Palabras mode shows no "?" slot before or after reading; the existing pass over all levels, modes and languages still renders non-empty tiles with the new words. (Tasks 2, 3)
4. **New inverse syllables render.** `am ac at ap ab …` are two-letter closed syllables; the syllable screen must show non-empty tiles for all of them. (Task 5)
5. **New clip keys do not collide.** Words and syllables with accents and `ç`/`ï` slug to unique file names, and a word equal to a syllable (`pa`, `no`, `si`) shares one clip. The existing test "no two clips share a file name" must stay green with the new data. (Task 7)

---

### Task 1: Placement rule, its tests, and moving the 7 misplaced words

**Files:**
- Create: `src/levelrule.js`, `tests/levels.mjs`, and the one-off content script (kept outside the repo, see Step 5)
- Modify: `package.json` (test script), `src/data/levels.ca.json`, `src/data/levels.es.json`
- Commit also: `docs/superpowers/specs/2026-10-17-book-content-design.md`, `docs/superpowers/plans/2026-10-17-book-content.md`

**Interfaces:**
- Produces: `sylLevel(syllable) -> 1..5`, `minLevel(hyphenated) -> 1..5`, `letterOf(hyphenated) -> string` exported from `src/levelrule.js`; `tests/levels.mjs` structure (blocks Task 3–5 extend).

- [ ] **Step 0: Branch**

```bash
git switch -c feature/book-content
```

- [ ] **Step 1: Write the failing test**

Create `tests/levels.mjs`:

```js
// Tests for the book-aligned content: placement rule, data format, per-letter coverage and inverse syllables.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sylLevel, minLevel, letterOf } from '../src/levelrule.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const eq = (fn, cases) => cases.every(([i, o]) => fn(i) === o);

// ---------- the placement rule ----------
check('sylLevel: direct syllables by consonant group', eq(sylLevel, [['ma', 1], ['a', 1], ['pa', 2], ['ca', 2], ['co', 2], ['fa', 3], ['ja', 3], ['ga', 3], ['gu', 3], ['gua', 3], ['ra', 3]]));
check('sylLevel: closed, glide and cluster syllables are level 4', eq(sylLevel, [['al', 4], ['et', 4], ['am', 4], ['neu', 4], ['bou', 4], ['rei', 4], ['tra', 4], ['pla', 4], ['gro', 4]]));
check('sylLevel: special spellings are level 5', eq(sylLevel, [['txa', 5], ['nya', 5], ['lla', 5], ['rra', 5], ['qui', 5], ['gue', 5], ['gui', 5], ['ça', 5], ['xa', 5], ['za', 5], ['ha', 5], ['ña', 5], ['cha', 5], ['ce', 5], ['gi', 5]]));
check('minLevel: whole words', eq(minLevel, [['ne-na', 1], ['ca-sa', 2], ['fo-ca', 3], ['ba-na-na', 3], ['sol', 4], ['neu', 4], ['llu-na', 5], ['pin-güí', 5], ['a-vi', 3], ['mà', 1]]));
check('letterOf: first grapheme', eq(letterOf, [['ne-na', 'n'], ['llu-na', 'll'], ['que-so', 'qu'], ['cha-ta', 'ch'], ['à-nec', 'a'], ['ós', 'o'], ['xo-co-la-ta', 'x']]));

// ---------- the data ----------
const LANGS = ['ca', 'es'];
const LV = Object.fromEntries(LANGS.map((l) => [l, readJSON(`src/data/levels.${l}.json`)]));
for (const l of LANGS) {
  const problems = [];
  const seen = new Set();
  LV[l].forEach((L, i) => L.words.forEach((o) => {
    const plain = o.w.replace(/-/g, '');
    if (seen.has(plain)) problems.push('duplicate ' + o.w);
    seen.add(plain);
    if (!/^[a-zàáèéíïòóúüçñ]+(-[a-zàáèéíïòóúüçñ]+)*$/.test(o.w)) problems.push('format ' + o.w);
    else if (o.w.split('-').some((p) => !/[aeiouàáèéíïòóúü]/.test(p))) problems.push('a part without a vowel in ' + o.w);
    if (o.e !== undefined && (typeof o.e !== 'string' || !o.e)) problems.push('bad emoji on ' + o.w);
    if (minLevel(o.w) > i + 1) problems.push(`${o.w} is in level ${i + 1} but needs ${minLevel(o.w)}`);
  }));
  check(`[${l}] words: format, no duplicates, optional emoji, none below its minimum level`, problems.length === 0, problems.slice(0, 6).join(' | '));
  const sylProblems = [];
  LV[l].forEach((L, i) => L.syl.forEach((s) => { if (sylLevel(s) > i + 1) sylProblems.push(`${s} in level ${i + 1}`); }));
  check(`[${l}] syllables: none below its minimum level`, sylProblems.length === 0, sylProblems.slice(0, 6).join(' | '));
}

// Review Focus 1: the words that moved up keep their text and are now in the right level.
const inLevel = (l, idx, ws) => ws.every((w) => LV[l][idx].words.some((o) => o.w === w));
check('moved words keep their text and sit in their new level', inLevel('ca', 3, ['ni-not', 'bo-let', 'co-et']) && inLevel('es', 4, ['luz', 'pez', 'bra-zo', 'cer-do']));

console.log(failures ? `\n${failures} levels test(s) FAILED` : '\nAll levels tests passed');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/levels.mjs`
Expected: FAIL with `Cannot find module '.../src/levelrule.js'`.

- [ ] **Step 3: Create the rule module**

Create `src/levelrule.js`:

```js
// Placement rule for the book-aligned content (spec: docs/superpowers/specs/2026-10-17-book-content-design.md).
// Pure module, no globals: tests and scripts import it directly; the app can load it later through the dynamic-import seam.
const norm=s=>s.toLowerCase().replace(/ñ/g,'ny').replace(/ç/g,'ss').normalize('NFD').replace(/[̀-ͯ]/g,'');

// Minimum level of ONE syllable:
// 1 direct m s l n or a bare vowel; 2 direct p t b d c(k); 3 direct f v r g j; 4 closed, glide-ending or onset cluster; 5 special spelling.
export function sylLevel(raw){
  const s=norm(raw);
  if(/tx|ny|ll|rr|qu|ch|h|x|z|ss|gu[ei]|[cg][ei]/.test(s))return 5;
  if(/^(pl|bl|cl|fl|gl|pr|br|tr|gr|dr|fr|cr)/.test(s))return 4;
  const m=s.match(/^([^aeiou]*)([aeiou]+)(.*)$/);
  if(!m)return 5;
  if(m[3])return 4; // closed syllable (al, et, am...)
  if(m[2].length>1&&/[iu]$/.test(m[2])&&!/^[iu][aeiou]$/.test(m[2]))return 4; // glide ending (neu, bou, rei)
  const c=m[1][0]||'';
  if(!c)return 1;
  if('msln'.includes(c))return 1;
  if('ptbdck'.includes(c))return 2;
  if('fvrgj'.includes(c))return 3;
  return 5;
}

// Minimum level of a hyphenated word ("ca-sa"): its hardest syllable, and at least 3 for words of 3+ syllables.
export function minLevel(hyphenated){
  const parts=hyphenated.split('-');
  const l=Math.max(...parts.map(sylLevel));
  return parts.length>=3?Math.max(l,3):l;
}

// Book letter of a word: its first grapheme, accents ignored (ch ll ny qu tx rr gu count as one).
export function letterOf(hyphenated){
  const s=norm(hyphenated.replace(/-/g,''));
  const m=s.match(/^(ch|ll|ny|qu|tx|rr|gu)/);
  return m?m[1]:s[0];
}
```

- [ ] **Step 4: Run the test: the data checks must now fail for exactly the 7 words**

Run: `node tests/levels.mjs`
Expected: the 5 rule checks and both `syllables` checks PASS; FAIL on `[ca] words…` with `ni-not is in level 2 but needs 4 | bo-let is in level 2 but needs 4 | co-et is in level 3 but needs 4`; FAIL on `[es] words…` with `luz …, pez …, bra-zo …, cer-do …`; FAIL on `moved words keep their text…`.

- [ ] **Step 5: Create the one-off content script (outside the repo) and prove its serializer**

Put this file in your scratch directory (the session scratchpad; the commands below refer to it as `$P1`, e.g. `P1=<scratch>/p1-apply.mjs`). It is a one-off tool: the repo only keeps its output.

```js
// One-off content tool for project 1. Run from the repo root: node "$P1" <step>
//   check  - the serializer reproduces both level files byte for byte (do this first)
//   move   - move existing words that sit below their minimum level up to it
//   ca|es  - add the new words of that language at their minimum level (skips words that already exist)
//   syl    - add the inverse syllables (vowel x m c t p b) to level 4 in both languages
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = process.cwd();
const { minLevel } = await import(ROOT + '/src/levelrule.js');
const step = process.argv[2];
const file = (l) => `${ROOT}/src/data/levels.${l}.json`;
const load = (l) => JSON.parse(readFileSync(file(l), 'utf8'));
function serialize(levels) {
  const blocks = levels.map((L) => [
    '  {',
    `    "name": ${JSON.stringify(L.name)},`,
    `    "sub": ${JSON.stringify(L.sub)},`,
    `    "syl": ${JSON.stringify(L.syl)},`,
    '    "words": [',
    L.words.map((o) => '      ' + JSON.stringify(o)).join(',\n'),
    '    ]',
    '  }',
  ].join('\n'));
  return '[\n' + blocks.join(',\n') + '\n]\n';
}
const save = (l, levels) => writeFileSync(file(l), serialize(levels));

// Entries: "hy-phen-ated" or "hy-phen-ated|emoji" (no emoji = a picture-less word).
const WORDS = {
  ca: `
nen|👦 no niu|🪺 ni-na|🪆 nú-vi-a|👰 nius|🪺 nú-vol|☁️
si-re-na|🧜 serp|🐍 sar-di-na|🐟 si sa-ba-ta|👟 ser-ra|🪚 sa-bó|🧼 sac|🛍️
cui-na|🍳 cam-pa-na|🔔 car-gol|🐌 cor-da|🪢 co-ca cu-lle-ra|🥄 cuc|🐛
fa-nal fi-de-us|🍜 foc|🔥 fum|💨 fus-ta|🪵 fi-ga fil|🧵
bou|🐂 bo-nic bi-go-ti|🥸 bar-ret|🎩 bo-tó|🔘 ba-ta|🥼 banc
ma-le-ta|🧳 mos-ca|🪰 mà|✋ men-ta|🌿 mi-rall|🪞 me-ló|🍈 met-ge|🧑‍⚕️ ma-ri-e-ta|🐞 man-ta
dau|🎲 dut-xa|🚿 di-a-ri|📰 di-a dent|🦷 dò-mi-no dàl-ma-ta|🐕 dan-sa|💃 dit|☝️ dos|2️⃣ di-a-de-ma|👑
lu-pa|🔍 la-ca lec-tu-ra|📖 là-ser li-la|🟣 la-va-bo|🚽 la-be-rint li-ró lam-pis-ta|🧑‍🔧 làm-pa-da|💡 lí-ni-a|📏
ra-to-lí|🐭 riu|🏞️ rei-na|👸 ra-que-ta|🎾 ro-da|🛞 rei|🤴 re-ga-do-ra|🚿 ra-ïm|🍇 rà-di-o|📻 ra-te-ta|🐭
pa|🍞 pi-ja-ma pas-tís|🍰 pi-pí pin-ta|🎨 peu|🦶 pi-la|🔋 pa-la
tau-la ti-te-lla|🪆 ti-so-res|✂️ tú-nel|🚇 tim-bal|🥁 tas-sa|☕ tos|🤧 tu-li-pa|🌷
gat|🐱 joc|🎮 nus font|⛲ ós|🐻 ou|🥚 gos|🐕 vas|🥛 gol|⚽ nit|🌙 ull|👁️
xai|🐑 eu-ga|🐴 à-nec|🦆 u-ni-corn|🦄 i-gua-na|🦎 am-po-lla|🧴 in-di an-te-na|📡
`,
  es: `
lu-pa|🔍 la-go|🏞️ le-ón|🦁 li-món|🍋 le-che|🥛 lá-piz|✏️
ni-do|🪺 no-che|🌙 na-riz|👃 na-ran-ja|🍊 ne-gro ni-ña|👧 nu-tria|🦦 nú-me-ro
si-lla|🪑 se-llo|✉️ se-ta|🍄 su-ma|➕ si-re-na|🧜 so-fá|🛋️ sar-di-na|🐟
fa-ro|🔦 fue-go|🔥 fuen-te|⛲ fan-tas-ma|👻 fi-de-o|🍜 fo-co|🔦 fie-bre|🤒 fi-la
de-do|👆 dien-te|🦷 dos|2️⃣ dul-ce|🍬 dia-man-te|💎 de-sier-to|🏜️ dor-mir|🛌 dis-co|💿
ra-ta|🐀 ra-mo|💐 rí-o|🏞️ rey|🤴 ro-pa|👕 re-loj|🕐 rue-da|🛞 ra-tón|🐭 re-ga-lo|🎁
ma-le-ta|🧳 mo-chi-la|🎒 mo-ne-da|🪙
ta-za|☕ te-cho|🏠
be-bé|👶 ba-lón|⚽
`,
};

if (step === 'check') {
  let ok = true;
  for (const l of ['ca', 'es']) {
    const same = serialize(load(l)) === readFileSync(file(l), 'utf8');
    console.log(`${l}: serializer round-trip ${same ? 'OK' : 'DIFFERS'}`);
    ok = ok && same;
  }
  process.exit(ok ? 0 : 1);
} else if (step === 'move') {
  for (const l of ['ca', 'es']) {
    const levels = load(l);
    const moved = [];
    levels.forEach((L, i) => {
      for (const o of [...L.words]) {
        const need = minLevel(o.w);
        if (need > i + 1) { L.words.splice(L.words.indexOf(o), 1); levels[need - 1].words.push(o); moved.push(`${o.w} ${i + 1}->${need}`); }
      }
    });
    save(l, levels);
    console.log(`${l}: moved ${moved.length}: ${moved.join(', ')}`);
  }
} else if (step === 'ca' || step === 'es') {
  const levels = load(step);
  const have = new Set(levels.flatMap((L) => L.words.map((o) => o.w.replace(/-/g, ''))));
  const byLevel = [0, 0, 0, 0, 0];
  const skipped = [];
  for (const tok of WORDS[step].trim().split(/\s+/)) {
    const [w, e] = tok.split('|');
    const plain = w.replace(/-/g, '');
    if (have.has(plain)) { skipped.push(plain); continue; }
    have.add(plain);
    const lvl = minLevel(w);
    levels[lvl - 1].words.push(e ? { w, e } : { w });
    byLevel[lvl - 1]++;
  }
  save(step, levels);
  console.log(`${step}: added ${byLevel.reduce((a, b) => a + b, 0)} (by level ${byLevel.join(' ')}), skipped as existing: ${skipped.join(' ') || 'none'}`);
} else if (step === 'syl') {
  for (const l of ['ca', 'es']) {
    const levels = load(l);
    const syl = levels[3].syl;
    const add = [...'aeiou'].flatMap((v) => [...'mctpb'].map((c) => v + c)).filter((s) => !syl.includes(s));
    const at = syl.indexOf('us') + 1; // right after the existing closed series (al ar an as ... us)
    if (at === 0) throw new Error(`${l}: level 4 has no "us" to anchor on`);
    syl.splice(at, 0, ...add);
    save(l, levels);
    console.log(`${l}: added ${add.length} inverse syllables, level 4 now has ${syl.length}`);
  }
} else {
  console.error('usage: node p1-apply.mjs check|move|ca|es|syl');
  process.exit(2);
}
```

Run (from the repo root): `node "$P1" check`
Expected: `ca: serializer round-trip OK` and `es: serializer round-trip OK`, exit 0. If either says `DIFFERS`, stop: the script must not run on files it cannot reproduce.

- [ ] **Step 6: Move the 7 words**

Run: `node "$P1" move`
Expected exactly:
```
ca: moved 3: ni-not 2->4, bo-let 2->4, co-et 3->4
es: moved 4: luz 4->5, pez 4->5, bra-zo 4->5, cer-do 4->5
```
Then `git diff --stat src/data` shows only the two level files changed, and the diff contains only those 7 moved lines (no reformatting).

- [ ] **Step 7: Run the test and hook it into `npm test`**

Run: `node tests/levels.mjs`
Expected: every line PASS, ending `All levels tests passed`.

In `package.json`, change the `test` script so it ends with `... && node tests/sw.mjs && node tests/levels.mjs"`.

Run: `npm test`
Expected: all suites pass, including `All levels tests passed`.

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers src/levelrule.js tests/levels.mjs src/data/levels.ca.json src/data/levels.es.json package.json
git commit -m "feat(levels): placement rule with tests; move 7 words to their minimum level" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```

---

### Task 2: Optional pictures in the app

**Files:**
- Modify: `src/app.js` (`show()`), `tests/smoke.mjs` (harness option and tests)

**Interfaces:**
- Produces: `boot({ levelsPatch })` in `tests/smoke.mjs`: a function `(data) => data` applied to any served `levels.*.json` (Task 5 reuses it).

- [ ] **Step 1: Extend the harness and write the failing test**

In `tests/smoke.mjs`:

1. Change the `boot` signature line to add the option:

```js
async function boot({ manifest = null, lang = 'en-US', storage = {}, swMock = null, importFails = false, mic = null, levelsPatch = null } = {}) {
```

2. In the `w.fetch` stub, replace the line
`        return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(p, 'utf8')) };`
with
`        return { ok: true, status: 200, json: async () => { const d = JSON.parse(readFileSync(p, 'utf8')); return levelsPatch && /levels\.(es|ca)\.json$/.test(u) ? levelsPatch(d) : d; } };`

3. Insert this block immediately above the final `console.log(failures ? ...` line:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/smoke.mjs 2>&1 | grep -E "^FAIL.*pictures|^PASS.*pictures"`
Expected: `FAIL  pictures: a word without an emoji shows no picture slot before reading` (today the slot is shown with "?" for every word). The three other `pictures:` checks PASS.

- [ ] **Step 3: Implement**

In `src/app.js`, inside `show()`, change

```js
  pic.hidden=S.mode!=='word';
```

to

```js
  pic.hidden=S.mode!=='word'||!it.emoji; // a word without a picture (e.g. "no", "dia") has no slot at all
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: all suites pass; the four `pictures:` checks PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app.js tests/smoke.mjs
git commit -m "feat(app): pictures are optional; a picture-less word shows no slot" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```

---

### Task 3: Catalan vocabulary from the book

**Files:**
- Modify: `tests/levels.mjs`, `src/data/levels.ca.json`

**Interfaces:**
- Consumes: `letterOf`, `minLevel` (Task 1); the one-off script `$P1` (Task 1 Step 5).

- [ ] **Step 1: Write the failing test**

In `tests/levels.mjs`, add this block immediately above the final `console.log(failures ? ...` line:

```js
// ---------- coverage: at least 12 distinct words for each of the 11 book letters ----------
const BOOK = [...'mplntsfbdrc'];
const COVER_LANGS = ['ca'];
for (const l of COVER_LANGS) {
  const words = LV[l].flatMap((L) => L.words.map((o) => o.w));
  const counts = Object.fromEntries(BOOK.map((b) => [b, new Set(words.filter((w) => letterOf(w) === b)).size]));
  const low = BOOK.filter((b) => counts[b] < 12);
  check(`[${l}] at least 12 distinct words for each book letter`, low.length === 0, low.map((b) => `${b}=${counts[b]}`).join(' '));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/levels.mjs`
Expected: FAIL `[ca] at least 12 distinct words for each book letter  m=10 l=1 n=5 t=9 s=6 f=7 b=10 d=4 r=3`; everything else PASS.

- [ ] **Step 3: Add the Catalan words**

Run: `node "$P1" ca`
Expected exactly: `ca: added 111 (by level 7 11 22 62 9), skipped as existing: pa`
Then `git diff --stat src/data/levels.ca.json` shows only additions (about 111 lines) and no changed existing lines.

- [ ] **Step 4: Run the tests**

Run: `node tests/levels.mjs` — Expected: all PASS, including `[ca] at least 12 distinct words…`.
Run: `npm test` — Expected: all suites pass. (The smoke test's pass over every level, mode and language now renders the new words, including the picture-less ones.)

- [ ] **Step 5: Commit**

```bash
git add tests/levels.mjs src/data/levels.ca.json
git commit -m "feat(content): 111 Catalan words from the school book, placed by the level rule" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```

---

### Task 4: Spanish vocabulary

**Files:**
- Modify: `tests/levels.mjs`, `src/data/levels.es.json`

- [ ] **Step 1: Write the failing test**

In `tests/levels.mjs` change `const COVER_LANGS = ['ca'];` to `const COVER_LANGS = ['ca', 'es'];`.

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/levels.mjs`
Expected: FAIL `[es] at least 12 distinct words for each book letter  m=10 l=7 n=5 t=11 s=7 f=4 b=11 d=4 r=4`; `[ca]` line PASS.

- [ ] **Step 3: Add the Spanish words**

Run: `node "$P1" es`
Expected exactly: `es: added 53 (by level 1 5 17 19 11), skipped as existing: none`

- [ ] **Step 4: Run the tests**

Run: `node tests/levels.mjs` — Expected: all PASS.
Run: `npm test` — Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add tests/levels.mjs src/data/levels.es.json
git commit -m "feat(content): 53 Spanish words so every book letter has at least 12" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```

---

### Task 5: Inverse syllables (vowel + m c t p b) in level 4

**Files:**
- Modify: `tests/levels.mjs`, `tests/smoke.mjs`, `src/data/levels.ca.json`, `src/data/levels.es.json`

- [ ] **Step 1: Write the failing tests**

In `tests/levels.mjs`, add above the final `console.log(...)` line:

```js
// ---------- inverse syllables: the full series vowel + m c t p b is in level 4 ----------
const SERIES_LANGS = ['ca', 'es'];
for (const l of SERIES_LANGS) {
  const missing = [...'aeiou'].flatMap((v) => [...'mctpb'].map((c) => v + c)).filter((s) => !LV[l][3].syl.includes(s));
  check(`[${l}] inverse syllables (vowel + m c t p b) are in level 4`, missing.length === 0, missing.join(' '));
}
```

In `tests/smoke.mjs`, add above the final `console.log(...)` line (Review Focus 4):

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/levels.mjs` — Expected: FAIL for both `inverse syllables…` lines, listing the 25 missing syllables.
Run: `node tests/smoke.mjs 2>&1 | grep "syllables:"` — Expected: PASS already (the patch supplies the syllables; this test guards the rendering and stays green once the data is real).

- [ ] **Step 3: Add the syllables**

Run: `node "$P1" syl`
Expected exactly:
```
ca: added 25 inverse syllables, level 4 now has 75
es: added 25 inverse syllables, level 4 now has 75
```

- [ ] **Step 4: Run the tests**

Run: `node tests/levels.mjs` — Expected: all PASS.
Run: `npm test` — Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add tests/levels.mjs tests/smoke.mjs src/data/levels.ca.json src/data/levels.es.json
git commit -m "feat(content): inverse syllables (vowel + m c t p b) in level 4, both languages" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```

---

### Task 6: Capitals by default, with a one-time switch for existing readers

**Files:**
- Modify: `src/app.js`, `tests/smoke.mjs`

**Interfaces:**
- Produces: state field `S.upperMigrated` (boolean flag), default of `S.upper` is `true`.

- [ ] **Step 1: Write the failing tests**

In `tests/smoke.mjs`, add above the final `console.log(...)` line (Review Focus 2):

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/smoke.mjs 2>&1 | grep "capitals:"`
Expected: FAIL on `a new profile starts in capitals` and on `an existing lowercase reader is switched…`; the other `capitals:` checks may PASS already (they are the guards).

- [ ] **Step 3: Implement**

In `src/app.js`:

1. In the long `const S=Object.assign({...},load());` line, change `mode:'syl',upper:false,` to `mode:'syl',upper:true,`.
2. Right after the line `if(!S.pre)S.pre={es:0,ca:0};` add:

```js
// One-time switch to capitals (the school book is all capitals): readers only, once per profile; she can switch back with Aa.
if(PROFILE.kind==='reader'&&!S.upperMigrated){S.upper=true;S.upperMigrated=true;save()}
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: all suites pass, every `capitals:` check PASS. If an older smoke check fails because it assumed lowercase, fix the check (not the app) and say so in the commit message.

- [ ] **Step 5: Commit**

```bash
git add src/app.js tests/smoke.mjs
git commit -m "feat(app): capitals by default; one-time switch for existing reader profiles" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```

---

### Task 7: Audio for the new content (needs the user for the listening pass)

**Files:**
- Create: new `audio/<lang>/*.mp3`; modify `audio/manifest.json`; possibly `src/data/pronunciation.ca.json`, `src/data/pronunciation.es.json`

**Interfaces:**
- Consumes: the data from Tasks 3–5; the Azure key in `.env`.

- [ ] **Step 1: Check the key (never print it)**

Run: `npm run azure:voices`
Expected: ends with `✓  voz para es: es-ES-ElviraNeural` and `✓  voz para ca: ca-ES-JoanaNeural`.
**If it prints `HTTP 401` or `Faltan AZURE_SPEECH_KEY`: STOP and ask the user** to regenerate the key in the Azure portal and put it in `.env` themselves. Do not continue and do not ask them to paste it.

- [ ] **Step 2: See what will be generated**

Run: `npm run audio:plan`
Expected: a `Por generar:` count of roughly 214 (about 136 Catalan and 78 Spanish: new words, their syllable parts and the 25 inverse syllables per language). A number far from that means a data problem: stop and investigate before spending anything.

- [ ] **Step 3: Generate (no `--force`)**

Run: `npm run audio -- --provider azure`
Expected: `Hecho: N generados, 0 con error.` Then confirm no existing clip was touched:

Run: `git status --short audio | grep -v '^??'`
Expected: only ` M audio/manifest.json` (no modified `.mp3`). If any `.mp3` shows as modified, restore it with `git checkout -- <file>` and report it.

- [ ] **Step 4: Mechanical verification**

Run:

```bash
node -e "
import('./scripts/lib/clips.mjs').then(({buildClipList})=>{
 const fs=require('fs'),cp=require('child_process');
 const m=JSON.parse(fs.readFileSync('audio/manifest.json','utf8')).clips;
 const clips=buildClipList({name:'Leo'}).concat(buildClipList({name:'Elsa'}));
 const miss=clips.filter(c=>!(m[c.lang]||{})[c.key]||!fs.existsSync('audio/'+c.lang+'/'+c.file));
 console.log('clips needed:',clips.length,'| missing:',miss.length,miss.slice(0,10).map(c=>c.lang+':'+c.key).join(' '));
 const odd=[];
 for(const c of clips){const f='audio/'+c.lang+'/'+c.file;if(!fs.existsSync(f))continue;
  const d=parseFloat(cp.spawnSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',f],{encoding:'utf8'}).stdout);
  if(!(d>0.12&&d<4))odd.push(c.lang+':'+c.key+'='+d);}
 console.log('clips with a suspicious length:',odd.length,odd.slice(0,15).join(' '));
})"
```

Expected: `missing: 0` and an empty or tiny list of suspicious lengths. Investigate any listed clip.

- [ ] **Step 5: Tests**

Run: `npm test`
Expected: all suites pass, in particular `clips: no two clips share a file name` (Review Focus 5).

- [ ] **Step 6: Commit the audio**

```bash
git add audio
git commit -m "feat(audio): Azure clips for the new words and inverse syllables" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```

- [ ] **Step 7: Listening pass with the user (STOP here and ask)**

Start the review page: `npm run dev`, then tell the user to open `http://localhost:5173/tools/review.html` and listen to these 50 clips (short syllables are what text voices mispronounce):
`am ac at ap ab em ec et ep eb im ic it ip ib om oc ot op ob um uc ut up ub` in **both** Castellano and Català.
Ask them to list the ones that sound wrong. For each reported key:
1. Add an override in `src/data/pronunciation.<lang>.json` (for example `"ac": "ac"` spelled so the voice says the syllable; try a doubled vowel or a trailing period; see the comments in `scripts/spoken.mjs`).
2. Regenerate only that key: `npm run audio -- --provider azure --lang <lang> --only "<key>" --force`
   **Only for keys created in this task.** Never use `--force` on a key that existed before.
3. Ask them to listen again. Repeat until they are happy, then commit the overrides and clips.

---

### Task 8: Documentation and final checks

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `CLAUDE.md`**

1. In the architecture tree, replace the line
`tests/clipstore.mjs, tests/record.mjs    pruebas del guardado/API y de la página (jsdom con micro y servidor falsos)`
with
```
tests/clipstore.mjs, tests/record.mjs    pruebas del guardado/API y de la página (jsdom con micro y servidor falsos)
src/levelrule.js        regla de colocación por nivel (sylLevel, minLevel, letterOf); módulo puro, lo usan tests y scripts
tests/levels.mjs        pruebas de la regla, del formato de los datos, de la cobertura por letra (≥12 palabras) y de las sílabas inversas
```

2. In the pedagogy list, replace the prefix `- **Mundos:** el nivel es la dificultad;` with the following (keeping the rest of that bullet):

```
- **Contenido alineado con el libro del cole (catalán, todo en mayúsculas).** Niveles por estructura silábica, no por tema: 1 directas m s l n; 2 +p t b d c; 3 +f v r g j y palabras de 3+ sílabas; 4 sílabas cerradas (al, am, oc…), diptongos finales (neu, bou, rei) y grupos (pl, tr, gr…); 5 grafías especiales (tx ny ll rr qu, gu+e/i, ç x z h ñ ch, c/g suaves). `src/levelrule.js` calcula el nivel mínimo y un test falla si una palabra está por debajo. La letra del libro de una palabra es su primer grafema (`letterOf`), no se guarda. Cada una de las 11 letras del libro (M P L N T S F B D R C) tiene ≥12 palabras en cada idioma. El emoji de una palabra es opcional (sin emoji, no hay hueco de dibujo). Mayúsculas por defecto; a los perfiles lector existentes se les cambió una sola vez (`S.upperMigrated`).
- **Mundos:** el nivel es la dificultad;
```

3. Replace the whole item that starts with `9. **Audio del modo Leo sin generar.**` (run `grep -n "^9\. " CLAUDE.md` to see it) using a one-line Node replacement so the full line is swapped:

```bash
node -e "
const fs=require('fs');let t=fs.readFileSync('CLAUDE.md','utf8');
t=t.replace(/^9\. \*\*Audio del modo Leo sin generar\.\*\*.*\$/m,
'9. **Audio generado con Azure** (voces Elvira/Joana, mismas que los clips de Edge). El proveedor \`edge\` devuelve 403 desde 2026-10-15; no se intenta saltar la verificación de Microsoft. Pendiente: escuchar los clips de sonidos de letras de Leo que aún no se han revisado y revisar con nativo las palabras de sounds.ca.json.\n10. **Siguientes proyectos (cada uno con su spec):** (a) «Camino de Elsa»: desbloqueo letra a letra en el orden del libro, banco acumulativo entre niveles y ventana de repetición reciente (las mismas palabras salían demasiado: pesos 1+2.5×fallos, solo se excluye el último, niveles 1-2 con pocas palabras, 80% de palabras del mundo actual); (b) juego «Busca la paraula» (3 copias entre 12 palabras parecidas); (c) modo libro (página por letra: buscar la palabra, leer la frase con dibujo, fila de sílabas).');
fs.writeFileSync('CLAUDE.md',t);console.log(t.includes('10. **Siguientes proyectos')?'ok':'NOT REPLACED');"
```
Expected: `ok`.

- [ ] **Step 2: Full verification**

Run: `npm test`
Expected: all suites pass, 0 `FAIL` lines.

Run: `npm run audio:plan`
Expected: `Por generar:    0`.

Run: `git status --short`
Expected: only `CLAUDE.md` modified.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the book-aligned content, the placement rule and the next projects" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01EmU5E6652EQ8cqjjj91wvS"
```

- [ ] **Step 4: Tell the user what is left for them**

Report: the level bars will have dropped (expected); the first online visit on the tablet downloads the new clips (about 1.5 MB); Elsa's profile switched to capitals once (the Aa button reverts it); a real-tablet pass is still pending; and the next project is "Elsa's path" (letter unlocking and the repetition fix).

---

## Self-Review

**Spec coverage**
- Section 1 (data, optional emoji, `letterOf`, rule table, checker, the 7 moves): Tasks 1 and 2.
- Section 2 (111 Catalan, 53 Spanish, at least 12 per letter): Tasks 3 and 4, verified by the coverage test.
- Section 3 (25 inverse syllables per language; monosyllables arrive with section 2; letter pages and row layout excluded): Task 5.
- Section 4 (capitals default and one-time switch; audio, no overwrite, listening pass, key check): Tasks 6 and 7.
- Section 5 (tests list, order of work, files): Tasks 1–8 follow the spec's order. `package.json`, `CLAUDE.md` and `tests/smoke.mjs` are all covered.
- Roadmap items (Elsa's path, game, book mode) are documented in Task 8 and not built.

**Placeholder scan:** none. Every code step shows its code or an exact command with the expected output. The Task 7 step 7 pronunciation fixes depend on what the user reports; the procedure and the override file are specified.

**Consistency:** the function names `sylLevel`, `minLevel`, `letterOf`, the harness option `levelsPatch`, the state flag `S.upperMigrated`, and the script steps `check|move|ca|es|syl` are the same everywhere. Counts match the proven prototype run (3 + 4 moved, 111 + 53 added, 25 + 25 syllables, level 4 at 75).

**Review Focus:** each of the five lines has a test or a verification command in the task named.

**Known risk the plan cannot remove:** words were transcribed from photographs and the Spanish selection is mine; the user approved Appendix A of the spec, but some spellings may still need a fix after they see the words on screen.
