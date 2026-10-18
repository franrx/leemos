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

check('wordsFrom: the same word in two levels counts once; a word with no picture or that does not qualify is left out', wordsFrom([{ words: [{ w: 'pul-po', e: '🐙' }] }, { words: [{ w: 'pul-po', e: '🐙' }, { w: 'ta-pa', e: '🥫' }, { w: 'car-pa' }] }]).map((w) => w.text).join() === 'pulpo');
for (const lang of ['es', 'ca']) {
  const levels = readJSON(`src/data/levels.${lang}.json`);
  const words = wordsFrom(levels);
  const texts = words.map((w) => w.text);
  check(`[${lang}] wordsFrom: only qualifying words with a picture, once each, with their Camino step`, words.length > 0 && new Set(texts).size === texts.length && words.every((w) => w.emoji && qualifies(w.parts) && w.step === stepOf(w.parts.join('-'))));
  check(`[${lang}] wordsFrom: the examples of the spec are in and the excluded ones are out`, (lang === 'es' ? ['pulpo', 'carpa', 'barco'] : ['fusta', 'mosca', 'túnel']).every((x) => texts.includes(x)) && !texts.includes('tambor') && !texts.includes('cantar'));

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
