// Vista de documento: páginas, reordenar arrastrando, selección, separar, extraer y exportar.
import * as db from '../db.js';
import { icon } from '../icons.js';
import { h, $, $$, fmtDate, toast, sheet, confirmDlg, promptDlg, menu, progress, pickFiles } from '../ui.js';
import { blobUrl, renderPage } from '../imaging.js';
import { importFiles, pagesToNewDoc, removePagesFromDoc } from '../pages.js';
import { makeSortable } from '../sortable.js';
import { openExport } from '../export-sheet.js';
import { parseRanges, chunk } from '../ranges.js';
import { go } from '../nav.js';

export async function render(root, { id }) {
  let doc = await db.getDoc(id);
  if (!doc) { go('home', {}, { replace: true }); return; }
  let pages = await db.getPages(doc);
  let selecting = false;
  const selected = new Set();

  root.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" id="back" aria-label="Volver">${icon('back')}</button>
      <button class="title-btn" id="title" title="Renombrar"></button>
      <button class="icon-btn" id="sel" aria-label="Seleccionar">${icon('select')}</button>
      <button class="icon-btn" id="ocr" aria-label="Texto (OCR)">${icon('ocr')}</button>
      <button class="icon-btn" id="more" aria-label="Más">${icon('more')}</button>
    </header>
    <div class="doc-view">
      <div class="doc-info" id="info"></div>
      <div class="page-grid" id="grid"></div>
    </div>
    <div class="bottom-actions" id="actions">
      <button class="btn" id="add">${icon('camera')}Añadir</button>
      <button class="btn primary" id="export">${icon('download')}Exportar</button>
    </div>
    <div class="selbar" id="selbar" hidden>
      <button id="sRot">${icon('rotateR')}Girar</button>
      <button id="sExt">${icon('scissors')}Extraer</button>
      <button id="sExp">${icon('download')}Exportar</button>
      <button id="sDel" class="danger">${icon('trash')}Eliminar</button>
      <button id="sDone">${icon('check')}Listo</button>
    </div>`;

  const grid = $('#grid', root);

  function draw() {
    $('#title', root).textContent = doc.name;
    $('#info', root).innerHTML = `<span>${pages.length} página${pages.length === 1 ? '' : 's'}</span>·<span>${fmtDate(doc.updated)}</span>
      ${pages.length > 1 ? `·<span>${selecting ? 'Toca para seleccionar' : 'Mantén pulsada una página y arrástrala para reordenar'}</span>` : ''}`;
    grid.classList.toggle('selecting', selecting);
    grid.innerHTML = '';
    pages.forEach((p, i) => {
      const tags = [];
      if (p.ocr) tags.push('<span class="tag" title="Texto reconocido">OCR</span>');
      if (p.annotations?.length) tags.push('<span class="tag" title="Con anotaciones">✎</span>');
      const card = h(`<div class="page-card ${selected.has(p.id) ? 'sel' : ''}" data-id="${p.id}" role="button" tabindex="0" aria-label="Página ${i + 1}">
        <span class="check">${icon('check')}</span>
        <div class="pthumb"><img src="${blobUrl(p.thumb)}" alt="" draggable="false"></div>
        <div class="pnum"><span>${i + 1}</span><span class="tags">${tags.join('')}</span></div></div>`);
      card.onclick = () => {
        if (selecting) { toggle(p.id); return; }
        go('editor', { docId: doc.id, index: pages.indexOf(p) });
      };
      card.onkeydown = e => { if (e.key === 'Enter') card.click(); };
      grid.append(card);
    });
    const add = h(`<button class="page-card add">${icon('plus')}<span>Añadir páginas</span></button>`);
    add.onclick = addPagesMenu;
    if (!selecting) grid.append(add);
    $('#selbar', root).hidden = !selecting;
    $('#actions', root).hidden = selecting;
    $('#sel', root).classList.toggle('on', selecting);
    updateSel();
  }

  function toggle(pid) {
    if (selected.has(pid)) selected.delete(pid); else selected.add(pid);
    $$('.page-card[data-id]', grid).forEach(c => c.classList.toggle('sel', selected.has(c.dataset.id)));
    updateSel();
  }
  function updateSel() {
    ['sRot', 'sExt', 'sExp', 'sDel'].forEach(k => { $(`#${k}`, root).disabled = !selected.size; });
  }
  const selPages = () => pages.filter(p => selected.has(p.id));
  function setSelecting(on) { selecting = on; selected.clear(); draw(); }

  const sortable = makeSortable(grid, {
    enabled: () => !selecting,
    onEnd: async order => {
      doc.pageIds = order;
      pages = order.map(oid => pages.find(p => p.id === oid));
      await db.putDoc(doc);
      draw();
    },
  });

  async function reload() { doc = await db.getDoc(id); pages = await db.getPages(doc); draw(); }

  function addPagesMenu() {
    menu([
      { icon: 'camera', label: 'Escanear con la cámara', onClick: () => go('camera', { docId: doc.id }) },
      { icon: 'idcard', label: 'Escanear carnet (2 caras)', onClick: () => go('camera', { docId: doc.id, mode: 'id' }) },
      { icon: 'upload', label: 'Importar fotos o PDF', onClick: async () => {
        const files = await pickFiles({ accept: 'image/*,application/pdf' });
        if (!files.length) return;
        const pr = progress('Importando…');
        try { await importFiles(doc, files, pr); } catch (e) { toast(e.message, 'error'); }
        pr.close(); reload();
      } },
    ]);
  }

  async function rename() {
    const n = await promptDlg('Nombre del documento', doc.name);
    if (n && n.trim()) { doc.name = n.trim(); await db.putDoc(doc); draw(); }
  }

  async function splitDoc() {
    if (pages.length < 2) { toast('Necesitas al menos 2 páginas'); return; }
    const body = h(`<div>
      <div class="chips" id="mode" style="margin-bottom:12px">
        <button class="chip on" data-v="each">Cada página</button>
        <button class="chip" data-v="n">Cada N páginas</button>
        <button class="chip" data-v="ranges">Por rangos</button>
      </div>
      <div id="nRow" hidden><label class="field"><span>Páginas por documento</span><input class="input" type="number" id="n" min="1" max="${pages.length}" value="2"></label></div>
      <div id="rRow" hidden><label class="field"><span>Rangos (cada uno será un documento)</span><input class="input" id="r" placeholder="1-3, 4-6, 7"></label></div>
      <p class="small muted">Se crean documentos nuevos; el original no se modifica.</p></div>`);
    let mode = 'each';
    $$('#mode .chip', body).forEach(c => c.onclick = () => {
      mode = c.dataset.v;
      $$('#mode .chip', body).forEach(x => x.classList.toggle('on', x === c));
      $('#nRow', body).hidden = mode !== 'n'; $('#rRow', body).hidden = mode !== 'ranges';
    });
    const s = sheet({
      title: 'Separar documento', body, actions: [{ label: 'Cancelar' }, { label: 'Separar', cls: 'primary', onClick: async () => {
        let groups;
        try {
          groups = mode === 'each' ? chunk(pages.length, 1) : mode === 'n' ? chunk(pages.length, Math.max(1, +$('#n', body).value || 1)) : parseRanges($('#r', body).value, pages.length);
        } catch (e) { toast(e.message, 'error'); return false; }
        const pr = progress('Separando…');
        for (let g = 0; g < groups.length; g++) {
          pr.set(g / groups.length);
          const first = groups[g][0] + 1, last = groups[g][groups[g].length - 1] + 1;
          await pagesToNewDoc(groups[g].map(i => pages[i]), `${doc.name} (${first === last ? `pág. ${first}` : `págs. ${first}-${last}`})`);
        }
        pr.close();
        toast(`Creados ${groups.length} documentos`, 'ok');
        return true;
      } }],
    });
    if (await s.done) go('home', {});
  }

  async function ocrAll() { go('ocr', { docId: doc.id, all: true }); }

  // ---------- Eventos ----------
  $('#back', root).onclick = () => go('home', {});
  $('#title', root).onclick = rename;
  $('#sel', root).onclick = () => setSelecting(!selecting);
  $('#sDone', root).onclick = () => setSelecting(false);
  $('#ocr', root).onclick = () => go('ocr', { docId: doc.id });
  $('#add', root).onclick = addPagesMenu;
  $('#export', root).onclick = () => { if (!pages.length) return toast('El documento no tiene páginas'); openExport(doc, pages).then(reload); };
  $('#sExp', root).onclick = () => openExport({ ...doc, name: `${doc.name} (selección)` }, selPages());
  $('#sExt', root).onclick = async () => {
    const sp = selPages();
    const nd = await pagesToNewDoc(sp, `${doc.name} (extracto)`);
    toast(`${sp.length} página(s) extraídas a un documento nuevo`, 'ok');
    setSelecting(false);
    go('doc', { id: nd.id });
  };
  $('#sDel', root).onclick = async () => {
    if (!(await confirmDlg(`¿Eliminar ${selected.size} página(s)?`, 'Eliminar', true))) return;
    await removePagesFromDoc(doc, [...selected]);
    selecting = false; selected.clear();
    await reload();
  };
  $('#sRot', root).onclick = async () => {
    const pr = progress('Girando…');
    const sp = selPages();
    for (let i = 0; i < sp.length; i++) {
      pr.set(i / sp.length);
      sp[i].rotation = ((sp[i].rotation || 0) + 90) % 360;
      // Las anotaciones usan coordenadas de la página: se giran con ella. El OCR deja de valer.
      if (sp[i].annotations?.length) sp[i].annotations = rotateAnnotations(sp[i].annotations);
      if (sp[i].ocr) sp[i].ocr = null;
      await renderPage(sp[i]);
      await db.putPage(sp[i]);
    }
    await db.putDoc(doc);
    pr.close();
    const keep = new Set(selected);
    await reload();
    keep.forEach(k => selected.add(k)); draw();
  };
  $('#more', root).onclick = () => menu([
    { icon: 'pen', label: 'Renombrar', onClick: rename },
    { icon: 'ocr', label: 'Reconocer texto de todo (OCR)', onClick: ocrAll },
    { icon: 'scissors', label: 'Separar en varios documentos', onClick: splitDoc },
    { icon: 'duplicate', label: 'Duplicar documento', onClick: async () => { const nd = await pagesToNewDoc(pages, `${doc.name} (copia)`); toast('Documento duplicado', 'ok'); go('doc', { id: nd.id }); } },
    { icon: 'share', label: 'Compartir…', onClick: () => openExport(doc, pages, { shareFirst: true }) },
    '-',
    { icon: 'trash', label: 'Eliminar documento', danger: true, onClick: async () => {
      if (!(await confirmDlg(`¿Eliminar “${doc.name}”? No se puede deshacer.`, 'Eliminar', true))) return;
      await db.deleteDoc(doc.id);
      toast('Documento eliminado');
      go('home', {}, { replace: true });
    } },
  ]);

  draw();
  return () => sortable.destroy();
}

// Gira 90° en sentido horario las coordenadas normalizadas de las anotaciones
function rotateAnnotations(anns) {
  const rp = ([x, y]) => [1 - y, x];
  return anns.map(a => {
    if (a.type === 'path') return { ...a, points: a.points.map(rp) };
    if (a.type === 'rect' || a.type === 'image') {
      // la caja (x,y,w,h) pasa a (1-y-h, x, h, w)
      return { ...a, x: 1 - a.y - a.h, y: a.x, w: a.h, h: a.w };
    }
    if (a.type === 'text') { const [x, y] = rp([a.x, a.y]); return { ...a, x: Math.max(0, x - 0.05), y }; }
    return a;
  });
}

