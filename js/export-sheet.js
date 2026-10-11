// Hoja de exportación: formato, resolución (ppp), compresión, tamaño de página,
// PDF buscable, extras, y peso estimado en vivo.
import { h, $, $$, sheet, fmtBytes, progress, toast, downloadBlob, shareFiles, safeName, esc } from './ui.js';
import { icon } from './icons.js';
import { settings, save } from './settings.js';
import { DPI_PRESETS, QUALITY_PRESETS, PAGE_SIZES, buildPdf, buildImages, zipFiles, estimateSize, ocrText } from './exporter.js';
import { recognizePage } from './ocr-engine.js';
import * as db from './db.js';

export function openExport(doc, pages, { shareFirst = false } = {}) {
  const o = { ...settings.export };
  if (!o.format) o.format = 'pdf';
  const hasOcr = pages.some(p => p.ocr?.words?.length);
  const body = h(`<div>
    <label class="field"><span>Nombre</span><input class="input" id="name" value="${esc(doc.name)}"></label>
    <div class="field"><span class="field-label">Formato</span>
      <div class="chips" id="fmt">
        <button class="chip" data-v="pdf">${icon('filePdf')}PDF</button>
        <button class="chip" data-v="jpg">${icon('image')}JPG</button>
        <button class="chip" data-v="png">${icon('image')}PNG</button>
        <button class="chip" data-v="txt">${icon('type')}Texto (OCR)</button>
      </div></div>
    <div id="imgOpts">
      <div class="field"><span class="field-label">Resolución</span>
        <div class="chips" id="dpi">
          ${DPI_PRESETS.map(d => `<button class="chip" data-v="${d.dpi}">${d.label}<small>${d.dpi} ppp</small></button>`).join('')}
          <button class="chip" data-v="custom">Personalizada</button>
        </div>
        <div class="row" id="dpiCustom" hidden style="margin-top:8px"><input class="input" type="number" min="50" max="600" step="10" id="dpiVal" style="max-width:120px"><span class="muted">ppp (50–600)</span></div>
      </div>
      <div class="field"><span class="field-label">Compresión</span>
        <div class="chips" id="q">${QUALITY_PRESETS.map(q => `<button class="chip" data-v="${q.q}">${q.label}</button>`).join('')}</div>
      </div>
      <div class="field" id="sizeField"><span class="field-label">Tamaño de página</span>
        <div class="chips" id="ps">${Object.entries(PAGE_SIZES).map(([k, v]) => `<button class="chip" data-v="${k}">${v.label}</button>`).join('')}</div>
      </div>
      <label class="switch" id="srchRow"><span class="sw-text">PDF buscable (OCR)<small>${hasOcr ? 'Añade una capa de texto invisible para buscar y seleccionar' : 'Reconocerá el texto antes de exportar (tarda unos segundos por página)'}</small></span><input type="checkbox" id="srch"></label>
      <label class="switch"><span class="sw-text">Escala de grises<small>Reduce el peso en documentos sin color</small></span><input type="checkbox" id="gray"></label>
      <label class="switch"><span class="sw-text">Numerar páginas</span><input type="checkbox" id="num"></label>
      <label class="field" style="margin-top:6px"><span>Marca de agua (opcional)</span><input class="input" id="wm" placeholder="p. ej. COPIA, CONFIDENCIAL"></label>
      <label class="field" id="pwRow"><span>Contraseña para abrir el PDF (opcional)</span>
        <div class="row"><input class="input" id="pw" type="password" autocomplete="new-password" placeholder="Sin contraseña"><button class="btn small" id="pwShow" type="button">Ver</button></div>
        <small class="muted">Cifrado AES-256. Si la olvidas no se podrá abrir.</small></label>
    </div>
    <div class="est"><div><div class="small muted">Peso estimado · ${pages.length} pág.</div><b id="est">—</b></div><small id="estNote"></small></div>
  </div>`);
  const canShare = !!(navigator.canShare && navigator.share);
  const s = sheet({
    title: 'Exportar', body,
    actions: [
      ...(canShare ? [{ label: 'Compartir / Drive', icon: 'share', onClick: () => run(true) }] : []),
      { label: 'Descargar', icon: 'download', cls: 'primary', onClick: () => run(false) },
    ],
  });

  const setChips = (id, val) => $$(`#${id} .chip`, body).forEach(c => c.classList.toggle('on', c.dataset.v === String(val)));
  function sync() {
    setChips('fmt', o.format);
    const isDpiPreset = DPI_PRESETS.some(d => d.dpi === o.dpi);
    setChips('dpi', isDpiPreset ? o.dpi : 'custom');
    $('#dpiCustom', body).hidden = isDpiPreset;
    $('#dpiVal', body).value = o.dpi;
    setChips('q', o.quality);
    setChips('ps', o.pageSize || 'auto');
    $('#imgOpts', body).hidden = o.format === 'txt';
    $('#sizeField', body).hidden = o.format !== 'pdf';
    $('#srchRow', body).hidden = o.format !== 'pdf';
    $('#srch', body).checked = !!o.searchable;
    $('#gray', body).checked = !!o.grayscale;
    $('#num', body).checked = !!o.pageNumbers;
    $('#wm', body).value = o.watermark || '';
    $('#pwRow', body).hidden = o.format !== 'pdf';
    $$('#q .chip', body).forEach(c => { c.disabled = o.format === 'png'; });
  }
  const bindChips = (id, key, conv = v => v) => $$(`#${id} .chip`, body).forEach(c => c.onclick = () => {
    if (c.dataset.v === 'custom') { $('#dpiCustom', body).hidden = false; setChips('dpi', 'custom'); $('#dpiVal', body).focus(); return; }
    o[key] = conv(c.dataset.v); sync(); estimate();
  });
  bindChips('fmt', 'format'); bindChips('dpi', 'dpi', Number); bindChips('q', 'quality', Number); bindChips('ps', 'pageSize');
  $('#dpiVal', body).oninput = e => { const v = +e.target.value; if (v >= 50 && v <= 600) { o.dpi = v; estimate(); } };
  $('#srch', body).onchange = e => { o.searchable = e.target.checked; estimate(); };
  $('#gray', body).onchange = e => { o.grayscale = e.target.checked; estimate(); };
  $('#num', body).onchange = e => { o.pageNumbers = e.target.checked; };
  $('#wm', body).oninput = e => { o.watermark = e.target.value.trim(); };
  $('#pw', body).oninput = e => { o.password = e.target.value; };
  $('#pwShow', body).onclick = () => { const i = $('#pw', body); i.type = i.type === 'password' ? 'text' : 'password'; };

  let estTok = 0, estT;
  function estimate() {
    clearTimeout(estT);
    const el = $('#est', body);
    if (o.format === 'txt') { el.textContent = fmtBytes(new Blob([ocrText(pages)]).size); $('#estNote', body).textContent = ''; return; }
    el.textContent = 'calculando…';
    estT = setTimeout(async () => {
      const tok = ++estTok;
      try {
        const bytes = await estimateSize(pages, o, o.format);
        if (tok !== estTok) return;
        el.textContent = `≈ ${fmtBytes(bytes)}`;
        $('#estNote', body).textContent = o.format !== 'pdf' && pages.length > 1 ? 'en total (ZIP)' : '';
      } catch (e) { if (tok === estTok) el.textContent = '—'; console.warn(e); }
    }, 250);
  }

  async function run(share) {
    const name = safeName($('#name', body).value || doc.name);
    const { password, ...remember } = o; // la contraseña nunca se guarda
    save('export', remember);
    o.password = password;
    const pr = progress('Exportando…');
    try {
      let files;
      if (o.format === 'txt' || (o.format === 'pdf' && o.searchable)) {
        const missing = pages.filter(p => !p.ocr);
        for (let i = 0; i < missing.length; i++) {
          pr.title(`Reconociendo texto (${i + 1}/${missing.length})`);
          missing[i].ocr = await recognizePage(missing[i], settings.ocrLangs, (f, st) => pr.set((i + f) / missing.length, st));
          await db.putPage(missing[i]);
        }
        pr.title('Exportando…');
      }
      if (o.format === 'pdf') {
        const bytes = await buildPdf(pages, o, (f, d) => pr.set(f, d), name);
        files = [new File([bytes], `${name}.pdf`, { type: 'application/pdf' })];
      } else if (o.format === 'txt') {
        files = [new File([ocrText(pages)], `${name}.txt`, { type: 'text/plain' })];
      } else {
        files = await buildImages(pages, o, o.format, (f, d) => pr.set(f, d), name);
      }
      pr.close();
      if (share) {
        const ok = await shareFiles(files, name);
        if (!ok) { toast('Este navegador no permite compartir; se descargará'); deliver(files, name); }
      } else deliver(files, name);
      toast(`Listo: ${files.length > 1 ? files.length + ' archivos' : files[0].name} (${fmtBytes(files.reduce((a, f) => a + f.size, 0))})`, 'ok');
      return true;
    } catch (e) {
      pr.close(); console.error(e);
      toast(`Error al exportar: ${e.message}`, 'error');
      return false;
    }
  }

  async function deliver(files, name) {
    if (files.length === 1) downloadBlob(files[0], files[0].name);
    else downloadBlob(await zipFiles(files), `${name}.zip`);
  }

  sync(); estimate();
  if (shareFirst && !canShare) toast('Compartir no está disponible en este navegador');
  return s.done;
}
