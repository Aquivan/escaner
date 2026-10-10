// Almacenamiento local con IndexedDB: documentos, páginas (con imágenes) y ajustes.
const DB_NAME = 'escanerpro';
const DB_VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pages')) {
        const s = db.createObjectStore('pages', { keyPath: 'id' });
        s.createIndex('docId', 'docId');
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transacción abortada'));
  }));
}

const req2p = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function getDocs() {
  const docs = await tx('docs', 'readonly', s => req2p(s.getAll()));
  return docs.sort((a, b) => b.updated - a.updated);
}
export const getDoc = id => tx('docs', 'readonly', s => req2p(s.get(id)));
export const putDoc = doc => { doc.updated = Date.now(); return tx('docs', 'readwrite', s => { s.put(doc); }); };
export const getPage = id => tx('pages', 'readonly', s => req2p(s.get(id)));
export const putPage = page => tx('pages', 'readwrite', s => { s.put(page); });
export const deletePage = id => tx('pages', 'readwrite', s => { s.delete(id); });
export const getAllPages = () => tx('pages', 'readonly', s => req2p(s.getAll()));

export async function getPages(doc) {
  const pages = await Promise.all(doc.pageIds.map(getPage));
  return pages.filter(Boolean);
}

export async function deleteDoc(id) {
  const doc = await getDoc(id);
  if (!doc) return;
  await tx('pages', 'readwrite', s => { for (const pid of doc.pageIds) s.delete(pid); });
  await tx('docs', 'readwrite', s => { s.delete(id); });
}

export async function newDoc(name) {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const doc = {
    id: uid(),
    name: name || `Escaneo ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`,
    created: Date.now(), updated: Date.now(), pageIds: [],
  };
  await putDoc(doc);
  return doc;
}

export async function getSetting(key, def) {
  const v = await tx('settings', 'readonly', s => req2p(s.get(key)));
  return v === undefined ? def : v;
}
export const setSetting = (key, val) => tx('settings', 'readwrite', s => { s.put(val, key); });

export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}
