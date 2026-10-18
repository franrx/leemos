// Builds the list of every audio clip the app can ask for, straight from src/data/*.json.
// Keys are lowercase text; the app looks clips up with text.toLowerCase() (see say() in src/app.js).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { wordsFrom } from '../../src/close.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJSON = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

// Filesystem-safe, deterministic, collision-free: [a-z0-9] kept, everything else -> _<hex codepoint>.
export function slug(text) {
  return [...text.normalize('NFC')]
    .map((c) => (/[a-z0-9]/.test(c) ? c : '_' + c.codePointAt(0).toString(16)))
    .join('');
}

export function buildClipList({ name = 'Elsa', langs = ['es', 'ca'] } = {}) {
  const out = new Map();
  const add = (lang, text, kind, extra = {}) => {
    const key = text.toLowerCase();
    const id = lang + ':' + key;
    if (!out.has(id)) out.set(id, { lang, text, key, kind, file: slug(key) + '.mp3', ...extra });
  };
  for (const lang of langs) {
    // Letter sounds first, so a one-letter key such as "a" is classified as a sound, not a syllable.
    const sounds = readJSON(`src/data/sounds.${lang}.json`);
    for (const g of sounds.groups) {
      for (const x of g.letters) {
        add(lang, x.l, 'sound', { ipa: x.ipa });
        add(lang, x.w, 'word');
      }
    }
    const levels = readJSON(`src/data/levels.${lang}.json`);
    const i18n = readJSON(`src/data/i18n.${lang}.json`);
    for (const L of levels) {
      L.syl.forEach((s) => add(lang, s, 'syllable'));
      for (const o of L.words) {
        const parts = o.w.split('-');
        add(lang, parts.join(''), 'word'); // full word first, so monosyllables count as words
        parts.forEach((p) => add(lang, p, 'syllable'));
      }
    }
    const closed = readJSON(`src/data/closed.${lang}.json`);
    // the stretched clips: every bank syllable, and the closed syllable of every word screen (src/close.js decides which words qualify)
    [...new Set([...closed.syl, ...wordsFrom(readJSON(`src/data/levels.${lang}.json`)).map((w) => w.closed)])].forEach((s) => { const key = '~' + s; if (!out.has(lang + ':' + key)) out.set(lang + ':' + key, { lang, text: s, key, kind: 'stretch', file: slug(key) + '.mp3' }); });
    const fill = (s) => s.split('{n}').join(name);
    [...i18n.oks, ...i18n.nos, i18n.rewardTitle, i18n.endTitle, i18n.hintSyl, i18n.hintWord, i18n.hintWhole, i18n.hintJudge, i18n.findIntro, i18n.closeIntro].forEach((s) => add(lang, fill(s), 'phrase'));
    // Leo's own lines (pre-reader screen), said by Lumi when a tap on him or the bubble asks for the sentence on screen
    [i18n.preIntroHint, i18n.preGameHint, i18n.preRest, ...i18n.preNos, ...i18n.preOks].forEach((s) => add(lang, fill(s), 'phrase'));
    add(lang, i18n.sample, 'word');
  }
  return [...out.values()];
}
