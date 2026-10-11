// Service worker: la app funciona sin conexión y las librerías pesadas
// (OpenCV, OCR, PDF) se descargan una sola vez.
const VERSION = 'v11';
const APP = `escaner-app-${VERSION}`;
const LIBS = 'escaner-libs-v1'; // librerías versionadas: no cambian entre versiones de la app

const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'icons/icon.svg',
  'js/main.js', 'js/nav.js', 'js/ui.js', 'js/icons.js', 'js/db.js', 'js/loader.js', 'js/settings.js',
  'js/filters.js', 'js/filter-worker.js', 'js/imaging.js', 'js/detect.js', 'js/pages.js', 'js/cropper.js',
  'js/sortable.js', 'js/ranges.js', 'js/exporter.js', 'js/upgrader.js', 'js/docinfo.js', 'js/backup.js', 'js/export-sheet.js', 'js/ocr-engine.js',
  'js/views/home.js', 'js/views/camera.js', 'js/views/crop.js', 'js/views/editor.js', 'js/views/doc.js',
  'js/views/annotate.js', 'js/views/ocr.js', 'js/views/pdftools.js',
];

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== APP && k !== LIBS) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isLib = (url.origin === location.origin && url.pathname.includes('/lib/')) || url.hostname === 'cdn.jsdelivr.net';
  if (isLib) {
    // Primero caché; si no está, red y se guarda
    e.respondWith((async () => {
      const cache = await caches.open(LIBS);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }
  if (url.origin !== location.origin) return;
  // App: red primero, sin la copia HTTP del navegador (para recibir actualizaciones al momento),
  // con respaldo de caché sin conexión
  e.respondWith((async () => {
    const cache = await caches.open(APP);
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' && await cache.match('index.html'));
      if (hit) return hit;
      throw new Error('Sin conexión');
    }
  })());
});
