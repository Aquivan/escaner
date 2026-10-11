// Herramientas PDF: unir, separar, extraer, organizar (girar/borrar/ordenar), comprimir,
// PDF a imágenes e importar al escáner. Trabaja con PDFs externos sin perder calidad
// salvo en "Comprimir" y "A imágenes".
import * as db from '../db.js';
import { icon } from '../icons.js';
import { h, $, $$, esc, toast, sheet, progress, pickFiles, downloadBlob, shareFiles, fmtBytes, safeName, promptDlg } from '../ui.js';
import { loadPdfJs, loadPdfLib } from '../loader.js';
import { makeCanvas, canvasToBlob } from '../imaging.js';
import { makeSortable } from '../sortable.js';
import { zipFiles, QUALITY_PRESETS } from '../exporter.js';
import { parseRanges, chunk } from '../ranges.js';
import { importFiles } from '../pages.js';
import { go, back } from '../nav.js';

const SRC_COLORS = ['#0f766e', '#7c3aed', '#db2777', '#ea580c', '#2563eb', '#65a30d', '#0891b2', '#b45309'];

const TOOL_INFO = {
  merge: ['merge', 'Unir PDFs', 'Combina varios PDFs en uno y ordena sus páginas'],
  split: ['scissors', 'Separar PDF', 'Divide por páginas, cada N páginas o por rangos'],
  extract: ['select', 'Extraer páginas', 'Elige páginas y guárdalas en un PDF nuevo'],
  organize: ['grid', 'Organizar', 'Reordena, gira o elimina páginas'],
  compress: ['compress', 'Comprimir PDF', 'Reduce el peso con niveles y peso estimado'],
  images: ['image', 'PDF a imágenes', 'Convierte cada página en JPG'],
  edit: ['pen', 'Editar en el escáner', 'Aplica filtros, OCR, firma y anotaciones'],
  protect: ['stamp', 'Proteger con contraseña', 'Cifra el PDF (AES-256) para que pida contraseña'],
  unlock: ['select', 'Quitar contraseña', 'Guarda una copia sin contraseña (debes conocerla)'],
};

export async function render(root, params) {
  let mode = params.mode || null;
  const sources = []; // {name, size, bytes:Uint8Array, pdfjs, color}
  let items = [];     // {id, src, index, rot}
  let selecting = false;
  const selected = new Set();
  let sortable = null;
  let thumbObs = null;

  function drawHome() {
    mode = null;
    root.innerHTML = `
      <header class="topbar"><button class="icon-btn" id="back" aria-label="Volver">${icon('back')}</button><h1>Herramientas PDF</h1></header>
      <div class="tools-view">
        <div class="tool-grid">${Object.entries(TOOL_INFO).map(([k, [ic, t, d]]) => `<button class="tool-card" data-k="${k}">${icon(ic)}<b>${t}</b><span>${d}</span></button>`).join('')}</div>
        <p class="small muted">${icon('info')} Los PDFs se procesan en tu dispositivo; no se suben a ningún servidor.</p>
      </div>`;
    $('#back', root).onclick = () => back();
    $$('.tool-card', root).forEach(b => b.onclick = () => start(b.dataset.k));
  }

  async function start(k) {
    const files = await pickFiles({ accept: 'application/pdf', multiple: k === 'merge' || k === 'organize' });
    if (!files.length) return;
    if (!files.length) return;
    if (k === 'edit') {
      const pr = progress('Importando PDF…');
      try {
        const doc = await db.newDoc(files[0].name.replace(/\.pdf$/i, ''));
        await importFiles(doc, files, pr);
        pr.close(); go('doc', { id: doc.id }, { replace: true });
      } catch (e) { pr.close(); toast(e.message, 'error'); }
      return;
    }
    if (k === 'protect' || k === 'unlock') {
      const f = files[0];
      const pw = await promptDlg(k === 'protect' ? 'Contraseña para abrir el PDF' : 'Contraseña actual del PDF', '', { placeholder: 'Contraseña' });
      if (!pw) return;
      const pr = progress(k === 'protect' ? 'Cifrando…' : 'Quitando contraseña…');
      try {
        const { encryptPdf, decryptPdf } = await import('../exporter.js');
        const src = new Uint8Array(await f.arrayBuffer());
        const bytes = k === 'protect' ? await encryptPdf(src, pw) : await decryptPdf(src, pw);
        pr.close();
        const base = safeName(f.name.replace(/\.pdf$/i, ''));
        await deliver([new File([bytes], `${base}${k === 'protect' ? '-protegido' : '-sin-clave'}.pdf`, { type: 'application/pdf' })]);
      } catch (e) {
        pr.close(); console.warn(e);
        toast(k === 'unlock' && /password|decrypt|crypt/i.test(String(e.message)) ? 'Contraseña incorrecta' : `Error: ${e.message}`, 'error');
      }
      return;
    }
    mode = k;
    await addFiles(files);
  }

  async function addFiles(files) {
    const pdfjs = await loadPdfJs();
    const pr = progress('Abriendo PDF…');
    try {
      for (const f of files) {
        pr.set(null, f.name);
        const bytes = new Uint8Array(await f.arrayBuffer());
        let doc;
        try {
          doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
        } catch (e) {
          toast(e.name === 'PasswordException' ? `“${f.name}” está protegido con contraseña` : `No se pudo abrir “${f.name}”`, 'error');
          continue;
        }
        const si = sources.length;
        sources.push({ name: f.name, size: f.size, bytes, pdfjs: doc, color: SRC_COLORS[si % SRC_COLORS.length] });
        for (let i = 0; i < doc.numPages; i++) items.push({ id: `${si}-${i}`, src: si, index: i, rot: 0 });
      }
    } finally { pr.close(); }
    if (!sources.length) { drawHome(); return; }
    drawWorkspace();
  }

  function drawWorkspace() {
    const [, title] = TOOL_INFO[mode];
    const total = sources.reduce((s, x) => s + x.size, 0);
    if (sortable) sortable.destroy();
    if (thumbObs) thumbObs.disconnect();
    const actions = {
      merge: `<button class="btn" id="addMore">${icon('plus')}Añadir PDF</button><button class="btn primary" id="go">${icon('merge')}Unir y guardar</button>`,
      organize: `<button class="btn" id="addMore">${icon('plus')}Añadir PDF</button><button class="btn primary" id="go">${icon('download')}Guardar PDF</button>`,
      split: `<button class="btn primary" id="go">${icon('scissors')}Separar…</button>`,
      extract: `<button class="btn primary" id="go" disabled>${icon('select')}Extraer selección</button>`,
      compress: `<button class="btn primary" id="go">${icon('compress')}Comprimir…</button>`,
      images: `<button class="btn primary" id="go">${icon('image')}Convertir…</button>`,
    }[mode];
    root.innerHTML = `
      <header class="topbar">
        <button class="icon-btn" id="back" aria-label="Volver">${icon('back')}</button>
        <h1>${title}</h1>
        ${mode !== 'extract' ? `<button class="icon-btn" id="sel" aria-label="Seleccionar">${icon('select')}</button>` : ''}
      </header>
      <div class="tools-view">
        <div class="row wrap" style="margin-bottom:12px">${sources.map(s => `<span class="file-pill"><i style="background:${s.color}"></i>${esc(s.name)} · ${s.pdfjs.numPages} pág. · ${fmtBytes(s.size)}</span>`).join('')}</div>
        <p class="small muted" id="hint">${mode === 'extract' ? 'Toca las páginas que quieres extraer.' : 'Mantén pulsada una página y arrástrala para reordenar. Usa “Seleccionar” para girar o eliminar.'} ${items.length} páginas · ${fmtBytes(total)}</p>
        <div class="page-grid" id="grid"></div>
      </div>
      <div class="bottom-actions" id="acts">${actions}</div>
      <div class="selbar" id="selbar" hidden>
        <button id="sAll">${icon('select')}Todas</button>
        <button id="sRotL">${icon('rotateL')}Izq.</button>
        <button id="sRotR">${icon('rotateR')}Der.</button>
        <button id="sDel" class="danger">${icon('trash')}Quitar</button>
        <button id="sDone">${icon('check')}Listo</button>
      </div>`;
    if (mode === 'extract') selecting = true;
    const grid = $('#grid', root);
    thumbObs = new IntersectionObserver(ents => ents.forEach(en => { if (en.isIntersecting) { thumbObs.unobserve(en.target); renderThumb(en.target); } }), { rootMargin: '300px' });
    for (const it of items) {
      const src = sources[it.src];
      const card = h(`<div class="page-card ${selected.has(it.id) ? 'sel' : ''}" data-id="${it.id}">
        <span class="check">${icon('check')}</span>
        <div class="pthumb"><canvas class="pdfthumb"></canvas></div>
        ${it.rot ? `<span class="rot-badge">${it.rot}°</span>` : ''}
        ${sources.length > 1 ? `<span class="src-dot" style="background:${src.color}"></span>` : ''}
        <div class="pnum"><span>${items.indexOf(it) + 1}</span><span class="small">${sources.length > 1 ? `p.${it.index + 1}` : ''}</span></div></div>`);
      card.onclick = () => { if (selecting) toggle(it.id); };
      grid.append(card);
      thumbObs.observe(card);
    }
    grid.classList.toggle('selecting', selecting);
    sortable = makeSortable(grid, {
      enabled: () => !selecting || mode === 'extract',
      onEnd: order => { items = order.map(id => items.find(i => i.id === id)); drawWorkspace(); },
    });
    $('#selbar', root).hidden = !selecting || mode === 'extract';
    $('#acts', root).hidden = selecting && mode !== 'extract';
    $('#back', root).onclick = () => { if (selecting && mode !== 'extract') { setSel(false); return; } reset(); drawHome(); };
    if ($('#sel', root)) $('#sel', root).onclick = () => setSel(!selecting);
    if ($('#addMore', root)) $('#addMore', root).onclick = async () => { const f = await pickFiles({ accept: 'application/pdf' }); if (f.length) addFiles(f); };
    $('#sDone', root).onclick = () => setSel(false);
    $('#sAll', root).onclick = () => { items.forEach(i => selected.add(i.id)); refreshSel(); };
    $('#sRotL', root).onclick = () => { items.forEach(i => { if (selected.has(i.id)) i.rot = (i.rot + 270) % 360; }); drawWorkspace(); };
    $('#sRotR', root).onclick = () => { items.forEach(i => { if (selected.has(i.id)) i.rot = (i.rot + 90) % 360; }); drawWorkspace(); };
    $('#sDel', root).onclick = () => { items = items.filter(i => !selected.has(i.id)); selected.clear(); if (!items.length) { reset(); drawHome(); return; } drawWorkspace(); };
    $('#go', root).onclick = () => ({ merge: saveAll, organize: saveAll, split: splitDlg, extract: extractSel, compress: compressDlg, images: imagesDlg })[mode]();
    refreshSel();
  }

  async function renderThumb(card) {
    const it = items.find(i => i.id === card.dataset.id);
    if (!it) return;
    try {
      const page = await sources[it.src].pdfjs.getPage(it.index + 1);
      const vp0 = page.getViewport({ scale: 1, rotation: (page.rotate + it.rot) % 360 });
      const scale = 260 / Math.max(vp0.width, vp0.height);
      const vp = page.getViewport({ scale, rotation: (page.rotate + it.rot) % 360 });
      const c = $('canvas', card);
      c.width = vp.width; c.height = vp.height;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    } catch (e) { console.warn(e); }
  }

  function toggle(id) { if (selected.has(id)) selected.delete(id); else selected.add(id); refreshSel(); }
  function refreshSel() {
    $$('.page-card[data-id]', root).forEach(c => c.classList.toggle('sel', selected.has(c.dataset.id)));
    ['sRotL', 'sRotR', 'sDel'].forEach(k => { const b = $(`#${k}`, root); if (b) b.disabled = !selected.size; });
    if (mode === 'extract') { const g = $('#go', root); g.disabled = !selected.size; g.lastChild.textContent = selected.size ? `Extraer ${selected.size} página(s)` : 'Extraer selección'; }
  }
  function setSel(on) { selecting = on; selected.clear(); drawWorkspace(); }
  function reset() { sources.forEach(s => s.pdfjs.destroy()); sources.length = 0; items = []; selected.clear(); selecting = false; }

  const baseName = () => safeName(sources[0]?.name.replace(/\.pdf$/i, '') || 'documento');

  // Construye un PDF sin pérdida a partir de una lista de elementos (copia de páginas)
  async function buildLossless(list, pr) {
    const PDFLib = await loadPdfLib();
    const out = await PDFLib.PDFDocument.create();
    const loaded = {};
    for (let k = 0; k < list.length; k++) {
      const it = list[k];
      pr && pr.set(k / list.length, `Página ${k + 1} de ${list.length}`);
      if (!loaded[it.src]) loaded[it.src] = await PDFLib.PDFDocument.load(sources[it.src].bytes, { ignoreEncryption: true });
      const [p] = await out.copyPages(loaded[it.src], [it.index]);
      if (it.rot) p.setRotation(PDFLib.degrees((p.getRotation().angle + it.rot) % 360));
      out.addPage(p);
    }
    out.setProducer('EscánerPro (pdf-lib)'); out.setCreator('EscánerPro');
    return out.save({ useObjectStreams: true });
  }

  async function deliver(files, zipName) {
    const canShare = navigator.canShare && navigator.canShare({ files });
    const s = sheet({
      title: 'Archivo listo', cls: 'dialog',
      body: `<p>${files.length === 1 ? esc(files[0].name) : `${files.length} archivos`} · <b>${fmtBytes(files.reduce((a, f) => a + f.size, 0))}</b></p>`,
      actions: [
        ...(canShare ? [{ label: 'Compartir', icon: 'share', onClick: async () => { await shareFiles(files, files[0].name); } }] : []),
        { label: files.length > 1 ? 'Descargar ZIP' : 'Descargar', icon: 'download', cls: 'primary', onClick: async () => {
          if (files.length === 1) downloadBlob(files[0], files[0].name); else downloadBlob(await zipFiles(files), zipName);
        } },
      ],
    });
    await s.done;
  }

  async function saveAll() {
    const pr = progress(mode === 'merge' ? 'Uniendo PDFs…' : 'Guardando PDF…');
    try {
      const bytes = await buildLossless(items, pr);
      pr.close();
      await deliver([new File([bytes], `${baseName()}${mode === 'merge' ? '-unido' : ''}.pdf`, { type: 'application/pdf' })]);
    } catch (e) { pr.close(); console.error(e); toast(`Error: ${e.message}`, 'error'); }
  }

  async function extractSel() {
    const list = items.filter(i => selected.has(i.id));
    const pr = progress('Extrayendo…');
    try {
      const bytes = await buildLossless(list, pr);
      pr.close();
      await deliver([new File([bytes], `${baseName()}-extracto.pdf`, { type: 'application/pdf' })]);
    } catch (e) { pr.close(); toast(`Error: ${e.message}`, 'error'); }
  }

  function splitDlg() {
    const n = items.length;
    const body = h(`<div>
      <div class="chips" id="m" style="margin-bottom:12px">
        <button class="chip on" data-v="each">Cada página</button><button class="chip" data-v="n">Cada N páginas</button><button class="chip" data-v="ranges">Por rangos</button>
      </div>
      <div id="nRow" hidden><label class="field"><span>Páginas por archivo</span><input class="input" type="number" id="n" min="1" max="${n}" value="2"></label></div>
      <div id="rRow" hidden><label class="field"><span>Rangos (uno por archivo)</span><input class="input" id="r" placeholder="1-3, 4-6, 7-${n}"></label></div>
      <p class="small muted">${n} páginas en total. Sin pérdida de calidad.</p></div>`);
    let m = 'each';
    $$('#m .chip', body).forEach(c => c.onclick = () => { m = c.dataset.v; $$('#m .chip', body).forEach(x => x.classList.toggle('on', x === c)); $('#nRow', body).hidden = m !== 'n'; $('#rRow', body).hidden = m !== 'ranges'; });
    sheet({ title: 'Separar PDF', body, actions: [{ label: 'Cancelar' }, { label: 'Separar', cls: 'primary', onClick: async () => {
      let groups;
      try { groups = m === 'each' ? chunk(n, 1) : m === 'n' ? chunk(n, Math.max(1, +$('#n', body).value || 1)) : parseRanges($('#r', body).value, n); } catch (e) { toast(e.message, 'error'); return false; }
      const pr = progress('Separando…');
      try {
        const files = [];
        for (let g = 0; g < groups.length; g++) {
          pr.set(g / groups.length, `Archivo ${g + 1} de ${groups.length}`);
          const bytes = await buildLossless(groups[g].map(i => items[i]));
          const a = groups[g][0] + 1, b = groups[g][groups[g].length - 1] + 1;
          files.push(new File([bytes], `${baseName()}-${a === b ? `p${a}` : `p${a}-${b}`}.pdf`, { type: 'application/pdf' }));
        }
        pr.close();
        setTimeout(() => deliver(files, `${baseName()}-separado.zip`), 250);
      } catch (e) { pr.close(); toast(e.message, 'error'); }
      return true;
    } }] });
  }

  // Rasteriza páginas a JPEG (para comprimir o exportar imágenes)
  async function rasterItem(it, dpi, q) {
    const page = await sources[it.src].pdfjs.getPage(it.index + 1);
    const rot = (page.rotate + it.rot) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation: rot });
    let scale = dpi / 72;
    const maxPx = 5000;
    if (Math.max(vp1.width, vp1.height) * scale > maxPx) scale = maxPx / Math.max(vp1.width, vp1.height);
    const vp = page.getViewport({ scale, rotation: rot });
    const c = makeCanvas(vp.width, vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const blob = await canvasToBlob(c, 'image/jpeg', q);
    c.width = c.height = 0;
    return { blob, wPt: vp1.width, hPt: vp1.height };
  }

  async function compressedPdf(list, dpi, q, gray, pr) {
    const PDFLib = await loadPdfLib();
    const out = await PDFLib.PDFDocument.create();
    for (let k = 0; k < list.length; k++) {
      pr && pr.set(k / list.length, `Página ${k + 1} de ${list.length}`);
      let { blob, wPt, hPt } = await rasterItem(list[k], dpi, q);
      if (gray) blob = await grayJpeg(blob, q);
      const img = await out.embedJpg(await blob.arrayBuffer());
      const p = out.addPage([wPt, hPt]);
      p.drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
    }
    return out.save({ useObjectStreams: true });
  }

  async function grayJpeg(blob, q) {
    const bmp = await createImageBitmap(blob);
    const c = makeCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const id = ctx.getImageData(0, 0, c.width, c.height), d = id.data;
    for (let j = 0; j < d.length; j += 4) { const l = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8; d[j] = d[j + 1] = d[j + 2] = l; }
    ctx.putImageData(id, 0, 0);
    return canvasToBlob(c, 'image/jpeg', q);
  }

  function compressDlg() {
    const total = sources.reduce((s, x) => s + x.size, 0);
    const LEVELS = [
      { k: 'low', label: 'Ligera', dpi: 200, q: 0.8, hint: 'Máxima calidad' },
      { k: 'med', label: 'Recomendada', dpi: 150, q: 0.65, hint: 'Buen equilibrio' },
      { k: 'high', label: 'Fuerte', dpi: 110, q: 0.5, hint: 'Para enviar por correo' },
      { k: 'max', label: 'Extrema', dpi: 80, q: 0.35, hint: 'Lo más ligero posible' },
    ];
    let lv = LEVELS[1], gray = false;
    const body = h(`<div>
      <div class="field"><span class="field-label">Nivel</span><div class="chips" id="lv" style="flex-wrap:wrap">${LEVELS.map(l => `<button class="chip ${l === lv ? 'on' : ''}" data-k="${l.k}">${l.label}<small>${l.dpi} ppp</small></button>`).join('')}</div></div>
      <label class="switch"><span class="sw-text">Escala de grises</span><input type="checkbox" id="g"></label>
      <div class="est"><div><div class="small muted">Original ${fmtBytes(total)} → estimado</div><b id="est">calculando…</b></div><small id="pct"></small></div>
      <p class="small muted">${icon('info')} Comprimir convierte las páginas en imagen: el texto deja de ser seleccionable. Para PDFs escaneados es lo ideal.</p></div>`);
    let tok = 0;
    async function est() {
      const t = ++tok;
      $('#est', body).textContent = 'calculando…'; $('#pct', body).textContent = '';
      const n = items.length;
      const idxs = n <= 3 ? [...Array(n).keys()] : [0, Math.floor(n / 2), n - 1];
      let sum = 0;
      for (const i of idxs) {
        let { blob } = await rasterItem(items[i], lv.dpi, lv.q);
        if (gray) blob = await grayJpeg(blob, lv.q);
        sum += blob.size;
        if (t !== tok) return;
      }
      const e = sum / idxs.length * n + 2000 + n * 400;
      $('#est', body).textContent = `≈ ${fmtBytes(e)}`;
      const pct = Math.round((1 - e / total) * 100);
      $('#pct', body).textContent = pct > 0 ? `−${pct}%` : 'no reduce';
    }
    $$('#lv .chip', body).forEach(c => c.onclick = () => { lv = LEVELS.find(l => l.k === c.dataset.k); $$('#lv .chip', body).forEach(x => x.classList.toggle('on', x === c)); est(); });
    $('#g', body).onchange = e => { gray = e.target.checked; est(); };
    est();
    sheet({ title: 'Comprimir PDF', body, actions: [{ label: 'Cancelar' }, { label: 'Comprimir', cls: 'primary', onClick: async () => {
      tok++;
      const pr = progress('Comprimiendo…');
      try {
        const bytes = await compressedPdf(items, lv.dpi, lv.q, gray, pr);
        pr.close();
        if (bytes.length >= total) toast('El resultado no es más ligero que el original; prueba un nivel más fuerte');
        setTimeout(() => deliver([new File([bytes], `${baseName()}-comprimido.pdf`, { type: 'application/pdf' })]), 250);
      } catch (e) { pr.close(); toast(e.message, 'error'); }
      return true;
    } }] });
  }

  function imagesDlg() {
    let dpi = 150, q = QUALITY_PRESETS[1].q;
    const body = h(`<div>
      <div class="field"><span class="field-label">Resolución</span><div class="chips" id="d">${[100, 150, 200, 300].map(v => `<button class="chip ${v === dpi ? 'on' : ''}" data-v="${v}">${v} ppp</button>`).join('')}</div></div>
      <div class="field"><span class="field-label">Calidad JPG</span><div class="chips" id="q">${QUALITY_PRESETS.slice(0, 4).map(p => `<button class="chip ${p.q === q ? 'on' : ''}" data-v="${p.q}">${p.label}</button>`).join('')}</div></div>
      <p class="small muted">${items.length} imágenes${items.length > 1 ? ' en un ZIP' : ''}.</p></div>`);
    $$('#d .chip', body).forEach(c => c.onclick = () => { dpi = +c.dataset.v; $$('#d .chip', body).forEach(x => x.classList.toggle('on', x === c)); });
    $$('#q .chip', body).forEach(c => c.onclick = () => { q = +c.dataset.v; $$('#q .chip', body).forEach(x => x.classList.toggle('on', x === c)); });
    sheet({ title: 'PDF a imágenes', body, actions: [{ label: 'Cancelar' }, { label: 'Convertir', cls: 'primary', onClick: async () => {
      const pr = progress('Convirtiendo…');
      try {
        const files = [];
        for (let k = 0; k < items.length; k++) {
          pr.set(k / items.length, `Página ${k + 1} de ${items.length}`);
          const { blob } = await rasterItem(items[k], dpi, q);
          files.push(new File([blob], `${baseName()}-${String(k + 1).padStart(2, '0')}.jpg`, { type: 'image/jpeg' }));
        }
        pr.close();
        setTimeout(() => deliver(files, `${baseName()}-imagenes.zip`), 250);
      } catch (e) { pr.close(); toast(e.message, 'error'); }
      return true;
    } }] });
  }

  if (mode && TOOL_INFO[mode]) { drawHome(); start(mode); } else drawHome();
  return () => { if (sortable) sortable.destroy(); if (thumbObs) thumbObs.disconnect(); reset(); };
}
