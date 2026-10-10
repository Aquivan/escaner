// Creación e importación de páginas, operaciones sobre documentos.
import * as db from './db.js';
import { decodeBlob, renderPage, canvasToBlob, fitCanvas, makeCanvas, MAX_SIDE } from './imaging.js';
import { detectQuad, FULL } from './detect.js';
import { DEFAULT_FILTER } from './filters.js';
import { loadPdfJs } from './loader.js';
import { settings } from './settings.js';

export function defaultFilter() {
  return { ...DEFAULT_FILTER, ...(settings.defaultFilter || {}) };
}

export function blankPage(blob) {
  return {
    id: db.uid(), docId: null, original: blob, corners: FULL.map(p => [...p]), rotation: 0,
    filter: defaultFilter(), annotations: [], ocr: null, created: Date.now(),
  };
}

// Crea una página a partir de una foto. detect: intenta recortar automáticamente.
export async function pageFromImage(blob, { detect = true, filter } = {}) {
  const page = blankPage(blob);
  if (filter) page.filter = { ...filter };
  let detected = false;
  if (detect) {
    try {
      const c = await decodeBlob(blob, 1000);
      const q = await detectQuad(c);
      if (q) { page.corners = q; detected = true; }
    } catch (e) { console.warn(e); }
  }
  await renderPage(page);
  return { page, detected };
}

export async function addPages(doc, pages, at = doc.pageIds.length) {
  for (const p of pages) { p.docId = doc.id; await db.putPage(p); }
  doc.pageIds.splice(at, 0, ...pages.map(p => p.id));
  await db.putDoc(doc);
}

export async function savePage(page) {
  await db.putPage(page);
  const doc = await db.getDoc(page.docId);
  if (doc) await db.putDoc(doc); // actualiza fecha
}

// Rasteriza un PDF en imágenes (para editarlo como escaneo)
export async function pdfToImages(file, { dpi = 200, onProgress } = {}) {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    let scale = dpi / 72;
    const vp0 = page.getViewport({ scale: 1 });
    if (Math.max(vp0.width, vp0.height) * scale > MAX_SIDE) scale = MAX_SIDE / Math.max(vp0.width, vp0.height);
    const vp = page.getViewport({ scale });
    const c = makeCanvas(vp.width, vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    out.push(await canvasToBlob(c, 'image/jpeg', 0.92));
    page.cleanup();
    onProgress && onProgress(i / pdf.numPages);
  }
  pdf.destroy();
  return out;
}

// Importa imágenes y PDFs a un documento
export async function importFiles(doc, files, prog) {
  const pages = [];
  let i = 0;
  for (const f of files) {
    i++;
    const label = `${f.name} (${i}/${files.length})`;
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      prog && prog.set(null, `Leyendo PDF ${label}`);
      const imgs = await pdfToImages(f, { onProgress: fr => prog && prog.set(fr, `Leyendo PDF ${label}`) });
      for (const b of imgs) {
        const p = blankPage(b);
        p.filter = { ...DEFAULT_FILTER, preset: 'original', shadows: false, sharpness: 0 };
        await renderPage(p);
        pages.push(p);
      }
    } else if (f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|bmp|gif)$/i.test(f.name)) {
      prog && prog.set((i - 1) / files.length, `Procesando imagen ${label}`);
      const { page } = await pageFromImage(f, { detect: settings.detectOnImport !== false });
      pages.push(page);
    }
  }
  if (pages.length) await addPages(doc, pages);
  return pages;
}

export async function duplicatePage(doc, page) {
  const p = { ...structuredClone({ ...page, original: null, processed: null, thumb: null }), original: page.original, processed: page.processed, thumb: page.thumb, id: db.uid() };
  const idx = doc.pageIds.indexOf(page.id);
  await addPages(doc, [p], idx + 1);
  return p;
}

// Copia páginas a un documento nuevo
export async function pagesToNewDoc(pages, name) {
  const doc = await db.newDoc(name);
  const copies = pages.map(pg => ({ ...pg, id: db.uid(), docId: doc.id, annotations: structuredClone(pg.annotations || []), ocr: pg.ocr ? structuredClone(pg.ocr) : null, corners: structuredClone(pg.corners), filter: { ...pg.filter } }));
  await addPages(doc, copies);
  return doc;
}

export async function removePagesFromDoc(doc, ids) {
  for (const id of ids) await db.deletePage(id);
  doc.pageIds = doc.pageIds.filter(id => !ids.includes(id));
  await db.putDoc(doc);
}

// Compone anverso y reverso de un carnet en una sola página A4
export async function composeIdCard(frontPage, backPage) {
  const A4W = 2480, A4H = 3508; // 300 ppp
  const cardW = Math.round(85.6 / 25.4 * 300), maxH = Math.round(70 / 25.4 * 300);
  const c = makeCanvas(A4W, A4H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, A4W, A4H);
  let y = Math.round(A4H * 0.12);
  for (const p of [frontPage, backPage]) {
    const im = await decodeBlob(p.processed, 3000);
    let w = cardW, h = w * im.height / im.width;
    if (h > maxH) { h = maxH; w = h * im.width / im.height; }
    const x = (A4W - w) / 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(fitCanvas(im, Math.max(w, h) * 1.01), x, y, w, h);
    y += h + Math.round(A4H * 0.08);
  }
  const blob = await canvasToBlob(c, 'image/jpeg', 0.93);
  const page = blankPage(blob);
  page.filter = { ...DEFAULT_FILTER, preset: 'original', shadows: false, sharpness: 0 };
  page.idcard = true;
  await renderPage(page);
  return page;
}
