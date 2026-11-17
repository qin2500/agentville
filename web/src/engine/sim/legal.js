// Tile legality helpers shared by the world-sim and the agent behaviour (M3). Pure.
// A tile is legal to stand on when it is in bounds, cost < 255 and occ 0 (design §2, invariant 4).

/** @returns {boolean} true when (tx, ty) can be stood on (no grid = anything goes) */
export function isLegalTile(grid, tx, ty) {
  if (!grid || typeof grid.get !== 'function') return true;
  return (!grid.inBounds || grid.inBounds(tx, ty)) && grid.get('cost', tx, ty) < 255 && grid.get('occ', tx, ty) === 0;
}
/** the point itself when its tile is legal, else the nearest legal tile centre (ring search, deterministic), or null
 *  within `radius` tiles */
export function nearestLegal(grid, x, y, radius = 24) {
  const cx = Math.floor(x), cy = Math.floor(y);
  if (isLegalTile(grid, cx, cy)) return { x, y };
  for (let r = 1; r <= radius; r++) {
    let best = null, bd = Infinity;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !isLegalTile(grid, cx + dx, cy + dy)) continue;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = { x: cx + dx + 0.5, y: cy + dy + 0.5 }; }
    }
    if (best) return best;
  }
  return null;
}
