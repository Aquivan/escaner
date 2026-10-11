// Detección automática de bordes del documento con OpenCV.js
import { loadOpenCV, cvReady } from './loader.js';
import { makeCanvas } from './imaging.js';

export const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];

// Ordena 4 puntos como tl, tr, br, bl
export function orderQuad(pts) {
  const c = pts.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
  const sorted = [...pts].sort((a, b) => Math.atan2(a[1] - c[1], a[0] - c[0]) - Math.atan2(b[1] - c[1], b[0] - c[0]));
  // sorted en sentido horario empezando por el ángulo más negativo (arriba-izquierda aprox.)
  let tl = 0, best = Infinity;
  sorted.forEach((p, i) => { const s = p[0] + p[1]; if (s < best) { best = s; tl = i; } });
  return [0, 1, 2, 3].map(k => sorted[(tl + k) % 4]);
}

function polyArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) { const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % q.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}

export function isConvexQuad(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-9) return false;
    const s = Math.sign(cr);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

// Detecta el documento (IA + visión clásica). Devuelve esquinas normalizadas o null.
export async function detectQuad(source) {
  if (!cvReady()) { try { await loadOpenCV(); } catch { /* sigue solo con IA */ } }
  return (await detectSmart(source)).quad;
}

// Solo visión clásica (OpenCV)
export async function detectClassic(source, { minArea = 0.12 } = {}) {
  if (!cvReady()) { try { await loadOpenCV(); } catch { return null; } }
  const cv = window.cv;
  const sw = source.width || source.videoWidth, sh = source.height || source.videoHeight;
  const k = 480 / Math.max(sw, sh);
  const c = makeCanvas(sw * k, sh * k);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return detectOnSmall(cv, c, minArea);
}

// Versión síncrona para la vista previa en vivo (requiere OpenCV cargado)
export function detectQuadSync(canvasSmall, minArea = 0.12) {
  if (!cvReady()) return null;
  return detectOnSmall(window.cv, canvasSmall, minArea);
}

function detectOnSmall(cv, canvas, minArea) {
  const W = canvas.width, H = canvas.height, imgArea = W * H;
  const mats = [];
  const M = m => { mats.push(m); return m; };
  try {
    const src = M(cv.imread(canvas));
    const gray = M(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    // Cierre morfológico: borra el texto interior para que solo quede el contorno del papel
    const kernel = M(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9)));
    const closed = M(new cv.Mat());
    cv.morphologyEx(gray, closed, cv.MORPH_CLOSE, kernel);
    const blur = M(new cv.Mat());
    cv.GaussianBlur(closed, blur, new cv.Size(5, 5), 0);

    const candidates = [];
    const edgeMaps = [];
    // 1) Canny con umbrales derivados de la mediana
    const mean = cv.mean(blur)[0];
    const lo = Math.max(10, 0.4 * mean), hi = Math.min(255, Math.max(40, 1.1 * mean));
    const e1 = M(new cv.Mat()); cv.Canny(blur, e1, lo, hi);
    const e2 = M(new cv.Mat()); cv.Canny(blur, e2, 30, 90);
    // 2) Umbral de Otsu (papel claro sobre fondo oscuro o al revés)
    const e3 = M(new cv.Mat()); cv.threshold(blur, e3, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    edgeMaps.push(e1, e2, e3);
    const dk = M(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));

    for (const em of edgeMaps) {
      const dil = M(new cv.Mat());
      if (em === e3) em.copyTo(dil); else cv.dilate(em, dil, dk, new cv.Point(-1, -1), 2);
      const contours = M(new cv.MatVector());
      const hier = M(new cv.Mat());
      cv.findContours(dil, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      const list = [];
      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const a = cv.contourArea(cnt);
        if (a >= minArea * imgArea) list.push({ cnt, a }); else cnt.delete();
      }
      list.sort((x, y) => y.a - x.a);
      for (const { cnt } of list.slice(0, 8)) {
        const hull = new cv.Mat();
        cv.convexHull(cnt, hull, false, true);
        const peri = cv.arcLength(hull, true);
        let quad = null;
        for (const eps of [0.02, 0.03, 0.045, 0.06, 0.08]) {
          const approx = new cv.Mat();
          cv.approxPolyDP(hull, approx, eps * peri, true);
          if (approx.rows === 4) {
            quad = [];
            for (let j = 0; j < 4; j++) quad.push([approx.data32S[j * 2], approx.data32S[j * 2 + 1]]);
            approx.delete();
            break;
          }
          approx.delete();
        }
        hull.delete();
        if (quad) {
          const q = orderQuad(quad);
          const area = polyArea(q);
          if (area >= minArea * imgArea && isConvexQuad(q)) candidates.push({ q, area, score: area * quadRegularity(q) });
        }
      }
      list.forEach(({ cnt }) => cnt.delete());
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0].q;
    // Si coincide con el marco completo de la imagen no es una detección útil
    // Encoge un poco hacia el centro para no arrastrar el borde del fondo
    const cx = best.reduce((s, p) => s + p[0], 0) / 4, cy = best.reduce((s, p) => s + p[1], 0) / 4;
    const n = best.map(([x, y]) => {
      const k = 1.5 / Math.max(1, Math.hypot(x - cx, y - cy));
      return [Math.min(1, Math.max(0, (x + (cx - x) * k) / (W - 1))), Math.min(1, Math.max(0, (y + (cy - y) * k) / (H - 1)))];
    });
    if (polyArea(n) > 0.985) return null;
    return n;
  } catch (e) {
    console.warn('detección falló', e);
    return null;
  } finally {
    mats.forEach(m => { try { m.delete(); } catch { /* */ } });
  }
}

// 1 = ángulos rectos; penaliza cuadriláteros muy deformados
function quadRegularity(q) {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
    const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const cos = Math.abs((v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1));
    s += cos;
  }
  return Math.max(0.2, 1 - s / 4);
}

// ---------- Detección con IA (DocCornerNet, ~3,5 MB, ~30 ms) ----------
// Encuentra la hoja incluso con poco contraste con el fondo (papel blanco sobre mesa clara).
let mlMod = null, mlFailed = false;
const ML_BASE = () => new URL('lib/mldetect/', location.href).href;
export async function loadMl() {
  if (mlFailed) return null;
  if (!mlMod) {
    mlMod = import(new URL('lib/mldetect/scanic-mlDetector.js', location.href).href)
      .then(async m => { await m.initializeMl({ assetBaseUrl: ML_BASE() }); return m; })
      .catch(e => { console.warn('Detector IA no disponible', e); mlFailed = true; mlMod = null; return null; });
  }
  return mlMod;
}
export const mlReady = () => !!mlMod && !mlFailed;

async function detectMl(canvas) {
  const m = await loadMl();
  if (!m) return null;
  const r = await m.detectDocumentMl(canvas, { assetBaseUrl: ML_BASE(), minScore: 0.6 });
  if (!r || !r.success || !r.corners) return null;
  const W = canvas.width, H = canvas.height;
  const q = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'].map(k => [
    Math.min(1, Math.max(0, r.corners[k].x / W)), Math.min(1, Math.max(0, r.corners[k].y / H))]);
  if (!isConvexQuad(q) || polyArea(q) < 0.08) return null;
  return { q, score: r.score };
}

const quadDist = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));

// Combina IA y visión clásica: la IA decide dónde está la hoja; si la clásica coincide,
// se usan sus esquinas porque se pegan al borde exacto del papel.
export async function detectSmart(source, { live = false } = {}) {
  const sw = source.width || source.videoWidth, sh = source.height || source.videoHeight;
  const k = (live ? 360 : 480) / Math.max(sw, sh);
  const c = makeCanvas(sw * k, sh * k);
  c.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0, c.width, c.height);
  const classical = cvReady() ? detectOnSmall(window.cv, c, 0.12) : null;
  let ml = null;
  try { ml = await detectMl(c); } catch (e) { console.warn(e); }
  if (ml && classical) return { quad: quadDist(ml.q, classical) < 0.035 ? classical : ml.q, method: quadDist(ml.q, classical) < 0.035 ? 'mixto' : 'ia', score: ml.score, canvas: c };
  // Solo IA (la clásica no ve nada): se exige más seguridad para no confundir techos o paredes
  if (ml && ml.score >= 0.92) return { quad: ml.q, method: 'ia', score: ml.score, canvas: c };
  if (classical) return { quad: classical, method: 'clasico', score: null, canvas: c };
  return { quad: null, canvas: c };
}

// ---------- Nitidez (para avisar de fotos movidas) ----------
// Mira los bordes más marcados (el 0,5 % más fuerte del laplaciano dentro del documento):
// en una foto movida hasta las letras pierden contraste, y en una hoja casi en blanco
// basta con un título para que siga contando como nítida.
export function sharpness(canvas, quad) {
  const W = canvas.width, H = canvas.height;
  let x0 = 1, y0 = 1, x1 = W - 1, y1 = H - 1;
  if (quad) {
    const xs = quad.map(p => p[0] * W), ys = quad.map(p => p[1] * H);
    const mx = (Math.max(...xs) - Math.min(...xs)) * 0.08, my = (Math.max(...ys) - Math.min(...ys)) * 0.08;
    x0 = Math.max(1, Math.floor(Math.min(...xs) + mx)); x1 = Math.min(W - 1, Math.ceil(Math.max(...xs) - mx));
    y0 = Math.max(1, Math.floor(Math.min(...ys) + my)); y1 = Math.min(H - 1, Math.ceil(Math.max(...ys) - my));
  }
  if (x1 - x0 < 8 || y1 - y0 < 8) return 0;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const g = i => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  const hist = new Uint32Array(512);
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * W + x) * 4;
    const l = Math.abs(4 * g(i) - g(i - 4) - g(i + 4) - g(i - W * 4) - g(i + W * 4));
    hist[Math.min(511, l | 0)]++; n++;
  }
  // Media del 0,5 % de valores más altos
  let need = Math.max(20, Math.round(n * 0.005)), acc = 0, sum = 0;
  for (let v = 511; v >= 0 && acc < need; v--) { const take = Math.min(hist[v], need - acc); acc += take; sum += take * v; }
  return acc ? sum / acc : 0;
}
export const BLUR_THRESHOLD = 90; // por debajo, la foto se considera movida o desenfocada
