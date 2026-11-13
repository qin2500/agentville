// Engine v2 coordinates (design §3.2, R7, R10). OWNER: A2. Pure, no DOM.
// World positions are FLOAT TILES. Tile (tx, ty) covers [tx, tx+1) x [ty, ty+1); its centre is (tx+.5, ty+.5).
// Projection at 1x: a tile is a 32x16 px diamond; toScreen(tx, ty) is the tile's NORTH (top) corner.
export const TILE_W = 32, TILE_H = 16, HALF_W = 16, HALF_H = 8;

/** @returns {{ sx: number, sy: number }} 1x screen px: sx = (tx - ty) * 16, sy = (tx + ty) * 8 - z */
export function toScreen(tx, ty, z = 0) {
  return { sx: (tx - ty) * HALF_W + 0, sy: (tx + ty) * HALF_H - z + 0 };
}

/** Inverse of toScreen at z = 0. @returns {{ tx: number, ty: number }} float tiles */
export function toTile(sx, sy) {
  const a = sx / HALF_W, b = sy / HALF_H;   // a = tx - ty, b = tx + ty
  return { tx: (b + a) / 2 + 0, ty: (b - a) / 2 + 0 };
}

/** Screen column (16 px wide, design §3.2) and depth diagonal of a tile. */
export const col = (tx, ty) => tx - ty;
export const diag = (tx, ty) => tx + ty;

const UNIT = Object.freeze({ scale: 1, toScreen, toTile, TILE_W, TILE_H, HALF_W, HALF_H });

/** A projection at another scale (risk fallback s = 0.8): same API as the module functions.
 *  Everything scales, z included (z is 1x px). scale 1 returns the module functions themselves. */
export function makeProjection(scale = 1) {
  const s = Number(scale);
  if (!(s > 0) || !Number.isFinite(s)) throw new Error(`engine: bad projection scale ${scale}`);
  if (s === 1) return UNIT;
  const hw = HALF_W * s, hh = HALF_H * s;
  return Object.freeze({
    scale: s, TILE_W: TILE_W * s, TILE_H: TILE_H * s, HALF_W: hw, HALF_H: hh,
    toScreen: (tx, ty, z = 0) => ({ sx: (tx - ty) * hw + 0, sy: ((tx + ty) * HALF_H - z) * s + 0 }),
    toTile: (sx, sy) => { const a = sx / hw, b = sy / hh; return { tx: (b + a) / 2 + 0, ty: (b - a) / 2 + 0 }; },
  });
}
