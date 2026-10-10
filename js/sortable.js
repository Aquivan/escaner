// Reordenar tarjetas arrastrando (ratón: arrastrar; táctil: mantener pulsado y arrastrar).
export function makeSortable(container, { item = '.page-card[data-id]', onEnd, enabled = () => true } = {}) {
  let st = null; // {el, ghost, pointerId, startX, startY, timer, active, offX, offY}
  let suppressClick = false;

  const items = () => [...container.querySelectorAll(item)];

  function begin() {
    const r = st.el.getBoundingClientRect();
    const ghost = st.el.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = `${r.width}px`; ghost.style.height = `${r.height}px`;
    st.offX = st.startX - r.left; st.offY = st.startY - r.top;
    document.body.append(ghost);
    st.ghost = ghost; st.active = true;
    st.el.classList.add('dragging');
    st.before = items().map(e => e.dataset.id).join(',');
    if (navigator.vibrate) navigator.vibrate(15);
    move(st.startX, st.startY);
  }

  function move(x, y) {
    st.ghost.style.left = `${x - st.offX}px`; st.ghost.style.top = `${y - st.offY}px`;
    const under = document.elementFromPoint(x, y)?.closest(item);
    if (under && under !== st.el && container.contains(under)) {
      const r = under.getBoundingClientRect();
      const after = (y > r.bottom - r.height * 0.15) || (x > r.left + r.width / 2 && y > r.top + r.height * 0.15);
      container.insertBefore(st.el, after ? under.nextSibling : under);
    }
    // desplazamiento automático
    const edge = 70;
    if (y < edge) window.scrollBy(0, -12); else if (y > innerHeight - edge) window.scrollBy(0, 12);
  }

  function end() {
    if (!st) return;
    clearTimeout(st.timer);
    if (st.active) {
      st.ghost.remove(); st.el.classList.remove('dragging');
      suppressClick = true; setTimeout(() => { suppressClick = false; }, 50);
      const order = items().map(e => e.dataset.id);
      if (order.join(',') !== st.before) onEnd && onEnd(order);
    }
    st = null;
  }

  container.addEventListener('pointerdown', e => {
    if (!enabled() || e.button > 0) return;
    const el = e.target.closest(item);
    if (!el || e.target.closest('button:not(.page-card)')) return;
    st = { el, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false, touch: e.pointerType !== 'mouse' };
    if (st.touch) st.timer = setTimeout(() => { if (st && !st.active) begin(); }, 320);
  });
  const onMove = e => {
    if (!st || e.pointerId !== st.pointerId) return;
    const d = Math.hypot(e.clientX - st.startX, e.clientY - st.startY);
    if (!st.active) {
      if (st.touch) { if (d > 10) { clearTimeout(st.timer); st = null; } return; }
      if (d > 6) begin(); else return;
    }
    move(e.clientX, e.clientY);
  };
  const onCancel = () => { if (st && !st.active) { clearTimeout(st.timer); st = null; } else end(); };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', onCancel);
  // Evita que la página haga scroll mientras se arrastra en táctil
  container.addEventListener('touchmove', e => { if (st && st.active) e.preventDefault(); }, { passive: false });
  container.addEventListener('contextmenu', e => { if (st) e.preventDefault(); });
  container.addEventListener('click', e => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
  return {
    get dragging() { return !!(st && st.active); },
    destroy() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', onCancel);
    },
  };
}
