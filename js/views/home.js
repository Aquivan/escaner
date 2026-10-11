// Pantalla de inicio: documentos, búsqueda (también dentro del texto OCR) y accesos rápidos.
import * as db from '../db.js';
import { icon } from '../icons.js';
import { h, $, $$, esc, fmtDate, fmtBytes, toast, sheet, confirmDlg, pickFiles, progress, promptDlg, downloadBlob, shareFiles } from '../ui.js';
import { blobUrl } from '../imaging.js';
import { importFiles, pagesToNewDoc } from '../pages.js';
import { settings, save } from '../settings.js';
import { go } from '../nav.js';

const FILTER_NAMES = { original: 'Original', auto: 'Color mejorado', clean: 'Documento limpio', gray: 'Escala de grises', bw: 'Blanco y negro', board: 'Pizarra', photo: 'Foto' };

export async function render(root) {
  root.innerHTML = `
    <header class="topbar">
      <div class="brand"><img src="icons/icon.svg" alt=""><h1>EscánerPro</h1></div>
      <button class="icon-btn" id="selBtn" aria-label="Seleccionar">${icon('select')}</button>
      <button class="icon-btn" id="setBtn" aria-label="Ajustes">${icon('settings')}</button>
    </header>
    <div class="home">
      <div class="search">${icon('search')}<input class="input" id="q" type="search" placeholder="Buscar en nombres y en el texto de los documentos" autocomplete="off"></div>
      <div class="quick">
        <button id="qScan">${icon('camera')}Escanear</button>
        <button id="qImport">${icon('upload')}Importar fotos o PDF</button>
        <button id="qId">${icon('idcard')}Carnet / DNI</button>
        <button id="qTools">${icon('tools')}Herramientas PDF</button>
      </div>
      <div class="section-title"><h2>Mis documentos</h2><span class="muted small" id="count"></span></div>
      <div class="doc-list" id="list"></div>
    </div>
    <button class="fab" id="fab">${icon('camera')}<span>Escanear</span></button>
    <div class="selbar" id="selbar" hidden>
      <button id="sCancel">${icon('x')}Cancelar</button>
      <button id="sMerge">${icon('merge')}Unir</button>
      <button id="sDup">${icon('duplicate')}Duplicar</button>
      <button id="sDel" class="danger">${icon('trash')}Eliminar</button>
    </div>`;

  let docs = await db.getDocs();
  let pageText = null; // id doc -> texto OCR (carga perezosa para buscar)
  let selecting = false;
  const selected = new Set();
  const list = $('#list', root);

  async function ensureText() {
    if (pageText) return;
    pageText = {};
    for (const p of await db.getAllPages()) if (p.ocr && p.ocr.text) pageText[p.docId] = (pageText[p.docId] || '') + ' ' + p.ocr.text;
  }

  function snippet(text, q) {
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return '';
    const s = Math.max(0, i - 40);
    const part = text.slice(s, i + q.length + 60).replace(/\s+/g, ' ');
    const k = part.toLowerCase().indexOf(q);
    return (s ? '…' : '') + esc(part.slice(0, k)) + '<mark>' + esc(part.slice(k, k + q.length)) + '</mark>' + esc(part.slice(k + q.length)) + '…';
  }

  async function draw() {
    const q = $('#q', root).value.trim().toLowerCase();
    let shown = docs;
    const snips = {};
    if (q) {
      await ensureText();
      shown = docs.filter(d => {
        if (d.name.toLowerCase().includes(q) || (d.typeLabel || '').toLowerCase().includes(q)) return true;
        const t = pageText[d.id];
        if (t && t.toLowerCase().includes(q)) { snips[d.id] = snippet(t, q); return true; }
        return false;
      });
    }
    $('#count', root).textContent = docs.length ? `${docs.length} documento${docs.length > 1 ? 's' : ''}` : '';
    list.classList.toggle('selecting', selecting);
    if (!docs.length) {
      list.innerHTML = `<div class="empty" style="grid-column:1/-1">${icon('scan')}<h3>Aún no hay documentos</h3>
        <p>Pulsa <b>Escanear</b> para usar la cámara o <b>Importar</b> para añadir fotos o PDFs.</p>
        <p class="small">Todo se guarda solo en este dispositivo.</p></div>`;
      return;
    }
    if (!shown.length) { list.innerHTML = `<div class="empty" style="grid-column:1/-1"><p>Sin resultados para “${esc(q)}”.</p></div>`; return; }
    list.innerHTML = '';
    for (const d of shown) {
      const card = h(`<button class="doc-card ${selected.has(d.id) ? 'sel' : ''}" data-id="${d.id}">
        <div class="thumb">${icon('file')}</div>
        <span class="badge">${d.pageIds.length} pág.</span>
        <span class="check">${icon('check')}</span>
        <div class="meta"><div class="name">${esc(d.name)}</div><div class="sub">${d.typeLabel ? `<span class="tag">${esc(d.typeLabel)}</span> ` : ''}${fmtDate(d.updated)}</div>
        ${snips[d.id] ? `<div class="snippet">${snips[d.id]}</div>` : ''}</div></button>`);
      list.append(card);
      if (d.pageIds[0]) db.getPage(d.pageIds[0]).then(p => { if (p && p.thumb) $('.thumb', card).innerHTML = `<img src="${blobUrl(p.thumb)}" alt="">`; });
      let lp;
      card.addEventListener('pointerdown', () => { lp = setTimeout(() => { lp = 'fired'; if (!selecting) setSelecting(true); toggle(d.id); }, 550); });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => card.addEventListener(ev, () => { if (lp !== 'fired') clearTimeout(lp); }));
      card.addEventListener('click', () => {
        if (lp === 'fired') { lp = null; return; }
        if (selecting) toggle(d.id); else go('doc', { id: d.id });
      });
      card.addEventListener('contextmenu', e => e.preventDefault());
    }
  }

  function toggle(id) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    $$('.doc-card', list).forEach(c => c.classList.toggle('sel', selected.has(c.dataset.id)));
    updateSelBar();
  }

  function updateSelBar() {
    $('#sMerge', root).disabled = selected.size < 2;
    $('#sDup', root).disabled = selected.size !== 1;
    $('#sDel', root).disabled = !selected.size;
  }

  function setSelecting(on) {
    selecting = on; selected.clear();
    $('#selbar', root).hidden = !on;
    $('#fab', root).hidden = on;
    $('#selBtn', root).classList.toggle('on', on);
    updateSelBar();
    draw();
  }

  async function refresh() { docs = await db.getDocs(); pageText = null; draw(); }

  $('#q', root).addEventListener('input', () => draw());
  $('#selBtn', root).onclick = () => setSelecting(!selecting);
  $('#sCancel', root).onclick = () => setSelecting(false);
  $('#sDel', root).onclick = async () => {
    if (!(await confirmDlg(`¿Eliminar ${selected.size} documento(s)? No se puede deshacer.`, 'Eliminar', true))) return;
    for (const id of selected) await db.deleteDoc(id);
    toast('Documentos eliminados');
    setSelecting(false); refresh();
  };
  $('#sDup', root).onclick = async () => {
    const d = await db.getDoc([...selected][0]);
    await pagesToNewDoc(await db.getPages(d), `${d.name} (copia)`);
    toast('Documento duplicado', 'ok');
    setSelecting(false); refresh();
  };
  $('#sMerge', root).onclick = async () => {
    // Respeta el orden en que aparecen en la lista
    const ids = docs.map(d => d.id).filter(id => selected.has(id)).reverse();
    const name = await promptDlg('Nombre del documento unido', 'Documento unido');
    if (name == null) return;
    const all = [];
    for (const id of ids) all.push(...await db.getPages(await db.getDoc(id)));
    const nd = await pagesToNewDoc(all, name || 'Documento unido');
    toast(`Unidos ${ids.length} documentos (${all.length} páginas)`, 'ok');
    setSelecting(false);
    go('doc', { id: nd.id });
  };

  const scan = () => go('camera', {});
  $('#fab', root).onclick = scan;
  $('#qScan', root).onclick = scan;
  $('#qId', root).onclick = () => go('camera', { mode: 'id' });
  $('#qTools', root).onclick = () => go('pdftools', {});
  $('#qImport', root).onclick = async () => {
    const files = await pickFiles({ accept: 'image/*,application/pdf' });
    if (!files.length) return;
    const pr = progress('Importando…');
    try {
      const doc = await db.newDoc(files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') : undefined);
      const pages = await importFiles(doc, files, pr);
      pr.close();
      if (!pages.length) { await db.deleteDoc(doc.id); toast('No se encontraron imágenes ni PDFs válidos', 'error'); return; }
      go('doc', { id: doc.id });
    } catch (e) { pr.close(); console.error(e); toast(`Error al importar: ${e.message}`, 'error'); }
  };
  $('#setBtn', root).onclick = () => openSettings(refresh);

  // Soltar archivos sobre la ventana (escritorio)
  const onDrop = async e => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    const pr = progress('Importando…');
    try {
      const doc = await db.newDoc();
      await importFiles(doc, files, pr);
      pr.close(); go('doc', { id: doc.id });
    } catch (err) { pr.close(); toast(err.message, 'error'); }
  };
  const onOver = e => e.preventDefault();
  window.addEventListener('drop', onDrop);
  window.addEventListener('dragover', onOver);

  draw();
  return () => { window.removeEventListener('drop', onDrop); window.removeEventListener('dragover', onOver); };
}

async function openSettings(onChange) {
  const est = await db.storageEstimate();
  const f = settings.defaultFilter.preset || 'auto';
  const body = h(`<div>
    <label class="field"><span>Tema</span>
      <div class="chips" id="theme">
        ${[['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro']].map(([k, l]) => `<button class="chip ${settings.theme === k ? 'on' : ''}" data-v="${k}">${l}</button>`).join('')}
      </div></label>
    <label class="field"><span>Filtro por defecto al escanear</span>
      <select class="input" id="defF">${Object.entries(FILTER_NAMES).map(([k, l]) => `<option value="${k}" ${k === f ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="switch"><span class="sw-text">Captura automática<small>Dispara sola cuando el documento está quieto y bien encuadrado</small></span><input type="checkbox" id="auto" ${settings.autoCapture ? 'checked' : ''}></label>
    <label class="switch"><span class="sw-text">Revisar recorte tras cada foto<small>Si está apagado, solo se abre cuando no se detectan bordes</small></span><input type="checkbox" id="rev" ${settings.reviewCapture ? 'checked' : ''}></label>
    <label class="switch"><span class="sw-text">Detectar bordes al importar fotos<small>Útil para fotos de papeles; apágalo para capturas de pantalla</small></span><input type="checkbox" id="det" ${settings.detectOnImport !== false ? 'checked' : ''}></label>
    <div class="field-label" style="margin-top:14px">Copia de seguridad</div>
    <p class="small muted" style="margin:4px 0 8px">Guarda todos tus documentos en un archivo (por ejemplo en Google Drive) para no perderlos si cambias de teléfono o borras el navegador.</p>
    <div class="row wrap">
      <button class="btn small" id="bkShare">${icon('share')}Guardar en Drive / compartir</button>
      <button class="btn small" id="bkDown">${icon('download')}Descargar copia</button>
      <button class="btn small" id="bkRestore">${icon('upload')}Restaurar copia</button>
    </div>
    <p class="small muted" style="margin-top:12px">${icon('info')} Tus documentos se guardan solo en este dispositivo${est ? ` · Espacio usado: ${fmtBytes(est.usage)}` : ''}.</p>
  </div>`);
  const s = sheet({ title: 'Ajustes', body });
  $$('#theme .chip', body).forEach(b => b.onclick = async () => {
    $$('#theme .chip', body).forEach(x => x.classList.toggle('on', x === b));
    await save('theme', b.dataset.v);
  });
  $('#defF', body).onchange = e => save('defaultFilter', { preset: e.target.value });
  $('#auto', body).onchange = e => save('autoCapture', e.target.checked);
  $('#rev', body).onchange = e => save('reviewCapture', e.target.checked);
  $('#det', body).onchange = e => save('detectOnImport', e.target.checked);
  const makeBackup = async () => {
    const pr = progress('Creando copia de seguridad…');
    try { const { createBackup } = await import('../backup.js'); const f = await createBackup(x => pr.set(x)); pr.close(); return f; } catch (e) { pr.close(); toast(e.message, 'error'); return null; }
  };
  $('#bkDown', body).onclick = async () => { const f = await makeBackup(); if (f) { downloadBlob(f, f.name); toast(`Copia creada (${fmtBytes(f.size)})`, 'ok'); } };
  $('#bkShare', body).onclick = async () => {
    const f = await makeBackup(); if (!f) return;
    // En Android, el menú de compartir incluye "Guardar en Drive"
    if (!(await shareFiles([f], f.name))) { downloadBlob(f, f.name); toast('Compartir no está disponible; se descargó la copia'); }
  };
  $('#bkRestore', body).onclick = async () => {
    const files = await pickFiles({ accept: '.zip,application/zip', multiple: false });
    if (!files.length) return;
    const pr = progress('Restaurando…');
    try {
      const { restoreBackup } = await import('../backup.js');
      const r = await restoreBackup(files[0], x => pr.set(x));
      pr.close(); s.close();
      toast(`Restaurados ${r.docs} documentos (${r.pages} páginas)`, 'ok');
    } catch (e) { pr.close(); toast(e.message, 'error'); }
  };
  await s.done;
  onChange && onChange();
}

