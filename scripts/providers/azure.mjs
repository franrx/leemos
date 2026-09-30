// Azure AI Speech (neural voices), via SSML. Docs: https://learn.microsoft.com/azure/ai-services/speech-service/
// .env: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION (e.g. westeurope)
// Optional: AZURE_VOICE_ES (default es-ES-ElviraNeural), AZURE_VOICE_CA (default ca-ES-JoanaNeural), AZURE_RATE (default -10%).
// Azure lets you control pronunciation with SSML: put a fragment starting with "<" in src/data/pronunciation.<lang>.json.
// CHECK the current voice list for your region before generating: names and availability change.
import { httpError } from './_http.mjs';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const LOCALE = { es: 'es-ES', ca: 'ca-ES' };

export async function synthesize({ text, lang, env }) {
  const key = env.AZURE_SPEECH_KEY;
  const region = env.AZURE_SPEECH_REGION;
  if (!key || !region) throw new Error('Faltan AZURE_SPEECH_KEY y AZURE_SPEECH_REGION en .env');
  const voice = env['AZURE_VOICE_' + lang.toUpperCase()] || (lang === 'ca' ? 'ca-ES-JoanaNeural' : 'es-ES-ElviraNeural');
  const inner = text.trim().startsWith('<') ? text : esc(text);
  const rate = env.AZURE_RATE || '-10%';
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${LOCALE[lang]}">` +
    `<voice name="${voice}"><prosody rate="${rate}">${inner}</prosody></voice></speak>`;
  const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'leemos',
    },
    body: ssml,
  });
  if (!r.ok) throw await httpError(r);
  return Buffer.from(await r.arrayBuffer());
}
