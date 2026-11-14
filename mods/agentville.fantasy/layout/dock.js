// agentville.fantasy layout: the harbour. Its site (a cove under the square's column, cut for the biggest harbour from
// the start), the waterfront clearing, the footpath from the harbour up to town and room to pan; and the `dock` venue
// site the engine hands to the venue owner. Pure. Moved from the engine's world/sites.js
// (classic world.js dockSite / dockShore) unchanged, so the world is byte-identical.
import { routeOnRaster } from '#agentville/mod';
import { PATH, FOOT, LAND, DOCKC, ROUTE } from './roads.js';

/** classic dockSite: { cx, foot, sea, x0, x1 } in tiles (cx: the square's centre column; foot: where the footpath
 *  meets the harbour; sea: the first water row; x0..x1: the cove). Needs G.town. */
export function dockSite(G) {
  const SQ = G.square;
  const cx = SQ.x + (SQ.w >> 1), foot = G.town[3] + 5;
  return { cx, foot, sea: foot + 1, x0: cx - 20, x1: cx + 24 };
}

/** classic dockShore: the clearing (land near the harbour, not in a block), the footpath (A* from the town's south
 *  edge to the nearest path, then straight down to the harbour) and the bounds grown to show the harbour. Needs the
 *  roads and the land. */
export function dockShore(G) {
  const { R, dock: D, town, inBlock } = G, { at, flags: F } = R, top = town[3] + 1;
  for (let y = D.foot - 3; y <= D.sea + 12; y++) for (let x = D.x0 - 2; x <= D.x1 + 2; x++) { const i = at(x, y); if (i >= 0 && (F[i] & LAND) && inBlock[i] < 0) F[i] |= DOCKC; }
  const foot = i => { R.add(PATH, G.path, i); R.add(FOOT, null, i); };
  const from = [[D.cx, top], [D.cx + 1, top]];
  for (const [x, y] of routeOnRaster(R, from, (x, y) => { const i = at(x, y); return i >= 0 && (F[i] & PATH) !== 0; }, [D.cx - 14, town[1], D.cx + 15, top], [D.cx, town[3]], ROUTE)) foot(at(x, y));
  for (let y = top; y <= D.foot; y++) { foot(at(D.cx, y)); foot(at(D.cx + 1, y)); }
  const b = G.bounds;
  G.bounds = [Math.min(b[0], D.x0 - 4), b[1], Math.max(b[2], D.x1 + 5), Math.max(b[3], D.sea + 28)];
}

/** The harbour as a VenueSite (api.js): its rect is the clearing's box (where harbour objects may go), its anchor the
 *  footpath's foot. `data` is the classic dock record. */
export function dockVenue(D) {
  return {
    kind: 'harbour',
    rect: { x: D.x0 - 2, y: D.foot - 3, w: D.x1 - D.x0 + 5, h: D.sea + 12 - (D.foot - 3) + 1 },
    anchor: { tx: D.cx, ty: D.foot },
    data: { ...D },
  };
}
