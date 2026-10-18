// "Cierra / Tanca": closed syllables (CVC ending in s, r or l) built as 2 + 1, then words with the first syllable held as an anchor.
// Spec: docs/superpowers/specs/2026-10-18-closed-syllables-design.md
import { stepOf } from './levelrule.js';

export const CODAS = ['s', 'r', 'l'];
export const MIN_SYL = 6, SCREENS = 6;
const V = 'aeiouáéíóúàèòïü';
const CLOSED = new RegExp(`^(qu|gu|[^${V}]+)([${V}])([srl])$`); // one vowel: a diphthong (deus) is not a CVC syllable; qu/gu are one onset
const NUCLEUS = new RegExp(`^(qu|gu|[^${V}]*)([${V}]+)(.*)$`); // the u of qu/gu belongs to the onset
const ENDS_IN_VOWEL = new RegExp(`[${V}]$`);

// "pas" -> {onset: 'p', vowel: 'a', coda: 's', base: 'pa'}; anything else (open, no onset, another coda) -> null.
export function splitClosed(part) {
  const m = CLOSED.exec(String(part || ''));
  return m ? { onset: m[1], vowel: m[2], coda: m[3], base: m[1] + m[2] } : null;
}

// "pas" -> {pre: 'p', v: 'a', post: 's'}: the vowel run of a syllable, which the screen paints in its own colour. No vowel: all of it is pre.
export function nucleus(text) {
  const str = String(text || ''), m = NUCLEUS.exec(str);
  return m ? { pre: m[1], v: m[2], post: m[3] } : { pre: str, v: '', post: '' };
}

// A word for a word screen: 2 syllables, exactly one of them closed, and that one is onset + vowel + s/r/l.
export function qualifies(parts) {
  if (!Array.isArray(parts) || parts.length !== 2) return false;
  const closed = parts.filter((p) => !ENDS_IN_VOWEL.test(p));
  if (closed.length !== 1) return false;
  const c = splitClosed(closed[0]);
  if (!c) return false;
  const next = parts[parts.indexOf(closed[0]) + 1];
  return !(next && next[0] === c.coda); // gor-ro, ser-ra, tas-sa: the coda is the start of a trill or a geminate, not a sound to stretch
}

export function wordsFrom(levels) {
  const seen = new Set(), out = [];
  for (const L of levels) {
    for (const o of L.words) {
      const parts = o.w.toLowerCase().split('-'), text = parts.join('');
      if (!o.e || seen.has(text) || !qualifies(parts)) continue;
      seen.add(text);
      const closed = parts.find((p) => !ENDS_IN_VOWEL.test(p));
      out.push({ text, parts, emoji: o.e, step: stepOf(parts.join('-')), closed, coda: splitClosed(closed).coda });
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
function buildPlan(syls, words, rng) {
  const nWords = words.length >= 2 ? 2 : 0, nSyl = SCREENS - nWords;
  const picked = pickVaried(syls, nSyl, rng);
  const screens = picked.map((s, i) => ({ kind: 'syl', syl: s.syl, base: s.base, coda: s.coda, peek: i >= picked.length / 2 }));
  shuffle(words, rng).slice(0, nWords).forEach((w) => screens.push({ kind: 'word', w }));
  return screens;
}
const codaOf = (p) => (p.kind === 'syl' ? p.coda : p.w.coda);
const tripled = (plan) => plan.some((p, i) => i >= 2 && codaOf(p) === codaOf(plan[i - 1]) && codaOf(p) === codaOf(plan[i - 2]));
// The same coda is not used three screens in a row (syllables and words together) while another coda is open: retry a few shuffles.
export function planSession(syls, words, rng) {
  const varied = new Set([...syls.map((s) => s.coda), ...words.map((w) => w.coda)]).size > 1;
  let first = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const plan = buildPlan(syls, words, rng);
    if (!varied || !tripled(plan)) return plan;
    first = first || plan;
  }
  return first;
}

// The screen. ctx: { doc, $, S, t, fmt, rnd, nm, say, lumiPlay, sayLumi, sfx, poke, sparkle, later, earnSticker, showReward, refresh, pathPos, levels, data, save, rng }
export function createClose(ctx) {
  const { doc, $, S, t, fmt, rnd, nm, say, lumiPlay, sayLumi, sfx, poke, sparkle, later, earnSticker, showReward, refresh, pathPos, levels, data, save, rng = Math.random } = ctx;
  const room = $('closeRoom'), html = doc.documentElement;
  let plan = null, idx = 0, over = false, gen = 0, advancing = false;
  let rescueT = 0, rescued = false, rescueFn = null;
  const rescueMs = () => doc.defaultView.__leemosRescueMs || 3000;
  const disarm = () => { clearTimeout(rescueT); rescueT = 0; };
  // 3 seconds with no tap: model the hard part and leave the rest to her. Once per step; any tap pushes it back; nothing is shown or recorded as a failure.
  const INTRO_MS = 3000; // the first screen plays Lumi's instruction: the rescue must not start while it is still playing
  const arm = (extra = 0) => {
    disarm();
    if (rescued || advancing || over || !plan || !rescueFn) return;
    const g = gen;
    rescueT = later(() => { if (g !== gen || rescued || advancing || over) return; rescued = true; rescueFn(); }, rescueMs() + extra);
  };
  const tapped = () => { if (!rescued) arm(); }; // any tap, also on Lumi or the bubble, pushes the rescue back
  room.addEventListener('click', tapped, true);
  ['hint', 'mascot'].forEach((id) => $(id).addEventListener('click', tapped));
  const bank = () => ((data() || {}).syl) || [];
  const canPlay = () => openSyllables(bank(), pathPos()).length >= MIN_SYL;
  const buzz = () => { try { doc.defaultView.navigator.vibrate?.(15); } catch { /* no haptics here (iOS, desktop): nothing to do */ } };
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  // The same text as before, with the vowel in its own span (the accessible name and textContent do not change).
  const fill = (node, text) => {
    const n = nucleus(text); node.textContent = '';
    if (n.pre) node.append(doc.createTextNode(n.pre));
    if (n.v) node.append(el('span', 'v', n.v));
    if (n.post) node.append(doc.createTextNode(n.post));
    return node;
  };

  function leave() { gen++; disarm(); rescueFn = null; plan = null; room.hidden = true; room.innerHTML = ''; html.classList.remove('close'); }

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
    const base = fill(el('button', 'close-tile base'), u.base); base.onclick = () => { if (!done) say(u.base); }; // once the syllable is closed its stretched sound plays: the base must not cut it
    const coda = u.peek ? el('button', 'close-card', '?') : el('button', 'close-coda glow', '+' + u.coda);
    coda.setAttribute('aria-label', u.peek ? t('closeCover') : t('closeAdd', { c: u.coda }));
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      coda.classList.remove('glow', 'rescue'); coda.classList.add('docked'); coda.textContent = u.coda; coda.setAttribute('aria-label', u.coda);
      arc.classList.add('wide'); buzz(); sfx.ok(); lumiPlay('~' + u.text, false); // only a clip: without one it is silent
      onDone();
    };
    coda.onclick = finish;
    row.append(base, coda); wrap.append(row, arc); parent.appendChild(wrap);
    return { finish, coda, base, isDone: () => done };
  }

  // An open syllable has nothing to close: a tile she reads and taps to dock it.
  function openUnit(parent, u, onDone) {
    const wrap = el('div', 'close-unit'), row = el('div', 'close-syl'), arc = el('div', 'close-arc wide');
    const tile = fill(el('button', 'close-tile base'), u.text);
    let done = false;
    const finish = () => { if (done) return; done = true; say(u.text); onDone(); };
    tile.onclick = finish;
    row.appendChild(tile); wrap.append(row, arc); parent.appendChild(wrap);
    return { finish, coda: tile, base: tile, isDone: () => done };
  }

  // A word: its syllables one at a time; a closed one is built 2+1; each finished syllable docks into an anchor chip she can tap to hear it again.
  function wordFlow(stage, w) {
    const units = w.parts.map((p) => { const c = splitClosed(p); return c ? { text: p, closed: true, base: c.base, coda: c.coda } : { text: p, closed: false }; });
    const anchors = el('div', 'close-anchors'), cur = el('div', 'close-current'), pic = el('div', 'close-pic'); pic.hidden = true;
    stage.append(anchors, cur, pic);
    const g0 = gen;
    let i = 0, joined = false, ctl = null, wordRescued = false; // the rescue models ONE syllable of a word; the rest is hers
    const dock = (u) => {
      const chip = el('button', 'close-chip'); chip.setAttribute('aria-label', t('closeAnchor') + ': ' + u.text);
      if (u.closed) chip.append(fill(el('span', 'chip-base'), u.base), el('span', 'chip-coda', u.coda)); // a built closed syllable stays in two parts, never one block of three letters
      else fill(chip, u.text);
      chip.onclick = () => (u.closed ? lumiPlay('~' + u.text, false) : say(u.text));
      anchors.appendChild(chip);
      i++; step();
    };
    const step = () => {
      if (g0 !== gen) return;
      cur.innerHTML = ''; rescued = false;
      if (i >= units.length) {
        const j = el('button', 'btn primary', t('join')); j.id = 'closeJoin';
        j.onclick = () => { if (joined) return; joined = true; sfx.join(); say(w.text); pic.textContent = w.emoji || ''; pic.hidden = !w.emoji; pic.classList.add('pop'); anchors.classList.add('joined'); j.hidden = true; complete(); };
        cur.appendChild(j); j.focus();
        rescueFn = () => { j.classList.add('rescue'); };
        arm();
        return;
      }
      const u = units[i];
      const after = () => { const g = gen; later(() => { if (g === gen) dock(u); }, u.closed ? 900 : 0); };
      ctl = u.closed ? unit(cur, { text: u.text, base: u.base, coda: u.coda, peek: false }, after) : openUnit(cur, u, after);
      ctl.coda.focus();
      rescueFn = () => { if (!ctl || ctl.isDone()) return; if (!wordRescued) { wordRescued = true; ctl.finish(); } else ctl.coda.classList.add('rescue'); }; // models the syllable on screen (stretched if closed) and docks it for her, once per word; later steps only pulse
      arm();
    };
    step();
  }

  function complete() {
    if (advancing) return;
    advancing = true; disarm();
    $('hint').textContent = fmt(rnd(t('oks')));
    poke('cheer', 900);
    const g = gen;
    later(() => { if (g !== gen) return; idx++; idx < plan.length ? screen(false) : finishSession(); }, 1600);
  }

  function screen(first) {
    gen++; advancing = false; disarm(); rescued = false; rescueFn = null;
    const p = plan[idx];
    room.innerHTML = '';
    const dots = el('div', 'close-dots'); dots.setAttribute('role', 'img'); dots.setAttribute('aria-label', t('closeGoal', { i: idx + 1, n: plan.length }));
    for (let i = 0; i < plan.length; i++) dots.appendChild(el('i', i < idx ? 'on' : ''));
    const stage = el('div', 'close-stage');
    room.append(dots, stage);
    $('hint').textContent = t(p.kind === 'syl' ? 'closeIntro' : 'closeWordHint');
    if (p.kind === 'syl') {
      const c = unit(stage, { text: p.syl, base: p.base, coda: p.coda, peek: p.peek }, complete);
      c.coda.focus();
      rescueFn = () => { say(p.base); c.coda.classList.add('rescue'); }; // the base is modelled, the coda tile pulses harder, and she still has the last tap
      arm(first ? INTRO_MS : 0);
      if (!first) say(p.base); // the base sound starts each screen after the first (the first one plays the instruction instead)
    } else {
      wordFlow(stage, p.w);
    }
    if (first && S.sound) lumiPlay(t('closeIntro'), false);
  }

  function finishSession() {
    over = true; disarm();
    const reward = earnSticker(); save(); refresh();
    const msg = t('closeDone', { n: nm() });
    room.innerHTML = '';
    const again = el('button', 'btn primary', t('closeAgain')); again.id = 'closeAgain'; again.onclick = () => begin();
    room.append(el('p', 'close-done', msg), again);
    $('hint').textContent = msg;
    if (reward) later(() => showReward(reward), 500);
    else { again.focus(); sfx.win(); if (S.sound) sayLumi(msg); }
  }

  $('rewardOk').addEventListener('click', () => { if (!over) return; const g = gen; later(() => { const a = $('closeAgain'); if (g === gen && a) a.focus(); }, 0); }); // the reward closes: keyboard focus goes to "again"

  return { canPlay, begin, leave, active: () => !!plan, intro: 'closeIntro' };
}
