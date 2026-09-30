// What text do we actually send to the TTS provider for each clip? This is THE place to experiment.
//
// Isolated syllables are the hard part for any synthetic voice: "ma" may come out with question
// intonation, or be spelled out as a letter name. Things worth trying (listen with `npm run review`):
//   - append a period or an ellipsis:            "ma."  /  "ma…"
//   - repeat it, keep only the first (post step): "ma, ma"
//   - use SSML/IPA on Azure or Google:            "<phoneme alphabet='ipa' ph='ma'>ma</phoneme>"
//   - set an explicit override for a stubborn clip in src/data/pronunciation.<lang>.json
//
// Return a plain string. If it starts with "<" it is treated as an SSML fragment (Azure/Google).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/clips.mjs';

const overrides = {};
function loadOverrides(lang) {
  if (overrides[lang]) return overrides[lang];
  const p = join(ROOT, `src/data/pronunciation.${lang}.json`);
  overrides[lang] = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  return overrides[lang];
}

export function spokenFor(clip) {
  const o = loadOverrides(clip.lang)[clip.key];
  if (o) return o;
  switch (clip.kind) {
    case 'syllable':
      return clip.text; // TODO(experiment): try clip.text + '.'
    case 'word':
      return clip.text;
    default:
      return clip.text; // phrases
  }
}
