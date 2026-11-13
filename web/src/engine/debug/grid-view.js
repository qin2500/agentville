// M1 debug render: flat-coloured tiles, walkability and cover heatmaps (`&grid=ground|walk|cover|lot`). OWNER: A9.
// Pure apart from ctx calls: no DOM, no globals, no randomness.
import { COST_BLOCKED, EDGE } from '../core/grid.js';

// Local copy of the coords.js projection (that file is a stub on this branch).
const HW = 16, HH = 8;
const sxOf = (tx, ty) => (tx - ty) * HW;
const syOf = (tx, ty) => (tx + ty) * HH;

// Engine-reserved ground codes (grid.js LAYOUT_GROUND: EDGE 200, VENUE 201, HUB 202, ROUTE 203) keep fixed colours;
// codes below 200 take the colour of the mod's terrain type, and the terrain layer the colour of the mod's terrain
// class (world.mod.terrain.types / .classes); grey when the mod gives none.
const LAYOUT_GROUND_COL = { 200: '#6e6a5a', 201: '#6b4a2a', 202: '#e0c060', 203: '#8a8278' };
const UNKNOWN_COL = '#808080';
const KIND_COL = { building: '#8b2f2a', prop: '#5a6472', tree: '#1c4a22', venue: '#6b4a2a', decal: '#777777', token: '#4a5a7a' };
const LOT_HUES = 12;
const LOT_WILD_COL = '#707070', LOT_HUB_COL = '#d4af37', LOT_VENUE_COL = '#3a6ed8';
const DIM = 'rgba(0,0,0,0.55)';

const groundColour = (grid, i, byCode, TERRAIN_COL) => {
  const g = grid.ground[i];
  if (g >= 200) return LAYOUT_GROUND_COL[g] || TERRAIN_COL[grid.terrain[i]] || '#444';
  if (g > 0) return byCode[g] || UNKNOWN_COL;
  return TERRAIN_COL[grid.terrain[i]] || '#444';
};
const lotColour = l => l >= 0 ? `hsl(${(l * 47) % 360},${55 + (l % 3) * 10}%,${42 + (l % LOT_HUES % 2) * 8}%)`
  : l === -2 ? LOT_HUB_COL : l === -3 ? LOT_VENUE_COL : LOT_WILD_COL;
const coverColour = c => {
  // 0 transparent -> orange (50) -> red (100)
  const t = Math.min(100, c) / 100;
  const g = Math.round(t < 0.5 ? 165 * (1 - 0) : 165 * (1 - (t - 0.5) * 2));
  return `rgba(255,${g},0,${(0.25 + 0.65 * t).toFixed(2)})`;
};
const costColour = c => c === COST_BLOCKED ? '#d02020' : c <= 2 ? '#2fa84a' : c <= 4 ? '#a8c830' : '#e0a020';

const LEGENDS = {
  // ground: the mod's terrain classes first (groundLegend), then these
  ground: [['edge', LAYOUT_GROUND_COL[200]], ['route', LAYOUT_GROUND_COL[203]], ['hub', LAYOUT_GROUND_COL[202]],
    ['building', '#8b2f2a'], ['prop', '#5a6472'], ['tree', '#1c4a22'], ['venue', '#6b4a2a'], ['door', '#ffd400']],
  walk: [['cost 1-2', '#2fa84a'], ['cost 3-4', '#a8c830'], ['cost 5+', '#e0a020'], ['blocked', '#d02020'], ['edge wall', '#ff00ff']],
  cover: [['cover 0', 'rgba(0,0,0,0)'], ['cover ~50', '#ffa500'], ['cover 100', '#ff0000']],
  lot: [['settlement', '#4aa0c0'], ['wild', LOT_WILD_COL], ['hub', LOT_HUB_COL], ['venue', LOT_VENUE_COL]],
};

/** cam: { x, y, z } (x, y float tiles at the view centre; z zoom). A tile corner (tx, ty) is drawn at
 *  css = (toScreen(tx, ty) - toScreen(cam.x, cam.y)) * z + [cssW / 2, cssH / 2]. ctx is already scaled by dpr.
 *  @returns {{ drawn: number }} */
export function drawGridDebug(ctx, world, { cam, cssW, cssH, mode = 'ground' }) {
  const grid = world.grid, objects = world.objects;
  const byCode = [];
  for (const t of world.mod?.terrain?.types || []) if (t.color) byCode[t.code] = t.color;
  // terrain-layer colours come from the mod's classes (grey for a class without a colour)
  const classes = Array.isArray(world.mod?.terrain?.classes) ? world.mod.terrain.classes : [];
  const terCol = [];
  for (const c of classes) if (c.color) terCol[c.code] = c.color;
  const z = cam.z;
  const csx = sxOf(cam.x, cam.y), csy = syOf(cam.x, cam.y);
  const px = tx => Math.round((sxOf(tx[0], tx[1]) - csx) * z + cssW / 2);
  const py = tx => Math.round((syOf(tx[0], tx[1]) - csy) * z + cssH / 2);
  const P = [0, 0];
  const X = (tx, ty) => { P[0] = tx; P[1] = ty; return px(P); };
  const Y = (tx, ty) => { P[0] = tx; P[1] = ty; return py(P); };

  // visible tile range: invert the projection at the four viewport corners
  let minTx = Infinity, maxTx = -Infinity, minTy = Infinity, maxTy = -Infinity;
  for (const [cx, cy] of [[0, 0], [cssW, 0], [0, cssH], [cssW, cssH]]) {
    const sx = csx + (cx - cssW / 2) / z, sy = csy + (cy - cssH / 2) / z;
    const tx = (sx / HW + sy / HH) / 2, ty = (sy / HH - sx / HW) / 2;
    if (tx < minTx) minTx = tx; if (tx > maxTx) maxTx = tx;
    if (ty < minTy) minTy = ty; if (ty > maxTy) maxTy = ty;
  }
  const x0 = Math.max(grid.ox, Math.floor(minTx) - 1), x1 = Math.min(grid.ox + grid.w - 1, Math.ceil(maxTx) + 1);
  const y0 = Math.max(grid.oy, Math.floor(minTy) - 1), y1 = Math.min(grid.oy + grid.h - 1, Math.ceil(maxTy) + 1);

  if (ctx.imageSmoothingEnabled !== undefined) ctx.imageSmoothingEnabled = false;
  const layers = new Map();      // ground colour -> flat [tx, ty, ...]
  const heat = new Map();        // walk/cover overlay colour -> flat [tx, ty, ...]
  const dimTiles = [];
  const push = (col, tx, ty, m = layers) => { let a = m.get(col); if (!a) m.set(col, a = []); a.push(tx, ty); };
  const lines = [];              // [colour, x1, y1, x2, y2] edge segments grouped later
  const dots = [];

  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const i = (ty - grid.oy) * grid.w + (tx - grid.ox);
      let col;
      if (mode === 'lot') col = lotColour(grid.lot[i]);
      else if (mode === 'ground') {
        const occ = grid.occ[i];
        const o = occ ? objects && objects.byNum && objects.byNum(occ) : null;
        col = occ ? (KIND_COL[o ? o.kind : 'prop'] || KIND_COL.prop) : groundColour(grid, i, byCode, terCol);
        if (o && o.kind === 'building' && o.door && o.door.tx === tx && o.door.ty === ty) dots.push(tx, ty);
      } else col = groundColour(grid, i, byCode, terCol);
      push(col, tx, ty);
      if (mode === 'walk') {
        dimTiles.push(tx, ty);
        const c = grid.cost[i];
        if (c) push(costColour(c), tx, ty, heat);
      } else if (mode === 'cover') {
        dimTiles.push(tx, ty);
        const c = grid.cover[i];
        if (c) push(coverColour(c), tx, ty, heat);
      }
      const e = grid.edges[i];
      if (e) lines.push(tx, ty, e);
    }
  }
    let drawn = 0;
  const fillTiles = (col, a) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    for (let k = 0; k < a.length; k += 2) {
      const tx = a[k], ty = a[k + 1];
      const nx = X(tx, ty), ny = Y(tx, ty);
      const ex = X(tx + 1, ty), ey = Y(tx + 1, ty);
      const sx2 = X(tx + 1, ty + 1), sy2 = Y(tx + 1, ty + 1);
      const wx = X(tx, ty + 1), wy = Y(tx, ty + 1);
      // 1px outward overlap hides seams
      ctx.moveTo(nx, ny - 1); ctx.lineTo(ex + 1, ey); ctx.lineTo(sx2, sy2 + 1); ctx.lineTo(wx - 1, wy); ctx.closePath();
    }
    ctx.fill();
  };
  for (const [col, a] of layers) { fillTiles(col, a); drawn += a.length / 2; }
  if (dimTiles.length) fillTiles(DIM, dimTiles);
  for (const [col, a] of heat) fillTiles(col, a);

  // edge-blocked lines
  if (lines.length) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = mode === 'walk' ? '#ff00ff' : '#101010';
    ctx.beginPath();
    for (let k = 0; k < lines.length; k += 3) {
      const tx = lines[k], ty = lines[k + 1], e = lines[k + 2];
      const seg = (ax, ay, bx, by) => { ctx.moveTo(X(ax, ay), Y(ax, ay)); ctx.lineTo(X(bx, by), Y(bx, by)); };
      if (e & EDGE.N) seg(tx, ty, tx + 1, ty);          // N side (-y): N corner -> E corner
      if (e & EDGE.E) seg(tx + 1, ty, tx + 1, ty + 1);  // E side (+x)
      if (e & EDGE.S) seg(tx, ty + 1, tx + 1, ty + 1);  // S side (+y)
      if (e & EDGE.W) seg(tx, ty, tx, ty + 1);          // W side (-x)
    }
    ctx.stroke();
  }
  // door dots
  if (dots.length) {
    ctx.fillStyle = '#ffd400';
    ctx.beginPath();
    for (let k = 0; k < dots.length; k += 2) {
      const cx = X(dots[k] + 0.5, dots[k + 1] + 0.5), cy = Y(dots[k] + 0.5, dots[k + 1] + 0.5);
      ctx.moveTo(cx + 3, cy); ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  // legend
  const leg = mode === 'walk' || mode === 'cover' || mode === 'lot' ? LEGENDS[mode]
    : [...classes.filter(c => c.color).map(c => [c.name, c.color]), ...LEGENDS.ground];
  const lh = 14, bw = 120, bh = 22 + leg.length * lh;
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(8, 8, bw, bh);
  ctx.font = '11px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`grid: ${mode}`, 14, 12);
  leg.forEach(([name, c], n) => {
    const y = 28 + n * lh;
    ctx.fillStyle = c; ctx.fillRect(14, y, 10, 10);
    ctx.fillStyle = '#ffffff'; ctx.fillText(name, 30, y);
  });
  return { drawn };
}
