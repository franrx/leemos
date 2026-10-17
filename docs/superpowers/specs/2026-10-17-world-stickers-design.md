# Sticker sets per world — design

Date: 2026-10-17. Status: draft for review. Touches the saved state, the sync merge (`src/merge.js`), the album and the world picker. Read `2026-10-17-accounts-sync-design.md` for the merge rules this extends.

## Goal

The 16 worlds (bosque, playa, circo…) give a reason to try each one: stickers are collected **per world**, and the world picker shows the progress of each set. Nothing is ever locked.

## Decisions already made

| Question | Decision |
|---|---|
| Kind of reward | **Collect**: each world has its own set; no locking, no failure state. |
| Stickers she already has | **Moved into the worlds** where each animal fits; nothing is lost. |
| Sorpresa | The sticker comes from the world being shown in that session. |
| A full set | The sticker comes from the first incomplete world instead; nothing drops after all are done. |

## What is true today (checked in the code)

- `S.stickers` is a counter 0–24; sticker `i` is `STICKERS[i]` (`stickers.json`, 24 animals).
- A sticker is won **once per finished session** (`record()` in `app.js` and `finished` in `sounds.js`), not every 8 answers. `CLAUDE.md` says "cada 8 aciertos"; it is out of date and is corrected in this change.
- Leo (`kind:'pre'`) has the same rule in `sounds.js` with the same counter, and his own profile state.
- "Borrar progreso" does not touch stickers. That stays.
- `mergeData` merges `stickers` as the maximum.

## 1. Data

- `worlds.json`: each world gets `stk`, an array of **6 emoji** (96 in total). Every set has exactly 6, with no emoji repeated across worlds.
- The 24 old animals sit at the **start** of their world's `stk`, in their old relative order. The mapping (old emoji → world) is fixed once, in `LEGACY_WORLD` in `src/merge.js`: an array of 24 world ids in the old order. `stickers.json` stays only as the source of that order and for a test that checks the two agree. No world receives more than 6 old animals.
- The 72 new emoji are standard Unicode emoji that fit the world (circo 🎪🤡🎠…, dino 🦖🦕…, musica 🎵🎸…). Chosen in the plan; a test checks the sizes and that there are no duplicates.

## 2. Saved state and merge

- New `S.stk = {worldId: n}`: how many of that world's set she owns (the first `n` of `stk`). `S.stickers` stays as the **total** (`sum of S.stk`) so the album counter and old readers keep working.
- **Reading any state or server data** (`stkOf(d)` in `merge.js`):
  - if `d.stk` is a plain object, keep only keys that match `/^[a-z]{2,20}$/` (at most 32 keys) with whole numbers 0…`CAP_STK` (24; the app clamps to the set size on apply);
  - otherwise (state saved before this change, or a device not updated yet) migrate from `d.stickers`: for old index `i < d.stickers` (capped at 24), add 1 to `LEGACY_WORLD[i]`.
- `mergeData`: `stk[w] = max(stkOf(a)[w], stkOf(b)[w])` per world; `stickers = sum(stk)`. Commutative, associative, idempotent (same as the other counters). Because owned old animals are always the start of each set, the migration never loses or duplicates one.
- `applySynced` writes `state.stk` and `state.stickers`. `fpOf()` in `save()` uses `S.stk` (it already tracks `S.stickers`; both change together).
- The app migrates a local state on load with the same `stkOf`, so there is one implementation.

## 3. Earning

One function in `app.js`, `earnSticker()`, replaces the two copies (reader and Leo):

1. `w` = the id of the session's world (`WORLDS[worldNow()]`).
2. If `S.stk[w] < WORLDS[w].stk.length`: add 1 there. Otherwise take the first world (in `WORLDS` order) that is incomplete. If all 16 are complete: no sticker.
3. Return the emoji (`stk[n-1]` of that world), or `null`; update `S.stickers`; the caller counts the session sticker (`sStk++`) and shows the reward as today.

`sounds.js` receives `earnSticker` in its context instead of the `stickers` array.

## 4. What she sees

- **World picker:** each tile gets a small `n/6` badge (and a ✓ when complete). All tiles stay selectable. The Sorpresa tile shows the total (`x/96`).
- **Album:** grouped by world (world icon + name as a heading, then its six slots; owned ones show the emoji, the others stay dimmed like today). The counter shows `x/96`. `aria-label`s follow the existing `albumGot`/`albumLocked` keys.
- **Reward screen:** unchanged, plus the world icon next to the sticker when it comes from a different world than the one being played (the fallback case) so it is not a surprise.
- New texts in both `i18n.es.json` and `i18n.ca.json` (`albumInfo` now says `x/96`, a world heading format, the badge's `aria-label`). `npm test` already checks both files have the same keys.

## 5. Not in this change

Locking worlds, a badge for a finished set, sticker trading, per-language sets, changing how often a sticker is won, and the word preference by world (a separate step already agreed: remove it and make Sorpresa the default).

## 6. Failure modes

- A device that has not updated yet pushes only `stickers`: handled (migration from the legacy counter, merge by maximum). Its next pull gives it the total.
- Server data with unknown world ids, non-numbers, or huge numbers: dropped or capped by `stkOf`.
- A world that disappears later: its count stays harmless in the state (not shown, not counted in the picker); the total uses the worlds that exist.
- A set that grows later: owned count stays valid (it is a prefix); new slots appear dimmed.
- Two devices earning in the same world at once: maximum wins, so one sticker can be lost in the race. Accepted (same as other counters).

## 7. Testing

- `tests/merge.mjs`: `stkOf` migration (0, 7, 24 old stickers, over 24), merge max per world, `stickers = sum`, properties (commutative, associative, idempotent), hostile input, a legacy-only side merged with a new side.
- A data test: every world has 6 unique emoji, no emoji in two worlds, the 24 old animals come first in each set in old order, `LEGACY_WORLD` agrees with `stickers.json`.
- `tests/smoke.mjs`: an old saved state is migrated and shows the same stickers in the right worlds; finishing a session adds a sticker to the current world; Sorpresa uses the displayed world; a full world falls back to the first incomplete one; all full gives none; the picker shows `n/6`; the album is grouped; Leo earns through the same function; a pull from a legacy device keeps both sides' stickers.
- `tests/sync.mjs`: `stk` travels through pull-merge-push.
