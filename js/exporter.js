// Exportación: PDF (opcionalmente buscable), JPG/PNG y texto; estimación de tamaño.
import { loadPdfLib, loadJSZip } from './loader.js';
import { decodeBlob, drawAnnotations, resizeCanvas, canvasToBlob, makeCanvas } from './imaging.js';

export const PAGE_SIZES = {
  auto: { label: 'Automático', size: null },
  a4: { label: 'A4', size: [595.28, 841.89] },
  letter: { label: 'Carta', size: [612, 792] },
  legal: { label: 'Oficio (Legal)', size: [612, 1008] },
  a5: { label: 'A5', size: [419.53, 595.28] },
};

export const DPI_PRESETS = [
  { key: 'low', label: 'Baja', dpi: 100, hint: '100 ppp · pantalla' },
  { key: 'med', label: 'Media', dpi: 150, hint: '150 ppp · correo' },
  { key: 'high', label: 'Alta', dpi: 300, hint: '300 ppp · impresión' },
];

export const QUALITY_PRESETS = [
  { key: 'none', label: 'Sin compresión', q: 0.95 },
  { key: 'low', label: 'Baja', q: 0.85 },
  { key: 'med', label: 'Media', q: 0.7 },
  { key: 'high', label: 'Alta', q: 0.5 },
  { key: 'max', label: 'Máxima', q: 0.32 },
];

// Tamaño físico (pt) para la imagen de una página
export function physicalSize(imgW, imgH, pageSize) {
  const landscape = imgW > imgH;
  if (pageSize && PAGE_SIZES[pageSize]?.size) {
    const [a, b] = PAGE_SIZES[pageSize].size;
    return landscape ? [b, a] : [a, b];
  }
  const aspect = Math.max(imgW, imgH) / Math.min(imgW, imgH);
  for (const k of ['a4', 'letter', 'legal']) {
    const [a, b] = PAGE_SIZES[k].size;
    if (Math.abs(aspect - b / a) / (b / a) < 0.04) return landscape ? [b, a] : [a, b];
  }
  const short = 595.28, long = short * aspect;
  return landscape ? [long, short] : [short, long];
}

// Calcula página (pt), zona de imagen (pt) y píxeles objetivo
function layoutFor(page, opts) {
  const [pw, ph] = physicalSize(page.width, page.height, opts.pageSize);
  const margin = opts.pageSize && opts.pageSize !== 'auto' ? (opts.margin || 0) : 0;
  const aw = pw - margin * 2, ah = ph - margin * 2;
  const k = Math.min(aw / page.width, ah / page.height);
  const dw = page.width * k, dh = page.height * k;
  const dx = (pw - dw) / 2, dy = (ph - dh) / 2;
  let px = Math.round(dw / 72 * opts.dpi), py = Math.round(dh / 72 * opts.dpi);
  if (px > page.width) { px = page.width; py = page.height; } // no ampliamos más allá del original
  return { pw, ph, dx, dy, dw, dh, px, py };
}

function toGrayscale(c) {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  for (let j = 0; j < d.length; j += 4) { const l = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8; d[j] = d[j + 1] = d[j + 2] = l; }
  ctx.putImageData(id, 0, 0);
}

function drawWatermark(c, text) {
  const ctx = c.getContext('2d');
  ctx.save();
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(-Math.atan2(c.height, c.width));
  const size = Math.min(c.width, c.height) / Math.max(4, text.length * 0.55);
  ctx.font = `bold ${size}px Helvetica, Arial, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(120,120,120,0.28)';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function drawPageNumber(c, n, total) {
  const ctx = c.getContext('2d');
  const size = Math.max(10, c.height * 0.016);
  ctx.font = `${size}px Helvetica, Arial, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  const t = `${n} / ${total}`;
  const w = ctx.measureText(t).width;
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.fillRect(c.width / 2 - w / 2 - size * 0.4, c.height - size * 2.1, w + size * 0.8, size * 1.4);
  ctx.fillStyle = '#333';
  ctx.fillText(t, c.width / 2, c.height - size * 0.8);
}

// Imagen final de una página según las opciones de exportación
export async function rasterPage(page, opts, n = 1, total = 1) {
  const L = layoutFor(page, opts);
  const src = await decodeBlob(page.processed, Math.max(L.px, L.py) * 1.02 + 2);
  if (page.annotations?.length) await drawAnnotations(src.getContext('2d'), page.annotations, src.width, src.height);
  let c = (src.width === L.px && src.height === L.py) ? src : resizeCanvas(src, L.px, L.py);
  if (opts.grayscale) toGrayscale(c);
  if (opts.watermark) drawWatermark(c, opts.watermark);
  if (opts.pageNumbers) drawPageNumber(c, n, total);
  return { canvas: c, layout: L };
}

async function encode(c, fmt, q) {
  return canvasToBlob(c, fmt === 'png' ? 'image/png' : 'image/jpeg', q);
}

// Texto compatible con WinAnsi (Helvetica estándar)
function makeSanitizer(font) {
  const cache = new Map();
  return s => {
    let out = '';
    for (const ch of s) {
      if (!cache.has(ch)) { try { font.encodeText(ch); cache.set(ch, ch); } catch { cache.set(ch, ch.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?')); } }
      out += cache.get(ch);
    }
    return out;
  };
}

export async function buildPdf(pages, opts, onProgress = () => {}, title = 'Documento') {
  const PDFLib = await loadPdfLib();
  const { PDFDocument, StandardFonts, pushGraphicsState, popGraphicsState, setTextRenderingMode, TextRenderingMode, setCharacterSqueeze } = PDFLib;
  const pdf = await PDFDocument.create();
  pdf.setTitle(title); pdf.setCreator('EscánerPro'); pdf.setProducer('EscánerPro (pdf-lib)');
  pdf.setCreationDate(new Date()); pdf.setModificationDate(new Date());
  const font = opts.searchable ? await pdf.embedFont(StandardFonts.Helvetica) : null;
  const sanitize = font ? makeSanitizer(font) : null;
  for (let i = 0; i < pages.length; i++) {
    onProgress(i / pages.length, `Página ${i + 1} de ${pages.length}`);
    const pg = pages[i];
    const { canvas, layout: L } = await rasterPage(pg, opts, i + 1, pages.length);
    const blob = await encode(canvas, 'jpg', opts.quality);
    const img = await pdf.embedJpg(await blob.arrayBuffer());
    const p = pdf.addPage([L.pw, L.ph]);
    if (L.dw < L.pw - 0.5 || L.dh < L.ph - 0.5) p.drawRectangle({ x: 0, y: 0, width: L.pw, height: L.ph, color: PDFLib.rgb(1, 1, 1) });
    p.drawImage(img, { x: L.dx, y: L.ph - L.dy - L.dh, width: L.dw, height: L.dh });
    // Capa de texto invisible (PDF buscable)
    if (font && pg.ocr?.words?.length) {
      for (const w of pg.ocr.words) {
        const text = sanitize(w.t);
        if (!text.trim()) continue;
        const bw = (w.x1 - w.x0) * L.dw, bh = (w.y1 - w.y0) * L.dh;
        if (bw <= 0 || bh <= 0) continue;
        const size = Math.max(1, bh * 0.92);
        const natural = font.widthOfTextAtSize(text, size) || 1;
        const squeeze = Math.max(10, Math.min(1000, (bw / natural) * 100));
        p.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible), setCharacterSqueeze(squeeze));
        p.drawText(text, { x: L.dx + w.x0 * L.dw, y: L.ph - L.dy - w.y1 * L.dh + bh * 0.2, size, font });
        p.pushOperators(setCharacterSqueeze(100), popGraphicsState());
      }
    }
  }
  onProgress(1, 'Guardando PDF…');
  const bytes = await pdf.save({ useObjectStreams: true });
  return opts.password ? encryptPdf(bytes, opts.password) : bytes;
}

// Protege un PDF con contraseña (AES-256). Se necesita para abrirlo.
export async function encryptPdf(bytes, password) {
  const { PDFDocument } = await import(new URL('lib/pdf-encrypt.mjs', location.href).href);
  const d = await PDFDocument.load(bytes);
  d.encrypt({ userPassword: password, ownerPassword: password, permissions: { printing: 'highResolution', copying: true } });
  return d.save();
}

// Quita la contraseña de un PDF (hay que conocerla)
export async function decryptPdf(bytes, password) {
  const { PDFDocument } = await import(new URL('lib/pdf-encrypt.mjs', location.href).href);
  const d = await PDFDocument.load(bytes, { password });
  return d.save();
}

export async function buildImages(pages, opts, fmt, onProgress = () => {}, base = 'pagina') {
  const files = [];
  const ext = fmt === 'png' ? 'png' : 'jpg';
  for (let i = 0; i < pages.length; i++) {
    onProgress(i / pages.length, `Página ${i + 1} de ${pages.length}`);
    const { canvas } = await rasterPage(pages[i], opts, i + 1, pages.length);
    const blob = await encode(canvas, fmt, opts.quality);
    const name = pages.length === 1 ? `${base}.${ext}` : `${base}-${String(i + 1).padStart(2, '0')}.${ext}`;
    files.push(new File([blob], name, { type: blob.type }));
  }
  return files;
}

export async function zipFiles(files, onProgress) {
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f);
  return zip.generateAsync({ type: 'blob', compression: 'STORE' }, m => onProgress && onProgress(m.percent / 100));
}

export function ocrText(pages) {
  return pages.map((p, i) => `--- Página ${i + 1} ---\n${p.ocr?.text || '(sin texto reconocido)'}`).join('\n\n');
}

// Estimación de tamaño: codifica hasta 3 páginas de muestra y extrapola
export async function estimateSize(pages, opts, fmt = 'pdf') {
  if (!pages.length) return 0;
  const n = pages.length;
  const idxs = n <= 3 ? [...Array(n).keys()] : [0, Math.floor(n / 2), n - 1];
  let sum = 0;
  for (const i of idxs) {
    const { canvas } = await rasterPage(pages[i], opts, i + 1, n);
    const b = await encode(canvas, fmt === 'png' ? 'png' : 'jpg', opts.quality);
    sum += b.size;
  }
  let total = sum / idxs.length * n;
  if (fmt === 'pdf') {
    total += 1200 + n * 450;
    if (opts.searchable) total += pages.reduce((s, p) => s + (p.ocr?.words?.length || 250) * 55, 0) * 0.45 + 30000;
  }
  return total;
}

export { makeCanvas };
