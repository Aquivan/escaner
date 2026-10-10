// "1-3, 5, 7-9" -> [[0,1,2],[4],[6,7,8]] (índices base 0). Lanza error si no es válido.
export function parseRanges(str, n) {
  const groups = [];
  for (const part of String(str).split(/[,;]+/)) {
    const s = part.trim();
    if (!s) continue;
    const m = s.match(/^(\d+)\s*(?:-\s*(\d+|fin|final|end))?$/i);
    if (!m) throw new Error(`Rango no válido: "${s}"`);
    const a = +m[1];
    const b = m[2] === undefined ? a : /^\d+$/.test(m[2]) ? +m[2] : n;
    if (a < 1 || b < 1 || a > n || b > n) throw new Error(`El rango "${s}" está fuera de 1–${n}`);
    const g = [];
    if (a <= b) for (let i = a; i <= b; i++) g.push(i - 1); else for (let i = a; i >= b; i--) g.push(i - 1);
    groups.push(g);
  }
  if (!groups.length) throw new Error('Escribe al menos un rango, p. ej. 1-3, 5');
  return groups;
}

export function chunk(n, size) {
  const out = [];
  for (let i = 0; i < n; i += size) out.push([...Array(Math.min(size, n - i)).keys()].map(k => k + i));
  return out;
}
