# Content aligned to Elsa's school reading book (project 1)

Date: 2026-10-17. Status: draft, pending review.

## Context and goal

Elsa's school gave her a Catalan reading dossier (19 pages photographed). It is all in capitals and has these page types:

- **LLETRES / vocals and consonants:** single letters in boxes with animal pictures.
- **SÍL·LABES:** boxed rows of six syllables per consonant (MA MO MI MU ME MO, the last repeating an earlier one), then direct/inverse pairs (MA/AM, CO/OC…).
- **MONOSÍL·LABS:** 36 short words (MÀ FOC SAL PA REI SAC…).
- **LECTURA <letter>** (M P L N T S F B D R C): "BUSCA LA PARAULA: X (3)" among 12 look-alike words starting with the same letter, then one sentence with a picture.

**Goal of this project:** make the app's vocabulary and syllable coverage match the book, in both languages, without changing Elsa's method or breaking her progress. The game ("busca la paraula"), the sentences and the per-letter book mode are separate projects (see Roadmap) that build on this one.

## Decisions (from the brainstorming)

1. **Keep the 5 levels.** The book's words are added to the existing levels by difficulty. A word's book letter is its first grapheme and is derived, never stored.
2. **Both languages.** Catalan gets the book's words. Spanish gets words written by me (there is no Spanish book), with the same per-letter coverage.
3. **Pictures become optional.** A word without an emoji shows no picture after it is read.
4. **Accept the progress-bar drop.** Adding words lowers each level's mastered percentage; mastered items stay mastered; no formula change.
5. **Approach A:** edit `levels.*.json` directly, guarded by a tested placement-rule checker (no generator, no runtime merge).
6. **Capitals** become the default for new profiles, and Elsa's existing profile switches to capitals once (she can switch back).
7. **Not in this project:** the single-letter pages (that is Leo's mode), the syllable-row layout, changes to the mastery formulas, world tags for new words.

## Roadmap (each its own spec, plan and build)

1. **This project:** content aligned to the book.
2. **Elsa's path:** letter-by-letter unlocking in the book's order (M P L N T S F B D R C, then the rest), a cumulative pool across levels, and a recent-history window against repetition. It comes next, before the game. Observed problem it must solve: the same words repeat a lot (*coco, casa, ninot, bota*, all level 2). Causes found in `pick()`: a missed word's weight is `1 + 2.5 × fails` against about 1 for others; only the immediately previous item is excluded; level 1 has 4 Catalan words, level 2 has 14; in Palabras mode 80% of picks go to words tagged with the current world. More vocabulary helps from level 3 upwards but cannot fix levels 1–2 (few words can be spelled with only m s l n), so the picker itself changes in that project. Open design question for it: does the automatic unlock replace the manual level buttons, or sit beside them? Availability rule to evaluate: an item is available when every consonant it uses is unlocked.
3. **"Busca la paraula" game:** tap the 3 hidden copies of a word among look-alikes; self-checking; needs at least 12 words per letter (target + 9 distractors + spares).
4. **Book mode:** pick the letter she is on at school and mirror the page: find the word, read the sentence with its picture, then the syllable row.

## Design

### 1. Data and the placement rule

**Format** is unchanged: `{"w":"ne-na","e":"👧","g":"granja"}`. `e` becomes optional. In `src/app.js` `show()`, the "?" picture slot is hidden when the current word has no emoji (today it is shown for every word in Palabras mode), and `join()` already only reveals a picture when there is one.

**Book letter** = first grapheme of the word without hyphens, accents ignored; `ch ll ny qu tx rr gu` count as one letter. Computed by `letterOf(w)`; no new field.

**Placement rule.** A word's minimum level is the highest level among its syllables; any word of 3 or more syllables is at least level 3:

| Level | A syllable that is… |
|---|---|
| 1 | direct with m s l n, or a bare vowel |
| 2 | direct with p t b d c (c/k before a o u) |
| 3 | direct with f v r g j (`gu` alone, `gua`, is direct) |
| 4 | closed (al, ar, et…), glide-ending (neu, bou, rei, rey), or an onset cluster (pl bl cl fl gl pr br tr gr dr fr cr) |
| 5 | special spelling: tx ny ll rr qu, gu+e/i, ç, x, z, h, ñ, ch, soft c/g before e/i |

**Checker.** A pure module `src/levelrule.js` exports `sylLevel(syllable)`, `minLevel(hyphenated)` and `letterOf(hyphenated)` (no globals, same pattern as `src/sounds.js`; `app.js` must not gain `import` statements, so any later use in the app goes through the dynamic-import seam). A test fails if any word sits **below** its minimum. New words are placed at exactly their minimum. A prototype over the 293 existing words found 286 already conform; the 7 exceptions move up to their minimum (their stats are keyed by word, so progress is untouched):

- Catalan: *ni-not* 2→4, *bo-let* 2→4, *co-et* 3→4.
- Spanish: *luz* 4→5, *pez* 4→5, *bra-zo* 4→5, *cer-do* 4→5.

### 2. Vocabulary

Target: **at least 12 distinct words for each of the 11 book letters, in both languages**, so the later game has a target, 9 distractors and spares.

| Distinct words per letter | M | P | L | N | T | S | F | B | D | R | C |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Catalan now | 10 | 17 | 1 | 5 | 9 | 6 | 7 | 10 | 4 | 3 | 26 |
| Catalan after | 19 | 24 | 12 | 14 | 17 | 14 | 15 | 17 | 15 | 13 | 33 |
| Spanish now | 10 | 22 | 7 | 5 | 11 | 7 | 4 | 11 | 4 | 4 | 29 |
| Spanish after | 13 | 22 | 13 | 13 | 13 | 14 | 12 | 13 | 12 | 13 | 29 |

- **Catalan:** 111 new words, all read off the book's pages (the 112th, *pa*, already exists). Where the book has both *caragol* and *cargol*, both are kept.
- **Spanish:** 53 new words I selected: concrete, known to a 6-year-old, standard Spain Spanish, no duplicates, an emoji only where one fits.
- New words get no world tags (`g`). Spelling and accents follow the book exactly; syllable splits follow standard Catalan/Spanish syllabification. The full lists are in Appendix A for review.

### 3. Syllables and monosyllables

Comparing the book's 79 distinct syllables with the app's syllable lists:

- **Direct syllables are fully covered** (M P L N T D B V S F R X with all vowels).
- **8 inverse syllables are missing, in both languages:** `am oc ac im at ap op ab`. The app's closed syllables end only in l r n s. The full series vowel × {m c t p b} (25 syllables) is added to level 4's `syl` list in both languages (50 → 75). Spanish does not get `xa xo xi xe xu` (not Spanish syllables).
- **Monosyllable words:** the book's 36 are all covered by the section 2 vocabulary (8 already existed); they sit wherever the rule places them (closed ones in level 4).
- **Not added:** single-letter pages (Leo's mode covers letters; a level 0 for Elsa is a possible later project); the six-syllable row layout and direct/inverse pairs (book mode, project 4).

### 4. Capitals and audio

**Capitals.** `S.upper` defaults to `true` for new profiles, both languages (one setting). Elsa's saved state holds `upper:false` explicitly, so a one-time migration sets it to `true` guarded by a new flag (`S.upperMigrated`), runs once per profile of kind `reader`, and is not repeated if she switches back with Aa. Leo's mode (kind `pre`) is untouched (it shows both cases). CSS uppercasing keeps accents and `Ç`.

**Audio.** New clips: about 136 Catalan (111 words + 25 syllables) and 78 Spanish (53 words + 25 syllables); exact counts from `npm run audio:plan`. Azure, same Elvira/Joana voices as the existing clips; a few thousand characters (cents) and about 1.5 MB in total. Generation never overwrites existing clips (no `--force` on existing keys). Mechanical check (every clip exists, plausible length, not silent) plus the user listens to the 50 new syllable clips (short ones like "ac"/"at" are what text voices mispronounce); bad ones get a `pronunciation.<lang>.json` override and a regeneration. Delivery uses the existing manifest and per-clip revision scheme. Needs a working `AZURE_SPEECH_KEY` in `.env` (verify with `npm run azure:voices`).

### 5. Testing and order of work

**New `tests/levels.mjs`:**
- `sylLevel`/`minLevel`/`letterOf` on known cases (*ne-na* 1, *ca-sa* 2, *fo-ca* 3, *ba-na-na* 3, *sol* 4, *neu* 4, *llu-na* 5, *gui* 5, `gu` alone direct, *pin-güí* 5).
- Both languages: word format (lowercase letters/accents, every part has a vowel, no duplicates); every word at or above its minimum level; at least 12 distinct words per book letter; the full inverse-syllable series in level 4; `e` absent or a non-empty string.

**`tests/smoke.mjs` additions:**
- A word without an emoji never shows the "?" slot, before or after joining.
- A new profile starts in capitals.
- An existing Elsa state with `upper:false` becomes capitals exactly once; after she toggles back it stays lowercase.
- Leo's mode is unaffected.
- The existing pass over every level, mode and language still renders non-empty tiles (now covering the new words).

Audio is not a permanent test: coverage is verified once with `npm run audio:plan` showing nothing left to generate.

**Order of work:** (1) rule and tests, move the 7 existing words; (2) optional emoji in the app; (3) Catalan words; (4) Spanish words; (5) inverse syllables; (6) capitals default and one-time switch; (7) audio generation and the user's listening pass; (8) `CLAUDE.md` update and review.

**Files:** new `src/levelrule.js`, `tests/levels.mjs`; modified `src/data/levels.ca.json`, `src/data/levels.es.json`, `src/app.js`, `tests/smoke.mjs`, `package.json` (test script), `CLAUDE.md`; new audio under `audio/` and `audio/manifest.json`; possibly `src/data/pronunciation.*.json`.

## Risks and open items

- Words were transcribed from photographs; some may be misspelt. Review Appendix A against the book.
- Hyphenation and the Spanish selection are my work and need the user's eye before anything ships.
- Short inverse-syllable clips may need pronunciation overrides.
- Level bars will drop after the words are added (accepted).
- The one-time capitals switch changes a setting the user did not touch (approved, reversible with one tap).
- The Azure key must be rotated and set in `.env` before audio generation.
- Clips are keyed by text and shared between profiles; regenerating a key replaces the clip for everyone.

## Appendix A: candidate words for review

Each entry is `syllable-split emoji (level)`. Emoji are optional; entries without one show no picture. "Existing words that move up" are the 7 exceptions from section 1.

### Català

New words: **111** (by level 1-5: 7 / 11 / 22 / 62 / 9). Already in the app and skipped: 1.

Per book letter, before → after: M 10→19, P 17→24, L 1→12, N 5→14, T 9→17, S 6→14, F 7→15, B 10→17, D 4→15, R 3→13, C 26→33.

Existing words that move up to their minimum level: ni-not (2 -> 4), bo-let (2 -> 4), co-et (3 -> 4).

**M**: ma-le-ta 🧳 (L3) · mos-ca 🪰 (L4) · mà ✋ (L1) · men-ta 🌿 (L4) · mi-rall 🪞 (L5) · me-ló 🍈 (L1) · met-ge 🧑‍⚕️ (L5) · ma-ri-e-ta 🐞 (L3) · man-ta (L4)

**P**: pi-ja-ma (L3) · pas-tís 🍰 (L4) · pi-pí (L2) · pin-ta 🎨 (L4) · peu 🦶 (L4) · pi-la 🔋 (L2) · pa-la (L2)

**L**: lu-pa 🔍 (L2) · la-ca (L2) · lec-tu-ra 📖 (L4) · là-ser (L4) · li-la 🟣 (L1) · la-va-bo 🚽 (L3) · la-be-rint (L4) · li-ró (L3) · lam-pis-ta 🧑‍🔧 (L4) · làm-pa-da 💡 (L4) · lí-ni-a 📏 (L3)

**N**: nen 👦 (L4) · no (L1) · niu 🪺 (L1) · ni-na 🪆 (L1) · nú-vi-a 👰 (L3) · nius 🪺 (L4) · nú-vol ☁️ (L4) · nus (L4) · nit 🌙 (L4)

**T**: tau-la (L4) · ti-te-lla 🪆 (L5) · ti-so-res ✂️ (L4) · tú-nel 🚇 (L4) · tim-bal 🥁 (L4) · tas-sa ☕ (L4) · tos 🤧 (L4) · tu-li-pa 🌷 (L3)

**S**: si-re-na 🧜 (L3) · serp 🐍 (L4) · sar-di-na 🐟 (L4) · si (L1) · sa-ba-ta 👟 (L3) · ser-ra 🪚 (L4) · sa-bó 🧼 (L2) · sac 🛍️ (L4)

**F**: fa-nal (L4) · fi-de-us 🍜 (L4) · foc 🔥 (L4) · fum 💨 (L4) · fus-ta 🪵 (L4) · fi-ga (L3) · fil 🧵 (L4) · font ⛲ (L4)

**B**: bou 🐂 (L4) · bo-nic (L4) · bi-go-ti 🥸 (L3) · bar-ret 🎩 (L4) · bo-tó 🔘 (L2) · ba-ta 🥼 (L2) · banc (L4)

**D**: dau 🎲 (L4) · dut-xa 🚿 (L5) · di-a-ri 📰 (L3) · di-a (L2) · dent 🦷 (L4) · dò-mi-no (L3) · dàl-ma-ta 🐕 (L4) · dan-sa 💃 (L4) · dit ☝️ (L4) · dos 2️⃣ (L4) · di-a-de-ma 👑 (L3)

**R**: ra-to-lí 🐭 (L3) · riu 🏞️ (L3) · rei-na 👸 (L4) · ra-que-ta 🎾 (L5) · ro-da 🛞 (L3) · rei 🤴 (L4) · re-ga-do-ra 🚿 (L3) · ra-ïm 🍇 (L4) · rà-di-o 📻 (L3) · ra-te-ta 🐭 (L3)

**C**: cui-na 🍳 (L2) · cam-pa-na 🔔 (L4) · car-gol 🐌 (L4) · cor-da 🪢 (L4) · co-ca (L2) · cu-lle-ra 🥄 (L5) · cuc 🐛 (L4)

**A**: à-nec 🦆 (L4) · am-po-lla 🧴 (L5) · an-te-na 📡 (L4)

**E**: eu-ga 🐴 (L4)

**G**: gat 🐱 (L4) · gos 🐕 (L4) · gol ⚽ (L4)

**I**: i-gua-na 🦎 (L3) · in-di (L4)

**J**: joc 🎮 (L4)

**O**: ós 🐻 (L4) · ou 🥚 (L4)

**U**: ull 👁️ (L5) · u-ni-corn 🦄 (L4)

**V**: vas 🥛 (L4)

**X**: xai 🐑 (L5)


### Castellano

New words: **53** (by level 1-5: 1 / 5 / 17 / 19 / 11). Already in the app and skipped: 0.

Per book letter, before → after: M 10→13, P 22→22, L 7→13, N 5→13, T 11→13, S 7→14, F 4→12, B 11→13, D 4→12, R 4→13, C 29→29.

Existing words that move up to their minimum level: luz (4 -> 5), pez (4 -> 5), bra-zo (4 -> 5), cer-do (4 -> 5).

**M**: ma-le-ta 🧳 (L3) · mo-chi-la 🎒 (L5) · mo-ne-da 🪙 (L3)

**L**: lu-pa 🔍 (L2) · la-go 🏞️ (L3) · le-ón 🦁 (L4) · li-món 🍋 (L4) · le-che 🥛 (L5) · lá-piz ✏️ (L5)

**N**: ni-do 🪺 (L2) · no-che 🌙 (L5) · na-riz 👃 (L5) · na-ran-ja 🍊 (L4) · ne-gro (L4) · ni-ña 👧 (L5) · nu-tria 🦦 (L4) · nú-me-ro (L3)

**T**: ta-za ☕ (L5) · te-cho 🏠 (L5)

**S**: si-lla 🪑 (L5) · se-llo ✉️ (L5) · se-ta 🍄 (L2) · su-ma ➕ (L1) · si-re-na 🧜 (L3) · so-fá 🛋️ (L3) · sar-di-na 🐟 (L4)

**F**: fa-ro 🔦 (L3) · fue-go 🔥 (L3) · fuen-te ⛲ (L4) · fan-tas-ma 👻 (L4) · fi-de-o 🍜 (L3) · fo-co 🔦 (L3) · fie-bre 🤒 (L4) · fi-la (L3)

**B**: be-bé 👶 (L2) · ba-lón ⚽ (L4)

**D**: de-do 👆 (L2) · dien-te 🦷 (L4) · dos 2️⃣ (L4) · dul-ce 🍬 (L5) · dia-man-te 💎 (L4) · de-sier-to 🏜️ (L4) · dor-mir 🛌 (L4) · dis-co 💿 (L4)

**R**: ra-ta 🐀 (L3) · ra-mo 💐 (L3) · rí-o 🏞️ (L3) · rey 🤴 (L4) · ro-pa 👕 (L3) · re-loj 🕐 (L4) · rue-da 🛞 (L3) · ra-tón 🐭 (L4) · re-ga-lo 🎁 (L3)

