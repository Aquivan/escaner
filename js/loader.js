// Carga diferida de librerías pesadas, con progreso. El service worker las guarda
// en caché, así que solo la primera carga es lenta.
const loaded = {};
const listeners = new Set();
export const status = {}; // nombre -> {state:'loading'|'ready'|'error', frac}

function emit(name, st) { status[name] = st; listeners.forEach(fn => fn(name, st)); }
export function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }

async function fetchWithProgress(url, onProg) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar ${url} (${res.status})`);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) return await res.blob();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProg && onProg(got / total);
  }
  return new Blob(chunks, { type: 'text/javascript' });
}

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Error cargando ${src}`));
    document.head.append(s);
  });
}

function loadScript(name, url, { progress = false } = {}) {
  if (loaded[name]) return loaded[name];
  loaded[name] = (async () => {
    emit(name, { state: 'loading', frac: 0 });
    try {
      if (progress) {
        const blob = await fetchWithProgress(url, f => emit(name, { state: 'loading', frac: f * 0.9 }));
        const u = URL.createObjectURL(blob);
        // Algunos entornos (p. ej. páginas incrustadas) no permiten scripts blob:; se carga por URL
        try { await injectScript(u); } catch { await injectScript(url); }
        URL.revokeObjectURL(u);
      } else {
        await injectScript(url);
      }
      if (name !== 'opencv') emit(name, { state: 'ready', frac: 1 }); // OpenCV avisa al terminar de iniciar WASM
    } catch (e) {
      loaded[name] = null;
      emit(name, { state: 'error', error: e });
      throw e;
    }
  })();
  return loaded[name];
}

let cvPromise = null;
export function loadOpenCV() {
  if (cvPromise) return cvPromise;
  cvPromise = (async () => {
    await loadScript('opencv', 'lib/opencv.js', { progress: true });
    // OpenCV.js inicializa WASM de forma asíncrona. No usamos `await cv` porque
    // el objeto Module de Emscripten tiene un `then` que provoca bucles.
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const check = () => {
        const cv = window.cv;
        if (cv && cv.Mat && cv.imread) return resolve();
        if (Date.now() - t0 > 60000) return reject(new Error('OpenCV no se inicializó'));
        setTimeout(check, 50);
      };
      check();
    });
    emit('opencv', { state: 'ready', frac: 1 });
    // ¡No devolver window.cv! Tiene un `then` y resolver una promesa con él cuelga la página.
    return true;
  })().catch(e => { cvPromise = null; emit('opencv', { state: 'error', error: e }); throw e; });
  return cvPromise;
}
export const cvReady = () => !!(window.cv && window.cv.Mat);

export async function loadPdfLib() {
  await loadScript('pdflib', 'lib/pdf-lib.min.js');
  return window.PDFLib;
}

export async function loadPdfJs() {
  await loadScript('pdfjs', 'lib/pdf.min.js');
  const lib = window.pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = new URL('lib/pdf.worker.min.js', location.href).href;
  return lib;
}

export async function loadJSZip() {
  await loadScript('jszip', 'lib/jszip.min.js');
  return window.JSZip;
}

export async function loadTesseract() {
  await loadScript('tesseract', 'lib/tesseract/tesseract.min.js');
  return window.Tesseract;
}
