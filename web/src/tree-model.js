// The Tree view's model and layout (tree.js draws it). Pure: no DOM, so node tests import it.
//
// Who reports to whom comes from each agent's `parentId` (classify.mjs roleOf: --bg job children,
// subagents, teammates, Codex threads, overrides). An agent whose parent is missing or hidden is a
// root; a parent loop is broken at its first-ranked member. Roots with reports are grouped by
// project (crowned bosses first); roots without reports go to one "Solo" group at the end.
//
// Resting subtrees (nobody awake in them) fold into a "+N resting" pill on their parent, and resting
// root teams into a pill on their project's heading, until opened. While filtering, every match and
// its chain of command show (ancestors that don't match are `ctx`: drawn dimmed), with no pills.

const ROLE_ORDER = { boss: 0, lead: 1, sub: 2, solo: 3 };
export const SOLO_KEY = 'solo';
export const groupKey = project => `proj:${project}`;
export const isErr = a => a.bucket === 'stalled' && a.severity === 'error';
export const isClick = a => a.bucket === 'stalled' && !!a.prompt && !isErr(a);

/**
 * @param {object[]} agents  the visible agents (hidden ones already removed)
 * @param {object} [o]
 * @param {(a: object) => boolean} [o.matches]  set while a search or filter is on
 * @param {Set<string>} [o.open]  ids (and group keys) whose resting pill is open
 * @param {Set<string>} [o.collapsed]  ids whose reports are folded away
 * @param {boolean} [o.allOpen]  every pill open (used to collect them for "Expand all")
 * @param {(a: object) => number} [o.rank]  stable order (first-seen); defaults to input order
 */
export function buildTree(agents, { matches = null, open = new Set(), collapsed = new Set(), allOpen = false, rank = null } = {}) {
  const byId = new Map(agents.map(a => [a.id, a]));
  const idx = new Map(agents.map((a, i) => [a.id, i]));
  const rk = rank || (a => idx.get(a.id));
  const order = (a, b) => rk(a) - rk(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const crowns = (a, b) => (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3) || order(a, b);

  // Effective parent: present, not itself; loops broken below.
  const parent = new Map();
  for (const a of agents) parent.set(a.id, a.parentId && a.parentId !== a.id && byId.has(a.parentId) ? a.parentId : null);
  const kidsOf = new Map(agents.map(a => [a.id, []]));
  const link = () => {
    for (const l of kidsOf.values()) l.length = 0;
    for (const a of agents) { const p = parent.get(a.id); if (p) kidsOf.get(p).push(a); }
  };
  link();
  const reached = new Set();
  const reach = id => { const st = [id]; while (st.length) { const x = st.pop(); if (reached.has(x)) continue; reached.add(x); for (const k of kidsOf.get(x)) st.push(k.id); } };
  for (const a of agents) if (!parent.get(a.id)) reach(a.id);
  if (reached.size < agents.length) {
    for (const a of [...agents].sort(order)) if (!reached.has(a.id)) { parent.set(a.id, null); link(); reach(a.id); }
  }
  for (const l of kidsOf.values()) l.sort(order);

  // Subtree facts, children before parents (post-order over the forest).
  const size = new Map(), awake = new Map();
  const post = [];
  { const st = agents.filter(a => !parent.get(a.id)).map(a => [a, false]);
    while (st.length) {
      const [a, done] = st.pop();
      if (done) { post.push(a); continue; }
      st.push([a, true]);
      for (const k of kidsOf.get(a.id)) st.push([k, false]);
    } }
  for (const a of post) {
    let n = 1, w = a.bucket !== 'resting';
    for (const k of kidsOf.get(a.id)) { n += size.get(k.id); w ||= awake.get(k.id); }
    size.set(a.id, n); awake.set(a.id, w);
  }

  // Filtering: matches plus their ancestors.
  const filtering = typeof matches === 'function';
  const match = new Set(), keep = new Set();
  if (filtering) {
    for (const a of agents) if (matches(a)) match.add(a.id);
    for (const id of match) for (let p = id; p && !keep.has(p); p = parent.get(p)) keep.add(p);
  }
  const kept = a => !filtering || keep.has(a.id);
  const isOpen = id => allOpen || open.has(id);
  const nodes = new Map();
  const pills = []; // every id/key with a resting pill (for "Expand all")

  function build(a, depth, up) {
    const all = kidsOf.get(a.id).filter(kept);
    let shown = all, rest = [];
    if (!filtering) { shown = all.filter(k => awake.get(k.id)); rest = all.filter(k => !awake.get(k.id)); }
    const pillOpen = rest.length > 0 && isOpen(a.id);
    if (rest.length) pills.push(a.id);
    if (pillOpen) shown = all;
    const restN = rest.reduce((s, k) => s + size.get(k.id), 0);
    const node = {
      id: a.id, a, depth, parent: up, kids: [],
      ctx: filtering && !match.has(a.id),
      pill: rest.length ? { n: restN, teams: rest.length, open: pillOpen } : null,
      collapsed: false, hidden: 0,
      total: size.get(a.id) - 1, // everyone under it, resting included
    };
    nodes.set(a.id, node);
    if (shown.length && collapsed.has(a.id)) {
      node.collapsed = true;
      node.hidden = shown.reduce((s, k) => s + (filtering ? countKept(k) : size.get(k.id)), 0);
    } else node.kids = shown.map(k => build(k, depth + 1, node));
    return node;
  }
  function countKept(a) { let n = 1; for (const k of kidsOf.get(a.id)) if (keep.has(k.id)) n += countKept(k); return n; }

  const roots = agents.filter(a => !parent.get(a.id) && kept(a)).sort(order);
  const heads = roots.filter(a => kidsOf.get(a.id).some(kept));
  const solos = roots.filter(a => !kidsOf.get(a.id).some(kept));

  const byProject = new Map();
  for (const a of heads) {
    const p = a.project || '—';
    if (!byProject.has(p)) byProject.set(p, []);
    byProject.get(p).push(a);
  }
  const groups = [];
  for (const [project, list] of byProject) {
    const key = groupKey(project);
    const live = filtering ? list : list.filter(a => awake.get(a.id));
    const dormant = filtering ? [] : list.filter(a => !awake.get(a.id));
    if (dormant.length) pills.push(key);
    const open2 = dormant.length > 0 && isOpen(key);
    const shown = (open2 ? [...live, ...dormant] : live).sort(crowns);
    const g = {
      key, project, kind: 'project',
      roots: [],
      pill: dormant.length ? { n: dormant.reduce((s, a) => s + size.get(a.id), 0), teams: dormant.length, open: open2 } : null,
      agents: list.reduce((s, a) => s + size.get(a.id), 0),
      boss: list.some(a => a.role === 'boss'),
      awake: live.length > 0,
      first: Math.min(...list.map(rk)),
    };
    g.roots = shown.map(a => build(a, 1, g));
    groups.push(g);
  }
  // Crowned teams first (as in Team), then projects with someone awake, then stable order.
  groups.sort((x, y) => (y.boss - x.boss) || (y.awake - x.awake) || (x.first - y.first));

  let solo = null;
  if (solos.length) {
    const live = filtering ? solos : solos.filter(a => a.bucket !== 'resting');
    const rest = solos.length - live.length;
    if (rest) pills.push(SOLO_KEY);
    const open2 = rest > 0 && isOpen(SOLO_KEY);
    solo = { key: SOLO_KEY, project: 'Solo', kind: 'solo', roots: [], pill: rest ? { n: rest, teams: rest, open: open2 } : null, agents: solos.length };
    solo.roots = (open2 ? solos : live).map(a => build(a, 1, solo));
  }
  const all = solo ? [...groups, solo] : groups;
  for (const g of all) g.n = g.roots.length;
  return { groups: all, nodes, pills, filtering, match, total: agents.length, shown: nodes.size };
}

/** Each node's parent / children / siblings for keyboard moves: heads at level 1, roots at 2. */
export function family(model, id) {
  const g = model.groups.find(x => x.key === id);
  if (g) {
    const i = model.groups.indexOf(g);
    return { parent: null, kids: g.roots.map(r => r.id), prev: model.groups[i - 1]?.key ?? null, next: model.groups[i + 1]?.key ?? null };
  }
  const n = model.nodes.get(id);
  if (!n) return null;
  const sibs = n.parent.roots || n.parent.kids;
  const i = sibs.indexOf(n);
  return { parent: n.parent.key || n.parent.id, kids: n.kids.map(k => k.id), prev: sibs[i - 1]?.id ?? null, next: sibs[i + 1]?.id ?? null };
}

// ---------- outline (narrow panels, phones): one row per item, depth-indented ----------
export function outline(model) {
  const rows = [];
  const walk = (n, setsize, pos) => {
    rows.push({ kind: 'node', id: n.id, node: n, level: n.depth + 1, setsize, pos });
    n.kids.forEach((k, i) => walk(k, n.kids.length, i + 1));
  };
  model.groups.forEach((g, gi) => {
    rows.push({ kind: 'head', id: g.key, group: g, level: 1, setsize: model.groups.length, pos: gi + 1 });
    g.roots.forEach((r, i) => walk(r, g.roots.length, i + 1));
  });
  return rows;
}

// ---------- chart layout: top-down org chart with orthogonal connectors ----------
export const DIM = { W: 200, H: 50, HGAP: 16, VGAP: 40, COLGAP: 24, ROWGAP: 8, INDENT: 18, TREEGAP: 40, HEAD: 36, BANDGAP: 28, PAD: 24 };

/**
 * Positions for every visible item (world px) plus one SVG path for all connectors.
 * Children that are all leaves stack into columns (so a boss with 100 reports stays compact);
 * otherwise children sit side by side under their parent. Root trees flow left to right and wrap
 * at `wrap` px; each project is a band under its heading; Solo cards wrap in a grid.
 */
export function layout(model, { wrap = 1400 } = {}) {
  const D = DIM;
  const items = new Map(); // id -> { x, y, w, h, kind }
  const d = [];
  const seg = (x1, y1, x2, y2) => d.push(`M${x1} ${y1}L${x2} ${y2}`);
  const measured = new Map();
  const stackRows = n => Math.max(3, Math.min(12, Math.ceil(Math.sqrt(n * 2.2))));
  function measure(n) {
    let m;
    if (!n.kids.length) m = { w: D.W, h: D.H };
    else if (n.kids.length > 3 && n.kids.every(k => !k.kids.length)) {
      const rows = Math.min(n.kids.length, stackRows(n.kids.length)), cols = Math.ceil(n.kids.length / rows);
      const bw = D.INDENT + cols * D.W + (cols - 1) * D.COLGAP, bh = rows * D.H + (rows - 1) * D.ROWGAP;
      m = { w: Math.max(D.W, bw), h: D.H + D.VGAP + bh, stack: { rows, cols, bw } };
    } else {
      const ks = n.kids.map(measure);
      const kw = ks.reduce((s, k) => s + k.w, 0) + (ks.length - 1) * D.HGAP;
      m = { w: Math.max(D.W, kw), h: D.H + D.VGAP + Math.max(...ks.map(k => k.h)), kw };
    }
    measured.set(n.id, m);
    return m;
  }
  function place(n, x, y) {
    const m = measured.get(n.id);
    const px = Math.round(x + (m.w - D.W) / 2), cx = px + D.W / 2;
    items.set(n.id, { x: px, y, w: D.W, h: D.H, kind: 'node' });
    if (!n.kids.length) return;
    const top = y + D.H, mid = top + D.VGAP / 2;
    seg(cx, top, cx, mid);
    if (m.stack) {
      const { rows, cols, bw } = m.stack;
      const x0 = Math.round(x + (m.w - bw) / 2) + D.INDENT;
      const spines = [];
      for (let c = 0; c < cols; c++) {
        const colX = x0 + c * (D.W + D.COLGAP), sx = colX - D.INDENT / 2 - 1;
        const inCol = n.kids.slice(c * rows, (c + 1) * rows);
        inCol.forEach((k, r) => {
          const ky = top + D.VGAP + r * (D.H + D.ROWGAP);
          items.set(k.id, { x: colX, y: ky, w: D.W, h: D.H, kind: 'node' });
          seg(sx, ky + D.H / 2, colX, ky + D.H / 2);
        });
        const last = top + D.VGAP + (inCol.length - 1) * (D.H + D.ROWGAP) + D.H / 2;
        seg(sx, mid, sx, last);
        spines.push(sx);
      }
      seg(Math.min(cx, spines[0]), mid, Math.max(cx, spines[spines.length - 1]), mid);
      return;
    }
    let kx = x + (m.w - m.kw) / 2;
    const centers = [];
    for (const k of n.kids) {
      const km = measured.get(k.id);
      place(k, kx, top + D.VGAP);
      const it = items.get(k.id);
      centers.push(it.x + D.W / 2);
      seg(it.x + D.W / 2, mid, it.x + D.W / 2, it.y);
      kx += km.w + D.HGAP;
    }
    seg(Math.min(cx, centers[0]), mid, Math.max(cx, centers[centers.length - 1]), mid);
  }

  let y = D.PAD, width = 0;
  for (const g of model.groups) {
    items.set(g.key, { x: D.PAD, y, w: Math.max(D.W, Math.min(wrap, 520)), h: D.HEAD - 8, kind: 'head' });
    y += D.HEAD;
    if (!g.roots.length) { y += D.BANDGAP - 8; continue; }
    if (g.kind === 'solo') {
      const per = Math.max(1, Math.floor((wrap + D.HGAP) / (D.W + D.HGAP)));
      g.roots.forEach((r, i) => {
        const x = D.PAD + (i % per) * (D.W + D.HGAP), yy = y + Math.floor(i / per) * (D.H + D.ROWGAP);
        items.set(r.id, { x, y: yy, w: D.W, h: D.H, kind: 'node' });
        width = Math.max(width, x + D.W);
      });
      y += Math.ceil(g.roots.length / per) * (D.H + D.ROWGAP) - D.ROWGAP + D.BANDGAP;
      continue;
    }
    let x = D.PAD, rowH = 0;
    for (const r of g.roots) {
      const m = measure(r);
      if (x > D.PAD && x + m.w > D.PAD + wrap) { x = D.PAD; y += rowH + D.VGAP; rowH = 0; }
      place(r, x, y);
      x += m.w + D.TREEGAP;
      rowH = Math.max(rowH, m.h);
      width = Math.max(width, x - D.TREEGAP);
    }
    y += rowH + D.BANDGAP;
  }
  return { items, path: d.join(''), width: Math.max(width, 0) + D.PAD, height: y };
}
