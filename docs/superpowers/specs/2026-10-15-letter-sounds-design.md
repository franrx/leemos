# Letter sounds for Leo (pre-reader profile)

Date: 2026-10-15. Status: draft, pending review.

## Goal

Leo (4, pre-reader) learns to associate each letter with its **sound** (phoneme, not letter name) in Spanish and Catalan. He gets his own profile in Leemos. Elsa's syllable method is untouched.

## Decisions already made

- Own profile for Leo (own name, progress, stickers, language), switchable from the home screen.
- Both languages (es, ca) from the start.
- Activity: **intro card, then tap game** (hear sound, tap the matching letter). Sound production judged by an adult is out of scope for now.
- No speech recognition, no tracking, no data leaves the device (CLAUDE.md rules still apply).

## Profiles and storage

- Elsa keeps `localStorage['leemos-v1']` unchanged. No migration.
- Leo uses `localStorage['leemos-v1:leo']`.
- `localStorage['leemos-profiles']` lists profiles and the active one: `{ active, list: [{ id, name, kind }] }`.
  - `kind: 'reader'` loads the current app. `kind: 'pre'` loads the sounds home.
  - Missing key defaults to a single `reader` profile (Elsa), so existing installs behave as today.
- `app.js` change is limited to profile selection at load and a switcher chip on the home screen. Every new field gets a default in the `Object.assign` line.
- IndexedDB `leemos-audio` is shared between profiles (parent recordings serve both children).
- Praise phrases include the child's name. Generated clips exist only for `NAME=Elsa`; for Leo they fall back to browser TTS until a `NAME=Leo` set is generated.

## Content

New `src/data/sounds.es.json` and `sounds.ca.json`:

```json
{ "groups": [ { "name": "...", "letters": [ { "l": "m", "word": "mano", "e": "🖐️" } ] } ] }
```

- Each picture word must start with the sound it demonstrates. Catalan words need native review (same open item as the existing lists).
- Proposed order (to confirm): 1) a e i o u, 2) m s l p, 3) t n d c, 4) r b f g, 5) v j z h ñ/ny ch/tx qu and remaining cases. es and ca differ where sounds differ (ç, ny, tx, open/closed e and o).
- Stats keys: `snd:m` (es), `ca:snd:m` (ca), same prefix rule as syllables.

## Activity

**Home (kind `pre`):** big "Jugar" button, letter progress, Lumi. Language toggle and sound switch stay reachable. No levels or modes.

**Session:** about 5 minutes, 5 or 10 exercises. Letters enter in groups of 3 to 4.

**Intro card** (once per new letter in a session):
- Large letter, lowercase and uppercase side by side; tapping plays the sound.
- Picture word with emoji, spoken ("M de mano 🖐️"). The picture is shown on purpose here: the goal is sound-letter linking, not reading.
- "Siguiente" button. No judging.

**Game step:** Lumi plays the sound; Leo taps the matching letter among 2 choices (3 once the letter is solid). Wrong tap: soft sound, Lumi says "Casi, escucha otra vez", sound replays, the wrong option fades, he tries again. Right tap: happy sound, picture, confetti. Replay button always visible.

**Selection and mastery:**
- Same weight formula as Elsa: `max(.25, 1 + fallos*2.5 - aciertos*.35 + (sin intentos ? 1.5 : 0))`. Mastered = `ok >= 2 && ok > fail`.
- Distractors come from letters already seen. Confusable pairs (m/n, b/d, p/b) appear together only once both are mastered.
- Next group is offered (not forced) when most of the current group is mastered.
- Stickers at session end, same 24 stickers and album as the current app.

**UI conventions:** tokens in `:root` with dark variant, targets at least 44 px, visible focus, `prefers-reduced-motion` disables confetti, mascot motion and transitions, Andika with fallback.

## Audio

Priority unchanged: parent recording, generated clip, browser TTS. New clip type `sound` in `scripts/spoken.mjs`, overrides in `pronunciation.*.json`, review in `tools/review.html`, regenerate with `--only`.

**Main risk:** TTS often turns an isolated phoneme into the letter name ("eme" for /m/), as seen with "ba". Mitigation: build the pipeline first, generate a first batch, and measure how many clips are right before building the screens. Expect some sounds to need Fran's recordings via "Grabar mi voz".

## Code layout

- New `src/sounds.js` (module) holds the pre-reader flow. `app.js` (575 lines) only gets profile selection and the switcher.
- i18n: new keys in both `i18n.es.json` and `i18n.ca.json` (`npm test` enforces parity).
- If `sw.js` `SHELL` changes (new files), bump `VERSION`.

## Testing

Extend `tests/smoke.mjs` (jsdom): profile creation and switching, Elsa's state untouched, es and ca sounds load, session flow (intro then game), wrong-tap retry, adaptive weighting, group unlock, i18n parity, audio priority for `snd:` keys. Real-browser check on the tablet is still pending as in CLAUDE.md (audio, installation).

## Out of scope

Adult-judged sound production, writing or tracing letters, blending into syllables (that is Elsa's mode), cloud sync, per-world stickers.

## Open items

1. Confirm group order and the 2-then-3 choice rule.
2. Native review of Catalan picture words.
3. Decide whether to generate a `NAME=Leo` praise set.
