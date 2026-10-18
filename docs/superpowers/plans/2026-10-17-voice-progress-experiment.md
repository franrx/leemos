# Voice-progress experiment (spike plan)

> **Status:** a spike. Its output is an **answer**, not a feature. The recording page and the analysis script are small tools kept for repeating the test; nothing here changes the app. Do not wire anything into `src/app.js` unless the decision rule at the end says so, and then only through a new spec.

## The question

Can recordings of Elsa reading, compared with the reference clip, tell us something **true** about her progress? Three candidate signals, from cheapest to most ambitious:

| Signal | What it measures | Needs |
|---|---|---|
| **Timing** | seconds from the syllable appearing to her first sound, and how long she speaks | loudness only |
| **Acoustic similarity** | MFCC + dynamic time warping distance between her clip and the app's reference clip | `ffmpeg`, plain Node |
| **Speech recognition** | does Whisper transcribe what was shown | the `whisper` CLI (already installed; models tiny/base/small cached) |

**Ground truth:** the parent's ✅ / 🔁 on each reading (that is already how the app works), plus deliberately wrong readings (see protocol).

## Decision rule (written before looking at any data)

- **Per-item correctness** (could replace or back up the parent's tap): a signal qualifies only if AUC ≥ **0.85** with the lower end of its 95% bootstrap interval ≥ **0.75**, on **at least 15 natural 🔁 and 40 ✅ readings** of Elsa. If none does, we do **not** build automatic scoring. AUC is **item-adjusted** (each reading is compared only with readings of the same item, so item difficulty and the reference clip's scale cannot pass for a signal) and its interval resamples **whole items**. Nobody speaking counts as the worst answer; a retried reading has no timing.
- **Progress trend** (the realistic win): timing qualifies if, for items read in two different sessions, the latency test-retest correlation (Spearman, first readings only) is ≥ **0.6**, and mean latency is clearly lower for mastered items than for items she still fails (difference larger than its bootstrap interval). If yes, the next step is a small spec for storing two numbers per exercise (latency, duration), never audio.
- **Positive control first:** on **adult** readings (correct vs deliberately wrong) at least one similarity signal must reach AUC ≥ **0.90**. If it does not, the method itself is broken, and the Elsa sessions are not worth doing.
- Possible outcomes: *drop it*, *timing only*, *timing + something else*. Say which in the report, with the numbers.

## Honest limits (to restate in the report)

- Labels are a parent's quick judgment, so they are noisy. One child, one microphone, one room. Results do not transfer to other children, other dialects (Mallorca) or other devices.
- Natural mistakes are rare, so negatives come mostly from **on-purpose wrong readings**, which are easier to detect than real confusions. A good score on them overstates real performance; say so.
- Her audio is a child's voice: it stays on this laptop in `lab/` (gitignored), is never synced or uploaded, and is deleted when the experiment is closed.

## Protocol

1. **Adult control (Fran, about 10 min):** 30 syllables read correctly and 30 read wrong on purpose, same lists, Spanish. Run the analysis; check the positive control. **Whoever taps stays silent until pressing Listo** (praise or a correction before the tap would end up in the clip and differ by verdict).
2. **Elsa, two sessions of about 5 min on different days:** about 40 readings each, mixed levels, **including items above her level** so natural errors appear. The parent taps ✅ / 🔁 as usual. At the end, a short "say it wrong on purpose" game gives about 20 labelled negatives. Repeat a few items across both sessions for the test-retest check.
3. Analyze, write the report, decide.

## Tasks

### Task 1: a local-only route that stores a reading

**Files:** create `scripts/lib/labapi.mjs`; modify `scripts/dev-server.mjs` (mount it the same way `clipapi` is mounted); create `tests/lab.mjs`; add to the `npm test` script; add `lab/` to `.gitignore`.

- `POST /__lab?session=<id>&n=<int>` (binary body, max 5 MB) writes `lab/<session>/<n>.webm`; `POST /__lab-label?session=<id>&n=<int>` (JSON body) appends one line to `lab/<session>/labels.jsonl`; `DELETE /__lab?session=<id>` removes that session's folder. Reuse `isLocalRequest` (loopback socket, `Host` localhost, matching `Origin`).
- `session` must match `/^[a-z0-9-]{3,40}$/`, `n` an integer 0–9999; anything else is a 400. No path is ever built from user text.
- [ ] Write `tests/lab.mjs` first (fake request/response like `tests/record.mjs`): a local request stores the file and the line; a non-loopback socket, a foreign `Host` and a foreign `Origin` get 403; `session=../x`, `n=-1`, `n=abc` and an oversized body are rejected; delete removes only that session; nothing is written outside `lab/`. Watch it fail, implement, watch it pass, run `npm test`, commit.

### Task 2: the recording page

**Files:** create `tools/lab.html`, `tools/lab.js` (reuse the microphone and level-meter code of `tools/record.js`; do not copy `src/app.js`).

- URL parameters: `lang=es|ca`, `level=1..5`, `n=40`, `who=elsa|adult`, `kind=read|wrong`.
- Per item: show the text in big tiles; **start recording at the instant it is shown** (so the onset inside the clip is her latency); a large "Listo" button stops it; the adult then taps ✅ or 🔁 (for `kind=wrong` the verdict is set to 🔁 automatically and the screen says "di la sílaba mal a propósito"). Upload the audio, then the label `{session, n, key, text, lang, who, kind, verdict, shownAtIso}`. Items come from `src/data/levels.<lang>.json` using the same keys as the app (`s:ma`, `w:casa`), some repeated.
- Show the live level bar and refuse to save a silent recording (the same check as `SILENT_PEAK` in the app). A visible "Grabando" indicator, and a "Borrar todo" button that calls `DELETE /__lab?session=<id>`.
- [ ] Manual check list (no jsdom test for throwaway UI): opens at `http://localhost:5173/tools/lab.html`, records with the real microphone, files and labels appear under `lab/`, silent recordings are refused, delete works. Commit.

### Task 3: the analysis script

**Files:** create `scripts/lab-analyze.mjs` and `scripts/lib/labdsp.mjs` (pure functions); create `tests/labdsp.mjs`; add it to `npm test`.

- `labdsp.mjs`: `frames(pcm, rate, ms)`, `vad(pcm, rate) → {onsetMs, offsetMs, peakDb, noiseDb}` (10 ms frames, noise floor = 10th-percentile energy, speech = more than 8 dB above it for at least 60 ms), `mfcc(pcm, rate)` (25 ms / 10 ms, 26 mel filters, 13 coefficients, per-clip mean/variance normalisation), `dtw(a, b)` (distance divided by path length), `auc(scores, labels)` (rank-based), `bootstrapCI(fn, data, 2000)`, `spearman`.
- [ ] Write `tests/labdsp.mjs` first with synthetic signals generated in Node: a 400 ms tone burst starting at a known time is detected within ±20 ms; pure silence and constant noise give no onset; `dtw` of a signal with itself is about 0 and with a different-frequency signal is clearly larger; `auc` returns 1 for perfectly separated, 0.5 for identical scores and 0 for inverted; `bootstrapCI` brackets the known AUC. Fail, implement, pass, commit.
- `lab-analyze.mjs <session...>`: decode each file with `ffmpeg -ar 16000 -ac 1 -f f32le -`; decode the reference clip (`audio/<lang>/…`, resolved through `audio/manifest.json`); compute timing, similarity, and run `whisper <files> --model small --language <lang> --output_format json` once per batch (also `base` for comparison); write `lab/report.md` and `lab/readings.csv` with: n per class, AUC with 95% interval for each signal, the confusion table of Whisper (exact match and edit distance ≤ 1 after lowercasing and removing accents), latency by verdict, test-retest for repeated items, and the verdict of the decision rule above, line by line.
- [ ] Run it on a recording of Fran's voice before the real sessions; check by hand that three reported onsets match what you hear. Commit.

### Task 4: run the adult control and decide whether to continue
- [ ] Fran records the adult control (protocol 1). Run the analysis. If no similarity signal reaches AUC 0.90, stop and write the finding (the method is unsound); otherwise continue.

### Task 5: the Elsa sessions and the answer
- [ ] Two sessions with Elsa and the on-purpose-wrong game (protocol 2). Run the analysis, read `lab/report.md`, write the conclusion **using the decision rule as written**, with the numbers, the limits above and a recommendation (drop it, timing only, or what to specify next). Put the conclusion in `docs/experiments/2026-10-voice-progress.md` (numbers only, no audio, no transcripts of her speech). Delete `lab/` or move it somewhere you choose.

## What would change the plan

If positive control fails, we stop after Task 4. If Elsa produces fewer than 15 natural 🔁, we say the per-item test is underpowered and judge timing only. If the microphone or room is too noisy for the loudness detector (noise floor within 15 dB of her speech), fix the setup before collecting more.

## Findings while building Tasks 1-3 (2026-10-18, before any child data)

These come from synthetic signals and from macOS `say` voices, not from Elsa. They say what the tools can do, not whether the idea works.

- **The pipeline works on real speech.** With the same macOS voice as reader and reference, the MFCC-DTW distance for the same syllable is about 2.1 to 2.6 and for a different syllable about 11 to 14. That is the easy, same-speaker case. Whisper runs through the CLI (`base` heard "Ma" and "Lo"; it wrote "¡P." and "Pi" for "pe"). Reported latency matched the silence added (390 ms for 400 ms).
- **Pitch is a warning sign.** With clean synthetic vowels, changing the pitch moved the features more than changing the vowel (see the INFO line printed by `tests/labdsp.mjs`). Real voices may behave differently, but this is exactly the risk for a 6-year-old against an adult reference voice. The adult control compares Fran with the generated voice, which tests the cross-speaker case before Elsa is recorded. Do not read the same-voice numbers above as evidence for children.
- **Fixed while testing on real clips:** generated references contain exact digital silence (the noise floor read -180 dB, so faint tails counted as speech and padding changed the distance). The noise floor now has a lower bound of -75 dB, log energies are floored 90 dB below the loudest filter, and clips are trimmed to the speech with no padding. The same audio inside different amounts of silence now gives a distance of 0.
- **Still to do by hand:** a real-microphone check of `tools/lab.html` in a browser (the jsdom test uses a fake microphone), and the adult control (Task 4).

## Review fixes before any recording (2026-10-18)

A fresh review of Tasks 1-3 found, and these changes fix:

- **Her recordings could be downloaded.** The static dev server served `lab/` (a child's voice and transcripts), which with `HOST=0.0.0.0` meant anyone on the network. It now answers 404 for `lab/`, with a test.
- **Item difficulty could pass for a signal.** Long words fail more and last longer, so duration looked predictive. The decision lines now use the item-adjusted AUC and an interval that resamples whole items.
- **The adult's voice could end up in the clip.** The page tells the adult to stay silent until Listo, and the speech detector ignores any burst more than 0.7 s after the reading.
- **Silent failures vanished.** A reading nobody spoke in now counts as the worst answer; the report counts them per verdict.
- **The page's microphone processing** (gain control, noise suppression, echo cancellation) is now off, because it changes the timing and levels being measured. The page also records tries, the recorder's start lag, uses a session id with seconds, and releases the microphone at the end or on wipe.
- **The control picked the "best" signal before checking it had data.** It now considers only signals with at least 20 readings of each kind.
- **Deliberate differences from the first draft of this plan:** the noise floor is the 5th percentile (not the 10th, and never below -75 dB), MFCCs remove the mean only (variance scaling magnified noise), DTW is divided by n + m, and the tolerant Whisper signal equals the exact one for syllables of up to three letters.

