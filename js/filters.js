// Procesamiento de imagen en JS puro (sin DOM): corrección de perspectiva,
// giro y filtros. Se usa desde un Web Worker y, como respaldo, en el hilo principal.
// Una "imagen" aquí es {data: Uint8ClampedArray RGBA, width, height}.

export const PRESETS = ['original', 'auto', 'clean', 'gray', 'bw', 'photo', 'board'];
export const DEFAULT_FILTER = { preset: 'auto', brightness: 0, contrast: 0, sharpness: 25, shadows: true };

const clamp = v => (v < 0 ? 0 : v > 255 ? 255 : v);

// ---------- Perspectiva ----------

// Resuelve la homografía que lleva los 4 puntos `from` a los 4 puntos `to`.
export function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Eliminación gaussiana con pivoteo parcial
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    const d = A[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / (A[r][r] || 1e-12);
  }
  return [...x, 1];
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Proporción real (ancho/alto) del documento a partir de su perspectiva.
// Método de Zhang y He ("Whiteboard scanning", 2007): estima la distancia focal
// suponiendo el centro óptico en el centro de la imagen. Devuelve null si no es fiable.
export function estimateAspect(q, sw, sh) {
  const u0 = sw / 2, v0 = sh / 2;
  const m = p => [p[0] - u0, p[1] - v0, 1];
  const m1 = m(q[0]), m2 = m(q[1]), m4 = m(q[2]), m3 = m(q[3]); // tl, tr, br, bl
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const c14 = cross(m1, m4);
  const d2 = dot(cross(m2, m4), m3), d3 = dot(cross(m3, m4), m2);
  if (Math.abs(d2) < 1e-9 || Math.abs(d3) < 1e-9) return null;
  const k2 = dot(c14, m3) / d2, k3 = dot(c14, m2) / d3;
  const n2 = m2.map((v, i) => k2 * v - m1[i]), n3 = m3.map((v, i) => k3 * v - m1[i]);
  let ar;
  const denom = n2[2] * n3[2];
  const f2 = Math.abs(denom) > 1e-12 ? -(n2[0] * n3[0] + n2[1] * n3[1]) / denom : -1;
  if (f2 > 0 && Math.abs(n2[2]) > 1e-6 && Math.abs(n3[2]) > 1e-6) {
    ar = Math.sqrt((n2[0] ** 2 / f2 + n2[1] ** 2 / f2 + n2[2] ** 2) / (n3[0] ** 2 / f2 + n3[1] ** 2 / f2 + n3[2] ** 2));
  } else {
    ar = Math.sqrt((n2[0] ** 2 + n2[1] ** 2) / (n3[0] ** 2 + n3[1] ** 2)); // casi frontal
  }
  if (!isFinite(ar) || ar < 0.15 || ar > 7) return null;
  return ar;
}

// Proporciones de papel habituales (ancho/alto en vertical) para "imantar" el resultado
const PAPER = [1 / Math.SQRT2, 8.5 / 11, 8.5 / 14, 85.6 / 53.98];

// Tamaño de salida para un cuadrilátero (tl, tr, br, bl) en píxeles de la imagen sw×sh
export function quadSize(q, sw, sh) {
  let w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  let h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const naive = w / h;
  let ar = sw && sh ? estimateAspect(q, sw, sh) : null;
  // Si la estimación difiere demasiado de lo medido, no nos fiamos de ella
  if (!ar || ar / naive > 1.9 || naive / ar > 1.9) ar = naive;
  for (const p of PAPER) for (const r of [p, 1 / p]) if (Math.abs(ar - r) / r < 0.035) ar = r;
  if (w / h < ar) w = h * ar; else h = w / ar;
  return [Math.max(1, Math.round(w)), Math.max(1, Math.round(h))];
}

export function isFullQuad(c) {
  if (!c) return true;
  const e = 0.002;
  return c[0][0] < e && c[0][1] < e && c[1][0] > 1 - e && c[1][1] < e && c[2][0] > 1 - e && c[2][1] > 1 - e && c[3][0] < e && c[3][1] > 1 - e;
}

// Corrige la perspectiva. corners normalizados [0..1] en orden tl,tr,br,bl.
export function warp(src, corners, maxSide = 0) {
  const { width: sw, height: sh, data: sd } = src;
  const q = corners.map(([x, y]) => [x * (sw - 1), y * (sh - 1)]);
  let [ow, oh] = quadSize(q, sw, sh);
  if (maxSide && Math.max(ow, oh) > maxSide) {
    const k = maxSide / Math.max(ow, oh);
    ow = Math.round(ow * k); oh = Math.round(oh * k);
  }
  const H = homography([[0, 0], [ow - 1, 0], [ow - 1, oh - 1], [0, oh - 1]], q);
  const out = new Uint8ClampedArray(ow * oh * 4);
  // Si se reduce mucho, muestreamos 2x2 para evitar aliasing
  const scale = Math.max(dist(q[0], q[1]) / ow, dist(q[0], q[3]) / oh);
  const ss = scale > 1.6 ? 2 : 1;
  const offs = ss === 2 ? [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]] : [[0, 0]];
  const inv = 1 / offs.length;
  let o = 0;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let r = 0, g = 0, bl = 0;
      for (let k = 0; k < offs.length; k++) {
        const X = x + offs[k][0], Y = y + offs[k][1];
        const den = H[6] * X + H[7] * Y + 1;
        let sx = (H[0] * X + H[1] * Y + H[2]) / den;
        let sy = (H[3] * X + H[4] * Y + H[5]) / den;
        if (sx < 0) sx = 0; else if (sx > sw - 1) sx = sw - 1;
        if (sy < 0) sy = 0; else if (sy > sh - 1) sy = sh - 1;
        const x0 = sx | 0, y0 = sy | 0;
        const x1 = x0 < sw - 1 ? x0 + 1 : x0, y1 = y0 < sh - 1 ? y0 + 1 : y0;
        const fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        r += sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
        g += sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
        bl += sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
      }
      out[o] = r * inv; out[o + 1] = g * inv; out[o + 2] = bl * inv; out[o + 3] = 255;
      o += 4;
    }
  }
  return { data: out, width: ow, height: oh };
}

// Giro en múltiplos de 90° (sentido horario)
export function rotate(img, deg) {
  deg = ((deg % 360) + 360) % 360;
  if (!deg) return img;
  const { width: w, height: h, data: d } = img;
  const nw = deg === 180 ? w : h, nh = deg === 180 ? h : w;
  const src32 = new Uint32Array(d.buffer, d.byteOffset, w * h);
  const out = new Uint8ClampedArray(w * h * 4);
  const o32 = new Uint32Array(out.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx, ny;
      if (deg === 90) { nx = h - 1 - y; ny = x; } else if (deg === 180) { nx = w - 1 - x; ny = h - 1 - y; } else { nx = y; ny = w - 1 - x; }
      o32[ny * nw + nx] = src32[y * w + x];
    }
  }
  return { data: out, width: nw, height: nh };
}

// ---------- Filtros ----------

function lumArray(d, n) {
  const L = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return L;
}

// Estima el fondo (papel) con una malla de máximos por bloque, dilatada y suavizada.
function backgroundGrid(chan, w, h) {
  const block = Math.max(8, Math.round(Math.max(w, h) / 48));
  const gw = Math.ceil(w / block), gh = Math.ceil(h / block);
  let g = new Float32Array(gw * gh);
  // Percentil alto (≈ máximo robusto) por bloque: usamos el 2º mayor de una muestra
  for (let by = 0; by < gh; by++) {
    for (let bx = 0; bx < gw; bx++) {
      let m1 = 0, m2 = 0;
      const y1 = Math.min(h, (by + 1) * block), x1 = Math.min(w, (bx + 1) * block);
      for (let y = by * block; y < y1; y += 2) {
        let i = y * w + bx * block;
        for (let x = bx * block; x < x1; x += 2, i += 2) {
          const v = chan[i];
          if (v > m1) { m2 = m1; m1 = v; } else if (v > m2) m2 = v;
        }
      }
      g[by * gw + bx] = m2 || m1;
    }
  }
  // Dilatación 3x3 (cubre bloques llenos de texto) y dos pasadas de suavizado
  const tmp = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < gw && yy < gh) { const v = g[yy * gw + xx]; if (v > m) m = v; }
    }
    tmp[y * gw + x] = m;
  }
  g = tmp;
  for (let pass = 0; pass < 2; pass++) {
    const t2 = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < gw && yy < gh) { s += g[yy * gw + xx]; c++; }
      }
      t2[y * gw + x] = s / c;
    }
    g = t2;
  }
  return { g, gw, gh, block };
}

// Fondo interpolado bilinealmente, fila a fila (rápido: sin funciones por píxel)
function bgRows(bg, w, h, onRow) {
  const { g, gw, gh, block } = bg;
  const xi0 = new Int32Array(w), xi1 = new Int32Array(w), xf = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let gx = (x + 0.5) / block - 0.5; if (gx < 0) gx = 0; if (gx > gw - 1) gx = gw - 1;
    xi0[x] = gx | 0; xi1[x] = Math.min(gw - 1, xi0[x] + 1); xf[x] = gx - xi0[x];
  }
  const col = new Float32Array(gw), row = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    let gy = (y + 0.5) / block - 0.5; if (gy < 0) gy = 0; if (gy > gh - 1) gy = gh - 1;
    const y0 = gy | 0, y1 = Math.min(gh - 1, y0 + 1), fy = gy - y0, o0 = y0 * gw, o1 = y1 * gw;
    for (let i = 0; i < gw; i++) col[i] = g[o0 + i] * (1 - fy) + g[o1 + i] * fy;
    for (let x = 0; x < w; x++) { const f = xf[x]; row[x] = col[xi0[x]] * (1 - f) + col[xi1[x]] * f; }
    onRow(y, row);
  }
}

// Quita sombras/iluminación desigual dividiendo por el fondo estimado.
// perChannel=true también corrige el tono del papel (blanquea).
export function removeShadows(img, perChannel = false) {
  const { data: d, width: w, height: h } = img;
  const n = w * h;
  // (Uint8ClampedArray ya recorta y redondea al asignar)
  if (perChannel) {
    const ch = new Uint8Array(n);
    for (let c = 0; c < 3; c++) {
      for (let i = 0, j = c; i < n; i++, j += 4) ch[i] = d[j];
      const bg = backgroundGrid(ch, w, h);
      bgRows(bg, w, h, (y, row) => {
        for (let x = 0, j = y * w * 4 + c; x < w; x++, j += 4) { const v = row[x]; d[j] = d[j] * 248 / (v > 24 ? v : 24); }
      });
    }
  } else {
    const L = lumArray(d, n);
    const bg = backgroundGrid(L, w, h);
    bgRows(bg, w, h, (y, row) => {
      for (let x = 0, j = y * w * 4; x < w; x++, j += 4) {
        const v = row[x], k = 245 / (v > 24 ? v : 24);
        d[j] *= k; d[j + 1] *= k; d[j + 2] *= k;
      }
    });
  }
  return img;
}

function percentiles(L, lo, hi) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < L.length; i++) hist[L[i]]++;
  const n = L.length;
  let acc = 0, a = 0, b = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * lo) { a = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * (1 - hi)) { b = v; break; } }
  return [a, b];
}

function applyLut(d, lut) {
  for (let j = 0; j < d.length; j += 4) { d[j] = lut[d[j]]; d[j + 1] = lut[d[j + 1]]; d[j + 2] = lut[d[j + 2]]; }
}

function saturate(d, s) {
  if (s === 1) return;
  for (let j = 0; j < d.length; j += 4) {
    const l = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) / 256;
    d[j] = clamp(l + (d[j] - l) * s); d[j + 1] = clamp(l + (d[j + 1] - l) * s); d[j + 2] = clamp(l + (d[j + 2] - l) * s);
  }
}

function toGray(d) {
  for (let j = 0; j < d.length; j += 4) { const l = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8; d[j] = d[j + 1] = d[j + 2] = l; }
}

function levels(img, loPct = 0.005, hiPct = 0.995, gamma = 1) {
  const L = lumArray(img.data, img.width * img.height);
  let [a, b] = percentiles(L, loPct, hiPct);
  if (b - a < 40) { a = Math.max(0, a - 20); b = Math.min(255, b + 20); }
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) { let x = (v - a) / (b - a); x = x < 0 ? 0 : x > 1 ? 1 : x; lut[v] = Math.round(Math.pow(x, gamma) * 255); }
  applyLut(img.data, lut);
}

function brightnessContrast(d, br, ct) {
  if (!br && !ct) return;
  const c = ct * 1.28; // -128..128
  const f = (259 * (c + 255)) / (255 * (259 - c));
  const b = br * 1.28;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = clamp(f * (v - 128) + 128 + b);
  applyLut(d, lut);
}

// Desenfoque de caja separable de un canal (radio r), con sumas acumuladas
function boxBlur1(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), div = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = src[o] * (r + 1);
    for (let k = 1; k <= r; k++) s += src[o + Math.min(w - 1, k)];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = s / div;
      s += src[o + (x + r + 1 < w ? x + r + 1 : w - 1)] - src[o + (x - r > 0 ? x - r : 0)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = tmp[x] * (r + 1);
    for (let k = 1; k <= r; k++) s += tmp[Math.min(h - 1, k) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / div;
      s += tmp[(y + r + 1 < h ? y + r + 1 : h - 1) * w + x] - tmp[(y - r > 0 ? y - r : 0) * w + x];
    }
  }
  return out;
}

// Máscara de enfoque sobre la luminancia (3× más rápida que por canal y sin halos de color)
export function sharpen(img, amount) {
  if (amount <= 0) return;
  const { data: d, width: w, height: h } = img;
  const r = Math.max(1, Math.round(Math.max(w, h) / 1600));
  const L = lumArray(d, w * h);
  const B = boxBlur1(L, w, h, r);
  const k = amount / 100 * 1.6;
  for (let i = 0, j = 0; i < L.length; i++, j += 4) {
    const diff = (L[i] - B[i]) * k;
    d[j] += diff; d[j + 1] += diff; d[j + 2] += diff;
  }
}

// Umbral adaptativo (Bradley) con imagen integral
export function adaptiveThreshold(img, t = 0.12) {
  const { data: d, width: w, height: h } = img;
  const n = w * h;
  const L = lumArray(d, n);
  const I = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += L[y * w + x];
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
    }
  }
  const s2 = Math.max(4, Math.round(Math.max(w, h) / 24)) >> 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - s2), y1 = Math.min(h, y + s2 + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - s2), x1 = Math.min(w, x + s2 + 1);
      const cnt = (x1 - x0) * (y1 - y0);
      const sum = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      const i = y * w + x;
      // Además del criterio local, lo muy claro es siempre blanco
      const v = (L[i] * cnt <= sum * (1 - t) && L[i] < 215) ? 0 : 255;
      const j = i * 4;
      d[j] = d[j + 1] = d[j + 2] = v;
    }
  }
}

// Aplica un ajuste completo de filtro a la imagen (modifica in situ y la devuelve)
export function applyFilter(img, f = DEFAULT_FILTER) {
  const s = { ...DEFAULT_FILTER, ...f };
  const d = img.data;
  switch (s.preset) {
    case 'original':
      if (s.shadows) removeShadows(img, false);
      break;
    case 'auto': // Color mejorado
      if (s.shadows) removeShadows(img, false);
      levels(img, 0.01, 0.985, 1.05);
      saturate(d, 1.18);
      break;
    case 'clean': // Documento limpio: papel blanco, tinta nítida, color conservado
      removeShadows(img, true);
      {
        const lut = new Uint8ClampedArray(256);
        for (let v = 0; v < 256; v++) { let x = (v / 255 - 0.1) / (0.84 - 0.1); x = x < 0 ? 0 : x > 1 ? 1 : x; lut[v] = Math.round(Math.pow(x, 1.35) * 255); }
        applyLut(d, lut);
      }
      saturate(d, 1.25);
      break;
    case 'gray':
      if (s.shadows) removeShadows(img, false);
      toGray(d);
      levels(img, 0.01, 0.99, 1.1);
      break;
    case 'bw':
      removeShadows(img, false);
      toGray(d);
      brightnessContrast(d, 0, s.contrast);
      if (s.sharpness > 0) sharpen(img, s.sharpness);
      adaptiveThreshold(img, Math.max(0.02, Math.min(0.35, 0.12 + s.brightness / 100 * 0.1)));
      return img;
    case 'board': // Pizarra blanca: fondo blanco puro y trazos de rotulador vivos
      removeShadows(img, true);
      {
        const lut = new Uint8ClampedArray(256);
        for (let v = 0; v < 256; v++) { let x = (v / 255 - 0.18) / (0.8 - 0.18); x = x < 0 ? 0 : x > 1 ? 1 : x; lut[v] = Math.round(Math.pow(x, 1.6) * 255); }
        applyLut(d, lut);
      }
      saturate(d, 1.8);
      break;
    case 'photo': // Foto: realce suave sin tocar el fondo
      levels(img, 0.002, 0.998, 1);
      saturate(d, 1.1);
      break;
  }
  brightnessContrast(d, s.brightness, s.contrast);
  if (s.sharpness > 0) sharpen(img, s.sharpness);
  return img;
}

// Pipeline completo para una página
export function processPipeline(src, { corners, rotation = 0, filter, maxSide = 0 }) {
  let img = src;
  if (corners && !isFullQuad(corners)) img = warp(img, corners, maxSide);
  img = rotate(img, rotation);
  if (img === src) img = { data: new Uint8ClampedArray(src.data), width: src.width, height: src.height };
  applyFilter(img, filter);
  return img;
}
