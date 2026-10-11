// Utilidades de interfaz: elementos, avisos, diálogos, hojas inferiores, progreso.
import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtBytes(n) {
  if (!isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

export function fmtDate(ts) {
  return new Date(ts).toLocaleString('es', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

let toastTimer;
export function toast(msg, kind = '') {
  let t = $('#toast');
  if (!t) { t = h('<div id="toast" role="status" aria-live="polite"></div>'); document.body.append(t); }
  t.className = `show ${kind}`;
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, kind === 'error' ? 4500 : 2600);
}

// Hoja/diálogo modal. Devuelve {el, close, done}
export function sheet({ title = '', body = '', actions = [], cls = '', onClose } = {}) {
  const wrap = h(`<div class="sheet-wrap ${cls}">
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-grip"></div>
      ${title ? `<div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Cerrar">${icon('x')}</button></div>` : ''}
      <div class="sheet-body"></div>
      ${actions.length ? '<div class="sheet-actions"></div>' : ''}
    </div></div>`);
  const bodyEl = $('.sheet-body', wrap);
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });
  const close = (val) => {
    if (!wrap.isConnected) return;
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 200);
    onClose && onClose(val);
    resolveDone(val);
  };
  const act = $('.sheet-actions', wrap);
  for (const a of actions) {
    const b = h(`<button class="btn ${a.cls || ''}">${a.icon ? icon(a.icon) : ''}<span>${esc(a.label)}</span></button>`);
    b.onclick = async () => {
      if (a.onClick) { const r = await a.onClick(b); if (r === false) return; close(r ?? a.value); } else close(a.value);
    };
    act.append(b);
  }
  wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-close]')) close(undefined); });
  document.body.append(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  return { el: wrap, body: bodyEl, close, done };
}

export function confirmDlg(msg, okLabel = 'Aceptar', danger = false) {
  return sheet({
    title: 'Confirmar', body: `<p>${esc(msg)}</p>`, cls: 'dialog',
    actions: [{ label: 'Cancelar', value: false }, { label: okLabel, value: true, cls: danger ? 'danger' : 'primary' }],
  }).done.then(v => !!v);
}

export function promptDlg(title, value = '', { multiline = false, placeholder = '' } = {}) {
  const field = multiline
    ? `<textarea class="input" rows="4" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
    : `<input class="input" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}">`;
  const s = sheet({
    title, body: field, cls: 'dialog',
    actions: [{ label: 'Cancelar', value: null }, { label: 'Aceptar', cls: 'primary', onClick: () => $('.input', s.el).value }],
  });
  const inp = $('.input', s.el);
  setTimeout(() => { inp.focus(); if (!multiline) inp.select(); }, 60);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !multiline) s.close(inp.value); });
  return s.done;
}

export function menu(items, anchor) {
  const s = sheet({ cls: 'menu-sheet', body: '' });
  const list = h('<div class="menu-list"></div>');
  for (const it of items) {
    if (it === '-') { list.append(h('<hr>')); continue; }
    const b = h(`<button class="menu-item ${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>${icon(it.icon || 'next')}<span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</button>`);
    b.onclick = () => { s.close(); setTimeout(() => it.onClick(), 10); };
    list.append(b);
  }
  s.body.append(list);
  return s;
}

// Superposición de progreso bloqueante
export function progress(title = 'Procesando…') {
  const el = h(`<div class="progress-overlay"><div class="progress-card">
    <div class="spinner"></div><div class="p-title">${esc(title)}</div>
    <div class="bar"><i></i></div><div class="p-detail"></div>
    <button class="btn small p-cancel" hidden>Cancelar</button></div></div>`);
  document.body.append(el);
  let cancelled = false;
  const api = {
    set(frac, detail) {
      const bar = $('.bar', el);
      if (frac == null) bar.classList.add('indet'); else { bar.classList.remove('indet'); $('.bar i', el).style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`; }
      if (detail !== undefined) $('.p-detail', el).textContent = detail;
    },
    title(t) { $('.p-title', el).textContent = t; },
    cancellable(cb) { const b = $('.p-cancel', el); b.hidden = false; b.onclick = () => { cancelled = true; cb && cb(); }; },
    get cancelled() { return cancelled; },
    close() { el.remove(); },
  };
  api.set(null);
  return api;
}

export function pickFiles({ accept = '*/*', multiple = true, capture } = {}) {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept; inp.multiple = multiple;
    if (capture) inp.setAttribute('capture', capture);
    inp.style.display = 'none';
    inp.onchange = () => { resolve([...inp.files]); inp.remove(); };
    // Si el usuario cancela no hay evento fiable; resolvemos vacío al recuperar el foco
    window.addEventListener('focus', () => setTimeout(() => { if (inp.isConnected && !inp.files.length) { resolve([]); inp.remove(); } }, 1200), { once: true });
    document.body.append(inp);
    inp.click();
  });
}

// Dentro de claude.ai la página no puede descargar por sí misma: se usa la capacidad "downloads"
let dlCap;
function downloadsCap() {
  if (dlCap === undefined) dlCap = window.claude?.use ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);
  return dlCap;
}
export const embedded = (() => { try { return window.top !== window; } catch { return true; } })();

export async function downloadBlob(blob, name) {
  const cap = await downloadsCap();
  if (cap) {
    try { await cap.save({ filename: name, data: blob }); } catch (e) {
      if (e?.code !== 'declined') toast(`No se pudo guardar: ${e?.message || e?.code || e}`, 'error');
    }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

export async function shareFiles(files, title) {
  try {
    if (navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files, title });
      return true;
    }
  } catch (e) {
    if (e.name === 'AbortError') return true;
    console.warn(e);
  }
  return false;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function safeName(s) {
  // Algunos navegadores descartan el nombre si lleva "·" u otros símbolos: se cambian por guiones
  return String(s || 'documento').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e·]/g, '').replace(/\s*·\s*/g, ' - ').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'documento';
}
