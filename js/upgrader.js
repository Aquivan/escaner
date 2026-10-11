// Genera en segundo plano la versión en alta resolución de las páginas procesadas en modo rápido.
import * as db from './db.js';
import { processPageCanvas, canvasToBlob, MAX_SIDE } from './imaging.js';

const pending = new Set();
let running = false, paused = false;

// Mientras la cámara está abierta no se procesa en alta (prioridad a las fotos nuevas)
export function pauseUpgrades(on) { paused = on; if (!on && pending.size && !running) setTimeout(run, 800); }

export function scheduleUpgrade(id) {
  if (!id) return;
  pending.add(id);
  if (!running && !paused) setTimeout(run, 1500); // deja terminar primero lo que el usuario está haciendo
}

async function upgradeOne(id) {
  const page = await db.getPage(id);
  if (!page || page.fullRes !== false || !page.docId) return;
  const rev = page.rev;
  const c = await processPageCanvas(page, MAX_SIDE);
  const blob = await canvasToBlob(c, 'image/jpeg', 0.92);
  const fresh = await db.getPage(id);
  if (!fresh || fresh.rev !== rev) return; // se editó mientras tanto: ya hay otra programada
  fresh.processed = blob; fresh.width = c.width; fresh.height = c.height; fresh.fullRes = true;
  await db.putPage(fresh);
}

async function run() {
  if (running) return;
  running = true;
  try {
    while (pending.size && !paused) {
      const id = pending.values().next().value;
      pending.delete(id);
      try { await upgradeOne(id); } catch (e) { console.warn('alta resolución', e); }
      await new Promise(r => setTimeout(r, 120)); // respiro para la interfaz
    }
  } finally { running = false; }
}

// Asegura la alta resolución antes de exportar u OCR (modifica y guarda el objeto página)
export async function ensureFullRes(page) {
  if (!page || page.fullRes !== false) return page;
  const c = await processPageCanvas(page, MAX_SIDE);
  page.processed = await canvasToBlob(c, 'image/jpeg', 0.92);
  page.width = c.width; page.height = c.height; page.fullRes = true;
  pending.delete(page.id);
  const fresh = await db.getPage(page.id);
  if (fresh && fresh.rev === page.rev) { Object.assign(fresh, { processed: page.processed, width: page.width, height: page.height, fullRes: true }); await db.putPage(fresh); }
  return page;
}

export async function ensureAllFullRes(pages, onProgress) {
  const todo = pages.filter(p => p && p.fullRes === false);
  for (let i = 0; i < todo.length; i++) { onProgress && onProgress(i / todo.length); await ensureFullRes(todo[i]); }
}

// Al abrir la app, retoma las páginas que quedaron sin alta resolución
export async function resumePending() {
  for (const d of await db.getDocs()) for (const id of d.pageIds) {
    const p = await db.getPage(id);
    if (p && p.fullRes === false) scheduleUpgrade(id);
  }
}
