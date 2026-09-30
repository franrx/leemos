// ElevenLabs text-to-speech. Docs: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
// .env: ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ES, ELEVENLABS_VOICE_CA (voice ids from your voice library)
// Optional: ELEVENLABS_MODEL (default eleven_multilingual_v2), ELEVENLABS_STABILITY, ELEVENLABS_SIMILARITY,
//           ELEVENLABS_SPEED, ELEVENLABS_SEND_LANGUAGE=1 (sends language_code, only for models that accept it).
// CHECK before generating: which model supports Catalan today, and that your chosen voice speaks it well.
import { httpError } from './_http.mjs';

export async function synthesize({ text, lang, env }) {
  const key = env.ELEVENLABS_API_KEY;
  const voice = env['ELEVENLABS_VOICE_' + lang.toUpperCase()];
  if (!key || !voice) throw new Error('Faltan ELEVENLABS_API_KEY y ELEVENLABS_VOICE_ES / ELEVENLABS_VOICE_CA en .env');
  const body = {
    text,
    model_id: env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
    voice_settings: {
      stability: Number(env.ELEVENLABS_STABILITY || 0.6),
      similarity_boost: Number(env.ELEVENLABS_SIMILARITY || 0.8),
      speed: Number(env.ELEVENLABS_SPEED || 0.9),
    },
  };
  if (env.ELEVENLABS_SEND_LANGUAGE === '1') body.language_code = lang;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw await httpError(r);
  return Buffer.from(await r.arrayBuffer());
}
