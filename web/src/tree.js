// Tree view: an org chart of who reports to whom (tree-model.js builds and lays it out).
//
// Wide panels get a top-down chart you pan (drag, scroll) and zoom (pinch, Cmd/Ctrl-scroll, the
// buttons); narrow panels and phones get an indented outline. Either way only items near the
// viewport are in the DOM, cards are keyed by id and patched in place, and a poll keeps the
// expand/collapse state, the camera (or scroll) and focus; if items above move, the view shifts
// with them so what you were looking at stays put. No conversation text: names and statuses only.
import { ROLE_NAME, BUCKET_NAME, isError, isPrompt, bucketIcon, icon, ago, esc, h, agentColor } from './ui.js';
import { rank, syncNodes } from './order.js';
import { buildTree, layout, outline, family, groupKey, SOLO_KEY, DIM } from './tree-model.js';
import { stoppedNote } from './important.js';

const RH = 48;            // outline row height
const NARROW = 640;       // below this list width, the outline replaces the chart
const MARGIN = 400;       // px around the viewport that are rendered too
const K_MIN = 0.15, K_MAX = 2;
const SVGNS = 'http://www.w3.org/2000/svg';

const statusWord = a => (isError(a) ? 'Error' : isPrompt(a) ? 'Needs a click' : a.bucket === 'stalled' ? 'Needs you' : BUCKET_NAME[a.bucket] || a.bucket);
const tone = a => (isError(a) ? 'error' : isPrompt(a) ? 'prompt' : a.bucket);

export function createTree({ S, app, matches, filtering }) {
  const st = { open: new Set(), collapsed: new Set(), focus: null, cam: { x: 0, y: 0, k: 1 }, hint: null, reveal: null };
  const list = document.getElementById('list');
  const root = h('div', { class: 'tv' });
  const bar = h('div', { class: 'tvbar', role: 'toolbar', 'aria-label': 'Tree view' });
  bar.innerHTML = `<button class="ghost" type="button" data-tv="expand" title="Open every resting pill and folded team">Expand all</button>
    <button class="ghost" type="button" data-tv="live" title="Fold everything back to the agents that are awake">Collapse to live</button>
    <span class="tvcount num" aria-live="off"></span><span class="spacer"></span>
    <span class="tvzoom"><button class="iconbtn" type="button" data-tv="out" aria-label="Zoom out" title="Zoom out (−)">−</button><button class="iconbtn" type="button" data-tv="in" aria-label="Zoom in" title="Zoom in (+)">+</button><button class="ghost" type="button" data-tv="fit" title="Fit the whole chart (0)">Fit</button></span>`;
  const port = h('div', { class: 'tvport' });
  const world = h('div', { class: 'tvworld' });
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'tvedges');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVGNS, 'path');
  svg.append(path);
  const layer = h('div', { class: 'tvtree', role: 'tree', 'aria-label': 'Who reports to whom' });
  world.append(svg, layer);
  port.append(world);
  root.append(bar, port);
  const count = bar.querySelector('.tvcount');

  let model = null, lay = null, rows = null, rowIdx = new Map(), mode = null, wrapW = 0, lastPath = null;
  const els = new Map(); // id -> element (cards and headings)

  // ---------- model ----------
  function rebuild() {
    model = buildTree(S.agents, { matches: filtering() ? matches : null, open: st.open, collapsed: st.collapsed, rank });
    const n = model.shown;
    count.textContent = model.filtering ? `${n} shown · ${model.match.size} match` : `${n} of ${model.total} shown`;
  }
  const portW = () => port.clientWidth || list.clientWidth || innerWidth;
  function pickMode() {
    const w = list.clientWidth || portW();
    return app.narrow() || w < NARROW ? 'outline' : 'chart';
  }

  // ---------- render (every poll and every state change) ----------
  function update() {
    const prev = mode === 'chart' ? lay?.items : null, prevRows = mode === 'outline' ? rowIdx : null;
    const anchor = pickAnchor();
    rebuild();
    mode = pickMode();
    root.classList.toggle('chart', mode === 'chart');
    root.classList.toggle('outline', mode === 'outline');
    list.classList.toggle('chart', mode === 'chart');
    if (!model.nodes.has(st.focus) && !model.groups.some(g => g.key === st.focus)) st.focus = model.groups[0]?.key ?? null;
    if (mode === 'chart') {
      rows = null; rowIdx = new Map();
      wrapW = Math.max(900, Math.round((portW() - 2 * DIM.PAD) / 200) * 200);
      lay = layout(model, { wrap: wrapW });
      if (lastPath !== lay.path) { path.setAttribute('d', lay.path); lastPath = lay.path; }
      svg.setAttribute('width', lay.width); svg.setAttribute('height', lay.height);
      world.style.width = `${lay.width}px`; world.style.height = `${lay.height}px`;
      if (prev && anchor && prev.has(anchor) && lay.items.has(anchor)) {
        const a = prev.get(anchor), b = lay.items.get(anchor);
        st.cam.x += (a.x - b.x) * st.cam.k; st.cam.y += (a.y - b.y) * st.cam.k;
      }
      clampCam();
      applyCam();
    } else {
      lay = null;
      rows = outline(model);
      rowIdx = new Map(rows.map((r, i) => [r.id, i]));
      world.style.transform = ''; world.style.width = ''; world.style.height = `${rows.length * RH}px`;
      if (prevRows && anchor && prevRows.has(anchor) && rowIdx.has(anchor)) {
        const dy = (rowIdx.get(anchor) - prevRows.get(anchor)) * RH;
        if (dy) list.scrollTop += dy;
      }
    }
    st.hint = null;
    if (st.reveal && (model.nodes.has(st.reveal))) { const id = st.reveal; st.reveal = null; st.focus = id; show(id, true); }
    cull();
  }
  // What should stay still on screen across this update: what the user just acted on, else the
  // focused item, else the item nearest the top-left of the viewport.
  function pickAnchor() {
    if (st.hint) return st.hint;
    if (layer.contains(document.activeElement) && st.focus) return st.focus;
    if (mode === 'chart' && lay) {
      const v = viewRect(0);
      let best = null, bd = Infinity;
      for (const [id, it] of lay.items) {
        if (it.x + it.w < v.x || it.x > v.x + v.w || it.y + it.h < v.y || it.y > v.y + v.h) continue;
        const d = (it.y - v.y) * 2 + (it.x - v.x);
        if (d < bd) { bd = d; best = id; }
      }
      return best;
    }
    if (mode === 'outline' && rows) return rows[Math.max(0, Math.floor((list.scrollTop - port.offsetTop) / RH))]?.id ?? null;
    return null;
  }

  // ---------- culling: only what's near the viewport is in the DOM ----------
  function viewRect(margin = MARGIN) {
    const { x, y, k } = st.cam;
    return { x: (-x - margin) / k, y: (-y - margin) / k, w: (port.clientWidth + 2 * margin) / k, h: (port.clientHeight + 2 * margin) / k };
  }
  function cull() {
    if (!model) return;
    const want = [];
    const pin = new Set([st.focus, S.selected]);
    if (layer.contains(document.activeElement)) pin.add(document.activeElement.dataset.id);
    const tab = st.focus;
    if (mode === 'chart') {
      const v = viewRect();
      for (const [id, it] of lay.items) {
        if (!pin.has(id) && it.kind === 'node' && (it.x + it.w < v.x || it.x > v.x + v.w || it.y + it.h < v.y || it.y > v.y + v.h)) continue;
        const el = item(id, null);
        if (!el) continue;
        place(el, it.x, it.y);
        want.push(el);
      }
    } else {
      const top = list.scrollTop - port.offsetTop - MARGIN, bot = top + list.clientHeight + 2 * MARGIN;
      rows.forEach((r, i) => {
        if (!pin.has(r.id) && r.kind === 'node' && (i * RH + RH < top || i * RH > bot)) return;
        const el = item(r.id, r);
        if (!el) return;
        place(el, 0, i * RH);
        want.push(el);
      });
    }
    for (const el of want) { const t = el.dataset.id === tab ? '0' : '-1'; if (el.getAttribute('tabindex') !== t) el.setAttribute('tabindex', t); }
    syncNodes(layer, want, false);
    if (els.size > want.length + 600) for (const [id, el] of els) if (!el.isConnected) els.delete(id);
  }
  function place(el, x, y) {
    if (el._x !== x || el._y !== y) { el.style.transform = `translate(${x}px, ${y}px)`; el._x = x; el._y = y; }
  }

  // ---------- items ----------
  function item(id, row) {
    const n = model.nodes.get(id);
    if (n) return card(n, row);
    const g = model.groups.find(x => x.key === id);
    return g ? head(g, row) : null;
  }
  function aria(el, level, setsize, pos, expanded) {
    const set = (k, v) => { if (v == null) el.removeAttribute(k); else if (el.getAttribute(k) !== String(v)) el.setAttribute(k, v); };
    set('aria-level', level); set('aria-setsize', setsize); set('aria-posinset', pos); set('aria-expanded', expanded);
  }
  function card(n, row) {
    const a = n.a;
    let el = els.get(n.id);
    if (!el || !el.classList.contains('tnode')) {
      el = h('div', { class: 'tnode', role: 'treeitem', 'data-id': n.id, 'data-act': 'tree', tabindex: '-1' });
      els.set(n.id, el);
    }
    const now = S.data?.serverTime || Date.now();
    const t = ago(now - (a.since || now));
    const hasKids = n.kids.length > 0 || n.collapsed;
    const pill = n.pill;
    const roleK = a.role in ROLE_NAME ? a.role : 'solo';
    const tail = [ROLE_NAME[a.role] || a.role, a.live ? '' : 'not running',
      n.collapsed ? `${n.hidden} reports folded` : '',
      pill && !pill.open ? `${pill.n} resting under it, press Down to show` : '',
      n.ctx ? 'shown for context' : ''].filter(Boolean).join(', ');
    const stop = stoppedNote(a);
    const sig = [a.name, roleK, tone(a), a.live, a.important, stop, t, pill?.n, pill?.open, n.collapsed, n.hidden, hasKids, n.ctx, tail].join('|');
    if (el._sig !== sig) {
      el._sig = sig;
      el.innerHTML = `<span class="tn1">${icon(roleK, 'px role')}<span class="tnm" title="${esc(a.name)}">${esc(a.name)}</span>${a.important ? '<span class="star" title="Important" aria-label="Important">★</span>' : ''}<i class="live ${a.live ? '' : 'no'}" aria-hidden="true"></i></span>
        <span class="tn2" title="${esc(stop || a.reason || statusWord(a))}">${icon(bucketIcon(a))}<span class="tst">${esc(stop || statusWord(a))}</span><span class="tago num">· ${esc(t)}</span>${pill ? `<span class="tpill${pill.open ? ' on' : ''}" data-pill="${esc(n.id)}" aria-hidden="true" title="${pill.open ? 'Fold the resting ones back' : `Show ${pill.n} resting`}">${pill.open ? '− resting' : `+${pill.n} resting`}</span>` : ''}</span>
        ${hasKids ? `<span class="ttog" data-tog="${esc(n.id)}" aria-hidden="true" title="${n.collapsed ? 'Show reports' : 'Fold reports'}">${n.collapsed ? `+${n.hidden}` : '−'}</span>` : ''}
        <span class="sr">, ${esc(statusWord(a))}${tail ? `, ${esc(tail)}` : ''}</span>`;
    }
    el.className = `tnode r-${roleK} t-${tone(a)}${n.ctx ? ' ctx' : ''}${S.selected === n.id ? ' cur' : ''}${a.hidden ? ' is-hidden' : ''}`;
    el.setAttribute('aria-selected', String(S.selected === n.id));
    el.style.setProperty('--agent-color', agentColor(a));
    const sibs = n.parent.roots || n.parent.kids;
    aria(el, n.depth + 1, sibs.length, sibs.indexOf(n) + 1, hasKids || (pill && pill.n) ? String(n.kids.length > 0) : null);
    if (row) el.style.setProperty('--lvl', row.level - 1); else el.style.removeProperty('--lvl');
    return el;
  }
  function head(g, row) {
    let el = els.get(g.key);
    if (!el || !el.classList.contains('thd')) {
      el = h('div', { class: 'thd', role: 'treeitem', 'data-id': g.key, 'data-act': 'tree', tabindex: '-1' });
      els.set(g.key, el);
    }
    const p = g.pill;
    const what = g.kind === 'solo' ? 'resting' : `resting team${p?.teams === 1 ? '' : 's'}`;
    const html = `<span class="thn" title="${esc(g.project)}">${esc(g.project)}</span><span class="thc num">${g.agents}</span>${tallyHTML(g)}${p ? `<span class="tpill${p.open ? ' on' : ''}" data-pill="${esc(g.key)}" aria-hidden="true">${p.open ? `− ${what}` : `+${g.kind === 'solo' ? p.n : p.teams} ${what}`}</span>` : ''}<span class="sr">${p && !p.open ? `, ${p.n} resting, press Enter to show` : ''}</span>`;
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    el.className = `thd k-${g.kind}`;
    const i = model.groups.indexOf(g);
    aria(el, 1, model.groups.length, i + 1, String(g.roots.length > 0));
    if (row) el.style.setProperty('--lvl', 0);
    return el;
  }
  // Awake counts per heading (resting ones are the pill).
  function tallyHTML(g) {
    const c = { error: 0, prompt: 0, stalled: 0, waiting: 0, building: 0 };
    const walk = n => { const a = n.a; if (a.bucket !== 'resting') c[tone(a)]++; n.kids.forEach(walk); };
    g.roots.forEach(walk);
    const word = { error: 'errors', prompt: 'need a click', stalled: 'need you', waiting: 'waiting', building: 'building' };
    return `<span class="tally">${Object.keys(c).filter(k => c[k]).map(k => `<span class="tt ${k}">${icon(k)}<span class="num">${c[k]}</span><span class="sr"> ${word[k]}</span></span>`).join('')}</span>`;
  }

  // ---------- camera ----------
  function settle() {
    if (!root.isConnected || !model) return;
    if (mode === 'chart') { clampCam(); applyCam(); }
    cull();
  }
  function clampCam() {
    if (!lay || !root.isConnected) return; // a detached port measures 0×0; settle() clamps later
    const c = st.cam, vw = port.clientWidth || 800, vh = port.clientHeight || 600;
    const W = lay.width * c.k, H = lay.height * c.k, M = 60;
    c.x = W + 2 * M <= vw ? Math.min(Math.max(c.x, 0), vw - W) : Math.min(M, Math.max(c.x, vw - W - M));
    c.y = H + 2 * M <= vh ? Math.min(Math.max(c.y, 0), Math.max(0, vh - H)) : Math.min(M, Math.max(c.y, vh - H - M));
  }
  function applyCam() {
    const { x, y, k } = st.cam;
    world.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) scale(${k})`;
    root.style.setProperty('--k', k);
  }
  let raf = 0;
  const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; cull(); }); };
  function zoomAt(f, sx, sy) {
    const c = st.cam, k = Math.min(K_MAX, Math.max(K_MIN, c.k * f));
    c.x = sx - (sx - c.x) * (k / c.k); c.y = sy - (sy - c.y) * (k / c.k); c.k = k;
    clampCam(); applyCam(); later();
  }
  function fit() {
    if (!lay) return;
    const vw = port.clientWidth, vh = port.clientHeight;
    const k = Math.min(1, Math.max(K_MIN, Math.min((vw - 24) / lay.width, (vh - 24) / lay.height)));
    st.cam = { k, x: Math.max(0, (vw - lay.width * k) / 2), y: 0 };
    clampCam(); applyCam(); cull();
  }
  // Bring an item into view (chart: pan the least; outline: scroll the list).
  function show(id, center = false) {
    if (mode === 'chart') {
      const it = lay?.items.get(id);
      if (!it) return;
      const c = st.cam, vw = port.clientWidth, vh = port.clientHeight, pad = 24;
      const x0 = it.x * c.k + c.x, y0 = it.y * c.k + c.y, x1 = x0 + it.w * c.k, y1 = y0 + it.h * c.k;
      if (center) { c.x += vw / 2 - (x0 + x1) / 2; c.y += vh / 3 - (y0 + y1) / 2; }
      else {
        if (x0 < pad) c.x += pad - x0; else if (x1 > vw - pad) c.x -= x1 - (vw - pad);
        if (y0 < pad) c.y += pad - y0; else if (y1 > vh - pad) c.y -= y1 - (vh - pad);
      }
      clampCam(); applyCam();
    } else {
      const i = rowIdx.get(id);
      if (i == null) return;
      const top = port.offsetTop + i * RH, sticky = bar.offsetHeight;
      if (center) list.scrollTop = top - list.clientHeight / 3;
      else if (top - sticky < list.scrollTop) list.scrollTop = top - sticky;
      else if (top + RH > list.scrollTop + list.clientHeight) list.scrollTop = top + RH - list.clientHeight;
    }
  }

  // ---------- state changes ----------
  const rerender = () => app.render();
  function togglePill(id) { st.hint = id; st.open.has(id) ? st.open.delete(id) : st.open.add(id); rerender(); }
  function toggleFold(id, want) {
    const on = want ?? !st.collapsed.has(id);
    if (on === st.collapsed.has(id)) return false;
    st.hint = id; on ? st.collapsed.add(id) : st.collapsed.delete(id); rerender();
    return true;
  }
  function expandAll() {
    const all = buildTree(S.agents, { matches: filtering() ? matches : null, allOpen: true, rank });
    st.open = new Set(all.pills); st.collapsed.clear(); rerender();
  }
  function collapseToLive() { st.open.clear(); st.collapsed.clear(); rerender(); }

  // ---------- pointer: click, double-click, drag to pan, wheel, pinch ----------
  let drag = null, dragged = false;
  const pts = new Map();
  port.addEventListener('pointerdown', e => {
    if (mode !== 'chart' || (e.pointerType === 'mouse' && e.button !== 0)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { const [p, q] = [...pts.values()]; drag = { pinch: Math.hypot(p.x - q.x, p.y - q.y), k: st.cam.k }; return; }
    drag = { x: e.clientX, y: e.clientY, cx: st.cam.x, cy: st.cam.y, id: e.pointerId, moved: false };
  });
  port.addEventListener('pointermove', e => {
    if (!drag || !pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (drag.pinch) {
      const [p, q] = [...pts.values()], r = port.getBoundingClientRect();
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      zoomAt((drag.k * d / drag.pinch) / st.cam.k, (p.x + q.x) / 2 - r.left, (p.y + q.y) / 2 - r.top);
      dragged = true;
      return;
    }
    if (e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) { drag.moved = true; port.setPointerCapture(e.pointerId); port.classList.add('dragging'); }
    st.cam.x = drag.cx + dx; st.cam.y = drag.cy + dy;
    clampCam(); applyCam(); later();
  });
  const endDrag = e => {
    pts.delete(e.pointerId);
    if (!drag) return;
    if (drag.moved || drag.pinch) dragged = true;
    if (pts.size === 0 || drag.pinch) { drag = null; port.classList.remove('dragging'); }
  };
  port.addEventListener('pointerup', endDrag);
  port.addEventListener('pointercancel', endDrag);
  // A drag ends in a click; it must not open or deselect anything.
  root.addEventListener('click', e => { if (dragged) { dragged = false; e.stopPropagation(); e.preventDefault(); } }, true);
  port.addEventListener('wheel', e => {
    if (mode !== 'chart') return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? port.clientHeight : 1;
    if (e.ctrlKey || e.metaKey) {
      const r = port.getBoundingClientRect();
      zoomAt(Math.exp(Math.max(-0.7, Math.min(0.7, -e.deltaY * unit * 0.01))), e.clientX - r.left, e.clientY - r.top);
    } else {
      st.cam.x -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit;
      st.cam.y -= (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit;
      clampCam(); applyCam(); later();
    }
  }, { passive: false });

  root.addEventListener('click', e => {
    const t = e.target;
    const tv = t.closest('[data-tv]')?.dataset.tv;
    if (tv) {
      if (tv === 'expand') return expandAll();
      if (tv === 'live') return collapseToLive();
      if (tv === 'fit') return fit();
      if (tv === 'in' || tv === 'out') return zoomAt(tv === 'in' ? 1.25 : 0.8, port.clientWidth / 2, port.clientHeight / 2);
      return;
    }
    const it = t.closest('.tnode, .thd');
    if (!it) return;
    const id = it.dataset.id;
    st.focus = id;
    const pill = t.closest('[data-pill]'), tog = t.closest('[data-tog]');
    if (pill) return togglePill(pill.dataset.pill);
    if (tog) return toggleFold(tog.dataset.tog);
    if (it.classList.contains('thd')) { const g = model.groups.find(x => x.key === id); if (g?.pill) togglePill(id); else { cull(); it.focus({ preventScroll: true }); } return; }
    if (e.detail === 2) return; // the dblclick handler opens it
    it.focus({ preventScroll: true });
    app.select(S.selected === id && !S.term ? null : id);
  });
  root.addEventListener('dblclick', e => {
    const it = e.target.closest('.tnode');
    if (it && !e.target.closest('[data-pill], [data-tog]')) app.activate(it.dataset.id);
  });

  // ---------- keyboard: a proper tree ----------
  function focusItem(id) {
    if (!id) return;
    st.focus = id;
    show(id);
    cull();
    els.get(id)?.focus({ preventScroll: true });
  }
  const after = fn => fn(); // toggles render synchronously; this runs on the new model
  layer.addEventListener('keydown', e => {
    const it = e.target.closest?.('.tnode, .thd');
    if (!it || e.metaKey || e.ctrlKey || e.altKey) return;
    const id = it.dataset.id, f = family(model, id);
    if (!f) return;
    const n = model.nodes.get(id), g = !n && model.groups.find(x => x.key === id);
    const items = mode === 'outline' ? rows.map(r => r.id) : null;
    // Down / Right into the children: a folded team unfolds, a closed resting pill opens.
    const into = () => {
      if (f.kids.length) return focusItem(f.kids[0]);
      if (n?.collapsed) { toggleFold(id, false); return after(() => focusItem(family(model, id)?.kids[0])); }
      const p = n ? n.pill : g?.pill;
      if (p && !p.open) { togglePill(id); return after(() => focusItem(family(model, id)?.kids[0])); }
    };
    const k = e.key;
    let done = true;
    if (mode === 'chart') {
      if (k === 'ArrowUp') focusItem(f.parent);
      else if (k === 'ArrowDown') into();
      else if (k === 'ArrowLeft') focusItem(f.prev);
      else if (k === 'ArrowRight') focusItem(f.next);
      else done = false;
    } else {
      const i = items.indexOf(id);
      if (k === 'ArrowUp') focusItem(items[i - 1]);
      else if (k === 'ArrowDown') focusItem(items[i + 1]);
      else if (k === 'ArrowRight') { if (it.getAttribute('aria-expanded') === 'true') focusItem(f.kids[0]); else into(); }
      else if (k === 'ArrowLeft') {
        if (n && n.kids.length) { toggleFold(id, true); focusItem(id); } else focusItem(f.parent);
      } else done = false;
    }
    if (!done) {
      if (k === 'Home') focusItem(model.groups[0]?.key);
      else if (k === 'End') focusItem(mode === 'outline' ? items[items.length - 1] : model.groups[model.groups.length - 1]?.key);
      else if (k === 'Enter') { if (n) { if (S.selected === id) app.menu(id, { el: it }); else app.select(id); } else if (g?.pill) togglePill(id); }
      else if (k === ' ') {
        if (n && (n.kids.length || n.collapsed)) { toggleFold(id); after(() => focusItem(id)); }
        else if (n?.pill || g?.pill) { togglePill(id); after(() => focusItem(id)); }
      } else if (mode === 'chart' && (k === '+' || k === '=')) zoomAt(1.25, port.clientWidth / 2, port.clientHeight / 2);
      else if (mode === 'chart' && k === '-') zoomAt(0.8, port.clientWidth / 2, port.clientHeight / 2);
      else if (mode === 'chart' && k === '0') fit();
      else return;
    }
    e.preventDefault();
    e.stopPropagation();
  });
  layer.addEventListener('focusin', e => { const id = e.target.dataset?.id; if (id) st.focus = id; });

  list.addEventListener('scroll', () => { if (root.isConnected && mode === 'outline') later(); }, { passive: true });
  let lastSize = '';
  new ResizeObserver(() => {
    if (!root.isConnected) return;
    const s = `${port.clientWidth}x${port.clientHeight}x${list.clientWidth}`;
    if (s === lastSize) return;
    lastSize = s;
    const m = pickMode(), w = Math.max(900, Math.round((portW() - 2 * DIM.PAD) / 200) * 200);
    if (m !== mode || (m === 'chart' && w !== wrapW)) update(); else { clampCam(); if (mode === 'chart') applyCam(); cull(); }
  }).observe(root);

  return {
    el: root,
    render() {
      if (!S.data) return [];
      update();
      // The panel inserts the root after this returns. Until then the port has no size (it may
      // just have been re-attached), so clamp and cull again once it's in the page: culling
      // against a 0-wide viewport would leave cards out while their connectors were drawn.
      queueMicrotask(settle);
      return [root];
    },
    // Selecting from elsewhere (hash, village, search): unfold the way to it and centre it.
    reveal(id) {
      const a = S.byId.get(id);
      if (!a) return;
      const up = [];
      for (let p = a.parentId, g = 0; p && S.byId.has(p) && g < 60; p = S.byId.get(p).parentId, g++) up.push(p);
      // An awake agent keeps its whole chain awake; only a resting one sits behind pills.
      const resting = a.bucket === 'resting';
      for (const p of up) { st.collapsed.delete(p); if (resting) st.open.add(p); }
      const top = up.length ? S.byId.get(up[up.length - 1]) : a;
      if (resting) { st.open.add(groupKey(top.project || '—')); st.open.add(SOLO_KEY); }
      st.reveal = id;
    },
    state: st,
  };
}
