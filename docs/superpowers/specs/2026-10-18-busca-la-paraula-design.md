# "Busca la paraula" game — design

Date: 2026-10-18. Status: draft for review. Touches the mode switch and the synced preferences. Builds on `2026-10-17-book-content-design.md` (the book page this mirrors; ≥12 words per letter) and `2026-10-17-elsas-path-design.md` (open letters).

## Goal

A play mode that mirrors the "BUSCA LA PARAULA: X (3)" page of the school book: a target word, 12 look-alike words, and she finds the 3 copies of the target. It trains careful visual reading of whole words, in both languages, and is self-checking (no adult judgment needed).

## Decisions already made

| Question | Decision |
|---|---|
| Role | **Separate play mode.** No effect on word/syllable stats, mastery, the Camino or `modAt`. It may give a sticker at the end of a game. |
| Words | **Every word that starts with the current Camino letter** (the letter she is on), like the book page: not filtered by the other letters' being open, because finding a copy is visual matching, not decoding. |
| Feedback | The right copy lights up and is **read aloud**; a wrong tap is a **soft wobble, silent**. No punishment sound, no counter of mistakes. |
| Round | 5 pages per game; each page: the target big at the top, a grid of 12 plain whole-word tiles (3 copies + 9 look-alikes), shuffled. No emoji on the tiles. |
| Sticker | One per finished game, from the same rule as a finished session (`earnSticker()`). |

## What is true today (checked in the code)

- Modes are `S.mode` ∈ `syl|word`; `effMode()` (`app.js`) falls back to `syl` while Palabras has fewer than `MIN_WORDS` (4) open words, without changing the stored preference. Buttons `#mSyl`, `#mWord`; `setMode()` dims and explains a locked mode with `t('wordsLocked')`.
- `openItems(mode, lv)` returns the open items of levels 0..level (cumulative bank, filtered by the Camino's `eligible`). The game does not use it (see section 1); it uses `pathPos()` for the current letter.
- `mode` is a synced preference: `PREF_KEYS` in `app.js` and `PREF_OK` in `merge.js` must stay identical (a test checks the parity).
- A sticker is won once per finished session through `earnSticker()`, shared by readers and Leo.
- The whole-word tile style (`.tile.whole`) and the case switch (Aa) already exist.
- Lumi's instruction phrases are `phrase` clips listed explicitly in `scripts/lib/clips.mjs`; a missing clip means silence, never the browser voice.

## 1. Choosing the tiles (pure, testable)

New module `src/find.js`, no DOM in the pure part:

- `pool(words, letter)`: all words of the language whose first grapheme (`letterOf`, `levelrule.js`) is `letter`, from every level. Measured on the real data: 12–33 words per book letter, in both languages. Filtering by the Camino's `eligible` would leave 0–9 for the early letters and lock the game exactly when she starts, so it is not applied. Words are compared by their joined text, lower-case, accents kept. A word of one syllable is allowed.
- The letter is the Camino's current step (M P L N T S F B D R C). On the last step ("el resto", no single letter) each page draws one of the 11 book letters at random.
- `similarity(a, b)`: higher means easier to confuse. Order of criteria: same first syllable, then the same length, then the smallest edit distance (Levenshtein) on the text.
- `makePage(pool, rng, exclude)`: picks a target not in `exclude`, then the **9 distinct** pool words closest to it (never the target itself, never a word with the same text), returns `{target, tiles}` where `tiles` has 12 entries: the target three times and the 9 others, shuffled. Deterministic given `rng`.
- Needs at least 10 distinct words in the pool (target + 9). The content tests already require ≥12 per book letter, so this never locks the game in practice; the check stays as a guard (and as the lock rule for a stubbed or edited data set).
- `makeGame(pool, rng, n=5)`: 5 pages with distinct targets (a pool of fewer than 5 gives as many pages as distinct targets, at least 1).

## 2. Flow and screen

- Entering Busca la paraula starts a game: page 1 of 5. A small row of 5 dots shows the page (reusing the dots look; it is not the session bar).
- The target shows in the current case (Aa), large, with a speaker button that reads it aloud (hearing the target does not give the answer: she still has to find the copies).
- Tap on a copy: it lights up, stays marked, and the word is read aloud. Tap on a marked copy: nothing. Tap on a look-alike: it wobbles once, silent. All 3 found: Lumi cheers (`sayLumi`) and the next page starts after a short pause.
- After page 5: the end screen with Lumi and a sticker (`earnSticker()`), then "play again" and the usual mode buttons.
- Leaving mid-game (changing mode, language, level, profile) discards it; nothing is saved. Reloading starts a new game.
- `prefers-reduced-motion`: no wobble and no pause animation; the lit state is a colour/outline change only. Targets ≥ 44 px, focus visible, tokens in `:root` with the dark variant.
- Game mode (full screen) keeps working: the grid is part of the game area.
- The session bar and its counters (`sDone`, `sOk`, `sStk`) and the goal dots are **not** touched by this mode. In this mode the session row is hidden.

## 3. Mode and preference

- `S.mode` gains the value `find`; a third button `#mFind` next to `#mSyl` and `#mWord`.
- `effMode()` keeps returning `syl|word` for the readers' exercises. The game checks `S.mode==='find'` and the pool size itself: if the pool is too small (guard only) the button is dimmed with a new hint (`findLocked`) and the stored preference is not changed (same rule as Palabras). If `levelrule.js` did not load (stub), the Camino position is unknown, so the game is locked the same way.
- Validation in `app.js` (`S.mode`) and `PREF_OK.mode` in `merge.js` accept `find`. `PREF_KEYS` does not change (`mode` is already there).
- Leo never sees the button (reader profiles only).

## 4. Audio

- New instruction phrase `findIntro` ("Busca la palabra y toca las 3 copias." / "Busca la paraula i toca les 3 còpies."). Played on the first page of each game (not on every page), like the first instruction of a session. Listed in `scripts/lib/clips.mjs`; its clip is generated with a plain `npm run audio -- --provider azure` (generates only missing files; never `--kind phrase --force`, which regenerates the approved clips). Without the clip: text only.
- Tapping a copy plays the word clip with the usual `say()` priority (recording, generated clip, nothing). No new word clips are needed.

## 5. Loading and files

- `src/find.js` is loaded with `import()` the first time the mode is used (`app.js` cannot have `import` statements). `tests/smoke.mjs` injects it through `window.__leemosImport` like `sounds.js`.
- `sw.js`: add `src/find.js` to `SHELL` and bump `VERSION`.
- New i18n keys in both languages: `mFind`, `findLocked`, `findIntro`, `findGoal` (page counter label), `findAgain`.
- `CLAUDE.md` and `README.md` get a short entry.

## 6. Tests

- `tests/find.mjs` (pure): 12 tiles with exactly 3 copies of the target and 9 distinct others; the target never among the others; same first syllable ranks closer; deterministic for a fixed `rng`; targets distinct across a game; every tile is from the pool and starts with the letter; both languages with the real data for every book letter (M P L N T S F B D R C); a pool of 9 words is refused; the last Camino step draws only book letters.
- Smoke (`tests/smoke.mjs`): the mode button exists, dims and does not change the stored preference when locked; a tap on a copy marks it and plays its clip; a wrong tap changes nothing in the stats, `S.total`, `modAt` or the session counters; 5 pages then the sticker (+1 in `S.stickers`); leaving mid-game gives no sticker; `mode` `find` survives a reload and is accepted by the sync merge (and an invalid value is rejected).
- Mutation checks for each guarantee (a copy counted twice, a wrong tap counted, the sticker given early, stats touched).
- Existing suites stay green; the `PREF_KEYS` parity test keeps passing.

## Not in this project

Sentences with pictures, the per-letter book mode (separate project), reading aloud with recognition, timing or scores, a parent setting for the letter, and mixing game rounds into normal sessions.

## Open points

- Whether the 5-page length should become a setting later (not now).
- Tile similarity is a heuristic; if the first rounds feel too easy or too hard on the tablet, only `similarity` changes.
