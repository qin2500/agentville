// agentville.fantasy free-lot greens (city cap, 2026-11-17): what a lot looks like while no house stands on it (a retired
// agent's old lot, or a free lot past the city cap). Pure data out, deterministic in the lot id: the same lot is always
// the same green. Uses only existing plan ground codes and prop kinds (objects.js); no art of its own.
//   orchard  rows of fruit trees on orchard ground, a beehive at the edge
//   garden   flower beds and bushes on garden ground, a bench when there is room
//   plaza    a small paved square with a well (or a fountain on a big lot) and flower boxes
import { GROUND } from '../../web/src/city-plan.js';

const h32 = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
export const GREEN_KINDS = ['orchard', 'garden', 'plaza'];

/** hooks.freeLot({ id, w, h, rank, look }) -> { kind, ground, props: [{ kind, x, y, v }] } in lot-local tiles (foot point
 *  at the tile centre: x + 0.5, y + 0.5). Orchards and gardens are twice as common as plazas. */
export function freeLot({ id, w, h }) {
  const r = h32(id), pick = r % 5, kind = pick < 2 ? 'orchard' : pick < 4 ? 'garden' : 'plaza';
  const at = (x, y) => ({ x: x + 0.5, y: y + 0.5 });
  const props = [];
  if (kind === 'orchard') {
    for (let y = 0; y < h; y += 2) for (let x = (y / 2) % 2; x < w; x += 2) props.push({ kind: 'tree', ...at(x, y), v: (r >> (x + y)) & 3 });
    if (w * h >= 9) props.push({ kind: 'beehive', ...at(w - 1, h - 1), v: 0 });
    return { kind, ground: GROUND.ORCHARD, props };
  }
  if (kind === 'garden') {
    const blooms = ['flowers', 'sunflower', 'clover', 'flowers'];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = (x * 7 + y * 13 + r) % 9;
      if (k < 4) props.push({ kind: blooms[k], ...at(x, y), v: (r >> k) & 3 });
      else if (k === 4) props.push({ kind: 'bush', ...at(x, y), v: (r >> 3) & 1 });
    }
    return { kind, ground: GROUND.GARDEN, props };
  }
  const cx = Math.floor((w - 1) / 2), cy = Math.floor((h - 1) / 2);
  if (w >= 4 && h >= 4) props.push({ kind: 'fountain', x: cx + 1, y: cy + 1, v: 0 });
  else props.push({ kind: 'well', ...at(cx, cy), v: 0 });
  for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) props.push({ kind: 'flowerbox', ...at(x, y), v: 0 });
  return { kind, ground: GROUND.PLAZA, props };
}
export default freeLot;
