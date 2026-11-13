// Tarjetas de visita → contacto (.vcf), como Adobe Scan y Microsoft Lens.
const TITLES = /\b(gerente|director|directora|jefe|jefa|ingenier[oa]|ing\.|abogad[oa]|abg\.|contador[a]?|cpc|asesor[a]?|coordinador[a]?|administrador[a]?|m[eé]dic[oa]|dr\.|dra\.|arquitect[oa]|ejecutiv[oa]|representante|ventas|ceo|cto|cfo|manager|sales|consultor[a]?|supervisor[a]?|analista|t[eé]cnic[oa]|propietari[oa])\b/i;
const COMPANY = /\b(S\.?\s?A\.?\s?C\.?|S\.?\s?A\.?|E\.?\s?I\.?\s?R\.?\s?L\.?|S\.?\s?R\.?\s?L\.?|S\.?\s?L\.?|LTDA|INC|CORP|GROUP|GRUPO|CONSULTORES|ASOCIADOS|SERVICIOS|IMPORT|EXPORT|COMERCIAL|STUDIO|ESTUDIO)\b/i;

export function parseContact(text) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const all = lines.join('\n');
  const emails = [...new Set(all.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [])];
  const webs = [...new Set((all.match(/\b(?:https?:\/\/)?(?:www\.)[\w-]+\.[\w./-]+/gi) || []).filter(w => !w.includes('@')))];
  const phones = [...new Set((all.match(/\+?[\d(][\d\s().-]{5,}\d/g) || [])
    .map(p => p.trim().replace(/\s+/g, ' '))
    .filter(p => { const d = p.replace(/\D/g, ''); return d.length >= 7 && d.length <= 15 && !/\b(10|20)\d{9}\b/.test(d); }))];
  const isData = l => /@|www\.|https?:|\d{5,}/i.test(l) || /^(tel|telf|cel|móvil|movil|phone|fax|e-?mail|correo|web|dir|direcci[oó]n|ruc)\b/i.test(l);
  const title = lines.find(l => TITLES.test(l) && !isData(l)) || '';
  const org = lines.find(l => COMPANY.test(l) && !isData(l) && l !== title) || '';
  // Nombre: 2–4 palabras con letras, sin datos, que no sea el cargo ni la empresa
  const name = lines.find(l => l !== title && l !== org && !isData(l) && /^[A-Za-zÁÉÍÓÚÑáéíóúñ.'\s-]{4,40}$/.test(l) && l.split(/\s+/).length >= 2 && l.split(/\s+/).length <= 5) || '';
  const address = lines.find(l => /\b(av\.?|avenida|jr\.?|jir[oó]n|calle|ca\.|psje|pasaje|mz\.?|lote|urb\.?|n[°º]|#)\b/i.test(l) && !/@/.test(l)) || '';
  return { name, title, org, phones, emails, webs, address };
}

const v = s => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, m => '\\' + m);

export function toVcf(c) {
  // Sin tratamientos (Ing., Dr., Lic.…) para nombre y apellidos
  const parts = (c.name || '').trim().replace(/^((ing|dr|dra|lic|abg|arq|sr|sra|srta|mg|mba|cpc)\.?\s+)+/i, '').split(/\s+/);
  const first = parts.slice(0, Math.max(1, parts.length - (parts.length > 2 ? 2 : 1))).join(' ');
  const last = parts.length > 1 ? parts.slice(first.split(' ').length).join(' ') : '';
  const out = ['BEGIN:VCARD', 'VERSION:3.0', `N:${v(last)};${v(first)};;;`, `FN:${v(c.name || c.org || 'Contacto')}`];
  if (c.org) out.push(`ORG:${v(c.org)}`);
  if (c.title) out.push(`TITLE:${v(c.title)}`);
  (c.phones || []).filter(Boolean).forEach((p, i) => out.push(`TEL;TYPE=${i === 0 ? 'CELL' : 'WORK'}:${v(p)}`));
  (c.emails || []).filter(Boolean).forEach(e => out.push(`EMAIL;TYPE=INTERNET:${v(e)}`));
  (c.webs || []).filter(Boolean).forEach(w => out.push(`URL:${v(w)}`));
  if (c.address) out.push(`ADR;TYPE=WORK:;;${v(c.address)};;;;`);
  out.push('END:VCARD');
  return out.join('\r\n') + '\r\n';
}
