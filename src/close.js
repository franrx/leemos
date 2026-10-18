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

// The screen. ctx: { doc, $, S, t, fmt, rnd, nm, say, lumiPlay, sayLumi, sfx, poke, sparkle, later, earnSticker, showReward, refresh, pathPos, levels, data, save, rng }
export function createClose(ctx) {
  const { doc, $, S, t, fmt, rnd, nm, say, lumiPlay, sayLumi, sfx, poke, sparkle, later, earnSticker, showReward, refresh, pathPos, levels, data, save, rng = Math.random } = ctx;
  const room = $('closeRoom'), html = doc.documentElement;
  let plan = null, idx = 0, over = false, gen = 0, advancing = false;
  const bank = () => ((data() || {}).syl) || [];
  const canPlay = () => openSyllables(bank(), pathPos()).length >= MIN_SYL;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  function leave() { gen++; plan = null; room.hidden = true; room.innerHTML = ''; html.classList.remove('close'); }

  function begin() {
    gen++;
    if (!canPlay()) { leave(); return false; }
    const pos = pathPos();
    plan = planSession(openSyllables(bank(), pos), openWords(wordsFrom(levels()), pos), rng);
    idx = 0; over = false;
    html.classList.add('close'); room.hidden = false; room.classList.toggle('upper', !!S.upper);
    screen(true);
    return true;
  }

  // One 2+1 unit: the CV base, then the coda (a glowing tile to dock, or a "?" card to turn over). onDone runs once, after the stretched sound starts.
  function unit(parent, u, onDone) {
    const wrap = el('div', 'close-unit'), row = el('div', 'close-syl'), arc = el('div', 'close-arc');
    const base = el('button', 'close-tile base', u.base); base.onclick = () => say(u.base);
    const coda = u.peek ? el('button', 'close-card', '?') : el('button', 'close-coda glow', '+' + u.coda);
    coda.setAttribute('aria-label', u.peek ? t('closeCover') : t('closeAdd', { c: u.coda }));
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      coda.classList.remove('glow', 'rescue'); coda.classList.add('docked'); coda.textContent = u.coda; coda.setAttribute('aria-label', u.coda);
      arc.classList.add('wide'); sfx.ok(); lumiPlay('~' + u.text, false); // only a clip: without one it is silent
      onDone();
    };
    coda.onclick = finish;
    row.append(base, coda); wrap.append(row, arc); parent.appendChild(wrap);
    return { finish, coda, base, isDone: () => done };
  }

  function complete() {
    if (advancing) return;
    advancing = true;
    $('hint').textContent = fmt(rnd(t('oks')));
    poke('cheer', 900);
    const g = gen;
    later(() => { if (g !== gen) return; idx++; idx < plan.length ? screen(false) : finishSession(); }, 1600);
  }

  function screen(first) {
    gen++; advancing = false;
    const p = plan[idx];
    room.innerHTML = '';
    const dots = el('div', 'close-dots'); dots.setAttribute('role', 'img'); dots.setAttribute('aria-label', t('closeGoal', { i: idx + 1, n: plan.length }));
    for (let i = 0; i < plan.length; i++) dots.appendChild(el('i', i < idx ? 'on' : ''));
    const stage = el('div', 'close-stage');
    room.append(dots, stage);
    $('hint').textContent = t('closeIntro');
    if (p.kind === 'syl') {
      const c = unit(stage, { text: p.syl, base: p.base, coda: p.coda, peek: p.peek }, complete);
      c.coda.focus();
    } else {
      complete(); // replaced by the word screen in the next task
    }
    if (first && S.sound) lumiPlay(t('closeIntro'), false);
  }

  function finishSession() {
    over = true;
    const reward = earnSticker(); save(); refresh();
    const msg = t('closeDone', { n: nm() });
    room.innerHTML = '';
    const again = el('button', 'btn primary', t('closeAgain')); again.id = 'closeAgain'; again.onclick = () => begin();
    room.append(el('p', 'close-done', msg), again);
    $('hint').textContent = msg;
    if (reward) later(() => showReward(reward), 500);
    else { again.focus(); sfx.win(); if (S.sound) sayLumi(msg); }
  }

  return { canPlay, begin, leave, active: () => !!plan, intro: 'closeIntro' };
}
