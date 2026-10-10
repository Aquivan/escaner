// OCR: reconocer texto (varios idiomas), copiar, descargar y crear PDF buscable.
import * as db from '../db.js';
import { icon } from '../icons.js';
import { $, $$, toast, progress, downloadBlob, shareFiles, safeName } from '../ui.js';
import { OCR_LANGS, OCR_ENGINES, PADDLE_MODELS, paddleAvailable, recognizePage } from '../ocr-engine.js';
import { settings, save } from '../settings.js';
import { openExport } from '../export-sheet.js';
import { ocrText } from '../exporter.js';
import { back } from '../nav.js';

export async function render(root, { docId, pageIndex, all }) {
  const doc = await db.getDoc(docId);
  if (!doc) { back(); return; }
  let pages = await db.getPages(doc);
  let scope = pageIndex != null && !all ? 'page' : 'all';
  let langs = [...(settings.ocrLangs || ['spa'])];

  root.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" id="back" aria-label="Volver">${icon('back')}</button>
      <h1>Texto (OCR)</h1>
    </header>
    <div class="ocr-view">
      <div class="card">
        <div id="engineBox" ${paddleAvailable() ? '' : 'hidden'}>
          <h3>Motor de reconocimiento</h3>
          <div class="chips" id="engine">${OCR_ENGINES.map(([k, l]) => `<button class="chip" data-v="${k}">${l}${k === 'paddle' ? ' <small>recomendado</small>' : ''}</button>`).join('')}</div>
          <div id="paddleOpts" style="margin-top:12px">
            <div class="chips" id="pmodel">${PADDLE_MODELS.map(([k, l, sz]) => `<button class="chip" data-v="${k}">${l} <small>${sz}</small></button>`).join('')}</div>
            <p class="small muted" style="margin-top:8px">PaddleOCR lee mejor fotos con poca luz, letra pequeña y tickets, y reconoce a la vez español, inglés, portugués, francés, alemán, italiano y otros idiomas latinos. La primera vez descarga el motor (unos 40 MB) y después funciona sin conexión.</p>
          </div>
        </div>
        <div id="tessOpts">
          <h3 style="margin-top:12px">Idiomas del documento</h3>
          <div class="chips" id="langs" style="flex-wrap:wrap">${OCR_LANGS.map(([k, l]) => `<button class="chip" data-v="${k}">${l}${k === 'spa' || k === 'eng' ? '' : ' <small>↓</small>'}</button>`).join('')}</div>
          <p class="small muted" style="margin-top:8px">Español e inglés funcionan sin conexión. Los marcados con ↓ se descargan la primera vez (unos 2–4 MB).</p>
        </div>
        ${pageIndex != null ? `<div class="chips" id="scope" style="margin-top:10px">
          <button class="chip" data-v="page">Solo la página ${+pageIndex + 1}</button>
          <button class="chip" data-v="all">Todo el documento (${pages.length})</button></div>` : ''}
        <div class="row" style="margin-top:14px"><button class="btn primary block" id="run">${icon('ocr')}Reconocer texto</button></div>
      </div>
      <div class="card" id="result" hidden>
        <div class="row" style="margin-bottom:8px"><h3 style="margin:0">Resultado</h3><span class="spacer"></span><span class="stat" id="stat"></span></div>
        <textarea class="input ocr-text" id="text" spellcheck="false"></textarea>
        <div class="row wrap" style="margin-top:10px">
          <button class="btn small" id="copy">${icon('copy')}Copiar</button>
          <button class="btn small" id="txt">${icon('download')}.txt</button>
          <button class="btn small" id="share">${icon('share')}Compartir</button>
          <span class="spacer"></span>
          <button class="btn small primary" id="pdf">${icon('filePdf')}PDF buscable</button>
        </div>
        <p class="small muted" style="margin-top:10px">${icon('info')} La precisión baja con letra muy pequeña, borrosa o manuscrita. Puedes corregir el texto aquí antes de copiarlo (la corrección no cambia la capa del PDF).</p>
      </div>
    </div>`;

  const engine = () => (paddleAvailable() ? settings.ocrEngine : 'tesseract');
  const setChips = () => {
    $$('#engine .chip', root).forEach(c => c.classList.toggle('on', c.dataset.v === engine()));
    $$('#pmodel .chip', root).forEach(c => c.classList.toggle('on', c.dataset.v === settings.paddleModel));
    $('#paddleOpts', root).hidden = engine() !== 'paddle';
    $('#tessOpts', root).hidden = engine() !== 'tesseract';
    $$('#langs .chip', root).forEach(c => c.classList.toggle('on', langs.includes(c.dataset.v)));
    $$('#scope .chip', root).forEach(c => c.classList.toggle('on', c.dataset.v === scope));
  };
  $$('#langs .chip', root).forEach(c => c.onclick = () => {
    const v = c.dataset.v;
    if (langs.includes(v)) { if (langs.length > 1) langs = langs.filter(x => x !== v); } else langs.push(v);
    save('ocrLangs', langs); setChips();
  });
  $$('#engine .chip', root).forEach(c => c.onclick = () => { save('ocrEngine', c.dataset.v); setChips(); });
  $$('#pmodel .chip', root).forEach(c => c.onclick = () => { save('paddleModel', c.dataset.v); setChips(); });
  $$('#scope .chip', root).forEach(c => c.onclick = () => { scope = c.dataset.v; setChips(); show(); });
  setChips();

  const targetPages = () => (scope === 'page' ? [pages[+pageIndex]] : pages).filter(Boolean);

  function show() {
    const tp = targetPages();
    const done = tp.filter(p => p.ocr);
    if (!done.length) { $('#result', root).hidden = true; return; }
    $('#result', root).hidden = false;
    $('#text', root).value = tp.length === 1 ? (tp[0].ocr?.text || '') : ocrText(tp);
    const conf = Math.round(done.reduce((s, p) => s + (p.ocr.conf || 0), 0) / done.length);
    const words = done.reduce((s, p) => s + (p.ocr.words?.length || 0), 0);
    $('#stat', root).innerHTML = `${words} palabras · confianza ${conf}% · ${done[0].ocr.engine?.startsWith('paddle') ? 'PaddleOCR' : 'Tesseract'}${done.length < tp.length ? ` · ${tp.length - done.length} pág. sin procesar` : ''}`;
  }

  $('#run', root).onclick = async () => {
    const tp = targetPages();
    const pr = progress('Reconociendo texto…');
    let cancelled = false;
    pr.cancellable(() => { cancelled = true; });
    try {
      for (let i = 0; i < tp.length && !cancelled; i++) {
        pr.title(`Reconociendo texto · página ${i + 1} de ${tp.length}`);
        tp[i].ocr = await recognizePage(tp[i], langs, (f, st) => pr.set((i + f) / tp.length, st));
        await db.putPage(tp[i]);
      }
      pr.close();
      toast(cancelled ? 'Cancelado' : 'Texto reconocido', cancelled ? '' : 'ok');
    } catch (e) {
      pr.close(); console.error(e);
      toast(`Error de OCR: ${e.message || e}. ${navigator.onLine ? '' : 'Sin conexión: usa español o inglés.'}`, 'error');
    }
    await db.putDoc(doc);
    show();
  };

  $('#copy', root).onclick = async () => {
    try { await navigator.clipboard.writeText($('#text', root).value); toast('Texto copiado', 'ok'); }
    catch { $('#text', root).select(); document.execCommand('copy'); toast('Texto copiado', 'ok'); }
  };
  const txtFile = () => new File([$('#text', root).value], `${safeName(doc.name)}.txt`, { type: 'text/plain' });
  $('#txt', root).onclick = () => downloadBlob(txtFile(), `${safeName(doc.name)}.txt`);
  $('#share', root).onclick = async () => {
    const text = $('#text', root).value;
    try { if (navigator.share) { await navigator.share({ title: doc.name, text }); return; } } catch (e) { if (e.name === 'AbortError') return; }
    if (!(await shareFiles([txtFile()], doc.name))) toast('Compartir no está disponible; usa Copiar');
  };
  $('#pdf', root).onclick = async () => {
    const prev = { ...settings.export };
    settings.export = { ...settings.export, format: 'pdf', searchable: true };
    await openExport(doc, targetPages().length === pages.length ? pages : targetPages());
    settings.export = { ...prev, ...settings.export };
  };
  $('#back', root).onclick = back;
  show();
  return null;
}

