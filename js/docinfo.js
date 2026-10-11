// Reconoce el tipo de documento y sus datos clave (número, fecha, empresa, total)
// a partir del texto del OCR, para ponerle nombre automáticamente.
// Pensado para documentos de Perú y Latinoamérica (RUC, boleta, factura, S/…).

const TYPES = [
  // [clave, etiqueta, expresión]
  ['nota_credito', 'Nota de crédito', /NOTA\s+DE\s+CR[EÉ]DITO/i],
  ['nota_debito', 'Nota de débito', /NOTA\s+DE\s+D[EÉ]BITO/i],
  ['guia', 'Guía de remisión', /GU[IÍ]A\s+DE\s+REMISI[OÓ]N/i],
  ['honorarios', 'Recibo por honorarios', /RECIBO\s+POR\s+HONORARIOS/i],
  ['factura', 'Factura', /\bFACTURA\b/i],
  ['boleta', 'Boleta', /\bBOLETA\b/i],
  ['voucher', 'Voucher', /\b(VOUCHER|CONSTANCIA\s+DE\s+(TRANSFERENCIA|OPERACI[OÓ]N|PAGO|DEP[OÓ]SITO)|YAPE|YAPEASTE|PLIN|PLINEASTE|TRANSFERENCIA\s+(EXITOSA|REALIZADA)|N[°º]?\s*DE\s+OPERACI[OÓ]N)\b/i],
  ['dni', 'DNI', /(DOCUMENTO\s+NACIONAL\s+DE\s+IDENTIDAD|\bRENIEC\b)/i],
  ['pasaporte', 'Pasaporte', /\b(PASAPORTE|PASSPORT)\b/i],
  ['licencia', 'Licencia de conducir', /LICENCIA\s+DE\s+CONDUCIR/i],
  ['cotizacion', 'Cotización', /\b(COTIZACI[OÓ]N|PROFORMA|PRESUPUESTO)\b/i],
  ['contrato', 'Contrato', /\bCONTRATO\b/i],
  ['certificado', 'Certificado', /\bCERTIFICADO\b/i],
  ['constancia', 'Constancia', /\bCONSTANCIA\b/i],
  ['acta', 'Acta', /\bACTA\b/i],
  ['informe', 'Informe', /\bINFORME\b/i],
  ['oficio', 'Oficio', /\bOFICIO\s*N/i],
  ['solicitud', 'Solicitud', /\bSOLICITUD\b|\bSOLICITO\b/i],
  ['receta', 'Receta médica', /\bRECETA\b|\bRp\.\s|\bC\.?M\.?P\.?\s*\d/i],
  ['recibo', 'Recibo', /\bRECIBO\b/i],
  ['ticket', 'Ticket', /\b(TICKET|SUBTOTAL|I\.?G\.?V\.?|TOTAL\s*(S\/|\$|USD|PEN))/i],
  ['carta', 'Carta', /\b(Estimad[oa]s?|Atentamente|Cordialmente|De mi consideraci[oó]n)\b/i],
];

const MONTHS = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const pad = n => String(n).padStart(2, '0');

function findDate(t) {
  let m = t.match(/\b(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{4}|\d{2})\b/);
  if (m) {
    let [, d, mo, y] = m.map(Number);
    if (y < 100) y += 2000;
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) return `${pad(d)}-${pad(mo)}-${y}`;
  }
  m = t.match(/\b(\d{1,2})\s+de\s+([a-záéíóú]+)\s+(?:de|del)\s+(\d{4})\b/i);
  if (m && MONTHS[m[2].toLowerCase()]) return `${pad(+m[1])}-${pad(MONTHS[m[2].toLowerCase()])}-${m[3]}`;
  m = t.match(/\b(\d{1,2})\s+(ene|feb|mar|abr|may|jun|jul|ago|sep|set|oct|nov|dic)[a-z]*\.?\s+(?:de\s+)?(\d{4})\b/i);
  if (m) { const k = Object.keys(MONTHS).find(x => x.startsWith(m[2].toLowerCase())); return `${pad(+m[1])}-${pad(MONTHS[k])}-${m[3]}`; }
  m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function findNumber(t, type) {
  // Serie y correlativo electrónicos: F001-00012345, B001-4521, E001-12, T001-88
  const pref = { factura: '[FE]', boleta: '[BE]', guia: '[TEV]', nota_credito: '[FBE]', nota_debito: '[FBE]', honorarios: 'E' }[type] || '[A-Z]';
  let m = t.match(new RegExp(`\\b(${pref}[A-Z0-9]{3})\\s*[-–—]\\s*(\\d{1,10})\\b`));
  if (m) return `${m[1]}-${m[2]}`;
  for (const mm of t.matchAll(/(?:^|[\s(])(?:N[uú]mero(?:\s+de\s+[a-záéíóú]+)?|Nro\.?|N[°º.])\s*[:#]?\s*([A-Z0-9-]{3,20})/gim)) {
    if (/\d/.test(mm[1])) return mm[1];
  }
  if (type === 'voucher') { m = t.match(/OPERACI[OÓ]N\D{0,15}(\d{4,})/i); if (m) return m[1]; }
  if (type === 'dni') { m = t.match(/\b(\d{8})\b/); if (m) return m[1]; }
  return null;
}

function findTotal(t) {
  const re = /(?<!SUB)TOTAL(?:\s+A\s+PAGAR|\s+GENERAL)?[^\n\d]{0,14}(S\/\.?|\$|USD|PEN|€)?\s*([\d]{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2})?)/gi;
  let m, last = null;
  while ((m = re.exec(t))) last = m;
  if (!last) return null;
  const cur = (last[1] || (/S\/|soles/i.test(t) ? 'S/' : '')).replace('S/.', 'S/');
  return `${cur ? cur + ' ' : ''}${last[2].replace(/\s/g, '')}`;
}

function findCompany(lines, typeLabelRe) {
  const legal = lines.find(l => /\b(S\.?\s?A\.?\s?C\.?|S\.?\s?A\.?|E\.?\s?I\.?\s?R\.?\s?L\.?|S\.?\s?R\.?\s?L\.?|S\.?\s?A\.?\s?A\.?)\s*$/i.test(l) || /\b(S\.A\.C|E\.I\.R\.L|S\.R\.L)\b/i.test(l));
  if (legal) return legal.replace(/\s*RUC.*$/i, '').trim();
  const ruc = lines.findIndex(l => /\bRUC\b/i.test(l));
  if (ruc > 0) {
    const prev = lines[ruc - 1];
    if (prev && !typeLabelRe.test(prev) && /[A-Za-z]{3}/.test(prev)) return prev.trim();
  }
  return null;
}

const clean = s => s.replace(/\s+/g, ' ').replace(/[<>"\\|?*]+/g, '').replace(/[:,;]+$/, '').trim();
const titleCase = s => (s === s.toUpperCase() && s.length > 4)
  ? s.toLowerCase().replace(/(^|\s|\.)([a-záéíóúñ])/g, (_, a, b) => a + b.toUpperCase()).replace(/\b(S\.?a\.?c\.?|E\.?i\.?r\.?l\.?|S\.?r\.?l\.?)\b/gi, x => x.toUpperCase())
      .replace(/(?!^)\b(De|Del|La|Las|Los|El|Y|En|Por|Para|Con)\b/g, x => x.toLowerCase())
  : s;

export function analyzeText(text) {
  const t = String(text || '');
  if (t.trim().length < 6) return null;
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  const hit = TYPES.find(([, , re]) => re.test(t));
  const type = hit ? hit[0] : 'documento';
  const label = hit ? hit[1] : 'Documento';
  const typeLabelRe = hit ? hit[2] : /^$/;
  const number = findNumber(t, type);
  const date = findDate(t);
  const total0 = ['factura', 'boleta', 'ticket', 'recibo', 'voucher', 'cotizacion', 'nota_credito', 'honorarios'].includes(type) ? findTotal(t) : null;
  let total = total0;
  if (!total && type === 'voucher') { const mm = t.match(/(S\/|\$)\s*([\d.,]+)/); if (mm) total = `${mm[1]} ${mm[2]}`; }
  const ruc = (t.match(/\bRUC\D{0,4}(\d{11})\b/i) || [])[1] || null;
  let company = findCompany(lines, typeLabelRe);
  // Título: primera línea con contenido que no sea el propio tipo ni datos sueltos
  const title = lines.find(l => l.length > 4 && /[A-Za-zÁÉÍÓÚÑáéíóúñ]{3}/.test(l) && !typeLabelRe.test(l) && !/^\W*(RUC|N[°º]|Fecha|Hora|Cliente|Se[nñ]or|Sr\.?|Rep[uú]blica)\b/i.test(l));
  const DESCRIPTIVE = ['contrato', 'certificado', 'constancia', 'acta', 'informe', 'solicitud', 'cotizacion', 'oficio'];
  const parts = [label];
  if (DESCRIPTIVE.includes(type)) {
    // "CONTRATO DE ARRENDAMIENTO" ya describe el documento
    const head = lines.find(l => typeLabelRe.test(l));
    if (head && head.length <= 70) parts[0] = titleCase(clean(head));
  }
  if (number) parts[0] += ` ${number}`;
  if (company) parts.push(titleCase(clean(company)).slice(0, 40));
  else if (type === 'carta') { const g = lines.find(l => /Estimad|Se[nñ]or/i.test(l)); if (g) parts.push(clean(g).replace(/[:,]$/, '').slice(0, 40)); }
  else if (type === 'documento' && !number && title) parts[0] = titleCase(clean(title)).slice(0, 50);
  else if (type === 'voucher' && total) parts.push(total);
  if (date) parts.push(date);
  return { type, label, number, date, total, ruc, company, name: clean(parts.join(' · ')).slice(0, 110) };
}

// Analiza la primera página (y la segunda si hace falta) de un documento.
// Si no tienen texto reconocido y runOcr es true, ejecuta el OCR primero.
export async function suggestForDoc(doc, { runOcr = true, onProgress } = {}) {
  const db = await import('./db.js');
  const { recognizePage } = await import('./ocr-engine.js');
  const { settings } = await import('./settings.js');
  let text = '';
  for (const id of doc.pageIds.slice(0, 2)) {
    const p = await db.getPage(id);
    if (!p) continue;
    if (!p.ocr && runOcr) {
      p.ocr = await recognizePage(p, settings.ocrLangs, onProgress);
      await db.putPage(p);
    }
    text += (p.ocr?.text || '') + '\n';
    if (text.trim().length > 40) break;
  }
  return analyzeText(text);
}
