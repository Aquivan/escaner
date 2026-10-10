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

// Detecta el documento en un canvas/imagen. Devuelve esquinas normalizadas o null.
export async function detectQuad(source, { minArea = 0.12 } = {}) {
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
