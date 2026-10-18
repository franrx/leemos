# Closed syllables ("Cierra" / "Tanca") — design

Date: 2026-10-18. Status: draft for review. Touches the mode switch, the synced `mode` preference and the audio pipeline (a new clip kind). Builds on `2026-10-17-elsas-path-design.md` (open letters) and `2026-10-18-busca-la-paraula-design.md` (the module-per-game pattern).

## Goal

Elsa reads open syllables (CV) but overloads her working memory when she blends syllables into words and when she meets closed syllables ending in a continuous consonant (CVC with -s, -r, -l: *pas, bar, sol*). A play mode that builds those syllables as "2 + 1" (the familiar CV base first, then the coda docks on), stretches the sound without a stop, holds the first syllable of a word on screen while she decodes the next, and never lets her stall or fail.

## Decisions already made

| Question | Decision |
|---|---|
| Place | A **new play mode**, a fourth button beside Sílabas, Palabras and Busca. Sílabas and Palabras do not change. |
| First version | **The core**: build the syllable (2+1, stretchy sound, peek-a-boo), then the word with the first syllable held as an anchor, with the 3-second rescue. Robot mode (audio-first picture choice) and minimal pairs (pata/pasta) are later projects. |
| Audio | **Try Azure first**, listen in the review page, re-record only what sounds wrong with "Grabar mi voz". |
| Progress | **Separate, no stats**: nothing touches `stats`, `total`, the session counters, `level` or the Camino. One sticker at the end of a session (`earnSticker()`); it changes `modAt` like any sticker. |
| Checking | Nothing verifies that she reads (there is no speech recognition on purpose). The adult next to her is the check, as in the other modes. The coda tile is a single tile, not a choice. |
| Leo | Never sees the mode. |

## What is true today (checked in the code)

- `STEPS` (`src/levelrule.js`) = `m p l n t s f b d r c *`, and `stepOf(text)` returns the highest Camino step a syllable or word needs (`pas` 6, `bar` 10, `sol` 6, `pul-po` 3). `pathPos()` (app.js) is the open step, 1–12, per language.
- The coda letters open at: **L step 3, S step 6, R step 10**.
- Level 4 has the inverse syllables `al ar as el er es il ir is ol or os ul ur us` and about 30 (es) / 55 (ca) words with closings. Closed CVC syllables like `pas` or `bar` exist only inside words (the syllable clips already cover every syllable of every word).
- Clips are keyed by lower-case text (`ck(x)` in app.js; `buildClipList` in `scripts/lib/clips.mjs`), each with a `kind` (`sound`, `syllable`, `word`, `phrase`). `scripts/spoken.mjs` decides what text goes to the TTS per kind; `pronunciation.*.json` overrides it per clip. Lumi's phrases never use the browser voice: no clip, silence.
- Game modules are loaded with `import()` on first use (`sounds.js`, `find.js`); `app.js` has no `import` statements. `mode` is a synced preference (`PREF_OK.mode` in `merge.js`).
- A word's picture appears only after she has read it (the app's rule).

## 1. Content

**Closed syllables** (`src/data/closed.es.json`, `closed.ca.json`): `{ "syl": ["mal", "pal", …] }`, a curated list of about 36 CVC syllables per language: onset (a consonant of the Camino) + vowel + coda s, r or l. Chosen so that every coda and every vowel appear, and so that there are **at least 6 syllables open at every step from 3 up** (step 3 has only the L coda: *mal mel mil mol mul pal pel pil pol pul*; step 6 adds S and the new onsets: *mas pas tos nas sal sol…*; step 10 adds R: *bar mar par tor…*). The two languages may differ in the list.

**Words** are derived, not listed: from `levels.<lang>.json`, a word qualifies when it has **exactly 2 syllables, exactly one closed syllable, and that closed syllable is onset + vowel + s/r/l** (so *pul-po, car-pa, bar-co, mos-ca, cor-da, fus-ta, ho-tel* qualify; a qualifying word with no picture in the level data, like *fa-nal*, is left out; *tam-bor, can-tar, ár-bol, del-fín, dor-mir* do not: a closing n or m, no onset, or two closed syllables). Single-syllable words (*sol, mar, bus, dos*) are not used as word screens. Words use their picture from the level data, so no new pictures are needed.

**Gating:** an item is open when `stepOf(item) <= pathPos()`. The mode is **locked** while fewer than 6 closed syllables are open (that is, at steps 1–2, where no coda letter is open) and the hint says it opens with the L.

**Word screens are optional per session:** in Spanish only *pul-po* (step 3) is open until step 11, where *car-pa, bar-co, cer-do, dis-co, dul-ce* arrive; Catalan has *tú-nel* (5) and *fus-ta* (7) earlier (*fa-nal* has no picture). A session uses 2 word screens when at least 2 distinct qualifying words are open; otherwise all 6 screens are syllable screens.

## 2. Session and screens

A session is **6 screens** (about 4 minutes, one objective each) and ends with a sticker. Syllables and words do not repeat within a session; the coda varies (the same coda is not used three screens in a row when others are open).

**Syllable screen (2 + 1)**, for the first half of the syllable screens:
1. The CV base (*PA*) appears large with a smooth arc under it. Lumi plays the base sound (the existing clip of `pa`).
2. She reads it aloud, then taps the glowing coda tile (*+S*).
3. The tile slides into place, the arc grows over both letters, and the whole syllable plays **stretched** (*paaa-sss*) with the `stretch` clip. Three letters are never shown at once as an unsegmented block.

**Peek-a-boo**, for the second half of the syllable screens: the base *PA* is shown and the coda is hidden behind a "?" card inside the same arc. She reads *PA* aloud, taps the card, the card turns over to *S*, and the stretched clip plays.

**Word screen:** the syllables appear one at a time, left to right. A closed syllable is always built with the 2+1 steps (base, then the coda docks). Once a syllable is done it docks into an **anchor chip** at the top: a small tile she can tap at any time to hear that syllable again, so she does not have to hold it in memory while she decodes the next. When the last syllable is done, a "Juntar" button appears (the app's existing join), the whole word plays, and only then the picture appears.

All screens: tiles ≥ 44 px, focus visible, colours as tokens with the dark variant, texts via `t()` in both languages. With `prefers-reduced-motion` the slide and the flip become instant (the arc and the final state remain).

## 3. The 3-second rescue (zero stall)

A timer starts when each step is shown and resets on every tap. If she does nothing for **3 seconds** (`window.__leemosRescueMs` overrides it in tests):
- **Syllable screen:** Lumi plays the base sound, the coda tile (or the "?" card) starts pulsing, and her only task is to tap it.
- **Word screen:** Lumi plays the syllable that is on screen (the closed one stretched, the open one normal) and docks it into the anchor chip for her; the remaining syllable is hers.
- The rescue fires **once per step** (no repeated nagging); after it, the pulse stays and there is no further timer.
- Nothing is shown or played that signals an error: no buzzer, no cross, no "try again". The rescue is not recorded anywhere.

The rescue answers inactivity only. The app cannot tell that she is hesitating while reading aloud, because there is no speech recognition.

## 4. Mode and wiring

- `mode` gains the value `close`; the button is `#mClose` (label "Cierra" / "Tanca"), the fourth in the row (the row becomes 4 columns, or 2×2 on a narrow phone).
- `PREF_OK.mode` in `merge.js` accepts `close` (`PREF_KEYS` does not change).
- `src/close.js` holds the pure part (the selection of syllables and words, the session plan) and `createClose(ctx)`, the screen. `app.js` loads it with `import()` the first time the mode is used, with a timeout like `find.js` (5 s; `window.__leemosCloseTimeout` in tests). If it cannot load, or fewer than 6 syllables are open, tapping the button shows a hint (`closeLocked`) and the saved mode does not change; a saved `close` falls back to a normal exercise without changing the preference.
- `next()` ignores a stray call while a session is on screen (as with Busca); language and Camino changes start a new session (`next(true)`).
- The screen has its own room element (`#closeRoom`) and the class `close` on `<html>` hides the reading screen's session bar, dots, tiles, picture and buttons.
- A session never touches stats, `total`, the session counters or the Camino; the end gives a sticker through `earnSticker()` and the reward overlay, then "otra vez".
- `sw.js`: add `src/close.js` and `src/data/closed.es.json`, `closed.ca.json` to `SHELL` and bump `VERSION`.
- New i18n keys in both languages: `mClose`, `closeLocked`, `closeIntro` (Lumi's instruction), `closeGoal`, `closeAgain`, `closeDone`, `closeCover` (aria label of the "?" card), `closeAnchor` (aria label of the anchor chip).

## 5. Audio

- A new clip kind **`stretch`**: the syllable said with a long vowel and a continuous coda (*paaa-sss*). Its key is `~<syllable>` (for example `~pas`) so it never collides with the normal `pas` syllable clip; the app looks it up with `ck('~pas')`. The file name comes from `slug(key)` as for every clip.
- `scripts/lib/clips.mjs` adds one `stretch` clip per syllable in `closed.<lang>.json`. `scripts/spoken.mjs` sends it as SSML to Azure: the vowel lengthened (a prosody/`emphasis` pattern or repeated vowel; the exact recipe is found by experiment, then written in `pronunciation.<lang>.json` per clip when it needs help). The base CV sound and the open syllables reuse the existing clips.
- The review page (`tools/review.html`) lists the `stretch` clips; the ones that sound wrong (a glottal stop before the coda, a letter-name reading, a question intonation) are re-recorded with "Grabar mi voz" (`tools/record.html`), which gets the same list.
- Lumi's instruction `closeIntro` is a normal `phrase` clip in the explicit phrase list; it plays on the first screen of a session. With no clip it is silent.
- Generating audio uses a plain run (`npm run audio -- --provider azure`), which generates only the missing clips. Never `--kind phrase --force`.

## 6. Tests

- `tests/close.mjs` (pure, real data, both languages): the word rule (2 syllables, exactly one closed, onset + vowel + s/r/l; the examples above qualify and the excluded ones do not); every step from 3 up has ≥ 6 open syllables, steps 1–2 have fewer than 6 (locked); no syllable of the bank uses a coda or onset letter that is not open at the step stepOf gives it; a session plan has 6 screens, no repeats, never the same coda three in a row when others are open, half docking and half peek-a-boo for syllable screens, and falls back to 6 syllable screens with fewer than 2 open words.
- Audio guards in `tests/azure.mjs` (or a new test): every syllable in the bank has a `stretch` clip in the clip list, the key rule `~…`, and, once generated, the file in the manifest and on disk; `closeIntro` is in the phrase list.
- Smoke (`tests/smoke.mjs`): the button, locked and open states, the preference kept when locked or when the module cannot load; a syllable screen (base, coda tile, dock, stretched clip, arc); peek-a-boo (card, reveal); a word screen (anchor chip, replay on tap, join, then the picture); the rescue after 3 s for each screen type and only once; nothing recorded (stats, total, session unchanged); the sticker once at the end and not before; language and Camino changes start a new session while a stray `next()` does not; the end-of-reading-session overlay does not open over the game; screen reader labels and focus; no errors.
- Mutation checks for each guarantee (a rescue that repeats, an error sound, stats touched, a sticker early, the same syllable twice).

## Not in this project

Audio-first picture choice (robot mode), comic minimal pairs (pata/pasta, cama/carta), counting the mode toward mastery, a verification choice between two codas, codas other than s/r/l, words with two closed syllables, and any voice recognition.

## Open points

- The Azure recipe for a clean stretch is unknown until tried. The fallback is recording the ones that fail; if most fail, recording all of them is a session of about 36 per language.
- Spanish has few open qualifying words until step 11 (*pulpo* only before that), so most early Spanish sessions are all syllable screens.
- Nothing stops her tapping the coda tile without reading; the adult is the check.
