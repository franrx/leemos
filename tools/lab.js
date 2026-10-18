// tools/lab.html: record readings for the voice-progress experiment (plan: docs/superpowers/plans/2026-10-17-voice-progress-experiment.md).
// Each item is shown and the microphone starts at THAT instant, so the first sound inside the clip is the reader's response time.
// The adult then taps ✅ / 🔁 (kind=wrong: the reader says another syllable on purpose and the verdict is 🔁 by construction).
// Audio and labels go to the local dev server only (/__lab, /__lab-label) and end up in the gitignored lab/ folder.
(() => {
  const $ = (id) => document.getElementById(id);
  const SILENT_PEAK = 0.01; // same rule as the app's recorder: no sound at all means the wrong microphone
  const MSG_SILENT = 'No se oyó nada. Comprueba que esté elegido el micrófono correcto (con auriculares Bluetooth suele elegirse otro) y que el volumen de entrada no esté a cero. Pulsa «Repetir esta».';
  const qs = new URLSearchParams(location.search);
  const choice = (k, allowed, dflt) => (allowed.includes(qs.get(k)) ? qs.get(k) : dflt);
  const lang = choice('lang', ['es', 'ca'], 'es');
  const who = choice('who', ['elsa', 'adult'], 'elsa');
  const kind = choice('kind', ['read', 'wrong'], 'read');
  const level = Math.max(1, Math.min(5, parseInt(qs.get('level'), 10) || 1));
  const total = Math.max(1, Math.min(200, parseInt(qs.get('n'), 10) || 40));
  const seed = parseInt(qs.get('seed'), 10) || 1;
  const upper = qs.get('upper') !== '0'; // the app shows capitals by default
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14); // down to the second: a reload must not reuse the folder of the previous run
  const session = `${who}-${kind}-${stamp}`; // matches /^[a-z0-9-]{3,40}$/ on the server

  let items = [], idx = 0, stream = null, recorder = null, chunks = [], recStart = 0, shownAtIso = '', blobMs = 0;
  let tries = 0, triesIdx = -1, startLagMs = null, closed = false;
  let peak = 1, ticks = 0, meterOn = false, raf = 0, audioCtx = null, source = null;
  const status = (t) => { $('status').textContent = t || ''; };
  const show = (ids) => { for (const id of ['start', 'done', 'retry', 'ok', 'fail', 'wipe']) $(id).hidden = !ids.includes(id); };

  const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  // The same list for the same lang, level, n and seed, so two sessions can be compared item by item. About 15% of the items repeat inside a session.
  function buildItems(levels) {
    const rnd = mulberry32(seed);
    const pre = lang === 'ca' ? 'ca:' : '';
    const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const syl = [], words = [];
    levels.slice(0, level).forEach((L) => {
      L.syl.forEach((s) => syl.push({ key: pre + 's:' + s, text: s, k: 's' }));
      L.words.forEach((o) => words.push({ key: pre + 'w:' + o.w, text: o.w.replace(/-/g, ''), k: 'w' }));
    });
    shuffle(syl); shuffle(words);
    const baseN = Math.min(syl.length + words.length, Math.ceil(total * 0.85));
    const nWords = Math.min(words.length, Math.round(baseN * 0.25));
    const base = shuffle([...syl.slice(0, baseN - nWords), ...words.slice(0, nWords)]).map((b) => ({ ...b, rep: false }));
    const out = [...base];
    while (out.length < total && base.length) out.push({ ...base[Math.floor(rnd() * base.length)], rep: true });
    return shuffle(out).slice(0, total);
  }

  function startMeter() {
    peak = 1; // unknown until an analyser works: never call a recording silent without evidence
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      source = audioCtx.createMediaStreamSource(stream);
      const an = audioCtx.createAnalyser();
      an.fftSize = 1024;
      source.connect(an);
      const buf = new Float32Array(an.fftSize);
      peak = 0; ticks = 0; meterOn = true;
      const tick = () => {
        try {
          an.getFloatTimeDomainData(buf);
          if (audioCtx.state === 'running') ticks++;
          let pk = 0;
          for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > pk) pk = v; }
          if (pk > peak) peak = pk;
          $('meterFill').style.width = Math.min(100, Math.round(pk * 300)) + '%';
          if (meterOn) raf = requestAnimationFrame(tick);
        } catch (e) { meterOn = false; }
      };
      tick();
    } catch (e) { meterOn = false; }
  }
  function stopMeter() {
    meterOn = false; cancelAnimationFrame(raf);
    try { if (source) source.disconnect(); } catch (e) { /* already disconnected */ }
    source = null; $('meterFill').style.width = '0%';
  }

  function startRecording() {
    const it = items[idx];
    $('big').textContent = upper ? it.text.toUpperCase() : it.text;
    $('big').className = it.k === 'w' ? 'big word' : 'big';
    $('ctx').textContent = kind === 'wrong' ? 'Di OTRA cosa, mal a propósito (otra sílaba u otra palabra)' : '';
    $('info').textContent = `${who} · ${kind} · nivel ${level} · ${idx + 1} de ${items.length}`;
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    if (triesIdx !== idx) { triesIdx = idx; tries = 0; }
    tries++; // a retry means she has already seen (and probably read) the item: its timing is not a first reaction
    startLagMs = null;
    shownAtIso = new Date().toISOString(); recStart = Date.now();
    recorder.onstart = () => { startLagMs = Date.now() - recStart; }; // how long the recorder took to really start
    recorder.start(); // the recording starts at the same instant the item is shown
    startMeter();
    $('meter').hidden = false;
    status('Grabando… no hables tú hasta pulsar «Listo» (tu voz quedaría en la grabación). Pulsa «Listo» cuando ella termine.');
    show(['done', 'wipe']);
  }

  function stopRecording() {
    return new Promise((res) => {
      recorder.onstop = () => { stopMeter(); $('meter').hidden = true; res(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })); };
      recorder.stop();
    });
  }

  async function post(url, init) {
    const r = await fetch(url, init);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `error ${r.status}`);
    return j;
  }
  const query = () => `session=${encodeURIComponent(session)}&n=${idx}`;

  function releaseMic() {
    try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* already stopped */ }
    stream = null;
  }

  async function onDone() {
    if (closed) return;
    show(['wipe']);
    const blob = await stopRecording();
    blobMs = Date.now() - recStart;
    if (!blob.size) { status('No se grabó nada. Pulsa «Repetir esta».'); show(['retry', 'wipe']); return; }
    if (ticks >= 2 && peak < SILENT_PEAK) { status(MSG_SILENT); show(['retry', 'wipe']); return; }
    try { await post(`/__lab?${query()}`, { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob }); }
    catch (e) { status(`No se pudo guardar: ${e.message}. Pulsa «Repetir esta».`); show(['retry', 'wipe']); return; }
    if (kind === 'wrong') { await label('fail'); return; }
    status('¿Cómo lo ha leído?');
    show(['ok', 'fail', 'wipe']);
  }

  async function label(verdict) {
    if (closed) return;
    const it = items[idx];
    show(['wipe']);
    try {
      await post(`/__lab-label?${query()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: it.key, text: it.text, lang, who, kind, verdict, level, seed, rep: it.rep, shownAtIso, recMs: blobMs, tries, startLagMs }) });
    } catch (e) {
      status(`No se pudo guardar la etiqueta: ${e.message}. Vuelve a pulsar.`);
      show(kind === 'wrong' ? ['retry', 'wipe'] : ['ok', 'fail', 'wipe']);
      return;
    }
    idx++;
    if (idx < items.length) startRecording();
    else { releaseMic(); $('big').textContent = '✓'; $('big').className = 'big'; $('ctx').textContent = ''; $('info').textContent = `${who} · ${kind} · terminado: ${items.length} lecturas (sesión ${session})`; status('Terminado. Los archivos están en lab/' + session + '/'); show(['wipe']); }
  }

  async function begin() {
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { autoGainControl: false, noiseSuppression: false, echoCancellation: false } }); } // the browser's processing would change the timing and levels being measured
    catch (e) { status('No pude usar el micrófono. Revisa el permiso del navegador (el candado junto a la dirección).'); return; }
    try {
      const r = await fetch(`/src/data/levels.${lang}.json`);
      if (!r.ok) throw new Error(String(r.status));
      items = buildItems(await r.json());
    } catch (e) { status('No encuentro el servidor local. Ejecuta «npm run dev» y abre http://localhost:5173/tools/lab.html'); return; }
    idx = 0;
    startRecording();
  }

  async function wipe() {
    if (!window.confirm || !window.confirm('¿Borrar todas las grabaciones de esta sesión?')) return;
    closed = true; // nothing more is recorded or uploaded after wiping
    try { if (recorder && recorder.state === 'recording') recorder.stop(); } catch (e) { /* not recording */ }
    stopMeter(); $('meter').hidden = true; releaseMic(); show(['wipe']);
    try { await post(`/__lab?session=${encodeURIComponent(session)}`, { method: 'DELETE' }); status('Sesión borrada. Recarga la página para empezar otra.'); }
    catch (e) { status(`No se pudo borrar: ${e.message}`); }
  }

  $('start').onclick = begin;
  $('done').onclick = onDone;
  $('retry').onclick = () => { show(['wipe']); startRecording(); };
  $('ok').onclick = () => label('ok');
  $('fail').onclick = () => label('fail');
  $('wipe').onclick = wipe;
  $('info').textContent = `${who} · ${kind} · nivel ${level} · ${total} lecturas · sesión ${session}`;
  show(['start']);
})();
