// Growth room round a placed block (M7): how far the block can grow toward each corner and still keep the
// layout gap to everything round it, so a nesting planner can grow its plan where there is room and the block keeps its
// place (every old item on its tile). Pure, no DOM, no storage.
//
//   growthRoom(rect, obstacles, gap, max) -> { se, sw, ne, nw }
//
// Each corner's entry is an array R of length max + 1: R[g] is the most the block can grow vertically (south for se/sw,
// north for ne/nw) while it grows g tiles horizontally (east for se/ne, west for sw/nw), with its opposite corner fixed;
// -1 when even no vertical growth fits. Values are capped at `max`. Plain data (the planner request must structuredClone).

const CORNERS = { se: [1, 1], sw: [-1, 1], ne: [1, -1], nw: [-1, -1] };

/** Whether rects a and b are closer than `gap` (the layout's near test). */
const near = (a, b, gap) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/**
 * @param {{ x: number, y: number, w: number, h: number }} b the block as it stands
 * @param {Array<{ x: number, y: number, w: number, h: number }>} obstacles everything it must keep `gap` from (not itself)
 * @param {number} gap
 * @param {number} [max]
 * @returns {{ se: number[], sw: number[], ne: number[], nw: number[] }}
 */
export function growthRoom(b, obstacles, gap, max = 64) {
  const out = {};
  for (const [k, [gx, gy]] of Object.entries(CORNERS)) {
    const R = new Array(max + 1).fill(max);
    for (const o of obstacles) {
      // the grown rect only moves its far edges, so it comes within the gap of o once g >= ax and v >= ay (or never)
      const fixedX = gx > 0 ? b.x < o.x + o.w + gap : o.x < b.x + b.w + gap;
      const fixedY = gy > 0 ? b.y < o.y + o.h + gap : o.y < b.y + b.h + gap;
      if (!fixedX || !fixedY) continue;
      const ax = Math.max(0, gx > 0 ? o.x - b.x - b.w - gap + 1 : b.x - o.x - o.w - gap + 1);
      const ay = Math.max(0, gy > 0 ? o.y - b.y - b.h - gap + 1 : b.y - o.y - o.h - gap + 1);
      if (ax > max) continue;
      R[ax] = Math.min(R[ax], ay - 1);
    }
    for (let g = 1; g <= max; g++) R[g] = Math.min(R[g], R[g - 1]);
    out[k] = R;
  }
  return out;
}

/** The rect a nested plan lands on when it keeps every old item on its tile: old origin - nest offset. */
export const anchoredRect = (b, plan) => ({ x: b.x - plan.nest.dx, y: b.y - plan.nest.dy, w: plan.w, h: plan.h });

export { near as nearRect };
