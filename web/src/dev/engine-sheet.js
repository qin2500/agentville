// Dev-only engine v2 art sheet (?engine=2&artsheet=1; tools/artpass/capture.mjs --sheet --engine 2 [--night]).
// Lazy-imported from main.js, so it adds nothing to a normal page. It draws with the SAME rasteriser and actor art the
// renderer uses (engine art/raster.js, render/actor-art.js), through whichever mod the page resolved, and exposes
//   window.artSheetPages = [{ name, canvas }]   (one PNG per page; capture.mjs reads .canvas.toDataURL)
//   window.artSheetReady = true                 once every page is drawn
// Pages: building families (models x day/night x plain/crown), folk (looks x 4 facings x frames, per anim), events.
// Params: &anchors=1 overlays pivots, heads and sprite anchors; &night=1 darkens the page ground; &folk=ninja forces
// the sheet fallback; &world=<mod id> picks the world. Pure of globals apart from start(): buildPages() takes its
// dependencies, so node tests can drive it with stubs.

export const T = 16;
export const Z = 1;                      // page zoom over engine px
export const FAMILIES = ['timber', 'mediterranean', 'stone', 'alpine', 'canal', 'thatch'];
// [model, w, h] as the planner places them.
export const MODELS = [
  ['farmhouse', 3, 3], ['cottage', 3, 3], ['timber', 3, 3], ['timber', 4, 3], ['townhouse', 2, 3], ['townhouse', 3, 3], ['manor', 4, 4], ['hall', 4, 5],
  ['barn', 4, 3], ['windmill', 3, 3], ['granary', 2, 2], ['chapel', 3, 5], ['smithy', 3, 3], ['inn', 4, 3], ['guildhall', 5, 4], ['clocktower', 2, 2],
  ['markethall', 5, 3], ['cathedral', 6, 8],
];
export const FOLK_FACINGS = 4;
export const FOLK_SEEDS = 6;
const PAGE_H = 1400;
const GROUND = { day: '#8a8f6a', night: '#2b3348' };

const mem = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => { m.set(k, v); } }; };

/** The pages this sheet will have, by name prefix: a cheap list for tools and tests (no drawing). */
export function pageNames() {
  return [...FAMILIES.map(f => `family-${f}`), 'folk', 'events'];
}

/** Lay out rows of cells (each row an array of cells) onto pages: a column is as wide as its widest cell on the page, a row
 *  as tall as its tallest; a new page starts when the next row would pass PAGE_H. */
function rowsToPages(name, rows, { createCanvas, night, anchors, pad = 6 }) {
  const LAB = 12;
  const groups = [];
  let cur = [], h = 0;
  for (const row of rows) {
    const rh = Math.max(40, ...row.map(c => c.h)) + pad * 2 + LAB;
    if (cur.length && h + rh > PAGE_H) { groups.push(cur); cur = []; h = 0; }
    cur.push({ row, rh }); h += rh;
  }
  if (cur.length || !groups.length) groups.push(cur);
  return groups.map((grp, gi) => {
    const ncol = Math.max(1, ...grp.map(r => r.row.length));
    const cws = Array.from({ length: ncol }, (_, i) => Math.max(40, ...grp.map(r => r.row[i]?.w ?? 0)) + pad * 2);
    const W = cws.reduce((x, y) => x + y, 0), H = grp.reduce((x, r) => x + r.rh, 0);
    const cv = createCanvas(Math.max(W, 1), Math.max(H, 1)), g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    let y = 0;
    for (const { row, rh } of grp) {
      let x = 0;
      row.forEach((c, i) => {
        g.fillStyle = GROUND[(c.lit ?? night) ? 'night' : 'day']; g.fillRect(x, y, cws[i], rh);
        c.draw(g, x + pad, y + pad + LAB, anchors);
        if (c.label) { g.fillStyle = '#fff'; g.font = '10px monospace'; g.fillText(c.label, x + 3, y + 10); }
        x += cws[i];
      });
      y += rh;
    }
    return { name: groups.length > 1 ? `${name}-p${gi}` : name, canvas: cv };
  });
}

const mark = (g, x, y, col) => { g.fillStyle = col; g.fillRect(Math.round(x) - 1, Math.round(y) - 1, 3, 3); };

function buildingCells(fam, style, deps, accent) {
  const rows = [];
  for (const [model, w, h] of MODELS) {
    const cells = []; rows.push(cells);
    for (const lit of [false, true]) for (const crown of [false, true]) {
      let r = null;
      try { r = deps.rasterize(model, style, { kind: 'building', w, h, variant: 0, lit, crown, accent }); } catch { r = null; }
      const label = `${model} ${w}x${h} ${lit ? 'night' : 'day'}${crown ? ' crown' : ''}`;
      if (!r || !r.img) { cells.push({ w: 60, h: 20, lit, label: `${label} (no art)`, draw() {} }); continue; }
      const iw = r.img.width * Z, ih = r.img.height * Z;
      cells.push({ w: iw, h: ih, lit, label, draw(g, x, y, anchors) {
        // footprint diamond from the north corner (the pivot), 32x16 tiles
        const px = x + r.pivot.x * Z, py = y + r.pivot.y * Z;
        g.fillStyle = 'rgba(255,255,255,0.25)'; g.beginPath();
        for (const [a, b] of [[0, 0], [w, 0], [w, h], [0, h]]) g.lineTo(px + (a - b) * 16 * Z, py + (a + b) * 8 * Z);
        g.fill();
        g.drawImage(r.img, x, y, iw, ih);
        if (anchors) {
          mark(g, px, py, '#00e5ff');
          for (const k of ['door', 'ridge', 'chimney', 'hub', 'glow']) { const p = r.anchors?.[k]; if (p) mark(g, x + p.x * Z, y + p.y * Z, k === 'door' ? '#ff2bd6' : '#ffd400'); }
          for (const p of r.anchors?.windows || []) if (p) mark(g, x + p.x * Z, y + p.y * Z, '#7cff00');
        }
      } });
    }
  }
  return rows;
}

/** Which actor stand-ins to draw: the boss, a sub (with a parent), solo agents by first-seen order, then ambient folk by seed. */
export function folkActors() {
  const out = [{ label: 'boss', a: { id: 'sheet:boss', kind: 'agent', input: { role: 'boss', crown: true } } },
    { label: 'sub', a: { id: 'sheet:sub', kind: 'agent', parent: 'sheet:lead', input: { role: 'sub', parent: 'sheet:lead' } } }];
  for (let i = 0; i < 3; i++) out.push({ label: `agent ${i}`, a: { id: `sheet:agent${i}`, kind: 'agent', input: { role: 'solo' } } });
  for (let s = 0; s < FOLK_SEEDS; s++) out.push({ label: `folk seed ${s}`, a: { id: `sheet:folk${s}`, kind: 'folk', look: { seed: s } } });
  return out;
}

/** The anims to show: the mod's own (mod.actors.anims) else the sheet fallback's walk and idle. */
export function folkAnims(mod) {
  const an = mod?.actors?.anims;
  const names = an && typeof an === 'object' ? Object.keys(an) : [];
  if (!names.length) return [['idle', 1], ['walk', 4]];
  return names.slice(0, 6).map(n => [n, Math.max(1, Math.min(8, an[n]?.frames | 0 || 1))]);
}

function folkPages(deps, night, anchors) {
  const art = deps.actorArt, pages = [];
  if (!art) return pages;
  const rows = folkActors();
  for (const [anim, frames] of folkAnims(deps.mod)) {
    const prow = [];
    for (const row of rows) {
      const cells = []; prow.push(cells);
      for (let face = 0; face < FOLK_FACINGS; face++) for (let f = 0; f < frames; f++) {
        let fr = null;
        try { fr = art.frame({ ...row.a, face, anim, frame: f }); } catch { fr = null; }
        const label = `${row.label} f${face}${frames > 1 ? ` #${f}` : ''}`;
        if (!fr || !fr.img) { cells.push({ w: 24, h: 24, label: `${label} -`, draw() {} }); continue; }
        const k = 3, iw = (fr.img.width || fr.w) * k, ih = (fr.img.height || fr.h) * k;
        cells.push({ w: iw, h: ih, label, draw(g, x, y, anch) {
          g.drawImage(fr.img, x, y, iw, ih);
          if (anch) {
            if (fr.pivot) mark(g, x + fr.pivot.x * k, y + fr.pivot.y * k, '#00e5ff');
            if (fr.head != null && fr.pivot) mark(g, x + fr.pivot.x * k, y + (typeof fr.head === 'object' ? fr.head.y : fr.head) * k, '#ff2bd6');
          }
        } });
      }
    }
    pages.push(...rowsToPages(`folk-${anim}-${art.mode ?? 'sheet'}`, prow, { createCanvas: deps.createCanvas, night, anchors }));
  }
  return pages;
}

/** One sample spec per effect kind of render/event-fx.js, each drawn at a few moments of its life (the real drawEventFx). */
export const EVENT_SAMPLES = [
  { label: 'burst', spec: { kind: 'sample', at: 'plaza:sheet', effect: 'burst', seconds: 2.5, colors: ['#c46a42', '#f4efe4', '#ffd23f'] } },
  { label: 'ring', spec: { kind: 'sample', at: 'plaza:sheet', effect: 'ring', seconds: 1.8, colors: ['#d8c8a8'] } },
  { label: 'site:<obj>', spec: { kind: 'sample', at: 'plaza:sheet', effect: 'site:sheet-house', seconds: 8 } },
  { label: 'anim:cheer (on the actor)', spec: { kind: 'sample', at: 'actor:sheet:agent0', effect: 'anim:cheer', seconds: 4 } },
];
export const EVENT_PHASES = [0.15, 0.5, 0.85];   // fractions of each effect's lifetime

// the event fx draw through the engine Gfx (rect / poly); this adapts a 2D context to it
const gfxOf = g => ({
  rect(x, y, w, h, c) { g.fillStyle = c; g.fillRect(x, y, w, h); },
  poly(pts, c) { g.fillStyle = c; g.beginPath(); for (const [a, b] of pts) g.lineTo(a, b); g.fill(); },
});

function eventsPage(deps, night) {
  const fxm = deps.eventFx, CW = 200, CH = 150, COLS = EVENT_PHASES.length, rows = EVENT_SAMPLES.length;
  const cv = deps.createCanvas(40 + COLS * CW, 40 + rows * CH), g = cv.getContext('2d');
  g.fillStyle = GROUND[night ? 'night' : 'day']; g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#fff'; g.font = '12px monospace';
  if (!fxm?.drawEventFx || !fxm.createEventFx) { g.fillText('no event fx in this engine', 12, 24); return { name: 'events', canvas: cv }; }
  const hookNote = typeof deps.mod?.events === 'function' ? 'the world ships an events hook' : 'this world ships no events hook (specs are samples)';
  g.fillText(`event fx: ${hookNote}; columns = ${EVENT_PHASES.map(p => `${Math.round(p * 100)}%`).join(' / ')} of the lifetime`, 12, 24);
  const gx = gfxOf(g);
  EVENT_SAMPLES.forEach((row, r) => {
    const fx = fxm.createEventFx();
    fx.add([row.spec], 0);
    const world = { villages: [{ name: 'sheet', cx: 0, cy: 0 }], objects: new Map([['sheet-house', { tx: -1, ty: -1, w: 3, h: 3, z: 40 }]]) };
    const actors = [{ id: 'sheet:agent0', x: 0, y: 0 }];
    EVENT_PHASES.forEach((ph, c) => {
      const x0 = 20 + c * CW, y0 = 40 + r * CH, t = ph * row.spec.seconds;
      g.fillStyle = '#fff'; g.fillText(`${row.label} @${t.toFixed(2)}s`, x0 + 4, y0 + 12);
      try {
        // the effects draw in world screen px around the target's tile: translate the target to the cell centre
        g.save?.(); g.translate?.(x0 + CW / 2, y0 + CH * 0.62);
        fxm.drawEventFx(gx, fx.active(t), t, { world, actors });
        g.restore?.();
      } catch { g.restore?.(); }
    });
  });
  return { name: 'events', canvas: cv };
}

/**
 * Build every page. deps: { rasterize, styleFor, actorArt, mod, eventFx (render/event-fx.js exports), createCanvas }. Never throws for one bad model or look.
 * @returns {{ name: string, canvas: object }[]}
 */
export function buildPages(deps, { night = false, anchors = false } = {}) {
  const pages = [];
  FAMILIES.forEach((famName, fam) => {
    let style = null;
    try { style = deps.styleFor(`sheet-${famName}`, { family: fam }); } catch { style = null; }
    const rows = buildingCells(famName, style, deps, style?.accent);
    pages.push(...rowsToPages(`family-${famName}`, rows, { createCanvas: deps.createCanvas, night, anchors }));
  });
  pages.push(...folkPages(deps, night, anchors));
  pages.push(eventsPage(deps, night));
  return pages;
}

/** Browser entry (main.js): resolve the mod, load the art, build the pages, publish window.artSheetPages. */
export async function start() {
  const q = new URLSearchParams(location.search);
  const [raster, reg, actorMod, worldMod, ui, eventFx] = await Promise.all([
    import('../engine/art/raster.js'), import('../engine/mod/registry.js'), import('../engine/render/actor-art.js'),
    import('../world.js'), import('../worlds.js'), import('../engine/render/event-fx.js')]);
  window.artSheetPages = [];
  window.artSheetReady = false;
  try {
    await raster.loadClassicArt();
    const id = ui.pickWorld(q.get('world'), undefined, reg.listMods().map(m => m.id));
    let mod; try { mod = reg.resolveMod(id); } catch { mod = reg.resolveMod(reg.DEFAULT_MOD); }
    const actorArt = actorMod.createActorArt({ mod, store: mem(), search: location.search });
    await actorArt.load();
    const pages = buildPages({ rasterize: raster.rasterize, styleFor: worldMod.styleFor, actorArt, mod, eventFx, createCanvas: raster.createCanvas },
      { night: q.get('night') === '1', anchors: q.get('anchors') === '1' });
    // OffscreenCanvas pages have no toDataURL: copy them to DOM canvases so the capture tool can read them
    window.artSheetPages = pages.map(p => {
      if (typeof p.canvas.toDataURL === 'function') return p;
      const c = document.createElement('canvas'); c.width = p.canvas.width; c.height = p.canvas.height;
      c.getContext('2d').drawImage(p.canvas, 0, 0);
      return { name: p.name, canvas: c };
    });
  } catch (e) { console.error('engine sheet failed:', e?.message || e); }
  window.artSheetReady = true;
}
