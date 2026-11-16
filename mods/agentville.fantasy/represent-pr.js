// Fantasy mod: what a PR is (api.js PrSpec; mod.represent.pr as a function of the PR view). Split from represent.js so
// the PR representation and the behaviour table have separate owners.
// A live PR is a building site on a lot (the lots hook asks for it). A loading PR (open now) is a ship at the harbour
// (venues.js), its class by the PR's size (classic dock-art.js shipClass; the engine vessel prop's classes). A merged
// PR has sailed: it is not drawn and takes no berth (its ship leaves when the PR merges). A closed PR is not shown.

/** The vessel classes, small to big (engine art/props/vessel.js CLASSES). */
export const SHIP_CLASSES = Object.freeze(['dinghy', 'cutter', 'brig']);
export const SMALL_LINES = 50, BIG_LINES = 500, BIG_FILES = 20;

// parity: har.ship-class-by-pr-size
/** A PR's ship by its size: < 50 lines changed a dinghy, > 500 lines or > 20 files a brig, otherwise a cutter. */
export function shipClass(size) {
  const n = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const lines = n(size?.additions) + n(size?.deletions), files = n(size?.files);
  return lines > BIG_LINES || files > BIG_FILES ? 'brig' : lines < SMALL_LINES ? 'dinghy' : 'cutter';
}

/** mod.represent.pr: (prView, ctx) => PrSpec. */
export function representPr(pr) {
  switch (pr?.state) {
    case 'building': return { as: 'lot' };
    case 'loading': return { as: 'venue', venue: 'harbour', model: shipClass(pr.size) };
    default: return { as: 'none' };   // merged: sailed; closed: not shown
  }
}

export const REPRESENT = { pr: representPr };
