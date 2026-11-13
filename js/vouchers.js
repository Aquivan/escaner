// 🧾 Puente con el Portal de Vouchers (aquivan.github.io/Claude/vouchers/).
// El portal abre EscánerPro con ?para=vouchers. Al terminar, «✅ Enviar a Vouchers» deja el PDF o las fotos en una
// base del navegador que comparten las dos páginas (son el mismo sitio: aquivan.github.io) y vuelve al portal, que
// los recoge en 📤 Subir. No pasa por ningún servidor: el archivo solo sale del teléfono cuando el portal lo sube.
const BD = 'puente-vouchers', ALMACEN = 'archivos';
export const PORTAL = '/Claude/vouchers/';

export function paraVouchers() {
  try {
    if (new URLSearchParams(location.search).get('para') === 'vouchers') sessionStorage.setItem('paraVouchers', '1');
    return sessionStorage.getItem('paraVouchers') === '1';
  } catch { return false; }
}

function abrir() {
  return new Promise((ok, ko) => {
    const r = indexedDB.open(BD, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ALMACEN, { keyPath: 'id' });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
}

/** Guarda los archivos para el portal y vuelve a él. */
export async function enviarAVouchers(files) {
  const db = await abrir();
  await new Promise((ok, ko) => {
    const tx = db.transaction(ALMACEN, 'readwrite');
    files.forEach((f, i) => tx.objectStore(ALMACEN).put({ id: Date.now() + '_' + i, nombre: f.name, tipo: f.type, blob: f, t: Date.now() }));
    tx.oncomplete = ok; tx.onerror = () => ko(tx.error);
  });
  db.close();
  try { sessionStorage.removeItem('paraVouchers'); } catch { /* */ }
  location.href = PORTAL + '?escaner=1';
}
