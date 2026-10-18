// "Cierra / Tanca": closed syllables (CVC ending in s, r or l) built as 2 + 1, then words with the first syllable held as an anchor.
// Spec: docs/superpowers/specs/2026-10-18-closed-syllables-design.md
import { stepOf } from './levelrule.js';

export const CODAS = ['s', 'r', 'l'];
export const MIN_SYL = 6, SCREENS = 6;
const V = 'aeiouáéíóúàèòïü';
const CLOSED = new RegExp(`^([^${V}]+)([${V}]+)([srl])$`);
const ENDS_IN_VOWEL = new RegExp(`[${V}]$`);

// "pas" -> {onset: 'p', vowel: 'a', coda: 's', base: 'pa'}; anything else (open, no onset, another coda) -> null.
export function splitClosed(part) {
  const m = CLOSED.exec(String(part || ''));
  return m ? { onset: m[1], vowel: m[2], coda: m[3], base: m[1] + m[2] } : null;
}

// A word for a word screen: 2 syllables, exactly one of them closed, and that one is onset + vowel + s/r/l.
export function qualifies(parts) {
  if (!Array.isArray(parts) || parts.length !== 2) return false;
  const closed = parts.filter((p) => !ENDS_IN_VOWEL.test(p));
  return closed.length === 1 && !!splitClosed(closed[0]);
}

export function wordsFrom(levels) {
  const seen = new Set(), out = [];
  for (const L of levels) {
    for (const o of L.words) {
      const parts = o.w.toLowerCase().split('-'), text = parts.join('');
      if (!o.e || seen.has(text) || !qualifies(parts)) continue;
      seen.add(text);
      out.push({ text, parts, emoji: o.e, step: stepOf(parts.join('-')) });
    }
  }
  return out;
}

export const openSyllables = (bank, pos) => bank.filter((s) => stepOf(s) <= pos).map((s) => ({ syl: s, ...splitClosed(s) }));
export const openWords = (words, pos) => words.filter((w) => w.step <= pos);

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// n syllables, never the same coda three times in a row while another coda is available.
function pickVaried(list, n, rng) {
  const pool = shuffle(list, rng), out = [];
  while (out.length < n && pool.length) {
    const last = out.slice(-2).map((x) => x.coda);
    const ban = last.length === 2 && last[0] === last[1] ? last[0] : null;
    let i = pool.findIndex((x) => x.coda !== ban);
    if (i < 0) i = 0;
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

// 6 screens: 4 syllables then 2 words (6 syllables when fewer than 2 words are open). In the syllable screens the first half docks, the second half peeks.
export function planSession(syls, words, rng) {
  const nWords = words.length >= 2 ? 2 : 0, nSyl = SCREENS - nWords;
  const picked = pickVaried(syls, nSyl, rng);
  const screens = picked.map((s, i) => ({ kind: 'syl', syl: s.syl, base: s.base, coda: s.coda, peek: i >= picked.length / 2 }));
  shuffle(words, rng).slice(0, nWords).forEach((w) => screens.push({ kind: 'word', w }));
  return screens;
}
