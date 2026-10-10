// Cámara con detección de bordes en vivo, captura automática, flash, modo lote y modo carnet.
import * as db from '../db.js';
import { icon } from '../icons.js';
import { h, $, toast, pickFiles, progress, embedded } from '../ui.js';
import { makeCanvas, canvasToBlob, decodeBlob, renderPage, blobUrl } from '../imaging.js';
import { detectQuad, detectQuadSync, FULL } from '../detect.js';
import { loadOpenCV, cvReady } from '../loader.js';
import { blankPage, addPages, composeIdCard, importFiles, removePagesFromDoc } from '../pages.js';
import { createCropper } from '../cropper.js';
import { settings, save } from '../settings.js';
import { go, back } from '../nav.js';

export async function render(root, params) {
  let mode = params.mode === 'id' ? 'id' : 'doc';
  let docId = params.docId || null;
  let insertAt = params.insertAt ?? null;
  let replaceId = params.replaceId || null; // repetir una página concreta
  let createdHere = false, firstIdx = null;
  let count = 0;
  let stream = null, track = null, torch = false;
  let running = true;
  let idFront = null; // página anverso pendiente en modo carnet
  let queue = Promise.resolve();
  let reviewing = false;

  root.innerHTML = `
    <div class="stage-view">
      <header class="topbar dark">
        <button class="icon-btn" id="close" aria-label="Cerrar">${icon('x')}</button>
        <h1 id="title"></h1>
        <button class="icon-btn" id="torch" aria-label="Flash" hidden>${icon('flashOff')}</button>
        <button class="icon-btn" id="gallery" aria-label="Importar de la galería">${icon('image')}</button>
      </header>
      <div class="stage" id="stage">
        <video class="cam-video" id="video" playsinline muted autoplay></video>
        <canvas class="overlay" id="ov"></canvas>
        <div class="cam-hint" id="hint">Iniciando cámara…</div>
        <div class="cam-flash" id="flash"></div>
      </div>
      <div class="cam-modes">
        <button data-m="doc">Documento</button>
        <button data-m="id">Carnet / DNI</button>
        <span class="cam-sep"></span>
        <button data-c="auto" aria-label="Captura automática">Auto</button>
        <button data-c="manual" aria-label="Captura manual">Manual</button>
      </div>
      <div class="cam-bottom">
        <div class="cam-thumb" id="thumb" hidden><b id="cnt">0</b></div>
        <button class="shutter" id="shutter" aria-label="Capturar"><i></i></button>
        <button class="btn primary cam-done" id="done" hidden>${icon('check')}Listo</button>
      </div>
    </div>`;

  const video = $('#video', root), ov = $('#ov', root), stage = $('#stage', root), hint = $('#hint', root);
  const setHint = t => { hint.textContent = t; hint.hidden = !t; };
  const updateMode = () => {
    root.querySelectorAll('.cam-modes [data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === mode));
    $('#title', root).textContent = params.replaceId ? 'Repetir página' : mode === 'id' ? 'Carnet / DNI' : 'Escanear';
  };
  updateMode();

  async function ensureDoc() {
    if (docId) return db.getDoc(docId);
    const d = await db.newDoc(mode === 'id' ? 'Carnet' : undefined);
    docId = d.id;
    createdHere = true;
    return d;
  }

  // ---------- Cámara ----------
  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador no permite usar la cámara aquí (se necesita HTTPS).');
    const tries = [
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false },
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
      { video: true, audio: false },
    ];
    let err;
    for (const c of tries) {
      try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch (e) { err = e; if (e.name === 'NotAllowedError') break; }
    }
    if (!stream) throw err || new Error('No se pudo abrir la cámara');
    if (!running) { stream.getTracks().forEach(t => t.stop()); return; }
    video.srcObject = stream;
    await video.play().catch(() => {});
    track = stream.getVideoTracks()[0];
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.torch) $('#torch', root).hidden = false;
      if (caps.focusMode && caps.focusMode.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    } catch { /* */ }
  }

  function showCamError(e) {
    const msg = embedded ? 'En esta versión la foto se toma con la cámara del teléfono. Pulsa el botón, haz la foto y la app detecta los bordes sola.' : e?.name === 'NotAllowedError' ? 'Permiso de cámara denegado. Actívalo en los ajustes del navegador o usa la cámara del sistema.' : (e?.message || 'No se pudo abrir la cámara.');
    stage.innerHTML = `<div class="cam-error">${icon('camera')}<p>${msg}</p>
      <button class="btn primary" id="sysCam">${icon('camera')}Usar la cámara del sistema</button>
      <button class="btn" id="sysGal">${icon('image')}Elegir fotos o PDF</button></div>`;
    $('#sysCam', root).onclick = async () => { const f = await pickFiles({ accept: 'image/*', multiple: false, capture: 'environment' }); if (f.length) handleFiles(f); };
    $('#sysGal', root).onclick = () => $('#gallery', root).click();
    $('#shutter', root).disabled = true;
  }

  // ---------- Detección en vivo ----------
  const small = makeCanvas(1, 1);
  let smooth = null, lastQuad = null, stableSince = 0, cooldownUntil = 0, lastCaptureQuad = null;
  function displayRect() {
    const vw = video.videoWidth, vh = video.videoHeight, sw = stage.clientWidth, sh = stage.clientHeight;
    const k = Math.min(sw / vw, sh / vh);
    return { x: (sw - vw * k) / 2, y: (sh - vh * k) / 2, w: vw * k, h: vh * k };
  }
  const qdist = (a, b) => (a && b ? Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1]))) : 1);

  function loop() {
    if (!running) return;
    if (video.videoWidth && !reviewing && !busyCapture) {
      const vw = video.videoWidth, vh = video.videoHeight;
      const k = 360 / Math.max(vw, vh);
      if (small.width !== Math.round(vw * k)) { small.width = Math.round(vw * k); small.height = Math.round(vh * k); }
      small.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, small.width, small.height);
      let q = cvReady() ? detectQuadSync(small, 0.15) : null;
      if (q) smooth = smooth && qdist(q, smooth) < 0.12 ? smooth.map((p, i) => [p[0] * 0.55 + q[i][0] * 0.45, p[1] * 0.55 + q[i][1] * 0.45]) : q;
      else smooth = null;
      drawOverlay(smooth);
      const now = performance.now();
      if (!cvReady()) setHint('Preparando detección de bordes…');
      else if (!smooth) { setHint(mode === 'id' ? (idFront ? 'Enfoca el REVERSO del carnet' : 'Enfoca el ANVERSO del carnet') : 'Buscando documento…'); stableSince = 0; }
      else {
        if (lastQuad && qdist(smooth, lastQuad) < 0.02) { if (!stableSince) stableSince = now; } else stableSince = 0;
        const movedSinceLast = qdist(smooth, lastCaptureQuad) > 0.08;
        const armed = settings.autoCapture && stableSince && now > cooldownUntil && movedSinceLast;
        $('#shutter', root).classList.toggle('armed', !!armed);
        if (armed && now - stableSince > 1100) { setHint(''); capture(true); }
        else setHint(settings.autoCapture ? (movedSinceLast || now > cooldownUntil + 4000 ? 'No te muevas…' : 'Cambia de página') : 'Documento detectado');
      }
      lastQuad = smooth;
    }
    setTimeout(() => requestAnimationFrame(loop), 90);
  }

  function drawOverlay(q) {
    const r = displayRect();
    const dpr = window.devicePixelRatio || 1;
    ov.style.width = `${stage.clientWidth}px`; ov.style.height = `${stage.clientHeight}px`;
    ov.width = stage.clientWidth * dpr; ov.height = stage.clientHeight * dpr;
    const c = ov.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, ov.width, ov.height);
    if (!q) return;
    const pts = q.map(([x, y]) => [r.x + x * r.w, r.y + y * r.h]);
    c.beginPath(); c.moveTo(...pts[0]); pts.slice(1).forEach(p => c.lineTo(...p)); c.closePath();
    c.fillStyle = 'rgba(45,212,191,.18)'; c.fill();
    c.lineWidth = 3; c.strokeStyle = '#2dd4bf'; c.stroke();
    for (const p of pts) { c.beginPath(); c.arc(p[0], p[1], 6, 0, 7); c.fillStyle = '#fff'; c.fill(); }
  }

  // ---------- Captura ----------
  let busyCapture = false;
  async function grabFrame() {
    // ImageCapture.takePhoto da más resolución en Android; si falla usamos el fotograma del vídeo
    if (window.ImageCapture && track && /Android/i.test(navigator.userAgent)) {
      try {
        const ic = new ImageCapture(track);
        const blob = await Promise.race([ic.takePhoto(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3500))]);
        if (blob && blob.size) return blob;
      } catch { /* respaldo */ }
    }
    const c = makeCanvas(video.videoWidth, video.videoHeight);
    c.getContext('2d').drawImage(video, 0, 0);
    return canvasToBlob(c, 'image/jpeg', 0.93);
  }

  async function capture(auto = false) {
    if (busyCapture || reviewing || !video.videoWidth) return;
    busyCapture = true;
    const fl = $('#flash', root); fl.classList.add('go'); requestAnimationFrame(() => requestAnimationFrame(() => fl.classList.remove('go')));
    if (navigator.vibrate) navigator.vibrate(30);
    lastCaptureQuad = smooth; cooldownUntil = performance.now() + 2500; stableSince = 0;
    const liveQuad = smooth;
    try {
      const blob = await grabFrame();
      await handleShot(blob, liveQuad, auto);
    } catch (e) { console.error(e); toast(`Error al capturar: ${e.message}`, 'error'); }
    busyCapture = false;
  }

  // Procesa una foto: detecta (o pide ajustar) esquinas y la añade
  async function handleShot(blob, liveQuad) {
    const preview = await decodeBlob(blob, 1600);
    let q = await detectQuad(preview).catch(() => null);
    if (!q && liveQuad) q = liveQuad;
    if (!q || settings.reviewCapture) {
      const res = await reviewCorners(preview, q || FULL, !q);
      if (!res) return; // repetir
      q = res;
    }
    const page = blankPage(blob);
    page.corners = q;
    if (mode === 'id') page.filter = { ...page.filter, preset: page.filter.preset === 'bw' ? 'bw' : 'auto' };
    enqueue(page);
  }

  function enqueue(page) {
    const isId = mode === 'id';
    queue = queue.then(async () => {
      await renderPage(page);
      if (isId) {
        if (!idFront) { idFront = page; toast('Anverso listo. Ahora el reverso.'); return; }
        const composed = await composeIdCard(idFront, page);
        idFront = null;
        await addToDoc(composed);
        toast('Carnet añadido (anverso y reverso en una página)', 'ok');
      } else {
        await addToDoc(page);
      }
    }).catch(e => { console.error(e); toast(`Error procesando: ${e.message}`, 'error'); });
  }

  async function addToDoc(page) {
    const doc = await ensureDoc();
    let at = insertAt != null ? insertAt : doc.pageIds.length;
    if (replaceId) {
      // Repetir: la nueva foto ocupa el lugar de la anterior y se vuelve a la revisión
      const old = doc.pageIds.indexOf(replaceId);
      if (old >= 0) at = old;
      await addPages(doc, [page], at);
      if (old >= 0) await removePagesFromDoc(doc, [replaceId]);
      replaceId = null; count++;
      setTimeout(finish, 0);
      return;
    }
    await addPages(doc, [page], at);
    if (firstIdx == null) firstIdx = at;
    if (insertAt != null) insertAt++;
    count++;
    $('#thumb', root).hidden = false;
    $('#thumb', root).style.backgroundImage = `url(${blobUrl(page.thumb)})`;
    $('#cnt', root).textContent = count;
    $('#done', root).hidden = false;
  }

  // Revisión manual de esquinas dentro de la cámara
  function reviewCorners(preview, q, failed) {
    reviewing = true;
    return new Promise(resolve => {
      const panel = h(`<div style="position:absolute;inset:0;background:var(--stage);z-index:5;display:flex;flex-direction:column">
        <div class="cam-hint" style="z-index:6">${failed ? 'No se detectaron bordes: ajusta las esquinas' : 'Ajusta las esquinas'}</div>
        <div class="stage" style="flex:1"></div>
        <div class="stage-bar">
          <button class="tool" data-a="retake">${icon('camera')}Repetir</button>
          <button class="tool" data-a="auto">${icon('wand')}Auto</button>
          <button class="tool" data-a="full">${icon('expand')}Todo</button>
          <button class="tool" data-a="ok">${icon('check')}Usar</button>
        </div></div>`);
      stage.append(panel);
      const cr = createCropper($('.stage', panel), preview, q);
      panel.addEventListener('click', async e => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (!a) return;
        if (a === 'auto') { const d = await detectQuad(preview); if (d) cr.set(d); else toast('No se encontraron bordes'); return; }
        if (a === 'full') { cr.set(FULL); return; }
        if (a === 'ok' && !cr.valid) { toast('Las esquinas se cruzan; corrígelas', 'error'); return; }
        const out = a === 'ok' ? cr.corners : null;
        cr.destroy(); panel.remove(); reviewing = false;
        resolve(out);
      });
    });
  }

  async function handleFiles(files) {
    const pr = progress('Importando…');
    try {
      const doc = await ensureDoc();
      const before = doc.pageIds.length;
      if (firstIdx == null) firstIdx = insertAt ?? before;
      const pages = await importFiles(doc, files, pr);
      if (insertAt != null && pages.length) {
        // importFiles añade al final: movemos a la posición pedida
        const ids = doc.pageIds.splice(before, pages.length);
        doc.pageIds.splice(insertAt, 0, ...ids); insertAt += ids.length;
        await db.putDoc(doc);
      }
      count += pages.length;
      pr.close();
      if (pages.length) {
        $('#thumb', root).hidden = false; $('#thumb', root).style.backgroundImage = `url(${blobUrl(pages[pages.length - 1].thumb)})`;
        $('#cnt', root).textContent = count; $('#done', root).hidden = false;
        toast(`${pages.length} página(s) añadidas`, 'ok');
      }
    } catch (e) { pr.close(); toast(e.message, 'error'); }
  }

  async function finish() {
    const pr = count || idFront ? progress('Terminando…') : null;
    await queue;
    pr && pr.close();
    if (idFront) toast('Falta el reverso del carnet; se descartó el anverso');
    if (params.returnBack || params.replaceId) back();
    else if (docId && count) go('editor', { docId, index: firstIdx ?? 0, fromScan: true, newDoc: createdHere }, { replace: true });
    else back();
  }

  // ---------- Eventos ----------
  $('#shutter', root).onclick = () => capture(false);
  $('#done', root).onclick = finish;
  $('#thumb', root).onclick = finish;
  $('#close', root).onclick = finish;
  $('#gallery', root).onclick = async () => { const f = await pickFiles({ accept: 'image/*,application/pdf' }); if (f.length) handleFiles(f); };
  const updateCapMode = () => root.querySelectorAll('.cam-modes [data-c]').forEach(b => b.classList.toggle('on', (b.dataset.c === 'auto') === !!settings.autoCapture));
  updateCapMode();
  root.querySelectorAll('.cam-modes [data-c]').forEach(b => b.onclick = async () => {
    await save('autoCapture', b.dataset.c === 'auto');
    updateCapMode();
    $('#shutter', root).classList.remove('armed');
    toast(settings.autoCapture ? 'Automático: dispara solo cuando el documento está quieto' : 'Manual: pulsa el botón para capturar');
  });
  $('#torch', root).onclick = async e => {
    torch = !torch;
    try { await track.applyConstraints({ advanced: [{ torch }] }); e.currentTarget.innerHTML = icon(torch ? 'flash' : 'flashOff'); e.currentTarget.classList.toggle('on', torch); } catch { toast('Flash no disponible'); }
  };
  root.querySelectorAll('.cam-modes [data-m]').forEach(b => b.onclick = () => {
    if (idFront && b.dataset.m !== 'id') idFront = null;
    mode = b.dataset.m; updateMode();
  });
  const onKey = e => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); capture(false); } };
  window.addEventListener('keydown', onKey);

  loadOpenCV().catch(() => setHint('Sin detección automática: ajusta las esquinas a mano'));
  try { await startCamera(); setHint(''); loop(); } catch (e) { console.warn(e); showCamError(e); }

  return () => {
    running = false;
    window.removeEventListener('keydown', onKey);
    if (stream) stream.getTracks().forEach(t => t.stop());
  };
}
