// "Escucha / Escolta": a robot sounds a word out syllable by syllable and she picks the picture (and, below, minimal pairs).
// Spec: docs/superpowers/specs/2026-10-21-listen-mode-design.md
import { stepOf } from './levelrule.js';
import { similarity, shuffle, closer } from './find.js';
import { splitClosed } from './close.js';

export const MIN_OPEN = 4, SCREENS = 6, GAP = 600, INTRO_MS = 2300; // GAP: milliseconds between two syllables; INTRO_MS: Lumi's intro plays before the first sounding-out

// Every word with a picture, once per text, with the Camino step it needs.
export function listenWords(levels) {
  const seen = new Set(), out = [];
  for (const L of levels) {
    for (const o of L.words) {
      const parts = o.w.toLowerCase().split('-'), text = parts.join('');
      if (!o.e || seen.has(text)) continue;
      seen.add(text);
      out.push({ text, parts, emoji: o.e, step: stepOf(parts.join('-')) });
    }
  }
  return out;
}
export const openWords = (words, pos) => words.filter((w) => w.step <= pos);
export const robotTargets = (words) => words.filter((w) => w.parts.length >= 2 && w.parts.length <= 3); // one syllable has nothing to blend

// The clip keys to try, in order, for one syllable: a closed syllable has a stretched clip ("~pas") for some words. Not when the next syllable starts with the same letter
// (bar-ret, tas-sa, tor-re): stretching that coda would teach a false sound (the same rule as Cierra's `qualifies`).
export const partKeys = (part, next) => { const c = splitClosed(part); return c && !(next && next[0] === c.coda) ? ['~' + part, part] : [part]; };

// One robot screen: a target not in `exclude` and the 2 open words most like it, never the same text or picture. null when there is no free target or fewer than 3 pictures.
export function makeRobot(words, rng, exclude = new Set()) {
  const free = robotTargets(words).filter((w) => !exclude.has(w.text));
  if (!free.length) return null;
  const target = free[Math.floor(rng() * free.length)];
  const others = shuffle(words.filter((w) => w.text !== target.text && w.emoji !== target.emoji), rng) // the shuffle breaks ties
    .map((w) => ({ w, s: similarity(target, w) })).sort((a, b) => closer(a.s, b.s)).map((x) => x.w);
  const picked = [];
  for (const w of others) { if (!picked.some((p) => p.emoji === w.emoji)) picked.push(w); if (picked.length === 2) break; }
  if (picked.length < 2) return null;
  return { kind: 'robot', target, cards: shuffle([target, ...picked], rng) };
}

// One pair screen: a pair not in `exclude`, one twin printed at random, the two pictures in random order. null when no pair is free.
export function makePair(pairs, rng, exclude = new Set()) {
  const free = pairs.filter((p) => !exclude.has(p.id));
  if (!free.length) return null;
  const pair = free[Math.floor(rng() * free.length)];
  const printed = rng() < 0.5 ? pair.a : pair.b;
  return { kind: 'pair', pair, printed, cards: shuffle([pair.a, pair.b], rng), answer: printed };
}

// 4 robot screens then 2 pair screens (6 robot when fewer than 2 pairs are open). Targets and pairs are distinct.
export function makeSession(words, rng, pairs = []) {
  const nPairs = pairs.length >= 2 ? 2 : 0, used = new Set(), screens = [];
  while (screens.length < SCREENS - nPairs) {
    const r = makeRobot(words, rng, used);
    if (!r) break;
    used.add(r.target.text); screens.push(r);
  }
  const usedPairs = new Set();
  for (let i = 0; i < nPairs; i++) {
    const q = makePair(pairs, rng, usedPairs);
    if (!q) break;
    usedPairs.add(q.pair.id); screens.push(q);
  }
  return screens;
}

// The screen. ctx: { doc, $, S, t, fmt, rnd, nm, say, part, lumiPlay, sayLumi, sfx, poke, sparkle, later, earnSticker, showReward, refresh, pathPos, levels, data, save, rng }
export function createListen(ctx) {
  const { doc, $, S, t, fmt, rnd, nm, say, part, lumiPlay, sayLumi, sfx, poke, sparkle, later, earnSticker, showReward, refresh, pathPos, levels, data = () => null, save, rng = Math.random } = ctx;
  const room = $('listenRoom'), html = doc.documentElement;
  let plan = null, idx = 0, over = false, gen = 0, advancing = false, talking = 0, idleT = 0, repeated = false, pairHinted = false;
  const idleMs = () => doc.defaultView.__leemosRescueMs || 3000;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const open = () => openWords(listenWords(levels().slice(0, S.level + 1)), pathPos()); // the levels up to hers, like Palabras: the Camino opens letters, the level caps the structure
  const pairs = () => { const d = data(); return openPairs(Array.isArray(d) ? d : [], pathPos()); };
  const canPlay = () => { const o = open(); return o.length >= MIN_OPEN && robotTargets(o).length >= MIN_OPEN; };

  function leave() { gen++; talking++; clearTimeout(idleT); plan = null; room.hidden = true; room.innerHTML = ''; html.classList.remove('listen'); }

  function begin() {
    gen++;
    if (!canPlay()) { leave(); return false; }
    plan = makeSession(open(), rng, pairs()); pairHinted = false;
    if (!plan.length) { leave(); return false; }
    idx = 0; over = false;
    html.classList.add('listen'); room.hidden = false; room.classList.toggle('upper', !!S.upper);
    screen(true);
    return true;
  }

  // The robot says the syllables one after the other with a pause. Each call starts a new sounding-out and cancels the one still running (`talking` is its token).
  async function sound(parts, robot) {
    const my = ++talking, g = gen;
    for (let i = 0; i < parts.length; i++) {
      if (my !== talking || g !== gen) return false;
      robot.classList.add('say');
      await part(partKeys(parts[i], parts[i + 1]));
      robot.classList.remove('say');
      if (my !== talking || g !== gen) return false;
      await new Promise((r) => later(r, GAP));
    }
    return my === talking && g === gen; // true: she heard the whole word and the idle clock may start
  }
  // Says the word and only then starts the 3 s of inactivity (a long word must not be repeated on top of itself).
  const say3 = (parts, robot) => sound(parts, robot).then((done) => { if (done) armIdle(robot, parts); });

  function armIdle(robot, parts) { // 3 s with no tap: the robot says it once more (once per screen, nothing recorded)
    clearTimeout(idleT);
    if (repeated || advancing || over) return;
    const g = gen;
    idleT = later(() => { if (g !== gen || repeated || advancing || over) return; repeated = true; sound(parts, robot); }, idleMs());
  }

  function screen(first) {
    gen++; advancing = false; repeated = false; clearTimeout(idleT);
    const p = plan[idx];
    room.innerHTML = '';
    const dots = el('div', 'listen-dots'); dots.setAttribute('role', 'img'); dots.setAttribute('aria-label', t('listenGoal', { i: idx + 1, n: plan.length }));
    for (let i = 0; i < plan.length; i++) dots.appendChild(el('i', i < idx ? 'on' : ''));
    if (p.kind === 'pair') { room.append(dots); pairScreen(p); return; }
    const robot = el('button', 'listen-robot', '🤖'); robot.setAttribute('aria-label', t('listenRobot'));
    const grid = el('div', 'listen-cards');
    p.cards.forEach((w) => {
      const b = el('button', 'listen-card', w.emoji);
      b.dataset.w = w.text; b.dataset.parts = w.parts.join('-'); b.dataset.answer = String(w === p.target);
      b.onclick = () => tap(b, w, p, robot);
      grid.appendChild(b);
    });
    room.append(dots, robot, grid);
    $('hint').textContent = t('listenIntro');
    robot.onclick = () => { clearTimeout(idleT); say3(p.target.parts, robot); };
    const spoke = first && S.sound && lumiPlay(t('listenIntro'), false); // only a clip: without one it is silent
    const g = gen;
    if (spoke) later(() => { if (g === gen) say3(p.target.parts, robot); }, INTRO_MS); // the first screen plays Lumi's instruction: the robot waits for it to end
    else say3(p.target.parts, robot);
  }

  // A pair screen: the printed word and two pictures; she reads it, taps the picture, then the word is said. A wrong picture only wobbles.
  function pairScreen(p) {
    const word = el('div', 'listen-word', p.printed.text);
    const grid = el('div', 'listen-cards two');
    p.cards.forEach((w) => {
      const b = el('button', 'listen-card', w.emoji);
      b.dataset.w = w.text; b.dataset.answer = String(w === p.answer);
      b.onclick = () => {
        if (!plan || over || advancing || b.classList.contains('found')) return;
        if (w === p.answer) {
          advancing = true; b.classList.add('found'); sfx.ok(); say(p.printed.text); poke('cheer', 900); sparkle(b, 10);
          $('hint').textContent = fmt(rnd(t('oks')));
          const g = gen; later(() => { if (g !== gen) return; idx++; idx < plan.length ? screen(false) : finishSession(); }, 1600);
        } else { b.classList.add('wobble'); later(() => b.classList.remove('wobble'), 500); }
      };
      grid.appendChild(b);
    });
    room.append(word, grid);
    $('hint').textContent = t('listenPairHint');
    if (S.sound && !pairHinted) { pairHinted = true; lumiPlay(t('listenPairHint'), false); } // only a clip: without one it is silent
  }

  function tap(b, w, p, robot) {
    if (!plan || over || advancing || b.classList.contains('found')) return;
    armIdle(robot, p.target.parts);
    if (w === p.target) {
      advancing = true; clearTimeout(idleT); talking++;
      b.classList.add('found'); sfx.ok(); say(w.text); poke('cheer', 900); sparkle(b, 10);
      $('hint').textContent = fmt(rnd(t('oks')));
      const g = gen;
      later(() => { if (g !== gen) return; idx++; idx < plan.length ? screen(false) : finishSession(); }, 1600);
    } else {
      b.classList.add('wobble'); later(() => b.classList.remove('wobble'), 500);
    }
  }

  function finishSession() {
    over = true; clearTimeout(idleT);
    const reward = earnSticker(); save(); refresh();
    const msg = t('listenDone', { n: nm() });
    room.innerHTML = '';
    const again = el('button', 'btn primary', t('listenAgain')); again.id = 'listenAgain'; again.onclick = () => begin();
    room.append(el('p', 'listen-done', msg), again);
    $('hint').textContent = msg;
    if (reward) later(() => showReward(reward), 500);
    else { again.focus(); sfx.win(); if (S.sound) sayLumi(msg); }
  }

  $('rewardOk').addEventListener('click', () => { if (!over) return; const g = gen; later(() => { const a = $('listenAgain'); if (g === gen && a) a.focus(); }, 0); }); // the reward closes: focus goes to "again"

  return { canPlay, begin, leave, active: () => !!plan, intro: 'listenIntro' };
}

// The problems of a pair {a, ea, b, eb} (hyphenated words and their pictures); an empty list means it can be used.
export function validPair(p) {
  const bad = [];
  const a = String(p.a || '').toLowerCase().split('-'), b = String(p.b || '').toLowerCase().split('-');
  if (!p.ea || !p.eb) bad.push('missing picture');
  if (p.ea && p.ea === p.eb) bad.push('same picture');
  const closed = b.filter((x) => splitClosed(x));
  if (closed.length !== 1) bad.push('b needs exactly one closed syllable');
  else {
    const c = splitClosed(closed[0]), i = b.indexOf(closed[0]);
    if (b[i + 1] && b[i + 1][0] === c.coda) bad.push('coda starts a trill or geminate');
    if (b.map((x, j) => (j === i ? c.base : x)).join('-') !== a.join('-')) bad.push('removing the coda does not give a');
  }
  return bad;
}

// Pairs whose two words are both open at Camino step `pos`, as {id, a, b} with a = the open twin.
export function openPairs(pairs, pos) {
  const mk = (h, e) => { const parts = h.toLowerCase().split('-'); return { text: parts.join(''), parts, emoji: e, step: stepOf(parts.join('-')) }; };
  return pairs.filter((p) => validPair(p).length === 0).map((p) => ({ id: p.a, a: mk(p.a, p.ea), b: mk(p.b, p.eb) })).filter((p) => p.a.step <= pos && p.b.step <= pos);
}
