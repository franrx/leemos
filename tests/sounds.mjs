// Unit tests for the letter-sound data and pure selection logic. Plain Node, no DOM.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sKey, phOf, isMastered, weightFor, choiceCount, lettersUpTo, shuffle,
  pickTarget, pickDistractors, canUnlockNext, totals,
} from '../src/sounds.js';
import { buildClipList } from '../scripts/lib/clips.mjs';
import { spokenFor } from '../scripts/spoken.mjs';

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
    const bare = x.l === 'ñ' ? (x.w || '').toLowerCase() : (x.w || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (!x.w || !bare.startsWith(x.l)) problems.push(`word "${x.w}" must start with "${x.l}"`);
    if (!x.e) problems.push('no emoji for ' + x.l);
    if (x.ph !== undefined && typeof x.ph !== 'string') problems.push('bad ph on ' + x.l);
  });
  check(`[${lang}] sounds data is well formed`, problems.length === 0, problems.slice(0, 4).join(' | '));
}

// Catalan reduces unstressed vowels (avió -> "əvió"), so a vowel's picture word must open on a stressed vowel.
const reduced = ['avió', 'elefant', 'ocell'];
check('[ca] vowel picture words do not start with a reduced unstressed vowel', DATA.ca.groups[0].letters.every((x) => !reduced.includes(x.w)));

// Weak or confusing Catalan picks were replaced: no flag emoji, no water buffalo for "nyu", and no "tx" (it sounds like "x" in some dialects).
const caAll = DATA.ca.groups.flatMap((g) => g.letters);
check('[ca] no flag emoji and no "tx"', caAll.every((x) => !/\p{Regional_Indicator}/u.test(x.e)) && !caAll.some((x) => x.l === 'tx'));
check('[ca] "ny" is not paired with the water buffalo', caAll.find((x) => x.l === 'ny').e !== '🐃');
check('s and z are treated as confusable', pickDistractors({ l: 's' }, [{ l: 's' }, { l: 'z' }, { l: 'x' }], {}, 'es', 1, () => 0.5)[0].l === 'x');

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
  const I = readJSON(`src/data/i18n.${lang}.json`);
  const leoLines = [I.preIntroHint, I.preGameHint, I.preRest, ...I.preNos, ...I.preOks].map((x) => x.split('{n}').join('Leo'));
  check(`[${lang}] Leo's own lines (intro, game, rest, "almost" and praise) are phrase clips with his name`, leoLines.every((x) => hasClip(lang, x.toLowerCase(), 'phrase')), leoLines.filter((x) => !hasClip(lang, x.toLowerCase(), 'phrase')).join(' | '));
  check(`[${lang}] every picture word is a clip`, all.every((x) => hasClip(lang, x.w.toLowerCase())));
}
// GitHub Pages runs Jekyll, which silently skips files whose name starts with "_" (the clips of "¡Muy bien!" are _a1muy_20bien...): .nojekyll makes it serve them
{
  const under = ['es', 'ca'].flatMap((l) => readdirSync(join(ROOT, 'audio', l)).filter((f) => f.startsWith('_')));
  check('pages: .nojekyll exists, so the clips whose names start with an underscore are served (' + under.length + ' of them)', !under.length || existsSync(join(ROOT, '.nojekyll')), String(under.length));
}
// A lone consonant read by a text voice comes out as the letter NAME ("eme"); an explicit IPA spelling avoids that.
for (const lang of ['es', 'ca']) {
  const all = DATA[lang].groups.flatMap((g) => g.letters);
  check(`[${lang}] every letter sound has an ipa spelling`, all.every((x) => typeof x.ipa === 'string' && x.ipa.length > 0), all.filter((x) => !x.ipa).map((x) => x.l).join(','));
}
const mClip = clips.find((c) => c.lang === 'es' && c.key === 'm' && c.kind === 'sound');
check('clips: a sound clip carries its ipa', !!mClip && mClip.ipa === 'mː', JSON.stringify(mClip));
check('spoken: a sound is sent as an SSML phoneme', !!mClip && spokenFor(mClip) === "<phoneme alphabet='ipa' ph='mː'>m</phoneme>", mClip && spokenFor(mClip));
const fileSeen = new Set(); let fileDup = 0;
clips.forEach((c) => { const k = c.lang + '/' + c.file; if (fileSeen.has(k)) fileDup++; fileSeen.add(k); });
check('clips: no two clips share a file name', fileDup === 0);

console.log(failures ? `\n${failures} sounds test(s) FAILED` : '\nAll sounds tests passed');
process.exit(failures ? 1 : 0);
