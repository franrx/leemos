// Tests for the Azure provider with a fake fetch: request shape, SSML wrapping, errors, and the voice-list check.
import { synthesize, listVoices } from '../scripts/providers/azure.mjs';
import { buildClipList } from '../scripts/lib/clips.mjs';
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };

const env = { AZURE_SPEECH_KEY: 'test-key', AZURE_SPEECH_REGION: 'westeurope' };
const calls = [];
let reply = () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, json: async () => [], text: async () => '' });
globalThis.fetch = async (url, opts = {}) => { calls.push({ url, opts }); return reply(); };
const last = () => calls[calls.length - 1];

// ---------- synthesize ----------
const sound = "<phoneme alphabet='ipa' ph='mː'>m</phoneme>";
const buf = await synthesize({ text: sound, lang: 'es', env });
check('azure: posts to the region endpoint with the key and an SSML content type', last().url === 'https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1' && last().opts.headers['Ocp-Apim-Subscription-Key'] === 'test-key' && last().opts.headers['Content-Type'] === 'application/ssml+xml');
check('azure: returns the audio bytes as a Buffer', Buffer.isBuffer(buf) && buf.length === 3);
check('azure: a letter sound goes into the SSML as an IPA phoneme, untouched', last().opts.body.includes(sound), last().opts.body);
check('azure: Spanish uses es-ES with Elvira', /xml:lang="es-ES"><voice name="es-ES-ElviraNeural"/.test(last().opts.body), last().opts.body);
await synthesize({ text: sound, lang: 'ca', env });
check('azure: Catalan uses ca-ES with Joana', /xml:lang="ca-ES"><voice name="ca-ES-JoanaNeural"/.test(last().opts.body), last().opts.body);
await synthesize({ text: 'a & b < c', lang: 'es', env });
check('azure: plain text is XML-escaped', last().opts.body.includes('a &amp; b &lt; c'), last().opts.body);
await synthesize({ text: 'ma', lang: 'es', env: { ...env, AZURE_VOICE_ES: 'es-ES-AlvaroNeural', AZURE_RATE: '-30%' } });
check('azure: voice and rate can be overridden from .env', /voice name="es-ES-AlvaroNeural"/.test(last().opts.body) && /rate="-30%"/.test(last().opts.body));
// Lumi (phrase clips) speaks with one warm voice in both languages; syllables and words keep the per-language voices.
for (const lang of ['es', 'ca']) {
  await synthesize({ text: 'Molt bé, Elsa!', lang, kind: 'phrase', env });
  check(`azure: a ${lang} phrase uses Lumi's voice, in the language's locale, at rate -5%`, new RegExp(`xml:lang="${lang === 'es' ? 'es-ES' : 'ca-ES'}"><voice name="es-ES-XimenaMultilingualNeural"><prosody rate="-5%"`).test(last().body ?? last().opts.body), last().opts.body);
}
await synthesize({ text: 'ma', lang: 'ca', kind: 'syllable', env });
check('azure: a syllable keeps the language voice', /voice name="ca-ES-JoanaNeural"/.test(last().opts.body), last().opts.body);
await synthesize({ text: 'Hola', lang: 'es', kind: 'phrase', env: { ...env, AZURE_VOICE_LUMI: 'es-ES-ElviraNeural', AZURE_RATE_LUMI: '-20%' } });
check("azure: Lumi's voice and rate can be overridden from .env", /voice name="es-ES-ElviraNeural"><prosody rate="-20%"/.test(last().opts.body), last().opts.body);
let msg = '';
try { await synthesize({ text: 'ma', lang: 'es', env: {} }); } catch (e) { msg = e.message; }
check('azure: a missing key or region is a clear error', /AZURE_SPEECH_KEY/.test(msg), msg);
reply = () => ({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'bad key' });
msg = '';
try { await synthesize({ text: 'ma', lang: 'es', env }); } catch (e) { msg = e.message; }
check('azure: an HTTP error carries the status and the body', /HTTP 401/.test(msg) && /bad key/.test(msg), msg);

// ---------- voice list ----------
reply = () => ({ ok: true, status: 200, json: async () => [
  { ShortName: 'es-ES-ElviraNeural', Locale: 'es-ES', Gender: 'Female', VoiceType: 'Neural' },
  { ShortName: 'ca-ES-JoanaNeural', Locale: 'ca-ES', Gender: 'Female', VoiceType: 'Neural' },
  { ShortName: 'fr-FR-DeniseNeural', Locale: 'fr-FR', Gender: 'Female', VoiceType: 'Neural' },
  { ShortName: 'ca-ES-EnricNeural', Locale: 'ca-ES', Gender: 'Male', VoiceType: 'Neural' },
] });
const voices = await listVoices({ env });
check('voices: asks the region for its voice list with the key', last().url === 'https://westeurope.tts.speech.microsoft.com/cognitiveservices/voices/list' && last().opts.headers['Ocp-Apim-Subscription-Key'] === 'test-key');
check('voices: keeps only Spanish and Catalan (Spain) voices', voices.map((v) => v.ShortName).join() === 'es-ES-ElviraNeural,ca-ES-JoanaNeural,ca-ES-EnricNeural');
reply = () => ({ ok: false, status: 403, statusText: 'Forbidden', text: async () => 'wrong region' });
msg = '';
try { await listVoices({ env }); } catch (e) { msg = e.message; }
check('voices: an HTTP error is reported with its body', /HTTP 403/.test(msg) && /wrong region/.test(msg), msg);

// Lumi's instruction phrases are an explicit list in scripts/lib/clips.mjs: a phrase the app speaks (hintFor in app.js) has to be in it, or no audio is ever generated for it.
for (const lang of ['es', 'ca']) {
  const i18n = JSON.parse(readFileSync(new URL(`../src/data/i18n.${lang}.json`, import.meta.url), 'utf8'));
  const phrases = buildClipList({ name: 'Elsa', langs: [lang] }).filter((c) => c.kind === 'phrase').map((c) => c.text);
  const filled = (k) => i18n[k].replace('{n}', 'Elsa');
  check(`clips: the ${lang} phrase list has the three instructions Lumi says for words and syllables, and the whole-word one`, ['hintSyl', 'hintWord', 'hintWhole', 'hintJudge'].every((k) => phrases.includes(filled(k))), ['hintSyl', 'hintWord', 'hintWhole', 'hintJudge'].filter((k) => !phrases.includes(filled(k))).join(','));
}

// ...and its audio has to exist: a phrase in the list whose clip is missing from the manifest or from disk would leave Lumi silent for it.
{
  const { existsSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync(new URL('../audio/manifest.json', import.meta.url), 'utf8'));
  for (const lang of ['es', 'ca']) {
    const i18n = JSON.parse(readFileSync(new URL(`../src/data/i18n.${lang}.json`, import.meta.url), 'utf8'));
    const missing = ['hintSyl', 'hintWord', 'hintWhole', 'hintJudge'].filter((k) => {
      const file = manifest.clips[lang][i18n[k].replace('{n}', 'Elsa').toLowerCase()];
      return !file || !existsSync(new URL(`../audio/${lang}/${file}`, import.meta.url));
    });
    check(`clips: Lumi's ${lang} instructions (syllables, words, whole words, judging) all have their audio in the manifest and on disk`, missing.length === 0, missing.join(','));
  }
}

console.log(failures ? `\n${failures} azure test(s) FAILED` : '\nAll azure tests passed');
process.exit(failures ? 1 : 0);
