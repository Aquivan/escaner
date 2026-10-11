// Punto de entrada: enrutador de vistas, service worker y precarga de herramientas.
import { loadSettings } from './settings.js';
import { loadOpenCV, onStatus } from './loader.js';
import { toast, h, $ } from './ui.js';

const views = {
  home: () => import('./views/home.js'),
  camera: () => import('./views/camera.js'),
  crop: () => import('./views/crop.js'),
  editor: () => import('./views/editor.js'),
  doc: () => import('./views/doc.js'),
  annotate: () => import('./views/annotate.js'),
  ocr: () => import('./views/ocr.js'),
  pdftools: () => import('./views/pdftools.js'),
};

let cleanup = null;
let renderSeq = 0;
const root = document.getElementById('app');

async function render(state) {
  const seq = ++renderSeq;
  if (cleanup) { try { await cleanup(); } catch (e) { console.warn(e); } cleanup = null; }
  const name = views[state?.name] ? state.name : 'home';
  try {
    const mod = await views[name]();
    if (seq !== renderSeq) return;
    root.innerHTML = '';
    root.dataset.view = name;
    window.scrollTo(0, 0);
    cleanup = (await mod.render(root, state.params || {})) || null;
  } catch (e) {
    if (seq !== renderSeq) return; // la vista ya cambió: el error es de una pantalla abandonada
    console.error(e);
    toast(`Error: ${e.message}`, 'error');
    if (name !== 'home') go('home', {}, { replace: true });
  }
}

export function go(name, params = {}, { replace = false } = {}) {
  const state = { name, params };
  if (replace) history.replaceState(state, ''); else history.pushState(state, '');
  return render(state);
}
export const back = () => history.back();
window.app = { go, back };

window.addEventListener('popstate', e => render(e.state || { name: 'home' }));

// Indicador global de carga de herramientas pesadas
function setupStatusPill() {
  const pill = h('<div id="lib-pill" hidden><div class="spinner tiny"></div><span></span></div>');
  document.body.append(pill);
  onStatus((name, st) => {
    const labels = { opencv: 'detección de bordes', tesseract: 'OCR', pdfjs: 'lector PDF' };
    if (!labels[name]) return;
    if (st.state === 'loading') {
      pill.hidden = false;
      $('span', pill).textContent = `Preparando ${labels[name]}… ${st.frac ? Math.round(st.frac * 100) + '%' : ''}`;
    } else {
      pill.hidden = true;
      if (st.state === 'error') toast(`No se pudo cargar ${labels[name]}. Revisa tu conexión.`, 'error');
    }
  });
}

async function start() {
  await loadSettings();
  setupStatusPill();
  const initial = history.state && views[history.state.name] ? history.state : { name: 'home', params: {} };
  history.replaceState(initial, '');
  await render(initial);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  // Precarga en segundo plano la detección de bordes para que la cámara esté lista
  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 1500));
  idle(() => loadOpenCV().catch(() => {}));
  // Completa en segundo plano la alta resolución de páginas que quedaron pendientes
  setTimeout(() => import('./upgrader.js').then(m => m.resumePending()).catch(() => {}), 4000);
}

start();
