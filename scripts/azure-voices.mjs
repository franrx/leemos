#!/usr/bin/env node
// `npm run azure:voices`: checks your Azure key and region, and lists the Spanish and Catalan voices you can use.
// Never prints the key. Set AZURE_VOICE_ES / AZURE_VOICE_CA in .env to pick one.
import { loadEnv } from './lib/env.mjs';
import { listVoices } from './providers/azure.mjs';

const env = loadEnv();
try {
  const voices = await listVoices({ env });
  console.log(`Región ${env.AZURE_SPEECH_REGION}: ${voices.length} voces es-ES / ca-ES\n`);
  for (const v of voices) console.log(`${v.Locale}  ${v.ShortName.padEnd(30)} ${v.Gender.padEnd(7)} ${v.VoiceType}`);
  const has = (n) => voices.some((v) => v.ShortName === n);
  const want = { es: env.AZURE_VOICE_ES || 'es-ES-ElviraNeural', ca: env.AZURE_VOICE_CA || 'ca-ES-JoanaNeural' };
  console.log('');
  for (const [l, n] of Object.entries(want)) console.log(`${has(n) ? '✓' : '✗ NO DISPONIBLE'}  voz para ${l}: ${n}`);
  process.exit(has(want.es) && has(want.ca) ? 0 : 2);
} catch (e) {
  console.error('✗ ' + e.message);
  process.exit(1);
}
