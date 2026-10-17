# Camino de Elsa (letter-by-letter path) — design

Date: 2026-10-17. Status: draft for review. Touches item selection (`pick`), the level bars, the end screen, the parent panel, the saved preferences and the sync merge whitelist. Read `2026-10-17-book-content-design.md` (levels, `levelrule.js`) and `2026-10-17-session-prefs-sync-design.md` (the `prefs` mechanism this reuses) first.

## Goal

Practice follows the school book, one letter at a time (M P L N T S F B D R C, then the rest), without showing her a letter the book has not taught, and without the same few words coming back all the time.

## Decisions already made

| Question | Decision |
|---|---|
| When is an item unlocked | **All its letters are open** (the syllabic method). `mapa` needs M and P. Vowels are always open. |
| The 5 levels | Stay as the **structure ceiling**; the path controls **which letters**. The pool is cumulative: every level from 1 up to the chosen one. |
| How letters unlock | **Both**: automatic after mastery, and the parent can open or close letters on a Camino screen to match the school. A switch turns the automatic part off. |
| Letters after C | One last step, **"el resto"**, opens every other letter at once (the book's order after C is unknown). |
| Defaults | Elsa's existing profile starts **all open** (nothing changes until the parent closes some). A new reader profile starts at **M only**. |

## Principles

- Optional to the child, nothing is ever scary: no failure state, nothing disappears that she already earned (stickers, stats).
- The path is a **preference**, not progress: latest change wins (a parent must be able to close letters, which a "maximum" rule forbids), and it reuses `S.prefs`, the 30 s idle rule and the whitelist.
- Pure logic in `src/levelrule.js` (tested in node); the app only glues it. Leo (`kind:'pre'`) is not affected.

## 1. The path and the unit rule (`src/levelrule.js`)

- `STEPS = ['m','p','l','n','t','s','f','b','d','r','c','*']`: 12 steps; step `n` (1-based) means the first `n` entries are open. Step 12 = everything.
- `unitsOf(hyphenated)`: the consonant units of a word or syllable, accents ignored. It reuses `norm` (ñ→ny, ç→ss) and tokenizes the joined text with `/ch|ll|ny|qu|tx|rr|gu|ss|[^aeiou]/g` (vowels are skipped, digraphs are one unit).
- `stepOfUnit(u)`: the step that opens it: `m p l n t s f b d r c` → 1…11; `rr` → 10 (it is an R); every other unit (`ch ll ny qu tx gu ss`, `v g j z h x y k w`, anything unknown) → 12. So an unexpected letter never stays locked forever.
- `stepOf(hyphenated)` = the largest `stepOfUnit` of its units, or 0 when it has no consonant (a bare vowel). An item is **eligible** at position `pos` when `stepOf(item) <= pos`. An item is **new** at `pos` when `stepOf(item) === pos`.
- Soft `c` (ce, ci) counts as C; accepted.

## 2. What she practices (`src/app.js`)

- **Pool:** `itemsFor` now returns the items of levels `0…S.level` (cumulative), then keeps only the eligible ones for the current language's position (`pathPos()`). If the filter would leave the pool **empty**, the filter is ignored (the app must never stall).
- **Weights:** unchanged (`max(.25, 1 + fail·2.5 − ok·.35 + (unseen ? 1.5 : 0))`); unseen items of the newest letter already weigh most, so no extra boost.
- **Recent window:** instead of excluding only the last item, exclude the last `k = min(6, floor(pool.length / 2))` item keys (kept in memory, not saved). If that leaves nothing, fall back to excluding only the last.
- **Effective mode:** `effMode()` is `'word'` only when `S.mode === 'word'` and the pool has **at least 4 words**; otherwise `'syl'`. The stored preference `S.mode` is never changed (so syncing it is safe). The Palabras button is dimmed (`aria-disabled`, title with the reason) while it is not available.
- Level bars count only **eligible** items of that level (so a bar can reach 100% with few letters open).

## 3. Unlocking

- **Automatic**, evaluated when a session ends (where the end screen computes the level-up): if `pathAuto` is on and the position is below 12, take the items that are **new** at the current position across levels `0…S.level` **in the mode she is practising** (`effMode()`; found in review: counting words she is never shown made most steps impossible to open); the next step opens when at least **75%** of them are mastered (`ok >= 2 && ok > fail`, the existing rule) or there are none. It opens **one** step per session. The end screen shows "¡Nueva letra: P!" (for step 12: "¡Todas las letras!").
- **Parent:** a **Camino** block in the parent panel (next to the account block) with 12 buttons (`M P L N T S F B D R C +`) for the current language. Tapping step `n` sets the position to `n` (opens or closes letters). A switch **"Abrir letras automáticamente"** controls `pathAuto` (default on). Switching it off is how a parent keeps Elsa from moving ahead of the school.
- **Level-up:** the existing offer (≥90% of the level's eligible items mastered) is shown only when the position is 12.

## 4. Saved state and sync

- New preferences, whitelisted in **both** `PREF_OK`/`PREF_KEYS` in `src/merge.js` and `PREF_KEYS` in `src/app.js` (keep them equal; a test checks): `pathEs`, `pathCa` (integers 1–12) and `pathAuto` (boolean). They live in `S.prefs {key:{v,at}}` and as plain fields `S.pathEs`, `S.pathCa`, `S.pathAuto`.
- **Defaults on load** (a one-time correction, stamps nothing, set before the sync baselines are taken): a state with no `pathEs`/`pathCa` gets 12 when it already has progress (`total > 0` or any stats), otherwise 1; `pathAuto` defaults to `true`. A parent's tap and an automatic advance both go through the same setter, which changes the field and lets `save()` stamp it.
- Applying a pull (`applyMerged`): a changed path redraws the Camino block and the level bars and the next exercise is picked only if the one on screen is no longer eligible (a parent closing letters does the same) (the same place that already handles a mode or language change).

## 5. What the adult sees

- The Camino block (parent panel), the dimmed Palabras button with a short note, the "new letter" line on the end screen. The child's screen has no new controls.
- No new Lumi audio in this change: the end-screen line is text (Lumi stays silent without a clip, as for any phrase without audio). A follow-up can generate clips with `npm run audio -- --kind phrase`.
- New texts in `i18n.es.json` and `i18n.ca.json` (same keys): `pathTitle`, `pathHelp`, `pathAuto`, `pathRest`, `pathOpen`, `pathClosed`, `wordsLocked`, `endNewLetter`, `endAllLetters`.

## 6. Not in this change

Leo's mode, the order of letters after C (one step for now), per-letter practice screens, rewards for opening a letter, new audio, and the "Busca la paraula" game and book mode.

## 7. Failure modes

- A position outside 1–12 or not an integer (hostile or old data): ignored by the whitelist; the app falls back to the default for the state.
- A pool that would be empty (a new language with few items, a very low level): the filter is skipped.
- Fewer than 4 eligible words: Palabras is dimmed and syllables are used; the stored mode is untouched.
- Parent closes letters while auto is on: the automatic rule only looks at the items **new at the current position**, so it advances at most one step per session; the switch exists for a parent who wants it to stay.
- Letters whose items are all above the level ceiling (e.g. position 3 at level 1, where only m s l n exist): nothing is new there, so the automatic rule opens them one per session without practice; they show up when the parent raises the level. Harmless, and the Camino block shows the position either way.
- Two devices change the path at once: latest change wins per key (the same rule as every preference).
- An item with a letter the rule does not know: counts as step 12, never locked forever.
- Elsa's existing profile at all-open: nothing changes until a parent closes letters.
- A fresh device with no progress that receives an experienced child through the sync: its placeholder M (never chosen, never stamped) becomes all-open (found in review). A child who is genuinely new at M and unstamped, first seen on a second fresh device, would also be opened: accepted (rare).
- The rule module cannot load (stub): nothing is locked, opened or offered; the Camino block is hidden.
- Leo's panel does not show the Camino block.

## 8. Testing

- `tests/levels.mjs`: `unitsOf` (digraphs, accents, ñ/ç, vowels only), `stepOfUnit`, `stepOf` for words and syllables in both languages, every word and syllable in the data gets a step 0–12, step 12 makes everything eligible, step 1 keeps only m-items and bare vowels; the counts of eligible items per step are non-decreasing.
- `tests/merge.mjs`: the three preferences are whitelisted (valid and invalid values), latest change wins, `PREF_KEYS` equals the app's list.
- `tests/smoke.mjs`: at position 1 only M items appear (many draws); position 12 shows the old behavior; the pool is cumulative across levels; the recent window prevents a repeat within `k` draws; Palabras is dimmed with fewer than 4 words and the exercise is a syllable; mastering the new letter opens the next one at the end of the session, once; the switch off keeps the position; a parent tap closes letters; level-up only at 12; defaults for an old profile (12) and a new one (1); a pulled path applies and re-picks the exercise; a hostile path value is ignored; the Camino block and the end-screen line exist in both languages.
- `tests/sync.mjs`: the path preferences travel through pull-merge-push.
