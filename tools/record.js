// tools/record.html: record the letter sounds and picture words with your own voice and save them into audio/
// through the local dev server (npm run dev). Same level bar and silence check as the app's recorder (src/app.js).
(() => {
  const $ = (id) => document.getElementById(id);
  const SILENT_PEAK = 0.01;
  const MSG_SILENT = 'No se oyó nada. Comprueba que esté elegido el micrófono correcto (con auriculares Bluetooth suele elegirse otro) y que el volumen de entrada no esté a cero. Luego prueba otra vez.';
  let clips = [], idx = 0, lang = 'es', pending = null;
  let recorder = null, stream = null, chunks = [], recording = false;
  let peak = 1, meterOn = false, raf = 0, audioCtx = null, source = null;

  const status = (t) => { $('status').textContent = t || ''; };
  const doneCount = () => clips.filter((c) => c.has).length;
  const nextMissing = (from) => { for (let k = 1; k <= clips.length; k++) { const j = (from + k) % clips.length; if (!clips[j].has) return j; } return -1; };

  function render() {
    const c = clips[idx];
    if (!c) return;
    $('big').textContent = c.text;
    $('big').className = c.kind === 'word' ? 'big word' : 'big';
    $('ctx').textContent = c.kind === 'sound' ? `el SONIDO de la letra, como en «${c.word}» ${c.emoji}` : `la palabra ${c.emoji}`;
    $('shared').hidden = !c.shared;
    $('progress').textContent = `${doneCount()} de ${clips.length} grabadas${c.has ? ' · esta ya está grabada ✓' : ''}`;
    $('rec').textContent = recording ? '⏹ Parar' : (c.has ? '⏺ Grabar otra vez' : '⏺ Grabar');
    $('meter').hidden = !recording;
    $('play').hidden = !pending;
    $('save').hidden = !pending;
  }

  async function load() {
    try {
      const r = await fetch(`/__clips?lang=${lang}`);
      if (!r.ok) throw new Error(String(r.status));
      clips = await r.json();
    } catch (e) {
      clips = [];
      status('No encuentro el servidor local. Ejecuta «npm run dev» y abre http://localhost:5173/tools/record.html');
      return;
    }
    pending = null;
    const first = clips.findIndex((c) => !c.has);
    idx = first < 0 ? 0 : first;
    status(first < 0 ? '¡Todo grabado! Puedes repetir las que quieras.' : '');
    render();
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
      peak = 0; meterOn = true;
      const tick = () => {
        an.getFloatTimeDomainData(buf);
        let pk = 0;
        for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > pk) pk = v; }
        if (pk > peak) peak = pk;
        $('meterFill').style.width = Math.min(100, Math.round(pk * 300)) + '%';
        if (meterOn) raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { meterOn = false; }
  }
  function stopMeter() {
    meterOn = false; cancelAnimationFrame(raf);
    try { if (source) source.disconnect(); } catch (e) { /* already disconnected */ }
    source = null; $('meterFill').style.width = '0%';
  }

  async function toggleRecord() {
    if (!clips.length) return;
    if (!recording) {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch (e) { status('No pude usar el micrófono. Revisa el permiso del navegador (el candado junto a la dirección).'); return; }
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks = []; pending = null;
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.start();
      startMeter();
      recording = true;
      const c = clips[idx];
      status(c.kind === 'sound' ? `Grabando… di solo el SONIDO de «${c.text}» (no el nombre de la letra) y pulsa Parar.` : `Grabando… di «${c.text}» y pulsa Parar.`);
      render();
    } else {
      const blob = await new Promise((res) => {
        recorder.onstop = () => { stopMeter(); stream.getTracks().forEach((t) => t.stop()); res(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })); };
        recorder.stop();
      });
      recording = false;
      if (!blob.size) status('No se grabó nada. Prueba otra vez.');
      else if (peak < SILENT_PEAK) status(MSG_SILENT);
      else { pending = blob; status('Escúchala y, si suena bien, pulsa Guardar.'); }
      render();
    }
  }

  async function save() {
    const c = clips[idx];
    if (!pending || !c) return;
    status('Guardando…');
    try {
      const r = await fetch(`/__clip?lang=${lang}&key=${encodeURIComponent(c.key)}`, { method: 'POST', headers: { 'Content-Type': pending.type || 'audio/webm' }, body: pending });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `error ${r.status}`);
    } catch (e) { status(`No se pudo guardar: ${e.message}. Puedes volver a pulsar Guardar.`); return; }
    c.has = true; pending = null;
    const n = nextMissing(idx);
    if (n < 0) status('Guardada ✓ ¡Todo grabado!');
    else { idx = n; status('Guardada ✓'); }
    render();
  }

  function go(step) {
    if (recording || !clips.length) return;
    pending = null; idx = (idx + step + clips.length) % clips.length;
    status(''); render();
  }

  $('rec').onclick = toggleRecord;
  $('save').onclick = save;
  $('play').onclick = () => { if (pending) new Audio(URL.createObjectURL(pending)).play().catch(() => {}); };
  $('prev').onclick = () => go(-1);
  $('next').onclick = () => go(1);
  $('lang').onchange = (e) => { if (recording) { e.target.value = lang; return; } lang = e.target.value; load(); };
  load();
})();
