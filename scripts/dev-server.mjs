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

createServer(async (req, res) => {
  try {
    if (await handleClipApi(req, res)) return; // recording export for tools/record.html (loopback only, even with HOST set)
    if (await handleLabApi(req, res)) return; // the voice-progress experiment (tools/lab.html): readings go to the gitignored lab/ folder
    handleStatic(req, res, { root: ROOT, localHostsOnly: loopback });
  } catch (e) {
    if (!res.headersSent) { res.writeHead(500); res.end('Server error'); } else res.destroy();
  }
}).listen(port, host, () => {
  console.log(`Leemos en http://localhost:${port}   (revisar audios: /tools/review.html, grabar: /tools/record.html)`);
  if (!loopback) console.log(`AVISO: escuchando en ${host}: cualquiera en tu red puede ver los archivos del proyecto (menos los que empiezan por «.»).`);
});
