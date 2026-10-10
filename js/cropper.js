// Editor de esquinas con lupa: arrastra esquinas o lados para ajustar el recorte.
import { isConvexQuad } from './detect.js';

export function createCropper(stage, source, corners, { onChange } = {}) {
  const canvas = document.createElement('canvas');
  canvas.style.touchAction = 'none';
  const loupe = document.createElement('div');
  loupe.className = 'loupe';
  const lc = document.createElement('canvas');
  lc.width = lc.height = 240;
  loupe.append(lc);
  stage.append(canvas, loupe);
  const ctx = canvas.getContext('2d');
  let q = corners.map(p => [...p]);
  let rect = { x: 0, y: 0, w: 1, h: 1, dpr: 1 };
  let drag = null;

  function layout() {
    const dpr = window.devicePixelRatio || 1;
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const pad = 22;
    const k = Math.min((sw - pad * 2) / source.width, (sh - pad * 2) / source.height);
    const w = Math.max(1, source.width * k), hgt = Math.max(1, source.height * k);
    canvas.style.width = `${sw}px`; canvas.style.height = `${sh}px`;
    canvas.width = Math.round(sw * dpr); canvas.height = Math.round(sh * dpr);
    canvas.style.position = 'absolute'; canvas.style.left = '0'; canvas.style.top = '0';
    canvas.style.maxWidth = 'none'; canvas.style.maxHeight = 'none';
    rect = { x: (sw - w) / 2, y: (sh - hgt) / 2, w, h: hgt, dpr };
    draw();
  }

  const toScreen = ([x, y]) => [rect.x + x * rect.w, rect.y + y * rect.h];
  const toNorm = (sx, sy) => [Math.min(1, Math.max(0, (sx - rect.x) / rect.w)), Math.min(1, Math.max(0, (sy - rect.y) / rect.h))];

  function draw() {
    const { dpr } = rect;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h);
    const pts = q.map(toScreen);
    // Máscara oscura fuera del recorte
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.moveTo(...pts[0]); for (let i = 3; i >= 1; i--) ctx.lineTo(...pts[i]); ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,.5)';
    ctx.fill('evenodd');
    ctx.restore();
    const valid = isConvexQuad(q);
    ctx.strokeStyle = valid ? '#5eead4' : '#f87171';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(...pts[0]); pts.slice(1).forEach(p => ctx.lineTo(...p)); ctx.closePath(); ctx.stroke();
    // Asas de lados
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      ctx.save(); ctx.translate(...m); ctx.rotate(ang);
      ctx.fillStyle = '#fff'; ctx.strokeStyle = valid ? '#0f766e' : '#b91c1c'; ctx.lineWidth = 2;
      roundRect(ctx, -14, -5, 28, 10, 5); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    for (const p of pts) {
      ctx.beginPath(); ctx.arc(p[0], p[1], 13, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(94,234,212,.25)'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = valid ? '#5eead4' : '#f87171'; ctx.stroke();
      ctx.beginPath(); ctx.arc(p[0], p[1], 4, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    }
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }

  function showLoupe(sx, sy, focus) {
    const [fx, fy] = toScreen(focus);
    loupe.style.display = 'block';
    const lx = Math.min(stage.clientWidth - 130, Math.max(10, sx - 60));
    let ly = sy - 160; if (ly < 10) ly = sy + 50;
    loupe.style.left = `${lx}px`; loupe.style.top = `${ly}px`;
    const l = lc.getContext('2d');
    const srcX = (fx - rect.x) / rect.w * source.width, srcY = (fy - rect.y) / rect.h * source.height;
    const span = 40 * source.width / rect.w; // ~40px de pantalla ampliados 3x
    l.fillStyle = '#000'; l.fillRect(0, 0, 240, 240);
    l.imageSmoothingEnabled = true;
    l.drawImage(source, srcX - span / 2, srcY - span / 2, span, span, 0, 0, 240, 240);
    l.strokeStyle = '#5eead4'; l.lineWidth = 2;
    l.beginPath(); l.moveTo(120, 95); l.lineTo(120, 145); l.moveTo(95, 120); l.lineTo(145, 120); l.stroke();
  }

  function pos(e) { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  canvas.addEventListener('pointerdown', e => {
    const [sx, sy] = pos(e);
    const pts = q.map(toScreen);
    let best = null, bd = 34;
    pts.forEach((p, i) => { const d = Math.hypot(p[0] - sx, p[1] - sy); if (d < bd) { bd = d; best = { type: 'corner', i }; } });
    if (!best) {
      for (let i = 0; i < 4; i++) {
        const a = pts[i], b = pts[(i + 1) % 4];
        const d = Math.hypot((a[0] + b[0]) / 2 - sx, (a[1] + b[1]) / 2 - sy);
        if (d < 30) { best = { type: 'edge', i }; break; }
      }
    }
    if (!best) {
      // Toque en cualquier sitio: mueve la esquina más cercana
      let bi = 0, bdd = Infinity;
      pts.forEach((p, i) => { const d = Math.hypot(p[0] - sx, p[1] - sy); if (d < bdd) { bdd = d; bi = i; } });
      if (bdd < 90) best = { type: 'corner', i: bi };
    }
    if (!best) return;
    canvas.setPointerCapture(e.pointerId);
    const p0 = toScreen(q[best.i]);
    drag = { ...best, start: [sx, sy], orig: q.map(p => [...p]), off: best.type === 'corner' ? [p0[0] - sx, p0[1] - sy] : [0, 0] };
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    const [sx, sy] = pos(e);
    if (drag.type === 'corner') {
      q[drag.i] = toNorm(sx + drag.off[0], sy + drag.off[1]);
      showLoupe(sx, sy, q[drag.i]);
    } else {
      const dx = (sx - drag.start[0]) / rect.w, dy = (sy - drag.start[1]) / rect.h;
      const i = drag.i, j = (i + 1) % 4;
      for (const k of [i, j]) q[k] = [Math.min(1, Math.max(0, drag.orig[k][0] + dx)), Math.min(1, Math.max(0, drag.orig[k][1] + dy))];
      showLoupe(sx, sy, [(q[i][0] + q[j][0]) / 2, (q[i][1] + q[j][1]) / 2]);
    }
    draw();
  });
  const end = () => { if (!drag) return; drag = null; loupe.style.display = 'none'; draw(); onChange && onChange(q); };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  const ro = new ResizeObserver(layout);
  ro.observe(stage);
  layout();

  return {
    get corners() { return q.map(p => [...p]); },
    get valid() { return isConvexQuad(q); },
    set(c) { q = c.map(p => [...p]); draw(); },
    destroy() { ro.disconnect(); canvas.remove(); loupe.remove(); },
  };
}
