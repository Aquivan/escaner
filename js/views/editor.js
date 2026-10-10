// Revisar y editar: vista grande de la página, herramientas en fila (auto-mejora, filtros,
// ajustes, recortar y rotar, limpiar, texto, firma, anotar, extraer texto), tira de
// miniaturas numeradas para cambiar de página, reordenar y añadir más, y repetir o borrar.
import * as db from '../db.js';
import { icon } from '../icons.js';
import { h, $, $$, toast, progress, confirmDlg, menu, sheet, esc, safeName } from '../ui.js';
import { decodeBlob, canvasToImg, imgToCanvas, runFilter, renderPage, fitCanvas, drawAnnotations, blobUrl } from '../imaging.js';
import { DEFAULT_FILTER } from '../filters.js';
import { savePage, removePagesFromDoc, duplicatePage } from '../pages.js';
import { makeSortable } from '../sortable.js';
import { openExport } from '../export-sheet.js';
import { go, back } from '../nav.js';

const PRESET_LIST = [
  ['original', 'Original'], ['auto', 'Mejorado'], ['clean', 'Limpio'], ['gray', 'Grises'], ['bw', 'B/N'], ['photo', 'Foto'],
];
const NEUTRAL = { preset: 'original', shadows: false, sharpness: 0, brightness: 0, contrast: 0 };
const isEnhanced = f => (f.preset === 'auto' || f.preset === 'clean') && f.shadows;

export async function render(root, params) {
  const { docId, fromScan = false, newDoc = false } = params;
  let doc = await db.getDoc(docId);
  if (!doc || !doc.pageIds.length) { back(); return; }
  let idx = Math.min(params.index || 0, doc.pageIds.length - 1);
  let page, base, filter, rotation, dirty = false, panel = null, renderTok = 0;

  root.innerHTML = `
    <div class="stage-view review">
      <header class="topbar dark">
        <button class="icon-btn" id="back" aria-label="Volver">${icon('back')}</button>
        <h1>Revisar y editar</h1>
        <span class="pager" id="pager"></span>
        <button class="icon-btn" id="more" aria-label="Más opciones">${icon('more')}</button>
      </header>
      <div class="stage" id="stage">
        <canvas id="cv"></canvas><div class="spinner" id="spin" style="position:absolute"></div>
        <div class="stage-fabs">
          <button class="fab-round" id="retake" aria-label="Volver a escanear esta página" title="Volver a escanear">${icon('camera')}</button>
          <button class="fab-round" id="del" aria-label="Eliminar esta página" title="Eliminar">${icon('trash')}</button>
        </div>
      </div>
      <div class="stage-panel" id="panel" hidden></div>
      <div class="tool-chips" id="tools">
        <button class="magic" data-a="auto" aria-label="Mejora automática" title="Mejora automática">${icon('wand')}</button>
        <span class="tool-sep"></span>
        <button data-a="filters">${icon('drop')}Filtros</button>
        <button data-a="adjust">${icon('sliders')}Ajustes</button>
        <button data-a="crop">${icon('crop')}Recortar y rotar</button>
        <button data-a="clean">${icon('eraser')}Limpiar</button>
        <button data-a="text">${icon('type')}Añadir texto</button>
        <button data-a="sign">${icon('signature')}Firmar</button>
        <button data-a="annotate">${icon('highlighter')}Resaltar y dibujar</button>
        <button data-a="ocr">${icon('ocr')}Extraer texto</button>
      </div>
      <div class="thumb-strip" id="strip"></div>
      <div class="review-actions">
        ${fromScan && newDoc ? `<button class="btn ghost-dark" id="discard">Descartar escaneo</button>` : ''}
        <button class="btn primary" id="done">${fromScan ? 'Guardar' : 'Listo'}</button>
      </div>
    </div>`;
  const cv = $('#cv', root), spin = $('#spin', root), strip = $('#strip', root);

  // Recuerda la página actual en el historial para volver a ella desde recortar/anotar/OCR
  const remember = () => history.replaceState({ name: 'editor', params: { ...params, index: idx } }, '');

  async function load(i) {
    idx = i;
    remember();
    page = await db.getPage(doc.pageIds[idx]);
    filter = { ...DEFAULT_FILTER, ...page.filter };
    rotation = page.rotation || 0;
    dirty = false;
    if (!root.contains(cv)) return;
    $('#pager', root).textContent = `${idx + 1}/${doc.pageIds.length}`;
    markStrip();
    spin.hidden = false;
    await rebuildBase();
    await preview();
    drawPanel();
  }

  async function rebuildBase() {
    const src = await decodeBlob(page.original, 1500);
    base = await runFilter('pipeline', canvasToImg(src), { corners: page.corners, rotation, filter: NEUTRAL, maxSide: 1500 });
  }

  async function preview() {
    const tok = ++renderTok;
    spin.hidden = false;
    const out = await runFilter('filter', base, { filter });
    if (tok !== renderTok) return;
    const c = imgToCanvas(out);
    cv.width = c.width; cv.height = c.height;
    cv.getContext('2d').drawImage(c, 0, 0);
    if (page.annotations?.length) await drawAnnotations(cv.getContext('2d'), page.annotations, cv.width, cv.height);
    spin.hidden = true;
    $('[data-a="auto"]', root)?.classList.toggle('on', isEnhanced(filter));
  }

  // ---------- Tira de miniaturas ----------
  let sortable = null;
  async function drawStrip() {
    const pages = await db.getPages(doc);
    strip.innerHTML = '';
    pages.forEach((p, i) => {
      const t = h(`<div class="page-card strip-item" data-id="${p.id}" role="button" tabindex="0" aria-label="Página ${i + 1}">
        <img src="${blobUrl(p.thumb)}" alt="" draggable="false"><b>${i + 1}</b></div>`);
      t.onclick = async () => { const j = doc.pageIds.indexOf(p.id); if (j === idx) return; await persist(); load(j); };
      strip.append(t);
    });
    const add = h(`<button class="strip-add" aria-label="Añadir páginas">${icon('plus')}</button>`);
    add.onclick = addMenu;
    strip.append(add);
    markStrip();
  }
  function markStrip() {
    $$('.strip-item', strip).forEach(el => el.classList.toggle('current', el.dataset.id === doc.pageIds[idx]));
    $$('.strip-item b', strip).forEach((b, i) => { b.textContent = i + 1; });
    const cur = $('.strip-item.current', strip);
    if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  async function refreshThumb() {
    const el = $(`.strip-item[data-id="${page.id}"] img`, strip);
    if (el) el.src = blobUrl(page.thumb);
  }

  function addMenu() {
    menu([
      { icon: 'camera', label: 'Escanear más páginas', onClick: async () => { await persist(); go('camera', { docId, insertAt: doc.pageIds.length, returnBack: true }); } },
      { icon: 'idcard', label: 'Escanear carnet (2 caras)', onClick: async () => { await persist(); go('camera', { docId, mode: 'id', insertAt: doc.pageIds.length, returnBack: true }); } },
      { icon: 'upload', label: 'Importar fotos o PDF', onClick: async () => {
        await persist();
        const { pickFiles } = await import('../ui.js');
        const { importFiles } = await import('../pages.js');
        const files = await pickFiles({ accept: 'image/*,application/pdf' });
        if (!files.length) return;
        const pr = progress('Importando…');
        try { await importFiles(doc, files, pr); } catch (e) { toast(e.message, 'error'); }
        pr.close();
        doc = await db.getDoc(docId);
        await drawStrip();
        load(doc.pageIds.length - 1);
      } },
    ]);
  }

  // ---------- Paneles ----------
  async function filterThumbs() {
    const small = canvasToImg(fitCanvas(imgToCanvas(base), 160));
    for (const [k] of PRESET_LIST) {
      const out = await runFilter('filter', small, { filter: { ...DEFAULT_FILTER, preset: k, sharpness: 0 } });
      const el = $(`.filter-chip[data-p="${k}"] canvas`, root);
      if (!el) return;
      const c = imgToCanvas(out);
      el.width = c.width; el.height = c.height;
      el.getContext('2d').drawImage(c, 0, 0);
    }
  }

  function drawPanel() {
    const p = $('#panel', root);
    if (!p) return; // se salió de la pantalla mientras cargaba
    $$('#tools [data-a]', root).forEach(b => { if (b.dataset.a !== 'auto') b.classList.toggle('on', b.dataset.a === panel); });
    p.hidden = !panel;
    if (panel === 'filters') {
      p.innerHTML = `<div class="chips" style="gap:12px;padding-bottom:6px">${PRESET_LIST.map(([k, l]) =>
        `<button class="filter-chip ${filter.preset === k ? 'on' : ''}" data-p="${k}"><canvas></canvas>${l}</button>`).join('')}</div>
        <div class="row" style="padding-bottom:6px"><span class="spacer"></span><button class="btn small" id="all">Aplicar a todas</button></div>`;
      $$('.filter-chip', p).forEach(b => b.onclick = () => {
        filter.preset = b.dataset.p;
        if (b.dataset.p === 'bw' || b.dataset.p === 'clean') filter.shadows = true;
        $$('.filter-chip', p).forEach(x => x.classList.toggle('on', x === b));
        dirty = true; preview();
      });
      $('#all', p).onclick = applyAll;
      filterThumbs();
    } else if (panel === 'adjust') {
      const bw = filter.preset === 'bw';
      p.innerHTML = `
        <div class="slider-row"><span>${bw ? 'Umbral' : 'Brillo'}</span><input type="range" min="-100" max="100" id="br" value="${filter.brightness}"><output>${filter.brightness}</output></div>
        <div class="slider-row"><span>Contraste</span><input type="range" min="-100" max="100" id="ct" value="${filter.contrast}"><output>${filter.contrast}</output></div>
        <div class="slider-row"><span>Nitidez</span><input type="range" min="0" max="100" id="sh" value="${filter.sharpness}"><output>${filter.sharpness}</output></div>
        <label class="switch"><span class="sw-text">Quitar sombras<small>Uniforma la iluminación del papel</small></span><input type="checkbox" id="sd" ${filter.shadows ? 'checked' : ''} ${bw || filter.preset === 'clean' ? 'disabled checked' : ''}></label>
        <div class="row" style="padding-bottom:6px"><button class="btn small" id="reset">Restablecer</button><span class="spacer"></span><button class="btn small" id="all">Aplicar a todas</button></div>`;
      const bind = (id, key) => {
        const inp = $(`#${id}`, p);
        inp.oninput = () => { inp.nextElementSibling.textContent = inp.value; filter[key] = +inp.value; dirty = true; schedule(); };
      };
      bind('br', 'brightness'); bind('ct', 'contrast'); bind('sh', 'sharpness');
      $('#sd', p).onchange = e => { filter.shadows = e.target.checked; dirty = true; preview(); };
      $('#reset', p).onclick = () => { filter = { ...DEFAULT_FILTER, preset: filter.preset }; dirty = true; drawPanel(); preview(); };
      $('#all', p).onclick = applyAll;
    }
  }
  let schedT;
  const schedule = () => { clearTimeout(schedT); schedT = setTimeout(preview, 120); };

  async function persist() {
    if (!dirty) return;
    const pr = progress('Guardando página…');
    try {
      if ((page.rotation || 0) !== rotation) page.ocr = null;
      page.filter = { ...filter }; page.rotation = rotation;
      await renderPage(page);
      await savePage(page);
      dirty = false;
      refreshThumb();
    } finally { pr.close(); }
  }

  async function applyAll() {
    if (!(await confirmDlg(`¿Aplicar este filtro y ajustes a las ${doc.pageIds.length} páginas?`, 'Aplicar'))) return;
    const pr = progress('Aplicando a todas las páginas…');
    try {
      for (let i = 0; i < doc.pageIds.length; i++) {
        pr.set(i / doc.pageIds.length, `Página ${i + 1} de ${doc.pageIds.length}`);
        const p = i === idx ? page : await db.getPage(doc.pageIds[i]);
        p.filter = { ...filter };
        if (i === idx && (p.rotation || 0) !== rotation) { p.rotation = rotation; p.ocr = null; }
        await renderPage(p);
        await db.putPage(p);
      }
      await db.putDoc(doc);
      dirty = false;
      await drawStrip();
      toast('Aplicado a todas las páginas', 'ok');
    } catch (e) { toast(e.message, 'error'); }
    pr.close();
  }

  async function rotateBy(deg) {
    rotation = (rotation + deg + 360) % 360; dirty = true;
    await rebuildBase();
    preview();
    if (panel === 'filters') filterThumbs();
  }

  // ---------- Herramientas ----------
  $('#tools', root).addEventListener('click', async e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'auto') {
      filter = isEnhanced(filter) ? { ...DEFAULT_FILTER, ...NEUTRAL } : { ...DEFAULT_FILTER, preset: 'auto', shadows: true, sharpness: 25 };
      dirty = true; preview();
      toast(isEnhanced(filter) ? 'Mejora automática aplicada' : 'Imagen original');
      if (panel) drawPanel();
      return;
    }
    if (a === 'filters' || a === 'adjust') { panel = panel === a ? null : a; drawPanel(); return; }
    await persist();
    if (a === 'crop') go('crop', { pageId: page.id });
    if (a === 'clean') go('annotate', { pageId: page.id, tool: 'whiteout' });
    if (a === 'text') go('annotate', { pageId: page.id, tool: 'text' });
    if (a === 'sign') go('annotate', { pageId: page.id, tool: 'sign' });
    if (a === 'annotate') go('annotate', { pageId: page.id, tool: 'highlight' });
    if (a === 'ocr') go('ocr', { docId, pageIndex: idx });
  });

  $('#retake', root).onclick = async () => { await persist(); go('camera', { docId, replaceId: page.id }); };
  $('#del', root).onclick = async () => {
    if (!(await confirmDlg('¿Eliminar esta página?', 'Eliminar', true))) return;
    await removePagesFromDoc(doc, [page.id]);
    dirty = false;
    if (!doc.pageIds.length) {
      if (newDoc) await db.deleteDoc(docId);
      go(newDoc ? 'home' : 'doc', newDoc ? {} : { id: docId }, { replace: true });
      return;
    }
    await drawStrip();
    load(Math.min(idx, doc.pageIds.length - 1));
  };

  async function finish() {
    await persist();
    if (!fromScan) { back(); return; }
    // Guardar: nombre y, si se quiere, exportar enseguida
    const body = h(`<div><label class="field"><span>Nombre del documento</span><input class="input" id="nm" value="${esc(doc.name)}"></label>
      <p class="small muted">${doc.pageIds.length} página${doc.pageIds.length === 1 ? '' : 's'}. Se guarda en este teléfono; luego puedes exportarlo cuando quieras.</p></div>`);
    const s = sheet({
      title: 'Guardar escaneo', body,
      actions: [
        { label: 'Solo guardar', value: 'save' },
        { label: 'Guardar y exportar', icon: 'download', cls: 'primary', value: 'export' },
      ],
    });
    setTimeout(() => $('#nm', body).select(), 80);
    const nameEl = $('#nm', body);
    const v = await s.done;
    if (!v) return;
    doc.name = safeName(nameEl.value.trim()) || doc.name;
    await db.putDoc(doc);
    go('doc', { id: docId }, { replace: true });
    if (v === 'export') setTimeout(async () => openExport(doc, await db.getPages(doc)), 350);
    else toast('Guardado', 'ok');
  }

  $('#done', root).onclick = finish;
  $('#back', root).onclick = async () => { await persist(); if (fromScan) go('doc', { id: docId }, { replace: true }); else back(); };
  if ($('#discard', root)) $('#discard', root).onclick = async () => {
    if (!(await confirmDlg('¿Descartar todo este escaneo? Se borrarán sus páginas.', 'Descartar', true))) return;
    dirty = false;
    await db.deleteDoc(docId);
    toast('Escaneo descartado');
    go('home', {}, { replace: true });
  };
  $('#more', root).onclick = () => menu([
    { icon: 'rotateR', label: 'Girar a la derecha', onClick: () => rotateBy(90) },
    { icon: 'rotateL', label: 'Girar a la izquierda', onClick: () => rotateBy(-90) },
    { icon: 'duplicate', label: 'Duplicar página', onClick: async () => { await persist(); await duplicatePage(doc, page); doc = await db.getDoc(docId); await drawStrip(); toast('Página duplicada', 'ok'); load(idx + 1); } },
    { icon: 'grid', label: 'Ver todas las páginas', onClick: async () => { await persist(); go('doc', { id: docId }, { replace: fromScan }); } },
  ]);

  sortable = makeSortable(strip, {
    item: '.strip-item[data-id]',
    onEnd: async order => {
      const cur = doc.pageIds[idx];
      doc.pageIds = order;
      await db.putDoc(doc);
      idx = order.indexOf(cur);
      $('#pager', root).textContent = `${idx + 1}/${doc.pageIds.length}`;
      remember(); markStrip();
    },
  });

  await drawStrip();
  await load(idx);
  return () => { sortable && sortable.destroy(); return persist(); };
}
