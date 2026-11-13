// Exporta el texto reconocido a un documento de Word (.docx) editable, como Microsoft Lens.
import { loadJSZip } from './loader.js';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const run = (t, { bold = false, size = 0 } = {}) =>
  `<w:r>${bold || size ? `<w:rPr>${bold ? '<w:b/>' : ''}${size ? `<w:sz w:val="${size}"/>` : ''}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const para = (t, o) => `<w:p>${t ? run(t, o) : ''}</w:p>`;

export async function buildDocx(pages, title = 'Documento') {
  const body = [para(title, { bold: true, size: 32 })];
  pages.forEach((p, i) => {
    if (i > 0) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    const text = (p.ocr?.text || '').trim();
    if (!text) { body.push(para(`(Página ${i + 1} sin texto reconocido)`)); return; }
    for (const line of text.split('\n')) body.push(para(line));
  });
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', doc);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
