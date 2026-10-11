// Copia de seguridad de todos los documentos en un .zip (para guardarla en Google Drive,
// enviarla o pasarla a otro teléfono) y restauración desde ese archivo.
import * as db from './db.js';
import { loadJSZip } from './loader.js';
import { settings } from './settings.js';

const BLOBS = ['original', 'processed', 'thumb'];

export async function createBackup(onProgress) {
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  const docs = await db.getDocs();
  const meta = { app: 'EscánerPro', version: 1, created: new Date().toISOString(), docs: [], pages: [], signatures: settings.signatures || [] };
  let i = 0;
  const total = docs.reduce((s, d) => s + d.pageIds.length, 0) || 1;
  for (const d of docs) {
    meta.docs.push(d);
    for (const id of d.pageIds) {
      const p = await db.getPage(id);
      if (!p) continue;
      const rec = { ...p };
      for (const k of BLOBS) {
        if (p[k]) { zip.file(`paginas/${p.id}/${k}.jpg`, p[k]); rec[k] = `paginas/${p.id}/${k}.jpg`; }
      }
      meta.pages.push(rec);
      onProgress && onProgress(++i / total * 0.8);
    }
  }
  zip.file('escanerpro.json', JSON.stringify(meta));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, m => onProgress && onProgress(0.8 + m.percent / 500));
  const d = new Date();
  const name = `EscanerPro-copia-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.zip`;
  return new File([blob], name, { type: 'application/zip' });
}

// Restaura una copia. Los documentos que ya existen (mismo id) se reemplazan.
export async function restoreBackup(file, onProgress) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);
  const metaFile = zip.file('escanerpro.json');
  if (!metaFile) throw new Error('Este archivo no es una copia de EscánerPro');
  const meta = JSON.parse(await metaFile.async('string'));
  let i = 0;
  for (const rec of meta.pages) {
    const p = { ...rec };
    for (const k of BLOBS) {
      if (typeof rec[k] === 'string') {
        const f = zip.file(rec[k]);
        p[k] = f ? new Blob([await f.async('uint8array')], { type: 'image/jpeg' }) : null;
      }
    }
    await db.putPage(p);
    onProgress && onProgress(++i / (meta.pages.length || 1));
  }
  for (const d of meta.docs) await db.putDoc({ ...d });
  if (meta.signatures?.length) {
    const { save } = await import('./settings.js');
    const merged = [...new Set([...(settings.signatures || []), ...meta.signatures])].slice(0, 12);
    await save('signatures', merged);
  }
  return { docs: meta.docs.length, pages: meta.pages.length };
}
