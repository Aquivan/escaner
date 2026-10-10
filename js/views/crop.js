// Ajuste manual de esquinas de una página existente
import * as db from '../db.js';
import { icon } from '../icons.js';
import { $, toast, progress } from '../ui.js';
import { decodeBlob, renderPage } from '../imaging.js';
import { detectQuad, FULL } from '../detect.js';
import { createCropper } from '../cropper.js';
import { savePage } from '../pages.js';
import { back } from '../nav.js';

export async function render(root, { pageId }) {
  const page = await db.getPage(pageId);
  if (!page) { back(); return; }
  root.innerHTML = `
    <div class="stage-view">
      <header class="topbar dark">
        <button class="icon-btn" id="close" aria-label="Cancelar">${icon('x')}</button>
        <h1>Recortar y rotar</h1>
        <button class="icon-btn" id="ok" aria-label="Aplicar">${icon('check')}</button>
      </header>
      <div class="stage" id="stage"></div>
      <div class="stage-bar">
        <button class="tool" data-a="rotL">${icon('rotateL')}Girar izq.</button>
        <button class="tool" data-a="rotR">${icon('rotateR')}Girar der.</button>
        <button class="tool" data-a="auto">${icon('wand')}Detectar</button>
        <button class="tool" data-a="full">${icon('expand')}Todo</button>
        <button class="tool" data-a="ok">${icon('check')}Aplicar</button>
      </div>
    </div>`;
  const preview = await decodeBlob(page.original, 1800);
  let rotation = page.rotation || 0;
  const cr = createCropper($('#stage', root), preview, page.corners || FULL);

  async function apply() {
    if (!cr.valid) { toast('Las esquinas se cruzan; corrígelas', 'error'); return; }
    const pr = progress('Corrigiendo perspectiva…');
    try {
      page.corners = cr.corners;
      page.rotation = rotation;
      page.ocr = null; // el texto reconocido ya no coincide con la nueva geometría
      await renderPage(page);
      await savePage(page);
      pr.close();
      back();
    } catch (e) { pr.close(); toast(e.message, 'error'); }
  }
  root.querySelector('.stage-bar').addEventListener('click', async e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'auto') { const q = await detectQuad(preview); if (q) { cr.set(q); toast('Bordes detectados', 'ok'); } else toast('No se encontraron bordes; ajústalos a mano'); }
    if (a === 'full') cr.set(FULL);
    if (a === 'rotL' || a === 'rotR') {
      rotation = (rotation + (a === 'rotR' ? 90 : 270)) % 360;
      toast(rotation ? `El resultado se girará ${rotation}°` : 'Sin giro');
    }
    if (a === 'ok') apply();
  });
  $('#ok', root).onclick = apply;
  $('#close', root).onclick = back;
  return () => cr.destroy();
}
