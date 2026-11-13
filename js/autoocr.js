// Reconoce el texto de las páginas en segundo plano al guardar (como Google Drive o Adobe Scan):
// así los PDF salen buscables y se puede buscar dentro de los documentos sin esperar.
import * as db from './db.js';
import { settings } from './settings.js';

const queue = new Set();
let running = false, paused = false;

export function pauseAutoOcr(on) { paused = on; if (!on) kick(); }

export function queueDocOcr(doc) {
  if (settings.autoOcr === false || !doc) return;
  doc.pageIds.forEach(id => queue.add(id));
  kick();
}

function kick() { if (!running && !paused && queue.size) setTimeout(run, 2500); }

async function run() {
  if (running || paused) return;
  running = true;
  try {
    const { recognizePage } = await import('./ocr-engine.js');
    while (queue.size && !paused) {
      const id = queue.values().next().value;
      queue.delete(id);
      try {
        const page = await db.getPage(id);
        if (!page || page.ocr) continue;
        const rev = page.rev;
        const ocr = await recognizePage(page, settings.ocrLangs);
        const fresh = await db.getPage(id);
        if (fresh && fresh.rev === rev && !fresh.ocr) { fresh.ocr = ocr; await db.putPage(fresh); }
      } catch (e) { console.warn('OCR automático', e); }
      await new Promise(r => setTimeout(r, 200));
    }
  } finally { running = false; }
}

// Al abrir la app, completa el texto de documentos que quedaron sin leer
export async function resumeAutoOcr() {
  if (settings.autoOcr === false) return;
  for (const d of await db.getDocs()) {
    for (const id of d.pageIds) { const p = await db.getPage(id); if (p && !p.ocr) queue.add(id); }
  }
  kick();
}
