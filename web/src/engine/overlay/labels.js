// Pure label candidates + layout for the engine overlay (port of classic web/src/village.js:248-318).
// Everything is in CSS px (screen space). No DOM, no canvas: text width is measured through an injectable
// `measure(text, font)`, with a character-count estimate as the fallback so this runs in node.

const PLATE_ORDER = [['prompt', 'prompt'], ['error', 'error'], ['stalled', 'need'], ['waiting', 'wait']];
const FONT_SIGN = '800 14px ui-monospace, monospace';
const FONT_PRT = '600 10px ui-monospace, monospace';
const FONT_TAG = '11px system-ui, sans-serif';

// A badge sitting on an agent: anchors that agent's tag above it and blocks every other tag.
export const badgeOf = a => a.badge || null;

// labelCands -> Cand[] = { key, pri, cls, text, x, y, dy, center, accent?, counts?, parts?, cw? } (x,y = CSS px anchor).
// agents: [{id (server id), name, bucket, severity, prompt, since, rect:{x,y,w,h}, badge?:{l,t,r,b}}]
// villages: [{name, accent, x, y, counts?:{prompt,error,need,wait}}]  x,y = sign anchor (plaza top-centre, CSS px)
// prs: [{id, pr, x, y}]  indoorsSel: {id, name, x, y} | null
export function labelCands({ zoom = 1, agents = [], villages = [], prs = [], indoorsSel = null,
  selected = null, cursor = null, hover = null, hoverVil = null, alt = false, bubbles = true } = {}) {
  const cands = [];
  const add = (key, pri, cls, text, x, y, extra = {}) => { const c = { key, pri, cls, text, x, y, center: false, dy: 0, ...extra }; cands.push(c); return c; };

  // parity: lbl.village-signs
  // parity: lbl.map-plates-counts
  // At Map a village is one plate: name + counts, shown or hidden whole. Plates with counts outrank the rest
  // (errors, then needs-you, then waiting); hover shows any.
  for (const vil of villages) {
    const c = zoom < 1 && vil.counts, parts = c ? PLATE_ORDER.map(([k, f]) => [k, c[f] | 0]).filter(p => p[1]) : [];
    const pri = vil.name === hoverVil ? 0
      : parts.length ? 3 - Math.min(0.9, ((c.error + c.prompt) * 1e6 + c.need * 1e3 + c.wait) / 1e7) : 3.95;
    const cand = add(`v:${vil.name}`, pri, parts.length ? 'sign plate' : 'sign', vil.name, vil.x, vil.y,
      { center: true, accent: vil.accent, dy: -(zoom < 1 ? 40 : 20) });
    if (parts.length) Object.assign(cand, { counts: c, parts, cw: parts.reduce((w, [, n]) => w + 30 + String(n).length * 9, 0) });
  }

  if (zoom >= 1) {
    for (const a of agents) {
      const sel = a.id === selected, cur = a.id === cursor, st = a.bucket === 'stalled', err = a.severity === 'error';
      // parity: lbl.alt-shows-all-tags
      const pri = sel ? 0 : cur ? 1 : a.id === hover ? 2
        : st ? 4 + (err || a.prompt ? -0.5 : 0) + (a.since || 0) / 1e15 : alt ? 7 : -1;
      if (pri < 0) continue;
      const r = a.rect || { x: 0, y: 0, w: 0 };
      add(`t:${a.id}`, pri, `tag${sel || cur ? ' sel' : st ? (err ? ' er' : a.prompt ? ' pr' : ' st') : ''}`,
        a.name, r.x + (r.w || 0) / 2, r.y, { dy: a.badge ? -4 : -1 });
    }
    if (indoorsSel) add(`t:${indoorsSel.id}`, 0, 'tag sel',
      `${indoorsSel.name} (indoors)`, indoorsSel.x, indoorsSel.y);
    // parity: lbl.pr-numbers-zoom3
    if (zoom >= 3) for (const p of prs) add(`p:${p.id}`, 5, 'tag prt', `#${p.pr}`, p.x, p.y);
  }

  // Labels & status bubbles off: only hovered / selected / keyboard-cursor agent and hovered village keep text.
  if (!bubbles) {
    const keep = c => c.key === `t:${hover}` || c.key === `t:${selected}` || c.key === `t:${cursor}` || c.key === `v:${hoverVil}`;
    return cands.filter(keep);
  }
  return cands;
}

// Badge rects that block every tag except their own agent's (so a name never covers a neighbour's badge).
export function labelBlockers(agents, zoom = 1) {
  return zoom >= 1 ? agents.filter(a => a.badge).map(a => ({ id: a.id, l: a.badge.l, t: a.badge.t, r: a.badge.r, b: a.badge.b })) : [];
}

const estimate = (text, font) => String(text).length * (font === FONT_SIGN ? 8.4 : font === FONT_PRT ? 6 : 6.2);

// layoutLabels -> Placed[] = { key, cls, text, accent?, counts?, parts?, left, top, rect:{l,t,r,b} }, priority order.
// left/top = the CSS anchor (the .tag/.sign CSS translates around it), slid sideways if the head spot is taken.
// opts: { w, h, measure?(text, font) }
export function layoutLabels(cands, blockers = [], { w: Wd = Infinity, h: Ht = Infinity, measure = estimate } = {}) {
  // parity: lbl.dom-labels-priority-slide
  const sorted = [...cands].sort((a, b) => a.pri - b.pri);
  const rects = [], out = [];
  const overlaps = (r, p) => r.l < p.r + 2 && r.r > p.l - 2 && r.t < p.b + 1 && r.b > p.t - 1;
  for (const c of sorted) {
    const sx = c.x, sy = c.y + (c.dy || 0);
    const sign = c.cls.startsWith('sign');
    const font = c.cls === 'sign' ? FONT_SIGN : c.cls.includes('prt') ? FONT_PRT : FONT_TAG;
    const w = Math.max(Math.min(240, measure(c.text, font)), c.cw || 0) + (sign ? 28 : 14);
    const hh = c.counts ? 24 : sign ? 14 : 9;
    const at = dx => ({ l: sx + dx - w / 2, t: c.center ? sy - hh : sy - 18, r: sx + dx + w / 2, b: c.center ? sy + hh : sy });
    const blocked = r => c.pri > 0 && (rects.some(p => overlaps(r, p))
      || (c.cls.startsWith('tag') && blockers.some(p => `t:${p.id}` !== c.key && overlaps(r, p))));
    // An agent's tag sits over its head; when that spot is taken it may slide off to either side.
    const slide = c.key.startsWith('t:') ? [0, w / 2 + 12, -(w / 2 + 12)] : [0];
    let dxUsed = 0, rect = null;
    for (const dx of slide) {
      const q = at(dx);
      if (!blocked(q) && !(q.r < 0 || q.l > Wd || q.b < 0 || q.t > Ht)) { rect = q; dxUsed = dx; break; }
    }
    if (!rect) continue;
    rects.push(rect);
    const p = { key: c.key, cls: c.cls, text: c.text, left: sx + dxUsed, top: sy, rect };
    if (c.accent) p.accent = c.accent;
    if (c.counts) { p.counts = c.counts; p.parts = c.parts; }
    out.push(p);
  }
  return out;
}
