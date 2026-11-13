// Integración con la app Android (APK hecha con Capacitor).
// En la APK se usa el escáner de documentos de Google (ML Kit), el mismo de Google Drive:
// detección de bordes, captura automática, recorte y limpieza los hace el sistema.
// En el navegador nada de esto se carga y la app funciona igual que siempre.

export const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

let corePromise = null;
const core = () => (corePromise ||= import('../lib/capacitor-core.mjs'));
const plugins = {};
async function plugin(name) {
  if (!plugins[name]) { const { registerPlugin } = await core(); plugins[name] = registerPlugin(name); }
  return { api: plugins[name] }; // envuelto: el proxy del plugin no debe tratarse como promesa
}

// ¿Se puede usar el escáner de Google? (Android con Google Play services)
export async function googleScannerAvailable() {
  if (!window.androidBridge && !isNative()) return false;
  await core();
  try { return window.Capacitor.isPluginAvailable('DocumentScanner'); } catch { return false; }
}

// Abre el escáner de Google. Devuelve las páginas como Blob JPEG (ya recortadas) o null si se canceló.
export async function googleScan({ pageLimit = 30, gallery = true } = {}) {
  const ds = (await plugin('DocumentScanner')).api;
  try {
    const { available } = await ds.isGoogleDocumentScannerModuleAvailable();
    if (!available) {
      await ds.installGoogleDocumentScannerModule();
      // Se descarga una sola vez (unos segundos con conexión)
      await new Promise((ok, ko) => {
        let h;
        const t = setTimeout(() => { h?.remove?.(); ko(new Error('El escáner de Google se está descargando; inténtalo en un momento')); }, 90000);
        ds.addListener('googleDocumentScannerModuleInstallProgress', e => {
          if (e.state === 4 /* COMPLETED */ || e.progress >= 100) { clearTimeout(t); ok(); }
          if (e.state === 5 /* FAILED */ || e.state === 3 /* CANCELED */) { clearTimeout(t); ko(new Error('No se pudo descargar el escáner de Google')); }
        }).then(x => { h = x; });
      });
    }
  } catch (e) { console.warn('Módulo del escáner', e); }
  let res;
  try {
    res = await ds.scanDocument({ galleryImportAllowed: gallery, pageLimit, resultFormats: 'JPEG', scannerMode: 'FULL' });
  } catch (e) {
    if (/cancel/i.test(e?.message || e?.code || '')) return null;
    throw e;
  }
  const uris = res?.scannedImages || [];
  if (!uris.length) return null;
  const { Capacitor } = await core();
  const blobs = [];
  for (const u of uris) {
    const r = await fetch(Capacitor.convertFileSrc(u));
    blobs.push(await r.blob());
  }
  return blobs;
}

// ---------- Guardar y compartir archivos en la APK ----------
// (el WebView de Android no descarga enlaces blob: ni tiene navigator.share con archivos)
const toBase64 = blob => new Promise((ok, ko) => {
  const fr = new FileReader();
  fr.onload = () => ok(String(fr.result).split(',')[1]);
  fr.onerror = () => ko(fr.error);
  fr.readAsDataURL(blob);
});
async function writeCache(blob, name) {
  const fs = (await plugin('Filesystem')).api;
  const r = await fs.writeFile({ path: name, data: await toBase64(blob), directory: 'CACHE', recursive: true });
  return r.uri;
}
// Guarda en Documentos (carpeta pública del teléfono) y ofrece abrir/compartir
export async function nativeSave(blob, name) {
  const fs = (await plugin('Filesystem')).api;
  let saved = null;
  try {
    const r = await fs.writeFile({ path: `Escaner/${name}`, data: await toBase64(blob), directory: 'DOCUMENTS', recursive: true });
    saved = r.uri;
  } catch (e) { console.warn('No se pudo guardar en Documentos', e); }
  const uri = await writeCache(blob, name);
  const share = (await plugin('Share')).api;
  try { await share.share({ title: name, files: [uri], dialogTitle: saved ? 'Guardado en Documentos/Escaner · ¿compartir?' : 'Guardar o compartir' }); } catch { /* cancelado */ }
  return true;
}
export async function nativeShare(files, title) {
  const uris = [];
  for (const f of files) uris.push(await writeCache(f, f.name || `archivo-${uris.length + 1}`));
  const share = (await plugin('Share')).api;
  try { await share.share({ title, files: uris, dialogTitle: title || 'Compartir' }); } catch { /* cancelado */ }
  return true;
}
