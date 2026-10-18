// Unit tests for the pure part of the closed-syllables mode (src/close.js). Plain Node, no DOM.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODAS, MIN_SYL, SCREENS, splitClosed, nucleus, qualifies, wordsFrom, openSyllables, openWords, planSession } from '../src/close.js';
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
check('qualifies: not when the coda is the start of a trill or a geminate (gor-ro, ser-ra, tas-sa): the stretch would teach a wrong sound', !qualifies(['gor', 'ro']) && !qualifies(['ser', 'ra']) && !qualifies(['tas', 'sa']) && !qualifies(['tor', 're']) && qualifies(['car', 'pa']));
check('splitClosed: a diphthong is not a closed syllable (deus), and qu/gu work as an onset (quar, gus)', splitClosed('deus') === null && sp('quar') === 'qua+r' && sp('gus') === 'gu+s' && !qualifies(['fi', 'deus']));
for (const lang of ['es', 'ca']) {
  const levels = readJSON(`src/data/levels.${lang}.json`);
  const words = wordsFrom(levels);
  const texts = words.map((w) => w.text);
  check(`[${lang}] wordsFrom: only qualifying words with a picture, once each, with their Camino step`, words.length > 0 && new Set(texts).size === texts.length && words.every((w) => w.emoji && qualifies(w.parts) && w.step === stepOf(w.parts.join('-'))));
  check(`[${lang}] wordsFrom: no trill, geminate or diphthong word is taught`, ['gorro', 'tassa', 'serra', 'torre', 'gorra', 'sorra', 'fideus'].every((x) => !texts.includes(x)));
  check(`[${lang}] wordsFrom: each word knows its closed syllable and its coda`, words.every((w) => w.parts.includes(w.closed) && w.coda === splitClosed(w.closed).coda));
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
      const codas = plan.map((p) => (p.kind === 'syl' ? p.coda : p.w.coda)), kinds = new Set([...sy.map((x) => x.coda), ...wd.map((w) => w.coda)]);
      if (kinds.size > 1 && codas.some((c, i) => i >= 2 && c === codas[i - 1] && c === codas[i - 2])) problems.push(`pos ${pos}: three same codas in a row`);
      if (!sylS.every((p) => sy.some((x) => x.syl === p.syl))) problems.push(`pos ${pos}: a syllable that is not open`);
    }
  }
  check(`[${lang}] planSession: 6 screens, 4 syllables + 2 words (or 6 syllables with fewer than 2 words), no repeats, dock first then peek, codas vary, only open items`, problems.length === 0, problems.slice(0, 3).join(' | '));
}
const es = readJSON('src/data/levels.es.json');
check('es: at step 3 only one qualifying word is open (pulpo), so the session is all syllables', openWords(wordsFrom(es), 3).map((w) => w.text).join() === 'pulpo');

import { spokenFor } from '../scripts/spoken.mjs';
import { recordList } from '../scripts/lib/clipstore.mjs';
for (const lang of ['es', 'ca']) {
  const bank = readJSON(`src/data/closed.${lang}.json`).syl;
  const clips = buildClipList({ langs: [lang] });
  const st = clips.filter((c) => c.kind === 'stretch');
  const wordParts = wordsFrom(readJSON(`src/data/levels.${lang}.json`)).map((w) => w.closed), need = new Set([...bank, ...wordParts]);
  check(`[${lang}] clips: a stretch clip for every bank syllable AND for the closed syllable of every word screen, keyed "~syllable" so it never collides with the normal clip`, st.length === need.size && st.every((c) => c.key === '~' + c.text && c.file.startsWith('_7e')) && [...need].every((s) => st.some((c) => c.text === s)) && !clips.some((c) => c.kind !== 'stretch' && c.key.startsWith('~')), `${st.length} vs ${need.size}`);
  check(`[${lang}] clips: the instruction closeIntro is in the phrase list`, clips.some((c) => c.kind === 'phrase' && c.text === readJSON(`src/data/i18n.${lang}.json`).closeIntro));
  const ssml = st.map((c) => spokenFor(c));
  check(`[${lang}] spoken: a stretch clip is SSML with a long vowel and a long coda, never the plain syllable`, ssml.every((s, i) => s.startsWith('<') && /<prosody/.test(s) && s !== st[i].text) && spokenFor(st.find((c) => c.text === 'pas')).includes('aa') && /s{2,}/.test(spokenFor(st.find((c) => c.text === 'pas'))));
  const sal = spokenFor(st.find((c) => c.text === 'sal')), pas = spokenFor(st.find((c) => c.text === 'pas')), mar = spokenFor(st.find((c) => c.text === 'mar'));
  check(`[${lang}] spoken: an -l syllable is sent as the plain syllable, only slowed (a doubled vowel turns mel into mil and mol into mul, a doubled l sounds like "ll"); -s and -r keep the long hold`, />sal</.test(sal) && /<prosody rate="-\d+%">/.test(sal) && /a{3}s{3}</.test(pas) && /a{3}r{3}</.test(mar) && st.filter((c) => c.text.endsWith('l')).every((c) => { const v = spokenFor(c); return v.replace(/<[^>]*>/g, '') === c.text; }), `${sal} | ${pas}`);
  const rec = recordList({ lang }).filter((c) => c.kind === 'stretch');
  check(`[${lang}] record list: the stretch clips can be recorded, shown as the syllable`, rec.length === need.size && rec.every((c) => c.key === '~' + c.shown));
}
const nu = (s) => { const r = nucleus(s); return `${r.pre}|${r.v}|${r.post}`; };
check('nucleus: the vowel run of a syllable, with its onset before and its coda after', nu('ma') === 'm|a|' && nu('pas') === 'p|a|s' && nu('tra') === 'tr|a|' && nu('bou') === 'b|ou|' && nu('a') === '|a|');
check('nucleus: the u of qu/gu is part of the onset, not the nucleus', nu('qui') === 'qu|i|' && nu('gue') === 'gu|e|' && nu('quar') === 'qu|a|r' && nu('gus') === 'g|u|s');
check('nucleus: a syllable with no vowel keeps its whole text and no nucleus', nu('ps') === 'ps||' && nu('') === '||');
const es18 = readJSON('src/data/i18n.es.json'), ca18 = readJSON('src/data/i18n.ca.json');
const CKEYS = ['mClose', 'closeLocked', 'closeIntro', 'closeGoal', 'closeAgain', 'closeDone', 'closeCover', 'closeAnchor', 'closeAdd', 'closeWordHint'];
check('i18n: every closed-syllables key exists in both languages and is not empty', CKEYS.every((k) => typeof es18[k] === 'string' && es18[k] && typeof ca18[k] === 'string' && ca18[k]));
check('i18n: the Catalan instruction and the done text use "síl·laba" with the punt volat', /síl·laba/.test(ca18.closeIntro) && /síl·labes/.test(ca18.closeDone));
const swText = readFileSync(join(ROOT, 'sw.js'), 'utf8');
check('service worker: close.js and its data are cached with the shell and the version was bumped', /'src\/close\.js'/.test(swText) && /'src\/data\/closed\.es\.json'/.test(swText) && /'src\/data\/closed\.ca\.json'/.test(swText) && /VERSION = 'leemos-v15'/.test(swText));

console.log(failures ? `\n${failures} close test(s) FAILED` : '\nAll close tests passed');
process.exit(failures ? 1 : 0);
