// Cámara con detección de bordes en vivo, captura automática, flash, modo lote y modo carnet.
import * as db from '../db.js';
import { icon } from '../icons.js';
import { h, $, toast, pickFiles, progress, embedded } from '../ui.js';
import { makeCanvas, canvasToBlob, decodeBlob, renderPage, blobUrl, fitCanvas, canvasToImg, imgToCanvas } from '../imaging.js';
import { detectQuad, detectSmart, sharpness, BLUR_THRESHOLD, mlReady, loadMl, FULL } from '../detect.js';
import { loadOpenCV, cvReady } from '../loader.js';
import { blankPage, addPages, composeIdCard, importFiles, removePagesFromDoc } from '../pages.js';
import { createCropper } from '../cropper.js';
import * as F from '../filters.js';
const { homography } = F;
const filtersRotate = F.rotate;
import { settings, save } from '../settings.js';
import { go, back } from '../nav.js';

export async function render(root, params) {
  const MODES = { doc: 'Escanear', book: 'Libro', id: 'Carnet / DNI', board: 'Pizarra', receipt: 'Recibo' };
  let mode = MODES[params.mode] ? params.mode : 'doc';
  let docId = params.docId || null;
  let insertAt = params.insertAt ?? null;
  let replaceId = params.replaceId || null; // repetir una página concreta
  let createdHere = false, firstIdx = null;
  let count = 0;          // páginas ya procesadas y guardadas
  let base = 0, queued = 0, lastIdx = null, idFrontPending = false; // páginas que ya tenía el documento / capturadas en esta sesión
  let stream = null, track = null;
  let running = true;
  let idFront = null; // página anverso pendiente en modo carnet
  let queue = Promise.resolve();
  let reviewing = false;

  root.innerHTML = `
    <div class="stage-view">
      <header class="topbar dark">
        <button class="icon-btn" id="close" aria-label="Cerrar">${icon('x')}</button>
        <h1 id="title"></h1>
        <button class="cap-toggle" id="capMode" aria-label="Modo de captura"></button>
        <button class="flash-btn" id="torch" aria-label="Flash"></button>
        <button class="icon-btn" id="gallery" aria-label="Importar de la galería">${icon('image')}</button>
      </header>
      <div class="stage" id="stage">
        <video class="cam-video" id="video" playsinline muted autoplay></video>
        <canvas class="overlay" id="ov"></canvas>
        <div class="cam-hint" id="hint">Iniciando cámara…</div>
        <div class="cam-flash" id="flash"></div>
      </div>
      <div class="cam-modes">
        <div class="cam-mode-list">
          <button data-m="doc">Documento</button>
          <button data-m="book">Libro</button>
          <button data-m="id">Carnet</button>
          <button data-m="board">Pizarra</button>
          <button data-m="receipt">Recibo</button>
        </div>
      </div>
      <div class="cam-bottom">
        <div class="cam-thumb" id="thumb" hidden><b id="cnt">0</b></div>
        <button class="shutter" id="shutter" aria-label="Capturar"><i></i></button>
        <button class="btn primary cam-done" id="done" hidden>Revisar${icon('next')}</button>
      </div>
    </div>`;

  const video = $('#video', root), ov = $('#ov', root), stage = $('#stage', root), hint = $('#hint', root);
  const setHint = t => { hint.textContent = t; hint.hidden = !t; };
  const updateMode = () => {
    root.querySelectorAll('.cam-modes [data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === mode));
    $('#title', root).textContent = params.replaceId ? 'Repetir página' : MODES[mode];
  };
  updateMode();

  async function ensureDoc() {
    if (docId) return db.getDoc(docId);
    const d = await db.newDoc({ id: 'Carnet', book: 'Libro', board: 'Pizarra', receipt: 'Recibo' }[mode]);
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
    const readCaps = () => {
      try {
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        torchSupported = !!caps.torch;
        if (caps.focusMode && caps.focusMode.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      } catch { /* */ }
      if (window.ImageCapture) {
        try { new ImageCapture(track).getPhotoCapabilities().then(pc => { photoFlash = (pc.fillLightMode || []).includes('flash'); }).catch(() => {}); } catch { /* */ }
      }
      applyFlash();
    };
    readCaps();
    setTimeout(readCaps, 1200); // algunos teléfonos informan del flash un poco después
  }

  // ---------- Flash ----------
  // Automático: enciende la luz si la escena está oscura. Encendido: siempre. Apagado: nunca.
  let torchSupported = false, photoFlash = false, torchOn = false, darkSince = 0;
  const FLASH_LABEL = { auto: 'Auto', on: 'Sí', off: 'No' };
  function drawFlashBtn() {
    const m = settings.flashMode || 'auto';
    const b = $('#torch', root);
    b.innerHTML = `${icon(m === 'off' ? 'flashOff' : 'flash')}<span>${FLASH_LABEL[m]}</span>`;
    b.classList.toggle('on', m === 'on' || (m === 'auto' && torchOn));
  }
  async function setTorch(on) {
    if (!torchSupported || !track || torchOn === on) return;
    try { await track.applyConstraints({ advanced: [{ torch: on }] }); torchOn = on; } catch { torchSupported = false; }
    drawFlashBtn();
  }
  function applyFlash() {
    const m = settings.flashMode || 'auto';
    if (m === 'on') setTorch(true);
    else if (m === 'off') setTorch(false);
    drawFlashBtn();
  }
  // Brillo medio de la escena (0–255), muestreando la imagen reducida
  function sceneBrightness(c) {
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
    let s = 0, n = 0;
    for (let i = 0; i < d.length; i += 32) { s += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; n++; }
    return s / n;
  }
  function autoFlash(c) {
    if ((settings.flashMode || 'auto') !== 'auto' || !c) return;
    const b = sceneBrightness(c);
    const now = performance.now();
    if (b < 55) { if (!darkSince) darkSince = now; } else darkSince = 0;
    if (!torchOn && darkSince && now - darkSince > 900) {
      if (torchSupported) setTorch(true); // queda encendida mientras escaneas
      else if (!photoFlash) setHint('Poca luz: acércate a una lámpara o enciende la luz');
    }
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
  let smooth = null, lastQuad = null, stableSince = 0, cooldownUntil = 0, lastCaptureQuad = null;
  function displayRect() {
    const vw = video.videoWidth, vh = video.videoHeight, sw = stage.clientWidth, sh = stage.clientHeight;
    const k = Math.min(sw / vw, sh / vh);
    return { x: (sw - vw * k) / 2, y: (sh - vh * k) / 2, w: vw * k, h: vh * k };
  }
  const qdist = (a, b) => (a && b ? Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1]))) : 1);

  let sharpNow = 0, newPageReady = true, lastSig = null, shots = 0;
  // Huella 32×32 en grises del interior de la hoja, para saber si se cambió de hoja
  // aunque la nueva esté exactamente en el mismo sitio.
  function signature(canvas, q) {
    const W = canvas.width, H = canvas.height;
    let x = Math.max(q[0][0], q[3][0]) * W, x2 = Math.min(q[1][0], q[2][0]) * W;
    let y = Math.max(q[0][1], q[1][1]) * H, y2 = Math.min(q[2][1], q[3][1]) * H;
    const mx = (x2 - x) * 0.02, my = (y2 - y) * 0.02; x += mx; x2 -= mx; y += my; y2 -= my;
    if (x2 - x < 8 || y2 - y < 8) return null;
    const N = 32, t = makeCanvas(N, N), c = t.getContext('2d', { willReadFrequently: true });
    c.drawImage(canvas, x, y, x2 - x, y2 - y, 0, 0, N, N);
    const d = c.getImageData(0, 0, N, N).data, out = new Float32Array(N * N);
    let m = 0;
    for (let i = 0; i < N * N; i++) { out[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11; m += out[i]; }
    m /= N * N; for (let i = 0; i < N * N; i++) out[i] -= m; // insensible a cambios de luz
    return out;
  }
  // Diferencia relativa al contraste de las hojas (0 = igual; ~0,25 ruido; >0,45 otra hoja)
  const sigDiff = (a, b) => {
    if (!a || !b) return 0;
    let s = 0, sa = 0, sb = 0;
    for (let i = 0; i < a.length; i++) { s += Math.abs(a[i] - b[i]); sa += a[i] * a[i]; sb += b[i] * b[i]; }
    const std = (Math.sqrt(sa / a.length) + Math.sqrt(sb / b.length)) / 2;
    return s / a.length / Math.max(3, std);
  };
  async function loop() {
    if (!running) return;
    if (video.videoWidth && !reviewing && !busyCapture) {
      let r = { quad: null };
      try { r = await detectSmart(video, { live: true }); } catch (e) { console.warn(e); }
      if (!running) return;
      const q = r.quad;
      if (q) smooth = smooth && qdist(q, smooth) < 0.12 ? smooth.map((p, i) => [p[0] * 0.55 + q[i][0] * 0.45, p[1] * 0.55 + q[i][1] * 0.45]) : q;
      else smooth = null;
      sharpNow = r.canvas ? sharpness(r.canvas, smooth) : 0;
      autoFlash(r.canvas);
      const sharp = sharpNow >= BLUR_THRESHOLD;
      drawOverlay(smooth, sharp);
      const now = performance.now();
      if (!smooth) newPageReady = true; // se retiró o tapó la hoja: la siguiente será nueva
      if (!cvReady() && !mlReady()) setHint('Preparando detección de bordes…');
      else if (!smooth) { setHint(mode === 'id' ? (idFront ? 'Enfoca el REVERSO del carnet' : 'Enfoca el ANVERSO del carnet') : mode === 'book' ? 'Enfoca el libro abierto (2 páginas)' : 'Buscando documento…'); stableSince = 0; }
      else {
        if (lastQuad && qdist(smooth, lastQuad) < 0.02) { if (!stableSince) stableSince = now; } else stableSince = 0;
        // ¿Hay una hoja nueva? Se movió, se tapó un momento al cambiarla o cambió su contenido
        if (!newPageReady && (qdist(smooth, lastCaptureQuad) > 0.08 || (lastSig && sigDiff(signature(r.canvas, smooth), lastSig) > 0.45))) newPageReady = true;
        // La captura automática exige además que la imagen esté nítida
        const armed = settings.autoCapture && stableSince && now > cooldownUntil && newPageReady && sharp;
        $('#shutter', root).classList.toggle('armed', !!armed);
        if (armed && now - stableSince > 1100) { setHint(''); lastSig = signature(r.canvas, smooth); capture(true); }
        else if (!sharp) setHint('Imagen borrosa: sujeta firme o acerca un poco');
        else if (!settings.autoCapture) setHint('Documento detectado · pulsa el botón');
        else if (!newPageReady) setHint(`✓ Página ${shots} lista · coloca la siguiente hoja`);
        else setHint(shots ? `No te muevas… (página ${shots + 1})` : 'No te muevas…');
      }
      lastQuad = smooth;
    }
    setTimeout(() => requestAnimationFrame(loop), 60);
  }

  function drawOverlay(q, sharp = true) {
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
    c.fillStyle = sharp ? 'rgba(45,212,191,.18)' : 'rgba(251,191,36,.16)'; c.fill();
    c.lineWidth = 3; c.strokeStyle = sharp ? '#2dd4bf' : '#fbbf24'; c.stroke();
    for (const p of pts) { c.beginPath(); c.arc(p[0], p[1], 6, 0, 7); c.fillStyle = '#fff'; c.fill(); }
  }

  // ---------- Captura ----------
  let busyCapture = false;
  async function grabFrame() {
    // ImageCapture.takePhoto da más resolución en Android; si falla usamos el fotograma del vídeo
    if (window.ImageCapture && track && /Android/i.test(navigator.userAgent)) {
      try {
        const ic = new ImageCapture(track);
        const m = settings.flashMode || 'auto';
        const opts = photoFlash && !torchOn ? { fillLightMode: m === 'on' ? 'flash' : m === 'auto' ? 'auto' : 'off' } : {};
        const blob = await Promise.race([ic.takePhoto(opts), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500))]);
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
    lastCaptureQuad = smooth; cooldownUntil = performance.now() + 2500; stableSince = 0; newPageReady = false;
    if (mode !== 'id') shots++;
    const liveQuad = smooth;
    try {
      const blob = await grabFrame();
      await handleShot(blob, liveQuad, auto);
    } catch (e) { console.error(e); toast(`Error al capturar: ${e.message}`, 'error'); }
    busyCapture = false;
  }

  // Procesa una foto: detecta (o pide ajustar) esquinas y la añade
  async function handleShot(blob, liveQuad) {
    let preview = await decodeBlob(blob, 1600);
    const det = await detectSmart(preview).catch(() => ({ quad: null }));
    let q = det.quad;
    if (!q && liveQuad) q = liveQuad;
    const blurry = det.canvas ? sharpness(det.canvas, q) < BLUR_THRESHOLD * 0.8 : false;
    let rotation = 0;
    if (!q || blurry || settings.reviewCapture) {
      const msg = blurry ? 'La foto salió borrosa: repítela o úsala igual' : !q ? 'No se detectaron bordes: ajusta las esquinas' : 'Ajusta las esquinas';
      if (blurry && navigator.vibrate) navigator.vibrate([40, 60, 40]);
      const res = await reviewCorners(blob, preview, q || FULL, msg);
      if (!res) return; // repetir
      ({ q, rotation, blob } = res);
    }
    const page = blankPage(blob);
    page.corners = q;
    page.rotation = rotation;
    if (mode === 'id') page.filter = { ...page.filter, preset: page.filter.preset === 'bw' ? 'bw' : 'auto' };
    if (mode === 'board') page.filter = { preset: 'board', shadows: true, brightness: 0, contrast: 0, sharpness: 30 };
    if (mode === 'receipt') page.filter = { preset: 'gray', shadows: true, brightness: 0, contrast: 25, sharpness: 40 };
    if (mode === 'book') {
      // Libro abierto: una foto con dos páginas → dos hojas (izquierda y derecha)
      const [left, right] = splitSpread(q);
      const p2 = blankPage(blob);
      p2.corners = right; p2.rotation = rotation; p2.filter = { ...page.filter };
      page.corners = left;
      enqueue(page); enqueue(p2);
      queued += 2; setCounter(); quickThumb(preview, right, rotation);
      return;
    }
    enqueue(page);
    if (mode !== 'id' || idFrontPending) { queued++; setCounter(); quickThumb(preview, q, rotation); if (settings.autoCapture && !replaceId) toast(`Página ${base + queued} capturada`, 'ok'); }
    if (mode === 'id') idFrontPending = !idFrontPending;
  }

  // Contador = páginas que ya tenía el documento + capturadas ahora (aunque se sigan procesando)
  function setCounter() {
    const total = base + queued;
    $('#thumb', root).hidden = !total;
    $('#cnt', root).textContent = total;
    $('#done', root).hidden = !total;
  }
  // Miniatura al instante (recorte rápido de la vista previa) mientras se procesa en segundo plano
  function quickThumb(preview, q, rotation = 0) {
    try {
      const small = fitCanvas(preview, 420);
      const img = filtersRotate(F.warp(canvasToImg(small), q || FULL, 300), rotation);
      $('#thumb', root).style.backgroundImage = `url(${imgToCanvas(img).toDataURL('image/jpeg', 0.7)})`;
    } catch (e) { console.warn(e); }
  }

  // Divide el cuadrilátero de un libro abierto por su línea central real (en perspectiva)
  function splitSpread(q) {
    const H = homography([[0, 0], [1, 0], [1, 1], [0, 1]], q);
    const map = (x, y) => { const d = H[6] * x + H[7] * y + 1; return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d]; };
    const top = map(0.5, 0), bot = map(0.5, 1);
    return [[q[0], top, bot, q[3]], [top, q[1], q[2], bot]];
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
    lastIdx = at;
    if (insertAt != null) insertAt++;
    count++;
    if (mode === 'id') { queued = Math.max(queued, count); setCounter(); }
    $('#thumb', root).style.backgroundImage = `url(${blobUrl(page.thumb)})`;
  }

  // Revisión de esquinas tras la foto, con menú lateral (girar, cambiar por otra de la galería,
  // usar la imagen completa, detectar de nuevo) al estilo de los escáneres de Samsung y OneDrive.
  function reviewCorners(blob, preview, q, message) {
    reviewing = true;
    let rotation = 0;
    return new Promise(resolve => {
      const panel = h(`<div class="cam-review">
        <div class="cam-hint ${/borrosa/.test(message) ? 'warn' : ''}" style="z-index:6">${message}</div>
        <div class="stage" style="flex:1"></div>
        <div class="side-tools" aria-label="Opciones de la foto">
          <button data-a="rotate" title="Girar"><span>Girar</span>${icon('rotateR')}</button>
          <button data-a="gallery" title="Cambiar por una de la galería"><span>Galería</span>${icon('image')}</button>
          <button data-a="full" title="Imagen completa"><span>Todo</span>${icon('expand')}</button>
          <button data-a="auto" class="extra" title="Detectar bordes"><span>Detectar</span>${icon('wand')}</button>
          <button data-a="toggle" class="side-toggle" aria-label="Más opciones" title="Más opciones"><span>Cerrar</span><i class="chev-down">${icon('chevDown')}</i><i class="chev-up">${icon('chevUp')}</i></button>
        </div>
        <div class="rot-badge cam-rot" hidden></div>
        <div class="review-actions">
          <button class="btn ghost-dark" data-a="retake">${icon('camera')}Repetir</button>
          <button class="btn primary" data-a="ok">${icon('check')}Usar foto</button>
        </div></div>`);
      stage.append(panel);
      let cr = createCropper($('.stage', panel), preview, q);
      const badge = $('.cam-rot', panel);
      panel.addEventListener('click', async e => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (!a) return;
        if (a === 'toggle') { $('.side-tools', panel).classList.toggle('open'); return; }
        if (a === 'auto') { const d = await detectQuad(preview); if (d) { cr.set(d); toast('Bordes detectados', 'ok'); } else toast('No se encontraron bordes'); return; }
        if (a === 'full') { cr.set(FULL); return; }
        if (a === 'rotate') {
          rotation = (rotation + 90) % 360;
          badge.hidden = !rotation; badge.textContent = `Se girará ${rotation}°`;
          return;
        }
        if (a === 'gallery') {
          const f = await pickFiles({ accept: 'image/*', multiple: false });
          if (!f.length) return;
          blob = f[0];
          preview = await decodeBlob(blob, 1600);
          const d = await detectQuad(preview).catch(() => null);
          cr.destroy();
          cr = createCropper($('.stage', panel), preview, d || FULL);
          $('.cam-hint', panel).textContent = d ? 'Bordes detectados: revisa las esquinas' : 'No se detectaron bordes: ajusta las esquinas';
          return;
        }
        if (a === 'ok' && !cr.valid) { toast('Las esquinas se cruzan; corrígelas', 'error'); return; }
        const out = a === 'ok' ? { q: cr.corners, rotation, blob } : null;
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
      count += pages.length; queued += pages.length;
      if (pages.length) lastIdx = (insertAt != null ? insertAt : doc.pageIds.length) - 1;
      pr.close();
      if (pages.length) {
        $('#thumb', root).style.backgroundImage = `url(${blobUrl(pages[pages.length - 1].thumb)})`;
        setCounter();
        toast(`${pages.length} página(s) añadidas`, 'ok');
      }
    } catch (e) { pr.close(); toast(e.message, 'error'); }
  }

  async function finish() {
    const pr = queued > count || idFront ? progress('Terminando de procesar…') : null;
    await queue;
    pr && pr.close();
    if (idFront) toast('Falta el reverso del carnet; se descartó el anverso');
    // La revisión se abre en la última página capturada
    if (params.returnBack || params.replaceId) {
      try { if (lastIdx != null) sessionStorage.setItem(`editorJump:${docId}`, String(lastIdx)); } catch { /* */ }
      back();
    } else if (docId && count) go('editor', { docId, index: lastIdx ?? firstIdx ?? 0, fromScan: true, newDoc: createdHere }, { replace: true });
    else back();
  }

  // ---------- Eventos ----------
  $('#shutter', root).onclick = () => capture(false);
  $('#done', root).onclick = finish;
  $('#thumb', root).onclick = finish;
  $('#close', root).onclick = finish;
  $('#gallery', root).onclick = async () => { const f = await pickFiles({ accept: 'image/*,application/pdf' }); if (f.length) handleFiles(f); };
  const updateCapMode = () => {
    const b = $('#capMode', root);
    b.innerHTML = settings.autoCapture ? `${icon('auto')}<span>Auto</span>` : `${icon('camera')}<span>Manual</span>`;
    b.classList.toggle('on', !!settings.autoCapture);
  };
  updateCapMode();
  drawFlashBtn();
  if (docId) {
    const d0 = await db.getDoc(docId);
    if (d0 && d0.pageIds.length) {
      base = d0.pageIds.length - (params.replaceId ? 1 : 0);
      const lp = await db.getPage(d0.pageIds[d0.pageIds.length - 1]);
      if (lp?.thumb) $('#thumb', root).style.backgroundImage = `url(${blobUrl(lp.thumb)})`;
      setCounter();
    }
  }
  $('#capMode', root).onclick = async () => {
    await save('autoCapture', !settings.autoCapture);
    updateCapMode();
    $('#shutter', root).classList.remove('armed');
    toast(settings.autoCapture ? 'Automático: captura sola cada hoja, una tras otra' : 'Manual: pulsa el botón para capturar');
  };
  $('#torch', root).onclick = async () => {
    const order = ['auto', 'on', 'off'];
    const m = order[(order.indexOf(settings.flashMode || 'auto') + 1) % 3];
    await save('flashMode', m);
    if (m === 'auto') { darkSince = 0; if (torchOn) await setTorch(false); }
    applyFlash();
    const can = torchSupported || photoFlash;
    toast(m === 'auto' ? 'Flash automático: se enciende con poca luz' : m === 'on' ? (can ? 'Flash encendido' : 'Este navegador no deja controlar el flash del teléfono') : 'Flash apagado');
  };
  root.querySelectorAll('.cam-modes [data-m]').forEach(b => b.onclick = () => {
    if (idFront && b.dataset.m !== 'id') idFront = null;
    mode = b.dataset.m; updateMode();
  });
  const onKey = e => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); capture(false); } };
  window.addEventListener('keydown', onKey);

  loadOpenCV().catch(() => {});
  loadMl();
  try { await startCamera(); setHint(''); loop(); } catch (e) { console.warn(e); showCamError(e); }

  return () => {
    running = false;
    window.removeEventListener('keydown', onKey);
    if (torchOn && track) track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
    if (stream) stream.getTracks().forEach(t => t.stop());
  };
}
