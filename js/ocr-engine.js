// OCR con dos motores:
// - PaddleOCR (PP-OCRv6, ONNX en un Web Worker): el principal, mucho mejor con fotos, poca luz,
//   letra pequeña y tickets. Reconoce todos los idiomas de alfabeto latino a la vez.
// - Tesseract.js: respaldo. Español e inglés vienen incluidos; otros idiomas se descargan.
import { loadTesseract } from './loader.js';
import { decodeBlob, makeCanvas } from './imaging.js';
import { settings } from './settings.js';
import { embedded } from './ui.js';

export const OCR_ENGINES = [['paddle', 'PaddleOCR'], ['tesseract', 'Tesseract']];
export const PADDLE_MODELS = [['tiny', 'Rápido', '6 MB'], ['small', 'Máxima precisión', '31 MB']];
// Dentro de claude.ai no se publican los archivos de PaddleOCR (pesan más de lo permitido)
export const paddleAvailable = () => !embedded;

export const OCR_LANGS = [
  ['spa', 'Español'], ['eng', 'Inglés'], ['por', 'Portugués'], ['fra', 'Francés'],
  ['deu', 'Alemán'], ['ita', 'Italiano'], ['cat', 'Catalán'], ['glg', 'Gallego'], ['eus', 'Euskera'],
];
const LOCAL = new Set(['spa', 'eng']);

let worker = null, workerKey = '', onLog = null, creating = null;

const abs = p => new URL(p, location.href).href;

async function getWorker(langs) {
  const key = langs.join('+');
  if (worker && workerKey === key) return worker;
  if (creating && creating.key === key) return creating.p;
  if (worker) { await worker.terminate().catch(() => {}); worker = null; }
  const Tesseract = await loadTesseract();
  const allLocal = langs.every(l => LOCAL.has(l));
  const opts = {
    workerPath: abs('lib/tesseract/worker.min.js'),
    corePath: abs('lib/tesseract/core/'),
    workerBlobURL: false,
    gzip: true,
    cacheMethod: 'write',
    logger: m => onLog && onLog(m),
  };
  if (allLocal) await seedLocalLangs(langs);
  const p = (async () => {
    const w = await Tesseract.createWorker(langs, 1 /* LSTM */, opts);
    await w.setParameters({ tessedit_pageseg_mode: '3' });
    return w;
  })();
  creating = { key, p };
  try {
    worker = await p; workerKey = key;
    return worker;
  } finally { creating = null; }
}

// Los idiomas incluidos se guardan como lib/tessdata/<lang>.wasm (algunos hosts no sirven .gz).
// Se meten en la caché de Tesseract (idb-keyval: BD "keyval-store", almacén "keyval",
// clave "./<lang>.traineddata"), que el worker lee antes de intentar descargarlos.
function kv() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('keyval-store');
    r.onupgradeneeded = () => r.result.createObjectStore('keyval');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function seedLocalLangs(langs) {
  const db = await kv();
  try {
    for (const l of langs) {
      const key = `./${l}.traineddata`;
      const has = await new Promise(res => { const q = db.transaction('keyval').objectStore('keyval').count(key); q.onsuccess = () => res(q.result > 0); q.onerror = () => res(false); });
      if (has) continue;
      onLog && onLog({ status: 'loading language traineddata', progress: 0.2 });
      const resp = await fetch(abs(`lib/tessdata/${l}.wasm`));
      if (!resp.ok) throw new Error(`No se pudo cargar el idioma ${l}`);
      const data = new Uint8Array(await resp.arrayBuffer()); // gzip: Tesseract lo descomprime
      await new Promise((res, rej) => { const t = db.transaction('keyval', 'readwrite'); t.objectStore('keyval').put(data, key); t.oncomplete = res; t.onerror = () => rej(t.error); });
    }
  } finally { db.close(); }
}

const STATUS_ES = {
  'loading tesseract core': 'Cargando motor OCR',
  'initializing tesseract': 'Iniciando OCR',
  'loading language traineddata': 'Cargando idioma',
  'initializing api': 'Preparando',
  'recognizing text': 'Reconociendo texto',
};

// ---------- PaddleOCR ----------
let paddle = null, paddleKey = '', paddleCreating = null;

async function getPaddle(model) {
  if (paddle && paddleKey === model) return paddle;
  if (paddleCreating && paddleCreating.key === model) return paddleCreating.p;
  if (paddle) { await paddle.dispose().catch(() => {}); paddle = null; }
  const p = (async () => {
    const { PaddleOCR } = await import(abs('lib/paddle/paddleocr.mjs'));
    return PaddleOCR.create({
      textDetectionModelName: `PP-OCRv6_${model}_det`,
      textDetectionModelAsset: { url: abs(`lib/paddle/models/PP-OCRv6_${model}_det.tar`) },
      textRecognitionModelName: `PP-OCRv6_${model}_rec`,
      textRecognitionModelAsset: { url: abs(`lib/paddle/models/PP-OCRv6_${model}_rec.tar`) },
      worker: { createWorker: () => new Worker(abs('lib/paddle/worker-entry.js'), { type: 'module' }) },
      ortOptions: { backend: 'wasm', wasmPaths: abs('lib/paddle/ort/') },
    });
  })();
  paddleCreating = { key: model, p };
  try {
    paddle = await p; paddleKey = model;
    return paddle;
  } finally { paddleCreating = null; }
}

// PaddleOCR devuelve líneas; las partimos en palabras repartiendo el ancho por caracteres
// (sirve para la capa de texto del PDF buscable).
function lineToWords(text, b, score) {
  const words = [];
  const total = text.length || 1;
  for (const m of text.matchAll(/\S+/g)) {
    const a = m.index / total, z = (m.index + m[0].length) / total;
    words.push({ t: m[0], c: score, x0: b.x0 + (b.x1 - b.x0) * a, x1: b.x0 + (b.x1 - b.x0) * z, y0: b.y0, y1: b.y1 });
  }
  return words;
}

// Ordena las líneas en filas (arriba→abajo, izquierda→derecha) para reconstruir el texto
function itemsToText(items) {
  const sorted = [...items].sort((a, b) => (a.b.y0 + a.b.y1) - (b.b.y0 + b.b.y1));
  const rows = [];
  for (const it of sorted) {
    const cy = (it.b.y0 + it.b.y1) / 2, h = it.b.y1 - it.b.y0;
    const row = rows.find(r => Math.abs(r.cy - cy) < Math.max(h, r.h) * 0.5);
    if (row) row.items.push(it); else rows.push({ cy, h, items: [it] });
  }
  rows.sort((a, b) => a.cy - b.cy);
  const out = [];
  let prev = null;
  for (const r of rows) {
    if (prev && r.cy - prev.cy > Math.max(r.h, prev.h) * 2.2) out.push('');
    out.push(r.items.sort((a, b) => a.b.x0 - b.b.x0).map(i => i.text).join('   '));
    prev = r;
  }
  return out.join('\n');
}

async function recognizePaddle(page, onProgress) {
  const model = settings.paddleModel || 'tiny';
  onProgress && onProgress(0.1, paddle && paddleKey === model ? 'Preparando' : 'Cargando PaddleOCR (solo la primera vez)');
  const ocr = await getPaddle(model);
  const src = await decodeBlob(page.processed || page.original, 2600);
  onProgress && onProgress(0.4, 'Reconociendo texto');
  const [r] = await ocr.predict(src);
  const W = r.image?.width || src.width, H = r.image?.height || src.height;
  const items = (r.items || []).filter(i => i.text && i.text.trim()).map(i => {
    const xs = i.poly.map(p => p[0]), ys = i.poly.map(p => p[1]);
    return { text: i.text.trim(), score: Math.round((i.score || 0) * 100), b: { x0: Math.min(...xs) / W, x1: Math.max(...xs) / W, y0: Math.min(...ys) / H, y1: Math.max(...ys) / H } };
  });
  onProgress && onProgress(1, 'Listo');
  return {
    engine: `paddle-${model}`,
    lang: 'latin',
    text: itemsToText(items),
    conf: items.length ? Math.round(items.reduce((s, i) => s + i.score, 0) / items.length) : 0,
    words: items.flatMap(i => lineToWords(i.text, i.b, i.score)),
    lines: items.map(i => i.b),
    at: Date.now(),
  };
}

// Reconoce el texto de una página. Devuelve el objeto ocr que se guarda en la página.
export async function recognizePage(page, langs, onProgress, engine = settings.ocrEngine) {
  if (engine !== 'tesseract' && paddleAvailable()) {
    try { return await recognizePaddle(page, onProgress); } catch (e) {
      console.warn('PaddleOCR falló; se usa Tesseract', e);
      onProgress && onProgress(0, 'PaddleOCR no disponible; usando Tesseract');
    }
  }
  return recognizeTesseract(page, langs, onProgress);
}

async function recognizeTesseract(page, langs, onProgress) {
  onLog = m => onProgress && onProgress(m.progress || 0, STATUS_ES[m.status] || m.status);
  const w = await getWorker(langs.length ? langs : ['spa']);
  // Resolución adecuada: el texto pequeño necesita píxeles
  const src = await decodeBlob(page.processed || page.original, 3600);
  let c = src;
  const longSide = Math.max(src.width, src.height);
  if (longSide < 2200) {
    const k = 2200 / longSide;
    c = makeCanvas(src.width * k, src.height * k);
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
  }
  const { data } = await w.recognize(c);
  const W = c.width, H = c.height;
  let words = data.words;
  if (!words && data.blocks) {
    words = [];
    for (const b of data.blocks) for (const p of b.paragraphs || []) for (const l of p.lines || []) words.push(...(l.words || []));
  }
  const lines = (data.lines || []).map(l => ({ x0: l.bbox.x0 / W, y0: l.bbox.y0 / H, x1: l.bbox.x1 / W, y1: l.bbox.y1 / H }));
  const out = {
    engine: 'tesseract',
    lang: langs.join('+'),
    text: (data.text || '').replace(/\n{3,}/g, '\n\n').trim(),
    conf: Math.round(data.confidence || 0),
    words: (words || []).filter(wd => wd.text && wd.text.trim()).map(wd => ({
      t: wd.text.trim(), c: Math.round(wd.confidence),
      x0: wd.bbox.x0 / W, y0: wd.bbox.y0 / H, x1: wd.bbox.x1 / W, y1: wd.bbox.y1 / H,
    })),
    lines,
    at: Date.now(),
  };
  onLog = null;
  return out;
}

export async function terminateOcr() {
  if (worker) { await worker.terminate().catch(() => {}); worker = null; workerKey = ''; }
  if (paddle) { await paddle.dispose().catch(() => {}); paddle = null; paddleKey = ''; }
}
