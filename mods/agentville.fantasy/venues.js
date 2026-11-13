// agentville.fantasy venue definitions (api.js VenueDef), keyed by kind: the harbour.
// The layout's harbour site (kind 'harbour') gives `anchor` = { tx: cx, ty: foot } and, when it has them,
// `data` = { cx, foot, sea }: cx the main pier's west tile column (under the town square), foot the shore row, sea the
// first water row. Geometry follows the classic harbour (web/src/dock-art.js harbourGeom) in tiles: piers 7 tiles
// apart, 2 wide, pointing south; a sloop takes 3 tiles of a pier side.
// MOD-READY: `plan` returns nodes and berths but no objects; the harbour's art arrives with the dock-art piece (C2),
// which re-pins the goldens on purpose.

/** Harbour level by PRs loading now (classic dock-art.js tierFor). */
export const tierFor = n => (n <= 3 ? 1 : n <= 7 ? 2 : n <= 12 ? 3 : 4);
const PIERS = [null, [0], [-1, 0, 1], [-2, -1, 0, 1], [-2, -1, 0, 1, 2]];
const UNITS = [null, 4, 4, 5, 6];        // berth units per pier side (a sloop takes 2)
const PITCH = 7, PIER_W = 2, SHIP = 3;   // tiles

/** Grows at once; shrinks one level at a time, and only when the need is two or more levels lower (the classic harbour
 *  waits ten minutes instead, but a level here carries no clock). */
function level(load, prev) {
  const n = Number.isFinite(load?.states?.loading) ? load.states.loading : (load?.prs ?? 0);
  const need = tierFor(n);
  if (prev == null || need >= prev) return need;
  return need <= prev - 2 ? prev - 1 : prev;
}

function plan({ site, level: lv }) {
  const d = site.data && typeof site.data === 'object' ? site.data : {};
  const cx = Number.isInteger(d.cx) ? d.cx : site.anchor.tx, foot = Number.isInteger(d.foot) ? d.foot : site.anchor.ty;
  const sea = Number.isInteger(d.sea) ? d.sea : foot + 1;
  const tier = Math.min(4, Math.max(1, lv | 0)), quay = tier >= 2;
  const y0 = quay ? sea + 2 : sea, per = UNITS[tier] >> 1;
  // lanes: the main pier first, west side before east (dock-art.js lane order)
  const lanes = [];
  for (const k of PIERS[tier]) for (const side of ['w', 'e']) lanes.push({ k, side });
  lanes.sort((a, b) => Math.abs(a.k) - Math.abs(b.k) || a.k - b.k || (a.side === 'w' ? -1 : 1));
  const berths = [];
  for (const { k, side } of lanes) {
    const x = side === 'w' ? cx + k * PITCH - 1 : cx + k * PITCH + PIER_W;
    for (let j = 0; j < per; j++) berths.push({ id: `p${k + 2}${side}${j}`, tx: x, ty: y0 + 1 + j * SHIP, face: 2 });
  }
  return {
    objects: [],
    nodes: { foot: { tx: cx, ty: foot }, yard: quay ? { tx: cx + 3, ty: foot - 1 } : { tx: cx, ty: foot } },
    berths,
  };
}

export const VENUES = { harbour: { level, plan } };
