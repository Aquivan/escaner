// Editor de página: filtros, brillo/contraste/nitidez, quitar sombras, giro y navegación.
import * as db from '../db.js';
import { icon } from '../icons.js';
import { $, $$, toast, progress, confirmDlg, menu } from '../ui.js';
import { decodeBlob, canvasToImg, imgToCanvas, runFilter, renderPage, fitCanvas } from '../imaging.js';
import { DEFAULT_FILTER } from '../filters.js';
import { savePage, removePagesFromDoc, duplicatePage } from '../pages.js';
import { go, back } from '../nav.js';

const PRESET_LIST = [
  ['original', 'Original'], ['auto', 'Mejorado'], ['clean', 'Limpio'], ['gray', 'Grises'], ['bw', 'B/N'], ['photo', 'Foto'],
];
const NEUTRAL = { preset: 'original', shadows: false, sharpness: 0, brightness: 0, contrast: 0 };

export async function render(root, { docId, index = 0 }) {
  const doc = await db.getDoc(docId);
  if (!doc || !doc.pageIds.length) { back(); return; }
  let idx = Math.min(index, doc.pageIds.length - 1);
  let page, base, filter, rotation, dirty = false, panel = 'filters', renderTok = 0;

  root.innerHTML = `
    <div class="stage-view">
      <header class="topbar dark">
        <button class="icon-btn" id="back" aria-label="Volver">${icon('back')}</button>
        <button class="icon-btn" id="prev" aria-label="Anterior">${icon('back')}</button>
        <span class="pager" id="pager"></span>
        <button class="icon-btn" id="next" aria-label="Siguiente">${icon('next')}</button>
        <span class="spacer"></span>
        <button class="icon-btn" id="more" aria-label="Más">${icon('more')}</button>
        <button class="icon-btn" id="save" aria-label="Guardar">${icon('check')}</button>
      </header>
      <div class="stage" id="stage"><canvas id="cv"></canvas><div class="spinner" id="spin" style="position:absolute"></div></div>
      <div class="stage-panel" id="panel"></div>
      <div class="stage-bar">
        <button class="tool" data-a="crop">${icon('crop')}Recortar</button>
        <button class="tool" data-a="rotate">${icon('rotateR')}Girar</button>
        <button class="tool on" data-a="filters">${icon('wand')}Filtros</button>
        <button class="tool" data-a="adjust">${icon('sliders')}Ajustes</button>
        <button class="tool" data-a="annotate">${icon('pen')}Anotar</button>
        <button class="tool" data-a="ocr">${icon('ocr')}Texto</button>
      </div>
    </div>`;
  const cv = $('#cv', root), spin = $('#spin', root);

  async function load(i) {
    idx = i;
    page = await db.getPage(doc.pageIds[idx]);
    filter = { ...DEFAULT_FILTER, ...page.filter };
    rotation = page.rotation || 0;
    dirty = false;
    $('#pager', root).textContent = `${idx + 1} / ${doc.pageIds.length}`;
    $('#prev', root).disabled = idx === 0;
    $('#next', root).disabled = idx === doc.pageIds.length - 1;
    spin.hidden = false;
    const src = await decodeBlob(page.original, 1500);
    base = await runFilter('pipeline', canvasToImg(src), { corners: page.corners, rotation, filter: NEUTRAL, maxSide: 1500 });
    await preview();
    drawPanel();
  }

  async function preview() {
    const tok = ++renderTok;
    spin.hidden = false;
    const out = await runFilter('filter', base, { filter });
    if (tok !== renderTok) return;
    const c = imgToCanvas(out);
    cv.width = c.width; cv.height = c.height;
    cv.getContext('2d').drawImage(c, 0, 0);
    if (page.annotations?.length) {
      const { drawAnnotations } = await import('../imaging.js');
      await drawAnnotations(cv.getContext('2d'), page.annotations, cv.width, cv.height);
    }
    spin.hidden = true;
  }

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
    $$('.stage-bar .tool', root).forEach(b => b.classList.toggle('on', b.dataset.a === panel));
    if (panel === 'filters') {
      p.innerHTML = `<div class="chips" style="gap:12px;padding-bottom:6px">${PRESET_LIST.map(([k, l]) =>
        `<button class="filter-chip ${filter.preset === k ? 'on' : ''}" data-p="${k}"><canvas></canvas>${l}</button>`).join('')}</div>`;
      $$('.filter-chip', p).forEach(b => b.onclick = () => {
        filter.preset = b.dataset.p;
        if (b.dataset.p === 'bw' || b.dataset.p === 'clean') filter.shadows = true;
        $$('.filter-chip', p).forEach(x => x.classList.toggle('on', x === b));
        dirty = true; preview();
      });
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
      toast('Aplicado a todas las páginas', 'ok');
    } catch (e) { toast(e.message, 'error'); }
    pr.close();
  }

  $('.stage-bar', root).addEventListener('click', async e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'filters' || a === 'adjust') { panel = a; drawPanel(); return; }
    if (a === 'rotate') {
      rotation = (rotation + 90) % 360; dirty = true;
      const src = await decodeBlob(page.original, 1500);
      base = await runFilter('pipeline', canvasToImg(src), { corners: page.corners, rotation, filter: NEUTRAL, maxSide: 1500 });
      preview();
      if (panel === 'filters') filterThumbs();
      return;
    }
    await persist();
    if (a === 'crop') go('crop', { pageId: page.id });
    if (a === 'annotate') go('annotate', { pageId: page.id });
    if (a === 'ocr') go('ocr', { docId, pageIndex: idx });
  });
  $('#prev', root).onclick = async () => { if (idx > 0) { await persist(); load(idx - 1); } };
  $('#next', root).onclick = async () => { if (idx < doc.pageIds.length - 1) { await persist(); load(idx + 1); } };
  $('#save', root).onclick = async () => { await persist(); back(); };
  $('#back', root).onclick = async () => { await persist(); back(); };
  $('#more', root).onclick = () => menu([
    { icon: 'rotateL', label: 'Girar a la izquierda', onClick: async () => { rotation = (rotation + 270) % 360; dirty = true; const src = await decodeBlob(page.original, 1500); base = await runFilter('pipeline', canvasToImg(src), { corners: page.corners, rotation, filter: NEUTRAL, maxSide: 1500 }); preview(); } },
    { icon: 'duplicate', label: 'Duplicar página', onClick: async () => { await persist(); await duplicatePage(doc, page); toast('Página duplicada', 'ok'); load(idx + 1); } },
    { icon: 'camera', label: 'Escanear y añadir después de esta', onClick: async () => { await persist(); go('camera', { docId, insertAt: idx + 1 }); } },
    '-',
    { icon: 'trash', label: 'Eliminar página', danger: true, onClick: async () => {
      if (!(await confirmDlg('¿Eliminar esta página?', 'Eliminar', true))) return;
      await removePagesFromDoc(doc, [page.id]);
      dirty = false;
      if (!doc.pageIds.length) { back(); return; }
      load(Math.min(idx, doc.pageIds.length - 1));
    } },
  ]);

  await load(idx);
  return () => persist(); // guarda también si se sale con el botón atrás del sistema
}

