# Sync the session in progress and the preferences — design

Date: 2026-10-17. Status: draft for review. Extends `2026-10-17-accounts-sync-design.md` (read it first: this adds fields to the same synced `data`, the same pull-merge-push protocol and the same pure merge).

## Goal

A child (or the adult) can stop on one device and continue on another exactly where they were: the session in progress ("4 de 10", the stickers earned in it) and the preferences that make the app feel the same everywhere.

## Decisions already made

| Question | Decision |
|---|---|
| What counts as "everything" | The session in progress **plus** the preferences: mode, world, session length, capitals, language, reading speed, sound on/off and the **theme**. Not the chosen voice (each device has different voices) and not the recorded voice clips (large audio; a separate project). |
| Two devices at the same time | **Latest change wins**, with no interruption: a device that changed something in the last 30 seconds keeps its own value; it adopts a newer remote value when it is idle. |
| What of the session syncs | The **counters** (done, correct, stickers earned in the session), not the exact syllable on screen. The device that continues picks its own next exercise with the adaptive weights. |

## Principles

- Same as the accounts spec: optional, offline-first, minimal data, no tracking. These fields carry no personal data.
- Each kind of value has its **own timestamp**, so an unrelated change on one device can never overwrite another value on a second device. In particular the session and the preferences must **not** touch `modAt` (that stamp decides `level` and `name`).
- The merge stays a pure function in `src/merge.js`; applying values to the screen stays in `src/app.js`.

## 1. Data model (inside the synced `data`)

```
session: { done, ok, stk, at }          // counters of the session in progress; at = ms timestamp of its last change
prefs:   { mode: {v, at}, world: {v, at}, sessionLen: {v, at}, upper: {v, at},
           lang: {v, at}, rate: {v, at}, sound: {v, at}, theme: {v, at} }
```

### Merge rules

- **`session`**: the whole object comes from the side with the larger `at`. Ties are broken by the larger `done`, then `ok`, then `stk`, so the order of the arguments never matters. `done`, `ok`, `stk` are whole numbers capped like the other counters. A session whose `at` is older than **12 hours** is treated as no session (all zero): a session left over from yesterday must not resume.
- **`prefs`**: per key, the entry with the larger `at` wins (ties: the larger value as text, so the result is deterministic). Each key has a whitelist of valid values; anything else is dropped:

| key | valid `v` |
|---|---|
| `mode` | `'syl'`, `'word'` |
| `world` | `'auto'` or an integer 0–99 (clamped to the existing worlds when applied) |
| `sessionLen` | 5, 10, 15, 20 |
| `upper` | true, false |
| `lang` | `'es'`, `'ca'` |
| `rate` | number 0.5–1.1 |
| `sound` | true, false |
| `theme` | `''` (system), `'light'`, `'dark'` |

- `at` values must be safe integers; a missing or invalid `at` counts as 0, so a value with no timestamp loses to any stamped one.
- Not synced, never read from or written to the server: `voiceURI`, `voiceURIs`, the IndexedDB recordings.

The properties from the accounts spec hold for the new fields: commutative, associative, idempotent, and a value never reverts to an older one.

## 2. Local state and change detection

- **`S.session = {done, ok, stk, at}`** mirrors the three module counters (`sDone`, `sOk`, `sStk`). `save()` copies them in, so the session is also **persisted locally**: reloading the page mid-session no longer loses "4 de 10" (the existing pending item "persist the session in progress"). On load, a stored session older than 12 hours starts from zero.
- **`S.prefsAt = {mode, world, sessionLen, upper, lang, rate, sound, theme}`**: one timestamp per preference.
- `save()` compares three separate fingerprints (progress, session counters, each preference) and stamps **only the part that changed**: `modAt`, `session.at`, or `prefsAt[key]`, each as `Math.max(Date.now(), previous + 1)` so a stamp never goes backwards. Applying data that came from the server stamps nothing and schedules no sync (same rule as today).
- Existing saved states without these fields load with zeros and stamp nothing; the first real change stamps it.

## 3. Applying a pull

After the merge, `storeState` applies the merged data to the screen:

- **Idle rule.** A local value changed less than 30 seconds ago (its `at` is within 30 s of now) is **kept**; its `at` is renewed so it wins on the next push, and a push is scheduled. Otherwise the merged (newer) value is applied.
- **Session:** set `sDone/sOk/sStk` from the merged session, then `renderSession()` and `renderGoal()`. A merged session with `done >= sessionLen` is a finished session: it applies as zero (a new one starts). `done` is clamped below `sessionLen`.
- **Preferences:** applied through the same functions the UI uses (`applyTheme`, `applyCase`, `applySound`, the mode and world setters, the session-length selector, the speed slider, the language switch). Order: session length first, then the session counters, so the clamp uses the right length.
- Nothing is applied while the pull is in flight that was changed locally after the request started (the same merge-into-current-state rule as the progress fix).

## 4. What the adult sees

Nothing new in the UI. The "Sincronizado" line and the sync button stay as they are. A device that picks up a different theme, language or mode simply switches. No dialogs.

## 5. Testing

- `tests/merge.mjs`: session and prefs merge (latest wins, ties deterministic, per-key independence, whitelist, invalid values dropped, 12-hour expiry, caps, property tests: commutative, associative, idempotent).
- `tests/smoke.mjs`: the session persists across a reload; a pulled session shows "4 de 10"; a session changed locally 5 seconds ago is not overwritten by an older-looking remote one, but is adopted after 30 s of idleness; changing the theme on one device and the sound on another keeps both; a finished remote session applies as zero; a pulled language switches the interface; the voice is never synced; `modAt` is not touched by session or preference changes (the level does not revert).
- `tests/sync.mjs`: the new fields travel through pull-merge-push unchanged.

## 6. Failure modes to handle

- Clock differences between devices (only the relative order of stamps matters; a device whose clock is far ahead would win every tie in its favor — accepted, same as `modAt`).
- Two devices answering at once: each keeps its own session for 30 s of activity, then the later write wins; at most the counters of one device are lost for that window.
- A hostile or broken remote value (wrong type, out of range): dropped by the whitelist, never applied.
- A remote language the interface does not have: dropped.
- A session adopted on a device whose session length differs (pref arrives in the same pull): the length is applied first.

## 7. Not in this change

The exact syllable on screen, voice choice, recorded clips, a "continue on the other device?" prompt, history of sessions.
