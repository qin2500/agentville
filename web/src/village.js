// The village world (docs/ARCHITECTURE.md, "The village"): one compact town of project neighbourhoods. world.js does layout
// (stable, persisted) and sprite rendering; quiet.js decides which projects show; this file owns the
// camera (Map, 1–4×, clamped to the world), input, selection, DOM labels and the frame loop. If the sprite sheets fail to load, the same layout is
// drawn procedurally below. Frames run at 8 fps only while visible and animating; otherwise on demand.
import { BUCKET_NAME, ROLE_NAME, store, icon, esc } from './ui.js';
import { T, ZOOMS, R, ISO, plan, layout, placeAgents, loadSheets, SEA_DEEP, isoP, isoInv, itemBox, agentOffset } from './world.js';
import { visibleProjects } from './quiet.js';
import { folds } from './important.js';
import { dockData, dockDemo, demoDock, dockSig, dockRect, dockGeom } from './dock-art.js';

const FPS = 8;

export function createVillage(app) {
  const { S } = app;
  const host = document.getElementById('village');
  const cv = document.getElementById('cv');
  const labels = document.getElementById('labels');
  const ctx = cv.getContext('2d');
  const seenOrder = store.get('va.seen', []);
  const seenIdx = new Map(seenOrder.map((id, i) => [id, i]));
  const nightParam = new URLSearchParams(location.search).get('night');
  const quietNote = document.getElementById('quiet-note');
  const emptyNote = document.getElementById('empty-note');
  // The village is isometric (2.5D) only: the top-down view and its toggle are gone.
  const CAM_KEY = 'va.cam.iso'; // va.cam was the island world's camera, va.cam2 the top-down view's
  const savedCam = store.get(CAM_KEY, null);

  let zoom = savedCam?.z < 1 || ZOOMS.includes(savedCam?.z) ? savedCam.z : 2, cam = savedCam ? { x: savedCam.x, y: savedCam.y } : { x: 0, y: 0 }, tween = null;
  let userMoved = !!savedCam;
  let W = null, sig = '', placed = { vill: new Map(), crowd: new Map() }, counts = new Map(), shownAgents = [], quiet = [];
  let state = { loading: true, offline: false };
  let selected = null, hover = null, hoverVil = null, hoverDock = null, cursor = null, altTags = false;
  let hits = [], houseHits = [], clusters = [], lastBadges = [], simpleDock = [];
  let timer = 0, raf = 0;
  let renderer = null, artState = 'loading';
  cv.dataset.art = 'loading';
  loadSheets().then(r => { renderer = r; artState = cv.dataset.art = 'ready'; if (W) renderer.prepare(W); invalidate(); })
    .catch(e => { artState = cv.dataset.art = 'failed'; console.warn(`Village art unavailable, using the simple renderer: ${e.message}`); invalidate(); });

  // ?dockdemo=1: fake PRs at the dock for the whole page (the click panel reads S.dock too); the
  // server's own S.dock is ignored meanwhile.
  // The demo's PRs belong to resting agents when there are some, so their villagers walk crates down too.
  if (dockDemo()) Object.defineProperty(S, 'dock', { configurable: true, enumerable: true, get: () => demoDock(Date.now(), (S.agents || []).filter(a => a.bucket === 'resting' && !a.hidden)), set() {} });

  // ---------- model ----------
  function build() {
    let changed = false;
    for (const a of S.agents) if (!seenIdx.has(a.id)) { seenIdx.set(a.id, seenOrder.length); seenOrder.push(a.id); changed = true; }
    if (changed) {
      if (seenOrder.length > 3000) seenOrder.splice(0, seenOrder.length - 3000); // ponytail: trim the oldest ids
      store.set('va.seen', seenOrder);
    }
    // Quiet projects (every agent resting, nothing for a day) are left out of the village, not the list.
    // The selected agent's project always shows, so selecting from the list still finds its villager.
    const sel = selected && S.byId.get(selected);
    const vis = visibleProjects(S.agents, { hideQuiet: S.hideQuiet, keep: sel ? [sel.project || '—'] : [] });
    shownAgents = S.agents.filter(a => vis.shown.has(a.project || '—'));
    quiet = vis.quiet;
    updateQuietNote();
    if (!shownAgents.length) { W = null; sig = ''; placed = { vill: new Map(), crowd: new Map() }; return; }
    const P = plan(shownAgents, S.byId, S.data?.projects);
    if (P.sig !== sig) { // the world only re-lays out when something is added or removed
      sig = P.sig;
      W = layout(P);
      cv.dataset.villages = W.villages.length;
      if (renderer) renderer.prepare(W);
    }
    placed = placeAgents(W, shownAgents, S.byId, seenIdx);
    counts = new Map();
    for (const a of shownAgents) {
      if (a.hidden) continue;
      const c = counts.get(a.project || '—') || { need: 0, error: 0, prompt: 0, wait: 0 };
      if (a.bucket === 'stalled') c[a.severity === 'error' ? 'error' : a.prompt ? 'prompt' : 'need']++;
      else if (a.bucket === 'waiting') c.wait++;
      counts.set(a.project || '—', c);
    }
  }

  // "N quiet projects hidden · Show": small, in the village's bottom-right corner, only when some are.
  function updateQuietNote() {
    const n = quiet.length;
    quietNote.hidden = !n;
    if (!n || quietNote.dataset.n === String(n)) return;
    quietNote.dataset.n = String(n);
    quietNote.innerHTML = `<span>${n} quiet project${n === 1 ? '' : 's'} hidden</span><button type="button" class="ghost">Show</button>`;
    quietNote.title = `Nothing has happened in these for a day: ${quiet.slice(0, 10).join(', ')}${n > 10 ? ', …' : ''}. Settings → Hide quiet projects.`;
  }
  quietNote.addEventListener('click', e => { if (e.target.closest('button')) app.setHideQuiet(false); });

  // ---------- camera ----------
  // Canvas pixels: at 1–4× one canvas px is `zoom` CSS px (cheap, crisp); at Map (0.5×) the canvas is
  // CSS-sized and the world is drawn at half size. k = world px → canvas px.
  const reduce = () => S.reduceMotion;
  const active = () => !document.hidden && (S.panel !== 'full' || S.peek || document.body.classList.contains('village-only')) && host.clientWidth > 0; // S.peek: peek.js; village-only: zen.js
  // Map (any zoom < 1) is a fit level: the largest of ½, ¼, ⅛ that shows the whole town (every
  // neighbourhood, its streets and the square), centred; the forest ring and the sea fill the rest.
  // The dock's cove and first berths count as town, so the whole-town view shows them too.
  const land = () => {
    if (!W.dock) return W.town;
    const [a, b, c, d] = W.town, [e, g, h, i] = dockRect(W.dock);
    return [Math.min(a, e), Math.min(b, g), Math.max(c, h), Math.max(d, i)];
  };
  // View px: the isometric projection of world px (the simple fallback renderer draws in it too).
  const P = isoP;
  const shift = ([x, y], [ox, oy]) => [x + ox, y + oy];
  /** A tile rect [x0, y0, x1, y1] (inclusive) as a box in view px. */
  function box([x0, y0, x1, y1]) {
    const cs = [P(x0 * T, y0 * T), P((x1 + 1) * T, y0 * T), P(x0 * T, (y1 + 1) * T), P((x1 + 1) * T, (y1 + 1) * T)];
    return [Math.min(...cs.map(c => c[0])), Math.min(...cs.map(c => c[1])), Math.max(...cs.map(c => c[0])), Math.max(...cs.map(c => c[1]))];
  }
  function mapZoom() {
    if (!W) return 0.5;
    const [x0, y0, x1, y1] = box(land());
    return [0.5, 0.25].find(z => (x1 - x0 + 2 * T) * z <= host.clientWidth && (y1 - y0 + 2 * T) * z <= host.clientHeight) ?? 0.125;
  }
  function view() {
    if (zoom < 1) zoom = mapZoom();
    const px = zoom >= 1 ? zoom : 1, k = zoom / px;
    const cw = Math.ceil(host.clientWidth / px), ch = Math.ceil(host.clientHeight / px);
    const bw = cw / k, bh = ch / k;
    clamp(bw, bh);
    return { px, k, cw, ch, bw, bh, vx: Math.round(cam.x - bw / 2), vy: Math.round(cam.y - bh / 2) };
  }
  // The camera stays over the world (land + 10 tiles of sea); a world smaller than the view is centred.
  function clamp(bw, bh) {
    if (!W) return;
    if (zoom < 1) { const [x0, y0, x1, y1] = box(land()); cam.x = (x0 + x1) / 2; cam.y = (y0 + y1) / 2; return; }
    const [x0, y0, x1, y1] = box([W.bounds[0], W.bounds[1], W.bounds[2] - 1, W.bounds[3] - 1]);
    cam.x = x1 - x0 < bw ? (x0 + x1) / 2 : Math.min(Math.max(cam.x, x0 + bw / 2), x1 - bw / 2);
    cam.y = y1 - y0 < bh ? (y0 + y1) / 2 : Math.min(Math.max(cam.y, y0 + bh / 2), y1 - bh / 2);
  }
  const remember = () => { userMoved = true; store.set(CAM_KEY, { x: Math.round(cam.x), y: Math.round(cam.y), z: zoom }); };
  function nightAmount() {
    if (nightParam != null) return nightParam === '1' ? 1 : 0;
    const d = new Date(), hr = d.getHours() + d.getMinutes() / 60;
    return hr >= 20 || hr < 6 ? 1 : hr >= 18 ? (hr - 18) / 2 : hr < 8 ? (8 - hr) / 2 : 0;
  }

  function draw(now) {
    if (!host.clientWidth) return;
    const v = view();
    if (cv.width !== v.cw || cv.height !== v.ch) { cv.width = v.cw; cv.height = v.ch; }
    const cssW = `${v.cw * v.px}px`, cssH = `${v.ch * v.px}px`;
    if (cv.style.width !== cssW || cv.style.height !== cssH) { cv.style.width = cssW; cv.style.height = cssH; }
    ctx.imageSmoothingEnabled = false;
    const still = reduce() || state.offline;
    const t = still ? 0 : now / 1000;
    const selV = selected && placed.vill.get(selected);
    houseHits = [];
    if (W) {
      const restingHomes = new Map();
      for (const p of placed.vill.values()) if (folds(p.a) && p.own) restingHomes.set(p.home.id, [...(restingHomes.get(p.home.id) || []), p.a.id]);
      for (const it of W.items) if (restingHomes.has(it.id)) { const [x, y, w, h] = itemBox(it); houseHits.push({ ids: restingHomes.get(it.id), x, y, w, h }); }
    }
    const f = { ctx, k: v.k, vx: v.vx, vy: v.vy, bw: v.bw, bh: v.bh, zoom, t, still, night: nightAmount(), agents: placed.vill,
      selected, cursor, selectedHome: selV && (folds(selV.a) || selV.crowd) ? selV.home.id : null, dock: dockData(S), dockHover: hoverDock };
    if (W && artState === 'ready') hits = renderer.draw(f);
    else if (W && artState === 'failed') hits = drawSimple(f);
    else { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = SEA_DEEP; ctx.fillRect(0, 0, cv.width, cv.height); hits = []; }
    placeLabels(v);
  }

  // ---------- procedural fallback: the same layout as plain shapes, in the same iso projection ----------
  function drawSimple(f) {
    const { k, vx, vy, bw, bh } = f;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = SEA_DEEP; ctx.fillRect(0, 0, cv.width, cv.height);
    // The ground: world tiles through the iso transform (as the sprite renderer does).
    const cs = [isoInv(vx, vy), isoInv(vx + bw, vy), isoInv(vx, vy + bh), isoInv(vx + bw, vy + bh)];
    const x0 = Math.floor(Math.min(...cs.map(c => c[0])) / T) - 1, x1 = Math.ceil(Math.max(...cs.map(c => c[0])) / T) + 1;
    const y0 = Math.floor(Math.min(...cs.map(c => c[1])) / T) - 1, y1 = Math.ceil(Math.max(...cs.map(c => c[1])) / T) + 1;
    ctx.setTransform(k * ISO, k * ISO / 2, -k * ISO, k * ISO / 2, -vx * k, -vy * k);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const key = `${x},${y}`;
      if (!W.land.has(key)) continue;
      ctx.fillStyle = W.street.has(key) ? '#6f5a40' : W.path.has(key) ? '#8a7353' : (x + y) % 2 ? '#3b5d3a' : '#43683f';
      ctx.fillRect(x * T, y * T, T + 0.5, T + 0.5);
    }
    for (const v of W.villages) { const b = v.block; ctx.globalAlpha = 0.16; ctx.fillStyle = v.accent; ctx.fillRect(b.x * T, b.y * T, b.w * T, b.h * T); ctx.globalAlpha = 1; }
    simpleDock = [];
    let ships = [];
    if (W.dock) { // the dock: the pier on the water, and a hull at each berth with a PR loading
      const G = dockGeom(W.dock, f.dock.level);
      ctx.fillStyle = '#9a6a40'; ctx.fillRect(G.X0, G.Y0, G.X1 - G.X0, G.Y1 - G.Y0);
      ships = G.berths.slice(0, (f.dock.loading || []).length);
      const [a] = P(G.X0, G.Y1), [b] = P(G.X1, G.Y0), [, c] = P(G.X0, G.Y0), [, d] = P(G.X1, G.Y1);
      simpleDock.push({ key: 'dock', x: a, y: c, w: b - a, h: d - c });
    }
    ctx.setTransform(k, 0, 0, k, -vx * k, -vy * k);
    for (const b of ships) {
      const [x, y] = P(b.x, b.y + 23).map(Math.round);
      ctx.fillStyle = '#1a1c22'; ctx.fillRect(x - 12, y - 24, 24, 30);
      ctx.fillStyle = '#6a4630'; ctx.fillRect(x - 11, y - 4, 22, 9);
      ctx.fillStyle = '#f3ead2'; ctx.fillRect(x - 8, y - 23, 16, 18);
      simpleDock.push({ key: 'dock', x: x - 12, y: y - 24, w: 24, h: 30 });
    }
    // Buildings and villagers, back to front.
    const things = [];
    for (const it of W.items) if (it.kind === 'home' || it.kind === 'pr') things.push({ it, d: (it.x + it.w + it.y + it.h) * T });
    for (const p of f.agents.values()) if (!folds(p.a) && !p.crowd) things.push({ p, d: (p.pose === 'carry' ? p.x0 : p.x) + p.y });
    const out = [];
    for (const { it, p } of things.sort((a, b) => a.d - b.d)) {
      if (it) {
        const [x, y, w, h] = itemBox(it), roof = Math.round(h * 0.45);
        ctx.fillStyle = '#1a1c22'; ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
        ctx.fillStyle = it.kind === 'pr' ? (it.building ? '#8f8a86' : '#3f5a8c') : '#9c3f35'; ctx.fillRect(x, y, w, roof);
        ctx.fillStyle = '#9a6a3e'; ctx.fillRect(x, y + roof, w, h - roof);
        continue;
      }
      const fx = p.pose === 'carry' ? p.x0 : p.x, [ox, oy] = agentOffset({ x: fx, y: p.y });
      const left = Math.round(fx - 6 + ox), feet = p.y + oy, top = feet - 16;
      ctx.fillStyle = '#1a1c22'; ctx.fillRect(left - 1, top - 1, 14, 18);
      ctx.fillStyle = p.a.role === 'boss' ? '#f2c14e' : p.a.role === 'sub' ? '#7d8290' : '#e8b48a'; ctx.fillRect(left, top, 12, 16);
      if (p.a.id === selected || p.a.id === cursor) { ctx.strokeStyle = '#eaf2ff'; ctx.lineWidth = 1; ctx.strokeRect(left - 2.5, top - 2.5, 17, 21); }
      let t = top;
      if (p.a.bucket === 'stalled' || p.a.bucket === 'waiting') {
        t = top - 10;
        ctx.fillStyle = p.a.bucket === 'waiting' ? '#3d7be0' : p.a.severity === 'error' ? '#e5383b' : p.a.prompt ? '#9b5de5' : '#f5a623';
        ctx.fillRect(left + 2, t, 8, 8);
      }
      out.push({ id: p.a.id, x: left - 2, y: t, w: 16, h: feet - t, cx: left + 6, top: t, wx: fx, wy: p.y });
    }
    return out;
  }

  // ---------- DOM labels ----------
  // Priority order; a tag that would overlap one already placed is skipped: selected > keyboard
  // cursor > hover > village signs > stalled (errors, then longest waiting) > PR numbers > crowds > Alt.
  const labelEls = new Map();
  const measure = document.createElement('canvas').getContext('2d');
  const textW = new Map();
  const width = (text, font) => { const k = font + text; if (!textW.has(k)) { measure.font = font; textW.set(k, measure.measureText(text).width); } return textW.get(k); };
  function placeLabels(v) {
    const cands = [];
    const add = (key, pri, cls, text, x, y, center = false, accent, dy = 0) => { const c = { key, pri, cls, text, x, y, center, accent, dy }; cands.push(c); return c; };
    const s = v.k * v.px; // CSS px per world px
    // At Map a village is one plate: its name with its counts under it, shown or hidden whole.
    // Plates with counts outrank the rest (errors, then needs-you, then waiting); hover shows any.
    if (W) for (const vil of W.villages) {
      const c = zoom < 1 && counts.get(vil.name), parts = c ? [['prompt', c.prompt], ['error', c.error], ['stalled', c.need], ['waiting', c.wait]].filter(p => p[1]) : [];
      const pri = vil.name === hoverVil ? 0 : parts.length ? 3 - Math.min(0.9, ((c.error + c.prompt) * 1e6 + c.need * 1e3 + c.wait) / 1e7) : 3.95;
      const [sx, sy] = shift(P((vil.plaza.x + vil.plaza.w / 2) * T, (vil.plaza.y + 1) * T), [0, -(zoom < 1 ? 40 : 20)]);
      const cand = add(`v:${vil.name}`, pri, parts.length ? 'sign plate' : 'sign', vil.name, sx, sy, true, vil.accent);
      if (parts.length) Object.assign(cand, { counts: c, cw: parts.reduce((w, [, n]) => w + 30 + String(n).length * 9, 0),
        html: `<b>${esc(vil.name)}</b><span class="cnt">${parts.map(([k, n]) => `<i class="k-${k}">${icon(k)}${n}</i>`).join('')}</span>` });
    }
    if (zoom >= 1) {
      for (const hit of hits) {
        const a = S.byId.get(hit.id);
        if (!a) continue;
        const sel = a.id === selected, cur = a.id === cursor, st = a.bucket === 'stalled';
        const pri = sel ? 0 : cur ? 1 : a.id === hover ? 2 : st ? 4 + (a.severity === 'error' || a.prompt ? -0.5 : 0) + (a.since || 0) / 1e15 : altTags ? 7 : -1;
        // Anchored to its own badge (bottom 4 px above it), else to the sprite's head.
        if (pri >= 0) add(`t:${a.id}`, pri, `tag${sel || cur ? ' sel' : st ? (a.severity === 'error' ? ' er' : a.prompt ? ' pr' : ' st') : ''}`, a.name, hit.cx, hit.top, false, null, hit.badge ? -4 : -1);
      }
      const sv = selected && placed.vill.get(selected);
      const at = (it, x, y) => P(x, y); // a spot by a building, in view px
      if (sv && (folds(sv.a) || sv.crowd)) add(`t:${selected}`, 0, 'tag sel', `${sv.a.name} (${sv.crowd ? 'in the crowd' : 'indoors'})`, ...at(sv.home, sv.door, sv.home.y * T - 4));
      if (W) for (const [homeId, n] of placed.crowd) { const it = W.items.find(i => i.id === homeId); if (it) add(`c:${homeId}`, 6, 'tag', `+${n} more`, ...at(it, it.x * T + R[it.look][5], (it.y + it.h) * T + 64)); }
      if (zoom >= 3 && W) for (const it of W.items) if (it.kind === 'pr') add(`p:${it.id}`, 5, 'tag prt', `#${it.pr}`, ...at(it, it.x * T + R[it.look][5], (it.y + it.h) * T + 14));
      if (zoom >= 3 && renderer && artState === 'ready') for (const g of renderer.dockTags()) add(g.key, 5, 'tag prt', g.text, g.x, g.y); // each ship's PR number
    }
    cands.sort((a, b) => a.pri - b.pri);
    const rects = [], want = new Map(), plates = [];
    const Wd = host.clientWidth, Ht = host.clientHeight;
    // Every visible badge blocks tags (except its own agent's), so a name never covers a neighbour's badge.
    const badges = zoom >= 1 ? hits.filter(h => h.badge).map(h => ({ id: h.id, l: (h.badge[0] - v.vx) * s, t: (h.badge[1] - v.vy) * s, r: (h.badge[2] - v.vx) * s, b: (h.badge[3] - v.vy) * s })) : [];
    lastBadges = badges;
    const overlaps = (r, p) => r.l < p.r + 2 && r.r > p.l - 2 && r.t < p.b + 1 && r.b > p.t - 1;
    for (const c of cands) {
      const sx = (c.x - v.vx) * s, sy = (c.y - v.vy) * s + c.dy;
      const font = c.cls === 'sign' ? '800 14px ui-monospace, monospace' : c.cls.includes('prt') ? '600 10px ui-monospace, monospace' : '11px system-ui, sans-serif';
      const w = Math.max(Math.min(240, width(c.text, font)), c.cw || 0) + (c.cls.startsWith('sign') ? 28 : 14), hh = c.html ? 24 : c.cls.startsWith('sign') ? 14 : 9;
      const at = dx => ({ l: sx + dx - w / 2, t: c.center ? sy - hh : sy - 18, r: sx + dx + w / 2, b: c.center ? sy + hh : sy });
      const blocked = r => c.pri > 0 && (rects.some(p => overlaps(r, p)) || (c.cls.startsWith('tag') && badges.some(p => `t:${p.id}` !== c.key && overlaps(r, p))));
      // An agent's tag sits over its head; when that spot is taken it may slide off to either side.
      const slide = c.key.startsWith('t:') ? [0, w / 2 + 12, -(w / 2 + 12)] : [0];
      const r = slide.map(at).find(q => !blocked(q) && !(q.r < 0 || q.l > Wd || q.b < 0 || q.t > Ht));
      if (!r) continue;
      if (r.l !== sx - w / 2) c.dx = r.l - (sx - w / 2);
      rects.push(r);
      want.set(c.key, c);
      if (c.counts) plates.push({ name: c.text, ...c.counts, x: r.l, y: r.t, w: r.r - r.l, h: r.b - r.t });
    }
    clusters = plates;
    for (const [k, el] of labelEls) if (!want.has(k)) { el.remove(); labelEls.delete(k); }
    for (const [k, l] of want) {
      let el = labelEls.get(k);
      if (!el) { el = document.createElement('div'); el.dataset.key = k; labelEls.set(k, el); labels.append(el); }
      if (el.className !== l.cls) el.className = l.cls;
      if (l.html) { if (el.dataset.html !== l.html) { el.innerHTML = l.html; el.dataset.html = l.html; } }
      else if (el.textContent !== l.text || el.dataset.html) { el.textContent = l.text; delete el.dataset.html; }
      if (l.accent && el.style.getPropertyValue('--accent') !== l.accent) el.style.setProperty('--accent', l.accent);
      const left = `${Math.round((l.x - v.vx) * s + (l.dx || 0))}px`, top = `${Math.round((l.y - v.vy) * s + l.dy)}px`;
      if (el.style.left !== left) el.style.left = left;
      if (el.style.top !== top) el.style.top = top;
    }
  }

  // ---------- loop ----------
  const animating = () => !!tween || (!reduce() && !state.offline && !!W);
  function frame(now) {
    raf = 0;
    if (!active()) return;
    if (tween) {
      const p = Math.min(1, (now - tween.t0) / 300), e = 1 - (1 - p) ** 3;
      cam.x = tween.x0 + (tween.x1 - tween.x0) * e; cam.y = tween.y0 + (tween.y1 - tween.y0) * e;
      if (p >= 1) tween = null;
    }
    draw(now);
    clearTimeout(timer);
    if (tween) raf = requestAnimationFrame(frame);
    else if (animating()) timer = setTimeout(() => { raf = requestAnimationFrame(frame); }, 1000 / FPS);
  }
  function invalidate() { if (!raf && active()) { clearTimeout(timer); raf = requestAnimationFrame(frame); } }
  function setActive() { if (active()) invalidate(); else { clearTimeout(timer); cancelAnimationFrame(raf); raf = 0; } }

  function panTo(x, y, animate = true) {
    if (!animate || reduce()) { cam.x = x; cam.y = y; tween = null; } else tween = { t0: performance.now(), x0: cam.x, y0: cam.y, x1: x, y1: y };
    invalidate();
  }
  function centerOn(id, animate = true) {
    const p = placed.vill.get(id);
    if (!p) return;
    if (zoom < 1) zoom = 2;
    const away = folds(p.a) || p.crowd, [x, y] = shift(away ? [p.door, p.base] : [p.x, p.y], agentOffset(p));
    panTo(x, y - 16, animate);
  }
  // Default view: the whole town on one screen. The largest of 2× and 1× at which every neighbourhood
  // (and the square) fits, centred on it; a town too big for 1× opens at Map, which fits everything.
  function fitZoom() {
    const [x0, y0, x1, y1] = box(land()), w = x1 - x0 + 2 * T, h = y1 - y0 + 2 * T + 24; // + room for the signs above
    return [2, 1].find(z => w * z <= host.clientWidth && h * z <= host.clientHeight) ?? 0.5;
  }
  // The app can open with the village hidden (the expanded panel covers it): fitting a 0×0 canvas would
  // leave it zoomed right out, so the fit waits until the village is first shown.
  let homeLater = false;
  function home(animate = true) {
    if (!W) return;
    if (!host.clientWidth) { homeLater = true; return; }
    homeLater = false;
    const [x0, y0, x1, y1] = box(land());
    zoom = fitZoom();
    panTo((x0 + x1) / 2, (y0 + y1) / 2 - 6, animate);
  }
  function setZoom(z, anchor) {
    if (z === zoom || (z < 1 && zoom < 1) || !ZOOMS.includes(z)) return;
    if (anchor) { // keep the world point under the pointer where it is
      const v = view(), s = v.k * v.px, wx = v.vx + anchor[0] / s, wy = v.vy + anchor[1] / s;
      zoom = z;
      const n = view(), ns = n.k * n.px;
      cam.x = wx - anchor[0] / ns + n.bw / 2; cam.y = wy - anchor[1] / ns + n.bh / 2;
    } else zoom = z;
    remember();
    invalidate();
  }
  const zoomIndex = () => zoom < 1 ? 0 : ZOOMS.indexOf(zoom);
  const zoomStep = d => setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, zoomIndex() + d))]);

  // ---------- input ----------
  const toWorld = e => {
    const r = cv.getBoundingClientRect(), v = view(), s = v.k * v.px;
    return [v.vx + (e.clientX - r.left) / s, v.vy + (e.clientY - r.top) / s];
  };
  function pick(e) {
    const [x, y] = toWorld(e);
    for (let i = hits.length - 1; i >= 0; i--) { const h = hits[i]; if (x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h) return { id: h.id }; }
    const dk = !W ? null : artState === 'ready' ? renderer.dockHit(x, y) : simpleDock.find(h => x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h);
    if (dk) return dk.key.startsWith('agent:') ? { id: dk.key.slice(6) } : { dock: dk.key }; // a walking villager is that agent
    for (const h of houseHits) if (x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h) return { id: h.ids[0], house: true };
    if (zoom < 1 && W) { // Map: a click on a village zooms into it
      const [wx, wy] = isoInv(x, y);
      const vil = W.villages.find(vl => { const b = vl.block; return wx >= (b.x - 1) * T && wx < (b.x + b.w + 1) * T && wy >= (b.y - 1) * T && wy < (b.y + b.h + 1) * T; });
      if (vil) return { village: vil };
    }
    return null;
  }
  let drag = null, press = 0;
  cv.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false };
    cv.setPointerCapture(e.pointerId);
    // A long press on a villager or a house (touch or pen) opens its menu, like a right-click.
    clearTimeout(press);
    if (e.pointerType !== 'mouse') {
      const at = { clientX: e.clientX, clientY: e.clientY };
      press = setTimeout(() => {
        if (!drag || drag.moved) return;
        const p = pick(at);
        if (!p?.id) return;
        drag = null; host.classList.remove('dragging');
        app.menu(p.id, { x: at.clientX, y: at.clientY });
      }, 500);
    }
  });
  // Right-click a villager or a house: its menu.
  cv.addEventListener('contextmenu', e => {
    const p = pick(e);
    if (!p?.id) return;
    e.preventDefault();
    const kb = e.clientX === 0 && e.clientY === 0;
    app.menu(p.id, kb ? screenAt(p.id) : { x: e.clientX, y: e.clientY });
  });
  /** Where an agent stands on screen (for a menu opened from the keyboard). */
  function screenAt(id) {
    const r = cv.getBoundingClientRect(), v = view(), s = v.k * v.px, hit = hits.find(x => x.id === id);
    if (!hit) return { el: cv };
    return { x: r.left + (hit.x + hit.w / 2 - v.vx) * s, y: r.top + (hit.y + hit.h - v.vy) * s };
  }
  cv.addEventListener('pointermove', e => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; host.classList.add('dragging'); tween = null; }
      if (drag.moved) { cam.x = drag.cx - dx / zoom; cam.y = drag.cy - dy / zoom; invalidate(); }
      return;
    }
    const p = pick(e), id = p?.id || null;
    host.classList.toggle('hovering', !!(id || p?.village || p?.dock));
    if ((p?.village?.name || null) !== hoverVil) { hoverVil = p?.village?.name || null; invalidate(); }
    if ((p?.dock || null) !== hoverDock) { hoverDock = p?.dock || null; invalidate(); } // the dock (or one ship) lights up its outline
    if (id !== hover) { hover = p?.house ? null : id; invalidate(); }
  });
  cv.addEventListener('pointerup', e => {
    clearTimeout(press);
    const d = drag; drag = null;
    host.classList.remove('dragging');
    if (!d) return;
    if (d.moved) { const v = view(); clamp(v.bw, v.bh); remember(); return; }
    const p = pick(e);
    if (p?.village) { zoom = 2; panTo(...P((p.village.cx + 0.5) * T, (p.village.cy + 0.5) * T)); remember(); return; }
    // The dock or a ship: the PR panel (dock.js) opens on this event; a ship says which PR it is.
    if (p?.dock) { window.dispatchEvent(new CustomEvent('va:dock', { detail: { href: p.dock.startsWith('ship:') ? p.dock.slice(5) : null } })); return; }
    app.select(p ? p.id : null, { fromVillage: true, pan: false });
  });
  // Double-click a villager: open it in the built-in terminal (or its menu, which says why it can't be).
  cv.addEventListener('dblclick', e => { const p = pick(e); if (p?.id && !p.village) app.activate(p.id, { x: e.clientX, y: e.clientY }); });
  cv.addEventListener('pointerleave', () => { if (hover || hoverDock) { hover = null; hoverDock = null; invalidate(); } host.classList.remove('hovering'); });
  let wheelAcc = 0;
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) > 80) {
      const r = cv.getBoundingClientRect(), i = zoomIndex() + (wheelAcc < 0 ? 1 : -1);
      setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i))], [e.clientX - r.left, e.clientY - r.top]);
      wheelAcc = 0;
    }
  }, { passive: false });
  const ORDER = { stalled: 0, waiting: 1, building: 2, resting: 3 };
  cv.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const order = [...S.agents].sort((a, b) => ORDER[a.bucket] - ORDER[b.bucket]).filter(a => placed.vill.has(a.id));
      if (!order.length) return;
      const i = order.findIndex(a => a.id === (cursor || selected));
      cursor = order[(i + (e.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length].id;
      centerOn(cursor);
      updateAria();
    } else if (e.key === 'Enter' && cursor) { e.preventDefault(); app.select(cursor, { fromVillage: true }); }
    else if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && (cursor || selected)) { e.preventDefault(); app.menu(cursor || selected, screenAt(cursor || selected)); }
  });
  cv.addEventListener('blur', () => { if (cursor) { cursor = null; invalidate(); updateAria(); } });
  document.getElementById('zoom-in').addEventListener('click', () => zoomStep(1));
  document.getElementById('zoom-out').addEventListener('click', () => zoomStep(-1));
  document.getElementById('zoom-reset').addEventListener('click', () => { home(); remember(); });
  new ResizeObserver(() => { if (homeLater && host.clientWidth && !userMoved) home(false); invalidate(); }).observe(host);

  function updateAria() {
    const c = S.data?.counts || {};
    let label = state.loading ? 'Village: loading' : !S.agents.length ? 'Village: no agents'
      : `Village: ${c.stalled ?? 0} stalled, ${c.waiting ?? 0} waiting, ${c.building ?? 0} building`;
    const f = cursor && S.byId.get(cursor);
    if (f) label += `. ${f.name}, ${ROLE_NAME[f.role] || f.role}, ${BUCKET_NAME[f.bucket]}. Press Enter to select.`;
    cv.setAttribute('aria-label', label);
    emptyNote.hidden = !(S.data && !(S.data.agents || []).length);
    cv.dataset.zoom = zoom;
  }

  // e2e: land tiles missing anywhere in the box spanning every neighbourhood and the square (0 = one town).
  function townWater() {
    const rs = [W.square, ...W.villages.map(v => v.block)];
    const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y)), x1 = Math.max(...rs.map(r => r.x + r.w)), y1 = Math.max(...rs.map(r => r.y + r.h));
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (!W.land.has(`${x},${y}`)) n++;
    return n;
  }

  let firstData = true, sceneSig = '', lastTown = '';
  return {
    update(next) {
      const was = sceneSig;
      state = next;
      host.classList.toggle('dim', next.offline);
      build();
      if (firstData && W) { firstData = false; if (!selected && !userMoved) home(false); }
      // Until you move the camera yourself, it keeps the whole town in view as neighbourhoods come and go.
      const townSig = W ? W.town.join() : '';
      if (W && townSig !== lastTown && lastTown && !userMoved && !selected) home(false);
      lastTown = townSig;
      updateAria();
      sceneSig = JSON.stringify([state, sig, [...placed.vill.values()].map(p => [p.a.id, p.a.bucket, p.a.severity, p.a.prompt, p.a.name, p.x, p.y, p.crowd, p.look]), dockSig(dockData(S))]);
      if (sceneSig !== was || animating()) invalidate();
    },
    setSelected(id, { pan = true } = {}) {
      selected = id;
      cursor = null;
      if (id && !placed.vill.has(id) && S.byId.has(id)) build(); // a quiet project's agent: bring its neighbourhood back
      if (id && pan && placed.vill.has(id) && (S.panel !== 'full' || S.peek)) centerOn(id, true);
      invalidate();
    },
    setActive,
    /** After the village's box changed size (the peek): the whole town again, unless the camera was moved by hand. */
    refit() { if (!W || !host.clientWidth) return; if (!userMoved && !selected) home(false); else invalidate(); },
    key(k) { if (k === '+' || k === '=') zoomStep(1); else if (k === '-') zoomStep(-1); else if (k === '0') { home(); remember(); } },
    showAllTags(on) { altTags = on; invalidate(); },
    // The terminal view saves the camera on the way in and puts it back on the way out.
    camera: () => (tween ? { x: tween.x1, y: tween.y1, z: zoom } : { x: cam.x, y: cam.y, z: zoom }), // a pan in flight counts as done
    setCamera(c) { if (!c) return; zoom = c.z; cam.x = c.x; cam.y = c.y; tween = null; invalidate(); },
    debug: () => ({ zoom, iso: true, cam: { ...cam }, clusters,
      outdoors: [...placed.vill.values()].filter(p => !folds(p.a) && !p.crowd).map(p => p.a.id), homes: W?.items.filter(it => it.kind === 'home').map(it => it.agentId) || [], badges: lastBadges, hits: hits.map(h => ({ id: h.id, x: h.x, y: h.y, w: h.w, h: h.h, wx: h.wx, wy: h.wy, pose: placed.vill.get(h.id)?.pose, home: placed.vill.get(h.id)?.home.id })), bounds: W?.bounds, view: view(), villages: W?.villages.map(v => ({ name: v.name, plaza: v.plaza, block: { ...v.block }, accent: v.accent, growth: v.growth, cx: v.cx, cy: v.cy })),
      town: W?.town, square: W?.square, quiet, dock: W?.dock ? { ...W.dock, rect: dockRect(W.dock) } : null, fitZoom: W ? fitZoom() : null, townWater: W ? townWater() : null,
      ...(renderer && artState === 'ready' ? renderer.debug() : { walkers: [], flags: [] }), flagCheck: () => (renderer && artState === 'ready' ? renderer.flagCheck(ctx) : []), depthCheck: () => (renderer && artState === 'ready' ? renderer.depthCheck() : []),
      // Footprint tiles of each item that aren't land (0 = it stands on the island).
      items: W?.items.map(it => { let wet = 0; for (let j = it.y; j < it.y + it.h; j++) for (let i = it.x; i < it.x + it.w; i++) if (!W.land.has(`${i},${j}`)) wet++; return { id: it.id, x: it.x, y: it.y, w: it.w, h: it.h, village: it.village.name, kind: it.kind, building: it.building, look: it.look, wet }; }) }),
  };
}
