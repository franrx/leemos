// Unofficial "Edge TTS": reuses Microsoft Edge's Read Aloud feature, which speaks with the
// same neural voices as Azure AI Speech (Elvira, Joana...) but free and without any account
// or API key. This is a reverse-engineered WebSocket protocol, not a supported API: Microsoft
// can change or block it without notice. Prefer `azure`/`google` if you have a free-tier key.
// .env: none required.
// Optional: EDGE_VOICE_ES (default es-ES-ElviraNeural), EDGE_VOICE_CA (default ca-ES-JoanaNeural),
// EDGE_RATE (default -10%), EDGE_PITCH (default +0Hz), EDGE_VOLUME (default +0%).
import { randomUUID, createHash } from 'node:crypto';
import WebSocket from 'ws';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = '143';
const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const WIN_EPOCH_OFFSET = 11644473600; // seconds between 1601-01-01 and 1970-01-01

const LOCALE = { es: 'es-ES', ca: 'ca-ES' };
const DEFAULT_VOICE = { es: 'es-ES-ElviraNeural', ca: 'ca-ES-JoanaNeural' };

// Edge's client sends a rotating token: sha256(windowsFileTime + trustedClientToken), where
// the timestamp is rounded down to the nearest 5 minutes. Reverse-engineered, mirrors edge-tts.
function secMsGec() {
  let ticks = Math.floor(Date.now() / 1000) + WIN_EPOCH_OFFSET;
  ticks -= ticks % 300;
  const windowsTicks = ticks * 1e7; // 100ns units
  return createHash('sha256').update(`${windowsTicks}${TRUSTED_CLIENT_TOKEN}`).digest('hex').toUpperCase();
}

function dateHeader() {
  const d = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function synthesize({ text, lang, env }) {
  const voice = env['EDGE_VOICE_' + lang.toUpperCase()] || DEFAULT_VOICE[lang];
  const rate = env.EDGE_RATE || '-10%';
  const pitch = env.EDGE_PITCH || '+0Hz';
  const volume = env.EDGE_VOLUME || '+0%';
  const inner = text.trim().startsWith('<') ? text : esc(text);

  const url = `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}` +
    `&ConnectionId=${randomUUID().replace(/-/g, '')}`;

  const ws = new WebSocket(url, {
    headers: {
      'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      Cookie: `muid=${randomUUID().replace(/-/g, '').toUpperCase()};`,
    },
  });

  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timeout); ws.terminate(); fn(arg); } };
    const timeout = setTimeout(() => finish(reject, new Error('Edge TTS: tiempo de espera agotado')), 15000);

    ws.on('error', (e) => finish(reject, e));

    ws.on('open', () => {
      const requestId = randomUUID().replace(/-/g, '');
      const ts = dateHeader();
      ws.send(
        `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`
      );
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${LOCALE[lang]}'>` +
        `<voice name='${voice}'><prosody rate='${rate}' pitch='${pitch}' volume='${volume}'>${inner}</prosody></voice></speak>`;
      ws.send(
        `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n${ssml}`
      );
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const headerLen = data.readUInt16BE(0);
        chunks.push(data.subarray(headerLen + 2));
        return;
      }
      const msg = data.toString('utf8');
      if (msg.includes('Path:turn.end')) {
        settled = true;
        clearTimeout(timeout);
        ws.close();
        resolve(Buffer.concat(chunks));
      } else if (/Path:response/.test(msg) && /"errorCode"|statusCode"\s*:\s*"?[45]\d\d/.test(msg)) {
        finish(reject, new Error(`Edge TTS: respuesta de error del servidor: ${msg.slice(0, 200)}`));
      }
    });
  });
}
