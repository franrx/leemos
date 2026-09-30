// Builds the list of every audio clip the app can ask for, straight from src/data/*.json.
// Keys are lowercase text; the app looks clips up with text.toLowerCase() (see say() in src/app.js).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
  const add = (lang, text, kind) => {
    const key = text.toLowerCase();
    const id = lang + ':' + key;
    if (!out.has(id)) out.set(id, { lang, text, key, kind, file: slug(key) + '.mp3' });
  };
  for (const lang of langs) {
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
    const fill = (s) => s.split('{n}').join(name);
    [...i18n.oks, ...i18n.nos, i18n.rewardTitle, i18n.endTitle].forEach((s) => add(lang, fill(s), 'phrase'));
    add(lang, i18n.sample, 'word');
  }
  return [...out.values()];
}
