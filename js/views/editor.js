// Revisar y editar: vista grande de la página, herramientas en fila (auto-mejora, filtros,
// ajustes, recortar y rotar, limpiar, texto, firma, anotar, extraer texto), tira de
// miniaturas numeradas para cambiar de página, reordenar y añadir más, y repetir o borrar.
import * as db from '../db.js';
import { icon } from '../icons.js';
import { h, $, $$, toast, progress, confirmDlg, menu, sheet, esc } from '../ui.js';
import { decodeBlob, canvasToImg, imgToCanvas, runFilter, renderPage, fitCanvas, drawAnnotations, blobUrl } from '../imaging.js';
import { DEFAULT_FILTER } from '../filters.js';
import { savePage, removePagesFromDoc, duplicatePage } from '../pages.js';
import { makeSortable } from '../sortable.js';
import { openExport } from '../export-sheet.js';
import { go, back } from '../nav.js';
import { settings } from '../settings.js';

const PRESET_LIST = [
  ['original', 'Original'], ['auto', 'Mejorado'], ['clean', 'Limpio'], ['gray', 'Grises'], ['bw', 'B/N'], ['board', 'Pizarra'], ['photo', 'Foto'],
];
const NEUTRAL = { preset: 'original', shadows: false, sharpness: 0, brightness: 0, contrast: 0 };
const isEnhanced = f => (f.preset === 'auto' || f.preset === 'clean') && f.shadows;

export async function render(root, params) {
  const { docId, fromScan = false, newDoc = false } = params;
  let doc = await db.getDoc(docId);
  if (!doc || !doc.pageIds.length) { back(); return; }
  let idx = Math.min(params.index || 0, doc.pageIds.length - 1);
  // Al volver de la cámara se abre la última página capturada
  try {
    const j = sessionStorage.getItem(`editorJump:${docId}`);
    if (j != null) { sessionStorage.removeItem(`editorJump:${docId}`); idx = Math.min(+j, doc.pageIds.length - 1); }
  } catch { /* */ }
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
        <div class="side-tools" id="side" aria-label="Opciones de la página">
          <button data-s="crop" title="Recortar y rotar"><span>Recortar</span>${icon('crop')}</button>
          <button data-s="pen" title="Lápiz"><span>Lápiz</span>${icon('pen')}</button>
          <button data-s="text" title="Añadir texto"><span>Texto</span>${icon('type')}</button>
          <button data-s="highlight" class="extra" title="Resaltar"><span>Resaltar</span>${icon('highlighter')}</button>
          <button data-s="sign" class="extra" title="Firmar"><span>Firma</span>${icon('signature')}</button>
          <button data-s="clean" class="extra" title="Borrar manchas o marcas"><span>Borrador</span>${icon('eraser')}</button>
          <button data-s="rotate" class="extra" title="Girar"><span>Girar</span>${icon('rotateR')}</button>
          <button data-s="retake" class="extra" id="retake" title="Volver a escanear"><span>Repetir</span>${icon('camera')}</button>
          <button data-s="del" class="extra" id="del" title="Eliminar"><span>Eliminar</span>${icon('trash')}</button>
          <button data-s="toggle" class="side-toggle" aria-label="Más opciones" title="Más opciones"><span>Cerrar</span><i class="chev-down">${icon('chevDown')}</i><i class="chev-up">${icon('chevUp')}</i></button>
        </div>
      </div>
      <div class="stage-panel" id="panel" hidden></div>
      <div class="tool-chips" id="tools">
        <button class="magic" data-a="auto" aria-label="Mejora automática" title="Mejora automática">${icon('wand')}</button>
        <span class="tool-sep"></span>
        <button data-a="filters">${icon('drop')}Filtros</button>
        <button data-a="adjust">${icon('sliders')}Ajustes</button>
        <button data-a="ocr">${icon('ocr')}Extraer texto</button>
      </div>
      <div class="thumb-strip" id="strip"></div>
      <div class="review-actions">
        ${fromScan && newDoc ? `<button class="btn ghost-dark" id="discard">Descartar escaneo</button>` : ''}
        <button class="btn primary" id="done">${fromScan ? 'Guardar' : 'Listo'}</button>
      </div>
    </div>`;
  const cv = $('#cv', root), spin = $('#spin', root), strip = $('#strip', root);
  // Ajusta la imagen al espacio disponible (completa, sin recortes), como en Anotar
  const stageEl = $('#stage', root);
  function fitView() {
    if (!cv.width || !cv.height) return;
    const sw = stageEl.clientWidth - 16, sh = stageEl.clientHeight - 16;
    if (sw <= 0 || sh <= 0) return;
    const k = Math.min(sw / cv.width, sh / cv.height);
    cv.style.width = `${Math.floor(cv.width * k)}px`;
    cv.style.height = `${Math.floor(cv.height * k)}px`;
  }
  const ro = new ResizeObserver(fitView);
  ro.observe(stageEl);

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
    fitView();
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

  // "+": directo a la cámara (dentro están la galería y el modo carnet)
  async function addMenu() {
    await persist();
    go('camera', { docId, insertAt: doc.pageIds.length, returnBack: true });
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
    if (a === 'ocr') go('ocr', { docId, pageIndex: idx });
  });

  // Menú lateral: plegado muestra Recortar, Lápiz y Texto; la flecha lo despliega con nombres
  $('#side', root).addEventListener('click', async e => {
    const a = e.target.closest('[data-s]')?.dataset.s;
    if (!a || a === 'retake' || a === 'del') return;
    const side = $('#side', root);
    if (a === 'toggle') {
      side.classList.toggle('open');
      try { localStorage.setItem('sideOpen', side.classList.contains('open') ? '1' : ''); } catch { /* */ }
      return;
    }
    if (a === 'rotate') { rotateBy(90); return; }
    await persist();
    if (a === 'crop') go('crop', { pageId: page.id });
    if (a === 'pen') go('annotate', { pageId: page.id, tool: 'pen' });
    if (a === 'text') go('annotate', { pageId: page.id, tool: 'text' });
    if (a === 'sign') go('annotate', { pageId: page.id, tool: 'sign' });
    if (a === 'highlight') go('annotate', { pageId: page.id, tool: 'highlight' });
    if (a === 'clean') go('annotate', { pageId: page.id, tool: 'whiteout' });
  });
  try { if (localStorage.getItem('sideOpen')) $('#side', root).classList.add('open'); } catch { /* */ }
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
    // Guardar: nombre (con sugerencia automática leyendo el documento) y, si se quiere, exportar
    const body = h(`<div><label class="field"><span>Nombre del documento</span><input class="input" id="nm" value="${esc(doc.name)}"></label>
      <div class="auto-name" id="an"><button class="btn small" id="anBtn">${icon('wand')}Nombre automático</button><span class="small muted" id="anMsg">Lee el documento y lo nombra (tipo, número, empresa y fecha)</span></div>
      <p class="small muted">${doc.pageIds.length} página${doc.pageIds.length === 1 ? '' : 's'}. Se guarda en este teléfono; luego puedes exportarlo cuando quieras.</p></div>`);
    const s = sheet({
      title: 'Guardar escaneo', body,
      actions: [
        { label: 'Solo guardar', value: 'save' },
        { label: 'Guardar y exportar', icon: 'download', cls: 'primary', value: 'export' },
      ],
    });
    const { suggestForDoc } = await import('../docinfo.js');
    let info = null;
    const applyInfo = r => {
      info = r;
      if (!r) { $('#anMsg', body).textContent = 'No se encontró texto para sugerir un nombre'; return; }
      $('#nm', body).value = r.name;
      $('#anMsg', body).innerHTML = `<span class="tag">${esc(r.label)}</span>${r.total ? ` Total ${esc(r.total)}` : ''}`;
    };
    // Como Google Drive: lee el documento y propone el nombre sin que pulses nada
    // (si ya escribiste uno, no se toca)
    let typed = false;
    $('#nm', body).addEventListener('input', () => { typed = true; });
    const autoName = settings.autoOcr !== false;
    if (autoName) $('#anMsg', body).textContent = 'Leyendo el documento para nombrarlo…';
    const autoP = suggestForDoc(doc, { runOcr: autoName, onProgress: (f, st) => { if (!info) $('#anMsg', body).textContent = `${st || 'Leyendo'}…`; } })
      .then(r => { if (r && !typed && (r.type !== 'documento' || autoName)) applyInfo(r); else if (!r && autoName) $('#anMsg', body).textContent = 'No se encontró texto para nombrarlo'; return r; })
      .catch(() => null);
    $('#anBtn', body).onclick = async () => {
      const b = $('#anBtn', body); b.disabled = true;
      $('#anMsg', body).textContent = 'Leyendo el documento…';
      try { typed = false; applyInfo(await suggestForDoc(doc, { onProgress: (f, st) => { $('#anMsg', body).textContent = `${st || 'Leyendo'}…`; } })); } catch (e) { $('#anMsg', body).textContent = `No se pudo leer: ${e.message}`; }
      b.disabled = false;
    };
    setTimeout(() => $('#nm', body).select(), 80);
    const nameEl = $('#nm', body);
    const v = await s.done;
    if (!v) return;
    doc.name = nameEl.value.trim().replace(/[\\<>"|?*]+/g, '') || doc.name;
    if (info) { doc.type = info.type; doc.typeLabel = info.label; doc.info = { number: info.number, date: info.date, total: info.total, ruc: info.ruc, company: info.company }; }
    await db.putDoc(doc);
    // Si se guardó antes de terminar de leer y no escribiste un nombre, se nombra al terminar
    if (!info && !typed && autoName) {
      const defaultName = doc.name;
      autoP.then(async r => {
        const d = await db.getDoc(docId);
        if (!r || !d || d.name !== defaultName) return;
        Object.assign(d, { name: r.name, type: r.type, typeLabel: r.label, info: { number: r.number, date: r.date, total: r.total, ruc: r.ruc, company: r.company } });
        await db.putDoc(d);
        toast(`Nombrado: ${r.name}`, 'ok');
      });
    }
    // Texto de todas las páginas en segundo plano: PDF buscables y búsqueda dentro de los documentos
    import('../autoocr.js').then(m => m.queueDocOcr(doc)).catch(() => {});
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
    { icon: 'share', label: 'Compartir esta página', onClick: async () => {
      await persist();
      const { ensureFullRes } = await import('../upgrader.js');
      const pr = progress('Preparando…');
      try {
        await ensureFullRes(page);
        const { finalPageCanvas, canvasToBlob } = await import('../imaging.js');
        const blob = await canvasToBlob(await finalPageCanvas(page), 'image/jpeg', 0.9);
        const { safeName, shareFiles, downloadBlob } = await import('../ui.js');
        const f = new File([blob], `${safeName(doc.name)}-p${idx + 1}.jpg`, { type: 'image/jpeg' });
        pr.close();
        if (!(await shareFiles([f], f.name))) downloadBlob(f, f.name);
      } catch (e) { pr.close(); toast(e.message, 'error'); }
    } },
    { icon: 'idcard', label: 'Guardar como contacto (tarjeta de visita)', onClick: () => saveContact() },
    { icon: 'duplicate', label: 'Duplicar página', onClick: async () => { await persist(); await duplicatePage(doc, page); doc = await db.getDoc(docId); await drawStrip(); toast('Página duplicada', 'ok'); load(idx + 1); } },
    { icon: 'download', label: 'Exportar documento…', onClick: async () => { await persist(); openExport(doc, await db.getPages(doc)); } },
    { icon: 'grid', label: 'Ver todas las páginas', onClick: async () => { await persist(); go('doc', { id: docId }, { replace: fromScan }); } },
  ]);

  // Tarjeta de visita → contacto del teléfono (.vcf)
  async function saveContact() {
    await persist();
    const pr = progress('Leyendo la tarjeta…');
    let c;
    try {
      const { recognizePage } = await import('../ocr-engine.js');
      if (!page.ocr) { page.ocr = await recognizePage(page, settings.ocrLangs, (f, st) => pr.set(f, st)); await db.putPage(page); }
      const { parseContact } = await import('../vcard.js');
      c = parseContact(page.ocr.text);
    } catch (e) { pr.close(); toast(e.message, 'error'); return; }
    pr.close();
    const f = (id, label, val, type = 'text') => `<label class="field"><span>${label}</span><input class="input" id="${id}" type="${type}" value="${esc(val || '')}"></label>`;
    const body = h(`<div>
      ${f('cName', 'Nombre', c.name)}${f('cOrg', 'Empresa', c.org)}${f('cTitle', 'Cargo', c.title)}
      ${f('cTel', 'Teléfonos (separados por coma)', c.phones.join(', '), 'tel')}${f('cMail', 'Correo', c.emails.join(', '), 'email')}
      ${f('cWeb', 'Web', c.webs.join(', '))}${f('cAdr', 'Dirección', c.address)}
      <p class="small muted">Revisa los datos leídos y corrígelos si hace falta.</p></div>`);
    const sh = sheet({ title: 'Guardar contacto', body, actions: [{ label: 'Cancelar' }, { label: 'Guardar contacto', icon: 'download', cls: 'primary', onClick: async () => {
      const g = id => $(`#${id}`, body).value.trim();
      const list = id => g(id).split(/\s*,\s*/).filter(Boolean);
      const { toVcf } = await import('../vcard.js');
      const vcf = toVcf({ name: g('cName'), org: g('cOrg'), title: g('cTitle'), phones: list('cTel'), emails: list('cMail'), webs: list('cWeb'), address: g('cAdr') });
      const { safeName, shareFiles, downloadBlob } = await import('../ui.js');
      const file = new File([vcf], `${safeName(g('cName') || g('cOrg') || 'contacto')}.vcf`, { type: 'text/vcard' });
      // Al abrir el .vcf, el teléfono ofrece añadirlo a Contactos
      if (!(await shareFiles([file], file.name))) downloadBlob(file, file.name);
      return true;
    } }] });
    await sh.done;
  }

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
  return () => { ro.disconnect(); sortable && sortable.destroy(); return persist(); };
}
