// Tests for the book-aligned content: placement rule, data format, per-letter coverage and inverse syllables.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sylLevel, minLevel, letterOf, STEPS, unitsOf, stepOfUnit, stepOf } from '../src/levelrule.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const eq = (fn, cases) => cases.every(([i, o]) => fn(i) === o);

// ---------- the placement rule ----------
check('sylLevel: direct syllables by consonant group', eq(sylLevel, [['ma', 1], ['a', 1], ['pa', 2], ['ca', 2], ['co', 2], ['fa', 3], ['ja', 3], ['ga', 3], ['gu', 3], ['gua', 3], ['ra', 3]]));
check('sylLevel: closed, glide and cluster syllables are level 4', eq(sylLevel, [['al', 4], ['et', 4], ['am', 4], ['neu', 4], ['bou', 4], ['rei', 4], ['niu', 4], ['cui', 4], ['riu', 4], ['nia', 1], ['cua', 2], ['tra', 4], ['pla', 4], ['gro', 4]]));
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

// ---------- coverage: at least 12 distinct words for each of the 11 book letters ----------
const BOOK = [...'mplntsfbdrc'];
const COVER_LANGS = ['ca', 'es'];
for (const l of COVER_LANGS) {
  const words = LV[l].flatMap((L) => L.words.map((o) => o.w));
  const counts = Object.fromEntries(BOOK.map((b) => [b, new Set(words.filter((w) => letterOf(w) === b)).size]));
  const low = BOOK.filter((b) => counts[b] < 12);
  check(`[${l}] at least 12 distinct words for each book letter`, low.length === 0, low.map((b) => `${b}=${counts[b]}`).join(' '));
}

// ---------- inverse syllables: the full series vowel + m c t p b is in level 4 ----------
const SERIES_LANGS = ['ca', 'es'];
for (const l of SERIES_LANGS) {
  const missing = [...'aeiou'].flatMap((v) => [...'mctpb'].map((c) => v + c)).filter((s) => !LV[l][3].syl.includes(s));
  check(`[${l}] inverse syllables (vowel + m c t p b) are in level 4`, missing.length === 0, missing.join(' '));
}

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

console.log(failures ? `\n${failures} levels test(s) FAILED` : '\nAll levels tests passed');
process.exit(failures ? 1 : 0);
