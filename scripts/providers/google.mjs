// Google Cloud Text-to-Speech. Docs: https://cloud.google.com/text-to-speech/docs
// .env: GOOGLE_TTS_API_KEY, GOOGLE_VOICE_ES (default es-ES-Neural2-A), GOOGLE_VOICE_CA (default ca-ES-Standard-A)
// Optional: GOOGLE_SPEAKING_RATE (default 0.9). Fragments starting with "<" in pronunciation files are sent as SSML.
// CHECK the current voice list (voices:list) for es-ES and ca-ES before generating.
import { httpError } from './_http.mjs';

const LOCALE = { es: 'es-ES', ca: 'ca-ES' };

export async function synthesize({ text, lang, env }) {
  const key = env.GOOGLE_TTS_API_KEY;
  if (!key) throw new Error('Falta GOOGLE_TTS_API_KEY en .env');
  const name = env['GOOGLE_VOICE_' + lang.toUpperCase()] || (lang === 'ca' ? 'ca-ES-Standard-A' : 'es-ES-Neural2-A');
  const isSsml = text.trim().startsWith('<');
  const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: isSsml ? { ssml: `<speak>${text}</speak>` } : { text },
      voice: { languageCode: LOCALE[lang], name },
      audioConfig: { audioEncoding: 'MP3', speakingRate: Number(env.GOOGLE_SPEAKING_RATE || 0.9) },
    }),
  });
  if (!r.ok) throw await httpError(r);
  const j = await r.json();
  return Buffer.from(j.audioContent, 'base64');
}
