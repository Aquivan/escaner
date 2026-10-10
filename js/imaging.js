// Utilidades de imagen del hilo principal: decodificar, procesar (vía worker),
// redimensionar, miniaturas y dibujo de anotaciones.
import * as F from './filters.js';

export const MAX_SIDE = 4000;   // resolución máxima de trabajo
export const THUMB_SIDE = 360;

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}

export async function decodeBlob(blob, maxSide = MAX_SIDE) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    bmp = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im); im.onerror = () => rej(new Error('Imagen no válida'));
      im.src = URL.createObjectURL(blob);
    });
  }
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  const k = maxSide && Math.max(w, h) > maxSide ? maxSide / Math.max(w, h) : 1;
  const c = makeCanvas(w * k, h * k);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close(); else if (bmp.src) URL.revokeObjectURL(bmp.src);
  return c;
}

export function canvasToImg(c) {
  const id = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
  return { data: id.data, width: id.width, height: id.height };
}

export function imgToCanvas(img) {
  const c = makeCanvas(img.width, img.height);
  c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return c;
}

export function canvasToBlob(c, type = 'image/jpeg', q = 0.92) {
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('No se pudo codificar la imagen'))), type, q));
}

// Redimensionado de calidad (reducción por pasos)
export function resizeCanvas(src, w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  let cur = src;
  while (cur.width / 2 >= w && cur.height / 2 >= h) {
    const t = makeCanvas(cur.width / 2, cur.height / 2);
    const tc = t.getContext('2d'); tc.imageSmoothingQuality = 'high';
    tc.drawImage(cur, 0, 0, t.width, t.height);
    cur = t;
  }
  if (cur.width === w && cur.height === h) return cur === src ? cloneCanvas(src) : cur;
  const out = makeCanvas(w, h);
  const ctx = out.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, w, h);
  return out;
}

export function cloneCanvas(c) {
  const o = makeCanvas(c.width, c.height);
  o.getContext('2d').drawImage(c, 0, 0);
  return o;
}

export function fitCanvas(c, maxSide) {
  const k = Math.max(c.width, c.height) > maxSide ? maxSide / Math.max(c.width, c.height) : 1;
  return k === 1 ? c : resizeCanvas(c, c.width * k, c.height * k);
}

// ---------- Worker de filtros ----------
let worker = null, workerOk = true, seq = 0;
const pending = new Map();
function getWorker() {
  if (!workerOk) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./filter-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = e => {
      const p = pending.get(e.data.id); if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.rej(new Error(e.data.error));
      else p.res({ data: new Uint8ClampedArray(e.data.img.buffer), width: e.data.img.width, height: e.data.img.height });
    };
    worker.onerror = e => {
      console.warn('Worker no disponible, se usa el hilo principal', e);
      workerOk = false; worker = null;
      for (const [, p] of pending) p.retry();
      pending.clear();
    };
  } catch { workerOk = false; worker = null; }
  return worker;
}

function runLocal(op, img, opts) {
  return op === 'pipeline' ? F.processPipeline(img, opts) : F.applyFilter(img, opts.filter);
}

export function runFilter(op, img, opts) {
  const w = getWorker();
  if (!w) return Promise.resolve(runLocal(op, img, opts));
  return new Promise((res, rej) => {
    const id = ++seq;
    const copy = new Uint8ClampedArray(img.data); // conservamos el original por si falla
    pending.set(id, { res, rej, retry: () => { try { res(runLocal(op, { data: copy, width: img.width, height: img.height }, opts)); } catch (e) { rej(e); } } });
    const buf = new Uint8ClampedArray(copy).buffer;
    w.postMessage({ id, op, img: { buffer: buf, width: img.width, height: img.height }, opts }, [buf]);
  });
}

// Procesa una página completa: original → recorte/perspectiva → giro → filtro
export async function processPageCanvas(page, maxSide = MAX_SIDE) {
  const src = await decodeBlob(page.original, maxSide);
  const out = await runFilter('pipeline', canvasToImg(src), {
    corners: page.corners, rotation: page.rotation || 0, filter: page.filter || F.DEFAULT_FILTER, maxSide,
  });
  return imgToCanvas(out);
}

// Recalcula y guarda en el objeto página: processed (JPEG), thumb y dimensiones
export async function renderPage(page) {
  const c = await processPageCanvas(page);
  page.processed = await canvasToBlob(c, 'image/jpeg', 0.92);
  page.width = c.width; page.height = c.height;
  await updateThumb(page, c);
  return c;
}

export async function updateThumb(page, processedCanvas) {
  const base = processedCanvas || await decodeBlob(page.processed, 1400);
  let t = fitCanvas(base, THUMB_SIDE);
  if (page.annotations && page.annotations.length) {
    t = cloneCanvas(t);
    await drawAnnotations(t.getContext('2d'), page.annotations, t.width, t.height);
  }
  page.thumb = await canvasToBlob(t, 'image/jpeg', 0.8);
}

// Imagen final de la página (procesada + anotaciones) a cierta resolución máxima
export async function finalPageCanvas(page, maxSide = MAX_SIDE) {
  const base = await decodeBlob(page.processed, maxSide);
  const c = base;
  if (page.annotations && page.annotations.length) await drawAnnotations(c.getContext('2d'), page.annotations, c.width, c.height);
  return c;
}

// ---------- Anotaciones ----------
const imgCache = new Map();
export function loadImg(src) {
  if (imgCache.has(src)) return imgCache.get(src);
  const p = new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
  imgCache.set(src, p);
  return p;
}

export const FONT_STACK = 'Helvetica, Arial, sans-serif';

export function textLines(a) { return String(a.text || '').split('\n'); }

// Medida del bloque de texto en coordenadas normalizadas
export function measureText(ctx, a, W, H) {
  const px = a.size * H;
  ctx.font = `${a.bold ? 'bold ' : ''}${px}px ${FONT_STACK}`;
  const lines = textLines(a);
  const w = Math.max(...lines.map(l => ctx.measureText(l || ' ').width));
  return { w: w / W, h: (lines.length * px * 1.2) / H };
}

export async function drawAnnotations(ctx, anns, W, H) {
  for (const a of anns) {
    ctx.save();
    if (a.type === 'rect') {
      if (a.mode === 'highlight') {
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = a.color || '#ffeb3b';
        ctx.globalAlpha = 0.55;
      } else {
        ctx.fillStyle = a.color || '#ffffff';
      }
      ctx.fillRect(a.x * W, a.y * H, a.w * W, a.h * H);
    } else if (a.type === 'path') {
      ctx.strokeStyle = a.color || '#1a237e';
      ctx.lineWidth = Math.max(1, a.width * W);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (a.mode === 'highlight') { ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = 0.5; ctx.lineCap = 'butt'; }
      const pts = a.points;
      ctx.beginPath();
      ctx.moveTo(pts[0][0] * W, pts[0][1] * H);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx.quadraticCurveTo(pts[i][0] * W, pts[i][1] * H, mx * W, my * H);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last[0] * W + (pts.length === 1 ? 0.01 : 0), last[1] * H);
      ctx.stroke();
    } else if (a.type === 'text') {
      const px = a.size * H;
      ctx.font = `${a.bold ? 'bold ' : ''}${px}px ${FONT_STACK}`;
      ctx.textBaseline = 'top';
      if (a.bg) {
        const m = measureText(ctx, a, W, H);
        ctx.fillStyle = a.bg;
        ctx.fillRect(a.x * W - px * 0.15, a.y * H - px * 0.1, m.w * W + px * 0.3, m.h * H + px * 0.1);
      }
      ctx.fillStyle = a.color || '#000';
      textLines(a).forEach((l, i) => ctx.fillText(l, a.x * W, a.y * H + i * px * 1.2));
    } else if (a.type === 'image') {
      try {
        const im = await loadImg(a.src);
        ctx.drawImage(im, a.x * W, a.y * H, a.w * W, a.h * H);
      } catch { /* imagen dañada */ }
    }
    ctx.restore();
  }
}

// Bounding box normalizado de una anotación
export function annBounds(a, ctx, W, H) {
  if (a.type === 'rect' || a.type === 'image') return { x: a.x, y: a.y, w: a.w, h: a.h };
  if (a.type === 'text') { const m = measureText(ctx, a, W, H); return { x: a.x, y: a.y, w: m.w, h: m.h }; }
  if (a.type === 'path') {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const [x, y] of a.points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const pad = a.width / 2;
    return { x: x0 - pad, y: y0 - pad * W / H, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 * W / H };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

// Color medio del borde de una zona (para el corrector / limpieza básica)
export function sampleBorderColor(canvas, x, y, w, h) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const X = Math.max(0, Math.floor(x * canvas.width) - 3), Y = Math.max(0, Math.floor(y * canvas.height) - 3);
  const X2 = Math.min(canvas.width, Math.ceil((x + w) * canvas.width) + 3), Y2 = Math.min(canvas.height, Math.ceil((y + h) * canvas.height) + 3);
  if (X2 - X < 2 || Y2 - Y < 2) return '#ffffff';
  const d = ctx.getImageData(X, Y, X2 - X, Y2 - Y).data;
  const ww = X2 - X, hh = Y2 - Y;
  const vals = [];
  for (let yy = 0; yy < hh; yy++) for (let xx = 0; xx < ww; xx++) {
    if (yy > 2 && yy < hh - 3 && xx > 2 && xx < ww - 3) continue;
    const i = (yy * ww + xx) * 4;
    vals.push([d[i], d[i + 1], d[i + 2], d[i] + d[i + 1] + d[i + 2]]);
  }
  // Mediana por brillo: ignora trazos oscuros que crucen el borde
  vals.sort((a, b) => a[3] - b[3]);
  const top = vals.slice(Math.floor(vals.length * 0.4));
  const avg = [0, 1, 2].map(k => Math.round(top.reduce((s, v) => s + v[k], 0) / top.length));
  return `rgb(${avg[0]},${avg[1]},${avg[2]})`;
}

// Firma desde una foto: quita el fondo del papel y deja la tinta con transparencia
export async function signatureFromPhoto(blob, ink = null) {
  const c = fitCanvas(await decodeBlob(blob, 1600), 1200);
  const img = canvasToImg(c);
  F.removeShadows(img, false);
  const d = img.data;
  let x0 = img.width, y0 = img.height, x1 = 0, y1 = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const j = (y * img.width + x) * 4;
    const l = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    const a = l > 200 ? 0 : l < 120 ? 255 : Math.round((200 - l) / 80 * 255);
    if (ink) { d[j] = ink[0]; d[j + 1] = ink[1]; d[j + 2] = ink[2]; }
    d[j + 3] = a;
    if (a > 60) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  }
  if (x1 <= x0 || y1 <= y0) throw new Error('No se encontró una firma en la imagen');
  const full = imgToCanvas(img);
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(img.width - 1, x1 + pad); y1 = Math.min(img.height - 1, y1 + pad);
  const out = makeCanvas(x1 - x0 + 1, y1 - y0 + 1);
  out.getContext('2d').drawImage(full, -x0, -y0);
  return out.toDataURL('image/png');
}

const urlCache = new WeakMap();
export function blobUrl(blob) {
  if (!blob) return '';
  let u = urlCache.get(blob);
  if (!u) { u = URL.createObjectURL(blob); urlCache.set(blob, u); }
  return u;
}
