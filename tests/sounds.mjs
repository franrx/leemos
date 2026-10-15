// Unit tests for the letter-sound data and pure selection logic. Plain Node, no DOM.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sKey, phOf, isMastered, weightFor, choiceCount, lettersUpTo, shuffle,
  pickTarget, pickDistractors, canUnlockNext, totals,
} from '../src/sounds.js';
import { buildClipList } from '../scripts/lib/clips.mjs';

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
const distinct = [grp(4), { letters: [...'efgh'].map((l) => ({ l })) }];
const tt = totals(distinct, m(['a', 'b']), 'es');
check('totals: counts mastered letters over all groups', tt.done === 2 && tt.total === 8);

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

console.log(failures ? `\n${failures} sounds test(s) FAILED` : '\nAll sounds tests passed');
process.exit(failures ? 1 : 0);
