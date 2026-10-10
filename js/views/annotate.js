// Anotar: texto, firma, resaltado, lápiz y corrector (limpieza básica de manchas o dedos).
import * as db from '../db.js';
import { icon } from '../icons.js';
import { h, $, $$, toast, sheet, promptDlg, pickFiles, confirmDlg } from '../ui.js';
import { decodeBlob, drawAnnotations, annBounds, sampleBorderColor, updateThumb, signatureFromPhoto, makeCanvas } from '../imaging.js';
import { savePage } from '../pages.js';
import { settings, save } from '../settings.js';
import { back } from '../nav.js';

const COLORS = {
  text: ['#111111', '#1d4ed8', '#b91c1c', '#15803d', '#ffffff'],
  pen: ['#111111', '#1d4ed8', '#b91c1c', '#15803d', '#f59e0b'],
  highlight: ['#ffeb3b', '#a3e635', '#f9a8d4', '#7dd3fc', '#fdba74'],
};
const TOOLS = [
  ['select', 'move', 'Mover'], ['text', 'type', 'Texto'], ['sign', 'signature', 'Firma'],
  ['highlight', 'highlighter', 'Resaltar'], ['pen', 'pen', 'Lápiz'], ['whiteout', 'eraser', 'Corrector'],
];

export async function render(root, { pageId, tool: initialTool }) {
  const page = await db.getPage(pageId);
  if (!page) { back(); return; }
  const base = await decodeBlob(page.processed, 2400);
  let anns = structuredClone(page.annotations || []);
  const undo = [], redo = [];
  let tool = 'select', sel = -1, dirty = false;
  const opt = { textColor: COLORS.text[0], penColor: COLORS.pen[1], hlColor: COLORS.highlight[0], textSize: 0.028, penWidth: 0.004 };

  root.innerHTML = `
    <div class="stage-view">
      <header class="topbar dark">
        <button class="icon-btn" id="close" aria-label="Cerrar">${icon('x')}</button>
        <h1>Anotar</h1>
        <button class="icon-btn" id="undo" aria-label="Deshacer">${icon('undo')}</button>
        <button class="icon-btn" id="redo" aria-label="Rehacer">${icon('redo')}</button>
        <button class="icon-btn" id="save" aria-label="Guardar">${icon('check')}</button>
      </header>
      <div class="stage ann-stage" id="stage"><canvas id="cv"></canvas></div>
      <div class="stage-panel" id="panel"></div>
      <div class="stage-bar">${TOOLS.map(([k, ic, l]) => `<button class="tool" data-t="${k}">${icon(ic)}${l}</button>`).join('')}</div>
    </div>`;
  const stage = $('#stage', root), cv = $('#cv', root), ctx = cv.getContext('2d');
  let W = 1, H = 1; // tamaño de visualización en px CSS

  function layout() {
    const sw = stage.clientWidth - 16, sh = stage.clientHeight - 16;
    const k = Math.min(sw / base.width, sh / base.height);
    W = Math.max(1, base.width * k); H = Math.max(1, base.height * k);
    const dpr = window.devicePixelRatio || 1;
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    draw();
  }

  let drawTok = 0;
  async function draw(temp) {
    const tok = ++drawTok;
    const dpr = window.devicePixelRatio || 1;
    const off = makeCanvas(cv.width, cv.height);
    const o = off.getContext('2d');
    o.imageSmoothingQuality = 'high';
    o.drawImage(base, 0, 0, off.width, off.height);
    await drawAnnotations(o, temp ? [...anns, temp] : anns, off.width, off.height);
    if (tok !== drawTok) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(off, 0, 0);
    if (sel >= 0 && anns[sel]) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const b = annBounds(anns[sel], o, W, H);
      ctx.save();
      ctx.strokeStyle = '#2dd4bf'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.strokeRect(b.x * W - 4, b.y * H - 4, b.w * W + 8, b.h * H + 8);
      ctx.setLineDash([]);
      ctx.fillStyle = '#2dd4bf';
      ctx.beginPath(); ctx.arc(b.x * W + b.w * W + 4, b.y * H + b.h * H + 4, 9, 0, 7); ctx.fill();
      ctx.strokeStyle = '#042f2e'; ctx.lineWidth = 2;
      const hx = b.x * W + b.w * W + 4, hy = b.y * H + b.h * H + 4;
      ctx.beginPath(); ctx.moveTo(hx - 4, hy + 4); ctx.lineTo(hx + 4, hy - 4); ctx.stroke();
      ctx.restore();
    }
  }

  function snapshot() { undo.push(JSON.stringify(anns)); if (undo.length > 60) undo.shift(); redo.length = 0; dirty = true; updUndo(); }
  function updUndo() { $('#undo', root).disabled = !undo.length; $('#redo', root).disabled = !redo.length; }

  // ---------- Panel contextual ----------
  function panel() {
    const p = $('#panel', root);
    $$('.stage-bar .tool', root).forEach(b => b.classList.toggle('on', b.dataset.t === tool));
    const selA = sel >= 0 ? anns[sel] : null;
    const dots = (list, cur, key) => `<div class="color-dots">${list.map(c => `<button class="color-dot ${c === cur ? 'on' : ''}" data-k="${key}" data-c="${c}" style="background:${c}" aria-label="Color ${c}"></button>`).join('')}</div>`;
    let html = '';
    if (tool === 'select') {
      if (selA) {
        html = `<div class="row wrap" style="padding-bottom:6px">
          ${selA.type === 'text' ? `<button class="btn small" id="edit">${icon('type')}Editar</button>` : ''}
          ${selA.type === 'text' || selA.type === 'path' ? dots(selA.type === 'text' ? COLORS.text : COLORS.pen, selA.color, 'sel') : ''}
          ${selA.type === 'rect' && selA.mode === 'highlight' ? dots(COLORS.highlight, selA.color, 'sel') : ''}
          <span class="spacer"></span>
          <button class="btn small" id="dup">${icon('duplicate')}</button>
          <button class="btn small danger" id="del">${icon('trash')}Eliminar</button></div>`;
      } else html = '<p class="small" style="opacity:.75;margin:4px 0 8px">Toca una anotación para moverla, cambiar su tamaño (asa inferior) o borrarla.</p>';
    } else if (tool === 'text') {
      html = `${dots(COLORS.text, opt.textColor, 'text')}
        <div class="slider-row" style="margin-top:6px"><span>Tamaño</span><input type="range" id="tsize" min="10" max="90" value="${Math.round(opt.textSize * 1000)}"><output></output></div>
        <div class="row wrap" style="padding-bottom:6px"><span class="small" style="opacity:.75">Toca la página donde quieras escribir · Rápido:</span>
          <button class="btn small" data-q="✓">✓</button><button class="btn small" data-q="✗">✗</button><button class="btn small" data-q="date">Fecha</button></div>`;
    } else if (tool === 'pen') {
      html = `${dots(COLORS.pen, opt.penColor, 'pen')}
        <div class="slider-row" style="margin-top:6px"><span>Grosor</span><input type="range" id="pw" min="1" max="20" value="${Math.round(opt.penWidth * 1000)}"><output></output></div>`;
    } else if (tool === 'highlight') {
      html = `${dots(COLORS.highlight, opt.hlColor, 'hl')}<p class="small" style="opacity:.75;margin:6px 0">Arrastra sobre el texto que quieras resaltar.</p>`;
    } else if (tool === 'whiteout') {
      html = '<p class="small" style="opacity:.8;margin:4px 0 8px">Arrastra sobre una mancha, dedo o marca: se cubre con el color del papel de alrededor. (Limpieza básica: no reconstruye texto ni fondos complejos.)</p>';
    } else if (tool === 'sign') {
      html = `<div class="row" style="padding-bottom:6px"><button class="btn small" id="sigOpen">${icon('signature')}Elegir o crear firma</button></div>`;
    }
    p.innerHTML = html;
    $$('.color-dot', p).forEach(d => d.onclick = () => {
      const c = d.dataset.c, k = d.dataset.k;
      if (k === 'sel' && selA) { snapshot(); selA.color = c; draw(); } else if (k === 'text') opt.textColor = c; else if (k === 'pen') opt.penColor = c; else if (k === 'hl') opt.hlColor = c;
      panel();
    });
    const ts = $('#tsize', p);
    if (ts) { ts.nextElementSibling.textContent = ts.value; ts.oninput = () => { opt.textSize = ts.value / 1000; ts.nextElementSibling.textContent = ts.value; }; }
    const pw = $('#pw', p);
    if (pw) { pw.nextElementSibling.textContent = pw.value; pw.oninput = () => { opt.penWidth = pw.value / 1000; pw.nextElementSibling.textContent = pw.value; }; }
    $$('[data-q]', p).forEach(b => b.onclick = () => {
      const t = b.dataset.q === 'date' ? new Date().toLocaleDateString('es') : b.dataset.q;
      addText(t, 0.4, 0.45);
    });
    if ($('#edit', p)) $('#edit', p).onclick = () => editText(sel);
    if ($('#del', p)) $('#del', p).onclick = () => { snapshot(); anns.splice(sel, 1); sel = -1; panel(); draw(); };
    if ($('#dup', p)) $('#dup', p).onclick = () => {
      snapshot();
      const c = structuredClone(anns[sel]);
      if ('x' in c) { c.x = Math.min(0.9, c.x + 0.03); c.y = Math.min(0.9, c.y + 0.03); }
      if (c.type === 'path') c.points = c.points.map(([x, y]) => [x + 0.03, y + 0.03]);
      anns.push(c); sel = anns.length - 1; panel(); draw();
    };
    if ($('#sigOpen', p)) $('#sigOpen', p).onclick = openSignatures;
  }

  function addText(text, x, y) {
    snapshot();
    anns.push({ type: 'text', x, y, text, size: opt.textSize, color: opt.textColor, bold: false });
    sel = anns.length - 1; tool = 'select'; panel(); draw();
  }

  async function editText(i) {
    const a = anns[i];
    const t = await promptDlg('Editar texto', a.text, { multiline: true });
    if (t == null) return;
    snapshot();
    if (!t.trim()) { anns.splice(i, 1); sel = -1; } else a.text = t;
    panel(); draw();
  }

  // ---------- Firmas ----------
  function openSignatures() {
    const body = h(`<div>
      <div class="field-label" style="margin-bottom:8px">Mis firmas</div>
      <div class="sig-list" id="list"></div>
      <div class="field-label" style="margin:6px 0 8px">Dibuja una nueva</div>
      <canvas class="sig-pad" id="pad"></canvas>
      <div class="row wrap" style="margin-top:10px">
        <div class="color-dots"><button class="color-dot on" data-c="#111111" style="background:#111"></button><button class="color-dot" data-c="#1d4ed8" style="background:#1d4ed8"></button></div>
        <span class="spacer"></span>
        <button class="btn small" id="clear">Borrar</button>
        <button class="btn small" id="photo">${icon('camera')}Desde foto</button>
      </div>
      <label class="switch"><span class="sw-text">Guardar para usarla después</span><input type="checkbox" id="keep" checked></label>
    </div>`);
    const s = sheet({ title: 'Firma', body, actions: [{ label: 'Cancelar' }, { label: 'Usar firma dibujada', cls: 'primary', onClick: () => {
      const url = padToPng();
      if (!url) { toast('Dibuja tu firma primero'); return false; }
      if ($('#keep', body).checked) save('signatures', [url, ...(settings.signatures || [])].slice(0, 8));
      placeSignature(url);
      return true;
    } }] });
    const list = $('#list', body);
    function drawList() {
      const sigs = settings.signatures || [];
      list.innerHTML = sigs.length ? '' : '<p class="small muted" style="grid-column:1/-1">Aún no tienes firmas guardadas.</p>';
      sigs.forEach((u, i) => {
        const it = h(`<div class="sig-item" role="button" tabindex="0"><img src="${u}" alt="Firma ${i + 1}"><button class="del" aria-label="Borrar">${icon('x')}</button></div>`);
        it.onclick = e => {
          if (e.target.closest('.del')) { e.stopPropagation(); save('signatures', sigs.filter((_, k) => k !== i)); drawList(); return; }
          placeSignature(u); s.close(true);
        };
        list.append(it);
      });
    }
    drawList();
    // Pad de firma
    const pad = $('#pad', body), pctx = pad.getContext('2d');
    let ink = '#111111', drawing = false, last = null, lastMid = null, strokes = 0;
    const setup = () => { const r = pad.getBoundingClientRect(); const d = window.devicePixelRatio || 1; pad.width = r.width * d; pad.height = r.height * d; pctx.scale(d, d); pctx.lineCap = 'round'; pctx.lineJoin = 'round'; };
    setTimeout(setup, 250);
    const pt = e => { const r = pad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top, e.timeStamp]; };
    pad.onpointerdown = e => { drawing = true; pad.setPointerCapture(e.pointerId); last = pt(e); lastMid = last; strokes++; pctx.beginPath(); pctx.arc(last[0], last[1], 1.3, 0, 7); pctx.fillStyle = ink; pctx.fill(); };
    pad.onpointermove = e => {
      if (!drawing) return;
      const p = pt(e);
      const v = Math.hypot(p[0] - last[0], p[1] - last[1]) / Math.max(1, p[2] - last[2]);
      const mid = [(last[0] + p[0]) / 2, (last[1] + p[1]) / 2];
      pctx.strokeStyle = ink; pctx.lineWidth = Math.max(1.2, Math.min(3.6, 3.6 - v * 1.2));
      pctx.beginPath(); pctx.moveTo(...lastMid.slice(0, 2)); pctx.quadraticCurveTo(last[0], last[1], mid[0], mid[1]); pctx.stroke();
      last = p; lastMid = mid;
    };
    pad.onpointerup = pad.onpointercancel = () => { drawing = false; };
    $$('.color-dot', body).forEach(d => d.onclick = () => { ink = d.dataset.c; $$('.color-dot', body).forEach(x => x.classList.toggle('on', x === d)); });
    $('#clear', body).onclick = () => { pctx.clearRect(0, 0, pad.width, pad.height); strokes = 0; };
    $('#photo', body).onclick = async () => {
      const f = await pickFiles({ accept: 'image/*', multiple: false });
      if (!f.length) return;
      try {
        const rgb = ink === '#1d4ed8' ? [29, 78, 216] : [17, 17, 17];
        const url = await signatureFromPhoto(f[0], rgb);
        if ($('#keep', body).checked) save('signatures', [url, ...(settings.signatures || [])].slice(0, 8));
        placeSignature(url); s.close(true);
      } catch (e) { toast(e.message, 'error'); }
    };
    function padToPng() {
      if (!strokes) return null;
      const d = pctx.getImageData(0, 0, pad.width, pad.height).data;
      let x0 = pad.width, y0 = pad.height, x1 = -1, y1 = -1;
      for (let y = 0; y < pad.height; y++) for (let x = 0; x < pad.width; x++) if (d[(y * pad.width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 < 0) return null;
      const m = 6; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(pad.width - 1, x1 + m); y1 = Math.min(pad.height - 1, y1 + m);
      const out = makeCanvas(x1 - x0 + 1, y1 - y0 + 1);
      out.getContext('2d').drawImage(pad, -x0, -y0);
      return out.toDataURL('image/png');
    }
  }

  function placeSignature(url) {
    const im = new Image();
    im.onload = () => {
      snapshot();
      const w = 0.32, hN = w * W / H * im.height / im.width;
      anns.push({ type: 'image', src: url, x: 0.6 - w / 2, y: 0.78 - hN / 2, w, h: hN });
      sel = anns.length - 1; tool = 'select'; panel(); draw();
      toast('Arrastra la firma a su sitio y ajusta el tamaño con el asa');
    };
    im.src = url;
  }

  // ---------- Interacción ----------
  const norm = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  let act = null, lastTap = 0;

  function hit(x, y) {
    for (let i = anns.length - 1; i >= 0; i--) {
      const b = annBounds(anns[i], ctx, W, H);
      const px = 10 / W, py = 10 / H;
      if (x >= b.x - px && x <= b.x + b.w + px && y >= b.y - py && y <= b.y + b.h + py) return i;
    }
    return -1;
  }
  function onHandle(x, y) {
    if (sel < 0) return false;
    const b = annBounds(anns[sel], ctx, W, H);
    return Math.hypot((b.x + b.w) * W + 4 - x * W, (b.y + b.h) * H + 4 - y * H) < 22;
  }

  cv.addEventListener('pointerdown', e => {
    const [x, y] = norm(e);
    cv.setPointerCapture(e.pointerId);
    if (tool === 'select') {
      if (onHandle(x, y)) { snapshot(); act = { kind: 'resize', start: [x, y], orig: structuredClone(anns[sel]), b: annBounds(anns[sel], ctx, W, H) }; return; }
      const i = hit(x, y);
      const now = Date.now();
      if (i >= 0 && i === sel && now - lastTap < 350 && anns[i].type === 'text') { editText(i); lastTap = 0; return; }
      lastTap = now;
      sel = i; panel(); draw();
      if (i >= 0) { snapshot(); act = { kind: 'move', start: [x, y], orig: structuredClone(anns[i]), moved: false }; }
      return;
    }
    if (tool === 'text') { promptDlg('Escribe el texto', '', { multiline: true }).then(t => { if (t && t.trim()) addText(t, x, y); }); return; }
    if (tool === 'pen') { act = { kind: 'pen', a: { type: 'path', points: [[x, y]], color: opt.penColor, width: opt.penWidth } }; return; }
    if (tool === 'highlight' || tool === 'whiteout') { act = { kind: 'rect', start: [x, y], a: { type: 'rect', mode: tool === 'highlight' ? 'highlight' : 'fill', color: tool === 'highlight' ? opt.hlColor : '#ffffff', x, y, w: 0, h: 0 } }; return; }
    if (tool === 'sign') openSignatures();
  });

  cv.addEventListener('pointermove', e => {
    if (!act) return;
    const [x, y] = norm(e);
    if (act.kind === 'move') {
      const dx = x - act.start[0], dy = y - act.start[1];
      if (Math.abs(dx) + Math.abs(dy) > 0.003) act.moved = true;
      const a = anns[sel], o = act.orig;
      if (a.type === 'path') a.points = o.points.map(([px, py]) => [px + dx, py + dy]);
      else { a.x = o.x + dx; a.y = o.y + dy; }
      draw();
    } else if (act.kind === 'resize') {
      const a = anns[sel], o = act.orig, b = act.b;
      const nw = Math.max(0.02, x - b.x), nh = Math.max(0.01, y - b.y);
      const k = nw / Math.max(1e-6, b.w);
      if (a.type === 'image') { a.w = nw; a.h = o.h * k; }
      else if (a.type === 'rect') { a.w = nw; a.h = nh; }
      else if (a.type === 'text') a.size = Math.max(0.006, o.size * k);
      else if (a.type === 'path') { a.points = o.points.map(([px, py]) => [b.x + (px - b.x) * k, b.y + (py - b.y) * k]); a.width = o.width * k; }
      draw();
    } else if (act.kind === 'pen') {
      act.a.points.push([x, y]); draw(act.a);
    } else if (act.kind === 'rect') {
      const [sx, sy] = act.start;
      Object.assign(act.a, { x: Math.min(sx, x), y: Math.min(sy, y), w: Math.abs(x - sx), h: Math.abs(y - sy) });
      if (act.a.mode === 'fill') act.a.color = '#e2e8f0';
      draw(act.a);
    }
  });

  const finish = () => {
    if (!act) return;
    const a = act;
    act = null;
    if (a.kind === 'move' && !a.moved) { undo.pop(); updUndo(); }
    if (a.kind === 'pen' && a.a.points.length > 1) { snapshot(); anns.push(a.a); }
    if (a.kind === 'rect' && a.a.w > 0.005 && a.a.h > 0.004) {
      snapshot();
      if (a.a.mode === 'fill') a.a.color = sampleBorderColor(base, a.a.x, a.a.y, a.a.w, a.a.h);
      anns.push(a.a);
    }
    draw();
  };
  cv.addEventListener('pointerup', finish);
  cv.addEventListener('pointercancel', finish);

  $$('.stage-bar .tool', root).forEach(b => b.onclick = () => {
    tool = b.dataset.t;
    if (tool !== 'select') sel = -1;
    panel(); draw();
    if (tool === 'sign') openSignatures();
  });
  $('#undo', root).onclick = () => { if (!undo.length) return; redo.push(JSON.stringify(anns)); anns = JSON.parse(undo.pop()); sel = -1; dirty = true; updUndo(); panel(); draw(); };
  $('#redo', root).onclick = () => { if (!redo.length) return; undo.push(JSON.stringify(anns)); anns = JSON.parse(redo.pop()); sel = -1; dirty = true; updUndo(); panel(); draw(); };
  $('#save', root).onclick = async () => {
    page.annotations = anns;
    await updateThumb(page);
    await savePage(page);
    dirty = false;
    toast('Anotaciones guardadas', 'ok');
    back();
  };
  $('#close', root).onclick = async () => {
    if (dirty && !(await confirmDlg('¿Salir sin guardar las anotaciones?', 'Salir', true))) return;
    dirty = false; back();
  };
  const onKey = e => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel >= 0 && !e.target.closest('input,textarea')) { snapshot(); anns.splice(sel, 1); sel = -1; panel(); draw(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') $('#undo', root).click();
  };
  window.addEventListener('keydown', onKey);

  const ro = new ResizeObserver(layout);
  ro.observe(stage);
  if (initialTool && TOOLS.some(t => t[0] === initialTool)) tool = initialTool;
  updUndo(); panel(); layout();
  if (tool === 'sign') setTimeout(openSignatures, 150);
  if (tool === 'text') toast('Toca la página donde quieras escribir');
  return () => { ro.disconnect(); window.removeEventListener('keydown', onKey); };
}
