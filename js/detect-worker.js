// Hilo aparte para la IA de detección de bordes (DocCornerNet): así la cámara
// no se congela mientras se analiza cada fotograma.
let mod = null;
const base = new URL('../lib/mldetect/', import.meta.url).href;
async function load() {
  if (!mod) mod = import(base + 'scanic-mlDetector.js').then(async m => { await m.initializeMl({ assetBaseUrl: base }); return m; });
  return mod;
}
self.onmessage = async e => {
  const { id, bitmap, w, h } = e.data;
  try {
    const m = await load();
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const r = await m.detectDocumentMl(c, { assetBaseUrl: base, minScore: 0.6 });
    self.postMessage({ id, ok: !!(r && r.success && r.corners), corners: r?.corners, score: r?.score });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
