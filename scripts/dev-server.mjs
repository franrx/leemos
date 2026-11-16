// Zero-dependency static server for local development: `npm run dev` -> http://localhost:5173
// (Service workers and microphone access need localhost or https.)
// It listens on the loopback interface only, because the project folder holds secrets (.env) and a recording API.
// To reach it from another device on purpose (e.g. the tablet, without microphone): HOST=0.0.0.0 npm run dev
import { createServer } from 'node:http';
import { ROOT } from './lib/clips.mjs';
import { handleClipApi } from './lib/clipapi.mjs';
import { handleLabApi } from './lib/labapi.mjs';
import { handleStatic } from './lib/staticserver.mjs';

const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '127.0.0.1';
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
// Development only, off unless set: LEEMOS_SYNC_CONFIG_JSON='{"url":"http://127.0.0.1:5174","anonKey":"dev"}' makes /src/data/sync.config.json
// answer with that JSON (QA against scripts/fake-supabase-server.mjs). The committed file is never modified.
let overrides = null;
if (process.env.LEEMOS_SYNC_CONFIG_JSON) {
  try { JSON.parse(process.env.LEEMOS_SYNC_CONFIG_JSON); } catch { console.error('LEEMOS_SYNC_CONFIG_JSON no es JSON válido'); process.exit(1); }
  overrides = { '/src/data/sync.config.json': process.env.LEEMOS_SYNC_CONFIG_JSON };
}

createServer(async (req, res) => {
  try {
    if (await handleClipApi(req, res)) return; // recording export for tools/record.html (loopback only, even with HOST set)
    if (await handleLabApi(req, res)) return; // the voice-progress experiment (tools/lab.html): readings go to the gitignored lab/ folder
    handleStatic(req, res, { root: ROOT, localHostsOnly: loopback, overrides });
  } catch (e) {
    if (!res.headersSent) { res.writeHead(500); res.end('Server error'); } else res.destroy();
  }
}).listen(port, host, () => {
  console.log(`Leemos en http://localhost:${port}   (revisar audios: /tools/review.html, grabar: /tools/record.html)`);
  if (overrides) console.log('AVISO: la configuración de sincronización viene de LEEMOS_SYNC_CONFIG_JSON (solo desarrollo; src/data/sync.config.json no se toca).');
  if (!loopback) console.log(`AVISO: escuchando en ${host}: cualquiera en tu red puede ver los archivos del proyecto (menos los que empiezan por «.»).`);
});
