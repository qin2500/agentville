// Engine input controller (M4 P1): pointer, wheel, keyboard and menu behaviour mirrored from classic village.js.
// Pure of DOM globals except what `cv`/`host` expose (addEventListener, getBoundingClientRect, classList, setPointerCapture),
// all optional-chained so a tiny fake EventTarget drives it in node.
const LONG_PRESS_MS = 500;

/** Classic neighbourhood hit: a tile inside a village block grown by `pad` tiles. Returns the village or null. */
export function villageAtTile(villages, tx, ty, pad = 1) {
  for (const v of villages || []) {
    const b = v.block;
    if (b && tx >= b.x - pad && tx < b.x + b.w + pad && ty >= b.y - pad && ty < b.y + b.h + pad) return v;
  }
  return null;
}

/** Bind #zoom-in / #zoom-out / #zoom-reset. parity: camera.zoom-buttons, camera.reset-button */
export function bindZoomButtons(doc, camera) {
  const off = [];
  const on = (id, fn) => { const el = doc?.getElementById?.(id); if (el) { el.addEventListener('click', fn); off.push(() => el.removeEventListener?.('click', fn)); } };
  on('zoom-in', () => camera.zoomStep(1));
  on('zoom-out', () => camera.zoomStep(-1));
  on('zoom-reset', () => camera.reset());
  return () => off.forEach(f => f());
}

export function attachInput({ cv, host, camera, getHits, pick, alphaAt, resolve, villageAt, order, screenAt, centerOf, selected, app, isDemoId = () => false, onChange, emit, openPanel, timers } = {}) {
  const setT = (f, ms) => (timers || globalThis).setTimeout(f, ms), clearT = i => (timers || globalThis).clearTimeout(i);
  const fire = emit || ((name, detail) => globalThis.window?.dispatchEvent?.(new CustomEvent(name, { detail })));
  const st = { hover: null, hoverVil: null, hoverPanel: null, cursor: null, cursorKind: '' };
  const api = { get hover() { return st.hover; }, get hoverVil() { return st.hoverVil; }, get hoverPanel() { return st.hoverPanel; }, get cursor() { return st.cursor; }, get cursorStyle() { return st.cursorKind; }, detach };
  let drag = null, press = null;

  const changed = () => onChange?.({ hover: st.hover, hoverVil: st.hoverVil, hoverPanel: st.hoverPanel, cursor: st.cursor, cursorStyle: st.cursorKind });
  const css = e => { const r = cv.getBoundingClientRect?.() || { left: 0, top: 0 }; return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  /** What a CSS point means: { id, house? } | { village } | { panel } | null (panel: a host panel key, 'link:<href>' or any other key). */
  function what(e) {
    const p = css(e), hit = pick(getHits?.() || [], p.x, p.y, { alphaAt });
    let r = hit ? resolve(hit) : null;
    if (!r && camera.cam.z < 1) { const v = villageAt?.(p.x, p.y); if (v) r = { village: v }; }
    return r;
  }
  const centerFor = id => {
    const c = centerOf?.(id);
    if (c) return c;
    const s = screenAt?.(id);
    if (!s || s.el || !Number.isFinite(s.x)) return null;
    const r = cv.getBoundingClientRect?.() || { left: 0, top: 0 };
    return camera.cssToTile(s.x - r.left, s.y - r.top);
  };

  // parity: inp.hover-cursor-state
  function setCursorStyle(k) { st.cursorKind = k; host?.classList?.toggle?.('hovering', k === 'pointer'); host?.classList?.toggle?.('dragging', k === 'grabbing'); }
  const onMove = e => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; clearT(press); setCursorStyle('grabbing'); }   // parity: camera.drag-pan-threshold
      if (drag.moved) { camera.panBy(e.clientX - drag.lx, e.clientY - drag.ly); drag.lx = e.clientX; drag.ly = e.clientY; changed(); }
      return;
    }
    const p = what(e), id = p?.id || null, vil = p?.village?.name || null, panel = p?.panel || null;
    const hover = p?.house ? null : id;
    setCursorStyle(id || p?.village || p?.panel ? 'pointer' : '');
    if (hover !== st.hover || vil !== st.hoverVil || panel !== st.hoverPanel) { st.hover = hover; st.hoverVil = vil; st.hoverPanel = panel; }
    changed();
  };
  const onDown = e => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false };
    try { cv.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
    clearT(press);
    // parity: inp.right-click-long-press-menu: a long press on an agent or house opens its menu
    if (e.pointerType && e.pointerType !== 'mouse') {
      const at = { clientX: e.clientX, clientY: e.clientY };
      press = setT(() => {
        if (!drag || drag.moved) return;
        const p = what(at);
        if (!p?.id || isDemoId(p.id)) return;
        drag = null; setCursorStyle('');
        app.menu(p.id, { x: at.clientX, y: at.clientY });
      }, LONG_PRESS_MS);
    }
  };
  const onUp = e => {
    clearT(press);
    const d = drag; drag = null;
    setCursorStyle('');
    if (!d) return;
    if (d.moved) { camera.endDrag(); changed(); return; }
    const p = what(e);
    // parity: inp.map-click-zooms-village
    if (p?.village) { const v = p.village; camera.centerOn({ x: v.x ?? v.cx, y: v.y ?? v.cy }, { animate: true, zoomIn: true }); return; }
    if (p?.id && isDemoId(p.id)) return;
    // a host panel hit (the host maps its own hit kinds, engine-host.js): opens with the link it carries, if any
    if (p?.panel) { const k = String(p.panel); (openPanel || (h => fire('va:panel', { href: h })))(k.startsWith('link:') ? k.slice(5) : null); return; }
    app.select(p ? p.id : null, { fromVillage: true, pan: false });   // parity: inp.click-select
  };
  const onCancel = () => { clearT(press); if (drag?.moved) camera.endDrag(); drag = null; setCursorStyle(''); };
  const onLeave = () => { if (st.hover || st.hoverPanel || st.hoverVil) { st.hover = st.hoverPanel = st.hoverVil = null; changed(); } if (!drag) setCursorStyle(''); };
  // parity: inp.double-click-terminal
  const onDbl = e => { const p = what(e); if (p?.id && !p.village && !isDemoId(p.id)) app.activate(p.id, { x: e.clientX, y: e.clientY }); };
  // parity: inp.right-click-long-press-menu
  const onCtx = e => {
    const p = what(e);
    if (!p?.id) return;
    e.preventDefault();
    if (isDemoId(p.id)) return;
    const kb = e.clientX === 0 && e.clientY === 0;
    app.menu(p.id, kb ? screenAt(p.id) : { x: e.clientX, y: e.clientY });
  };
  const onWheel = e => { e.preventDefault(); camera.wheel(e.deltaY, css(e)); };   // parity: camera.wheel-anchor
  // parity: inp.keyboard-cycle-by-bucket, inp.keyboard-enter-select, inp.keyboard-menu-keys
  const onKey = e => {
    const sel = () => st.cursor || selected?.() || null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const ids = order() || [];
      if (!ids.length) return;
      const i = ids.indexOf(sel());
      st.cursor = ids[(i + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length];
      const c = centerFor(st.cursor);
      if (c) camera.centerOn(c, { animate: true });
      changed();
    } else if (e.key === 'Enter' && st.cursor) { e.preventDefault(); app.select(st.cursor, { fromVillage: true }); }
    else if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && sel()) { e.preventDefault(); app.menu(sel(), screenAt(sel())); }
  };
  const onBlur = () => { if (st.cursor) { st.cursor = null; changed(); } };

  const L = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onCancel], ['pointerleave', onLeave],
    ['dblclick', onDbl], ['contextmenu', onCtx], ['wheel', onWheel, { passive: false }], ['keydown', onKey], ['blur', onBlur]];
  for (const [n, f, o] of L) cv.addEventListener(n, f, o);
  function detach() { clearT(press); for (const [n, f, o] of L) cv.removeEventListener?.(n, f, o); }
  return api;
}
