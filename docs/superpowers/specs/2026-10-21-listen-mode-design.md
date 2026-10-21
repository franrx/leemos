# "Escucha / Escolta" mode (robot blending + minimal pairs) — design

Date: 2026-10-21. Status: implemented (B in v23, C in v24). Adds a fifth play mode. Builds on `2026-10-18-closed-syllables-design.md` (stretched clips, the parked robot-mode and minimal-pairs ideas) and `2026-10-18-busca-la-paraula-design.md` (the mode registry, `similarity`).

## Goal

Two short exercises in one mode, aimed at what Elsa finds hardest: blending syllables into a word, and noticing a closing letter (*pata* vs *pasta*). Both are self-checking (a picture is right or wrong), so no adult judgment is needed, and neither can fail her.

## Decisions already made

| Question | Decision |
|---|---|
| Structure | **One new mode, `S.mode==="listen"`**, two screen types. B (robot) and C (pairs) are built and committed separately, B first. |
| Robot audio | The robot says the word **syllable by syllable with pauses** (*pa… ta… ta*), reusing the existing syllable clips. No new TTS for B. A closed syllable uses its stretched `~` clip when one exists. |
| Pair screen | **She reads the word, taps the picture.** One printed word, two pictures; the word is spoken after the tap. |
| Pair data | **Small curated list**, ~6–8 pairs per language; new words get Azure clips. Catalan list flagged for native review. |
| Session | 6 screens: 4 robot then 2 pair. Fewer than 2 open pairs → 6 robot screens. No stats, no `total`, no Camino change, no mastery. One sticker at the end through `earnSticker()`. |
| Leo | Never gets it (`isGame` already excludes `kind:'pre'`). |
| Feedback | A wrong tap is a silent wobble. No punishment sound, no mistake counter. |
| Mute | The robot's syllables and the spoken word are reading sounds: silenced by `readingMuted()`. Lumi's phrases and the effects stay. |

## What is true today (checked in the code)

- `GAMEDEF` in `app.js` registers play modes (`file`, `create`, `ms`, `lock`, optional `data`); a mode needs a button `#m<Name>`, a room `#<name>Room`, and a module returning `{canPlay, begin, leave, active, intro}`. `isGame` excludes Leo.
- `src/find.js` exports `similarity(a, b)`, `shuffle`, `wordsOf`, `editDistance`: reusable for distractors.
- `levelrule.js` exposes `stepOf(hyphenated)` (the Camino step a word needs); the Camino position lives in `app.js`.
- Clips for every level word and syllable already exist. Stretched clips (`~<syl>`) exist only for the Cierra bank and the closed syllable of Cierra words.
- Pairs in the current banks: *pato/plato* and *capa/carpa* (es), *capa/carpa* (ca). Not enough: C needs its own data.

## 1. Pure logic (`src/listen.js`, testable)

- `openWords(words, pos)`: words with an emoji whose `stepOf` ≤ the current Camino step (cumulative levels 1..level, the rule Palabras uses). Needs **≥ 4** to unlock, otherwise the tap on the button shows `listenLocked` in the hint (the button does not dim: like Busca and Cierra, a play mode's lock is only known once its module is loaded).
- `makeRobot(words, rng, exclude)`: picks a target (2–3 syllables) not in `exclude`, then the 2 open words most similar to it (`similarity`), never the same text, never the same emoji. Returns `{kind:'robot', target, cards}` with 3 shuffled cards.
- `sayParts(parts)`: the clip sequence for a word, one entry per syllable; a closed syllable with a `~` clip uses it.
- `makePair(pairs, pos, rng, exclude)`: from the curated list, pairs whose two words are both open. Returns `{kind:'pair', printed, cards:[a,b], answer}`; which twin is printed and the card order are random.
- `makeSession(open, pairs, pos, rng)`: 4 robot + 2 pair screens, distinct targets, pairs last; fewer than 2 open pairs → 6 robot. Deterministic given `rng`.

## 2. Screens

**Robot.** The robot (a drawn companion in Lumi's style, not a copyrighted character) shows a pulse per syllable. It says the word's syllables with ~600 ms gaps, then 3 picture cards appear. Right tap: the card lights, the whole word is spoken, short pause, next screen. Wrong tap: the card wobbles, nothing else; she may tap again. After 3 s of inactivity the robot repeats the sounding-out once per screen (same idle detector as Cierra's rescue). A tap on the robot repeats it at any time. The word is never printed.

**Pair.** The printed word (case follows the Aa switch) big on top, two picture cards below. Right tap: the card lights and the word is spoken. Wrong tap: wobble, she may try the other card. No timer.

Shared visual rules: touch targets ≥ 44 px, `prefers-reduced-motion` keeps everything static and visible, animation only transform/opacity, game mode `--gz` fit with no scroll.

## 3. Data and audio

- `src/data/pairs.{es,ca}.json`: `[{"a":"pa-ta","ea":"🐾","b":"pas-ta","eb":"🍝"}]`, `a` the open twin, `b` the closed one. **Rule (checked by `validPair`):** `b` has exactly one closed syllable `x` (`splitClosed`) and replacing `x` by its base in `b` gives exactly `a` (*pas-ta* → *pa-ta*). So *pala/palma* and *sala/salsa* are NOT pairs (dropping the coda gives *pama*, *sasa*). Also: both words have an emoji, the emoji differ, and the coda does not start a trill or geminate.
- Starting data: es *pata/pasta, capa/carpa, dado/dardo*; ca *capa/carpa*. The list grows only with words Fran has approved; Catalan needs a native check, and until it has 2 open pairs a Catalan session is robot-only.
- `scripts/lib/clips.mjs` lists the new words and any new syllables, plus Lumi's phrases `listenIntro` and `listenPairHint`. Generate with Azure; the new words and syllables **must be listened to** in `/tools/review.html`.
- i18n (es and ca, same keys): `mListen`, `listenLocked`, `listenIntro`, `listenPairHint`; the end of session reuses the shared sticker message.

## 4. Flow

- Button `#mListen`, room `#listenRoom`. `mode` is already a synced preference, so `PREF_KEYS` (`app.js`) and `PREF_OK` (`merge.js`) both accept `listen`; the parity test stays green.
- A saved `listen` that cannot load (`listen.js` fails, or fewer than 4 open words) falls back to syllables without changing the stored preference, like Busca and Cierra.
- `next()` does not restart a running session; `next(true)` (language, Camino letter, sync) does.
- The 6 screens end with `earnSticker()` and the shared end screen.

## 5. Testing

- `tests/listen.mjs`: pure logic on the real data, both languages (card counts, no duplicate emoji or text, `~` clip choice, session shape, determinism, pair validation from section 3).
- `tests/smoke.mjs`: mode button and lock; robot plays syllables in order with gaps (fake timers); right and wrong taps; idle repeat; pair screen right and wrong; mute silences syllables but not Lumi; session ends with a sticker; saved-mode fallback; `PREF` parity; no-scroll check in game mode.
- A test that every clip the mode can ask for is in the clip list.

## 6. Build order

1. **B, robot**: pure logic and tests, screen, i18n, `GAMEDEF` entry, `CLAUDE.md`, service-worker bump. Commit and push.
2. **C, pairs**: `pairs.*.json` and its validation test, clip list and Azure generation, pair screen, session mix, docs. Commit and push, then review the new clips.

## Out of scope

Counting the mode toward mastery or the Camino, phoneme-level blending, voice recognition, adaptive repetition, a difficulty setting, pairs beyond s/r/l codas, anything for Leo.
