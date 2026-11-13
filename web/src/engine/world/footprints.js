// Footprint resolution for plan props (design §1.2). Pure. The table itself is mod data
// (mod.objects.props, e.g. mods/agentville.fantasy/objects.js); this file keeps no fantasy knowledge.
//
// footprintFor(prop, objectTypes) takes a plan prop { kind, x, y, v, dir?, len? } and the ObjectTypeTable and returns
//   { w, h, walk, z, run?, anchors?, snap?, kind?, dir? }  or null for a decal / unknown kind (floor, baked into ground).
// The table is plain data with NO functions (M1b), so it can cross into a mod sandbox (structuredClone / JSON):
// - byDir: { x: ObjectType, y: ObjectType }: the variant is picked by prop.dir ('y', else 'x'); the entry's other fields
//   are defaults the variant overrides.
// - walk 'edge' (fences): the engine derives w, h and run { dir, len, side } from prop.dir, prop.len and the prop's foot
//   point (side: which edge of the run's first tile row/column it sits on). A table-supplied run is ignored.
// - anchors: OFFSETS from the footprint's top-left tile (copied, so callers may mutate them).
// Legacy: a function-valued entry (prop) => ObjectType|null is still called for engine-side tables, but a mod table
// with functions cannot be sandboxed.

const EPS = 1e-6;
const clone = a => (a ? Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.map(s => ({ ...s }))])) : undefined);
const dirOf = p => (p.dir === 'y' ? 'y' : 'x');

/** The edge run a plan prop describes: { dir, len, side }. */
export function edgeRun(prop) {
  const dir = dirOf(prop), len = Math.max(1, Math.round(prop.len || 1));
  const side = dir === 'x' ? ((prop.y - Math.floor(prop.y + EPS)) < 0.5 ? 'N' : 'S') : ((prop.x - Math.floor(prop.x + EPS)) < 0.5 ? 'W' : 'E');
  return { dir, len, side };
}

/** @returns {{ w, h, walk, z, run?, anchors?, snap?, kind?, dir? } | null} null: a decal or a kind the table does not know */
export function footprintFor(prop, objectTypes) {
  const props = objectTypes?.props;
  if (!props) throw new Error('engine: footprintFor needs the mod ObjectTypeTable (mod.objects)');
  let base = props[prop.kind];
  if (typeof base === 'function') base = base(prop);   // legacy, not sandboxable
  if (base && base.byDir) { const { byDir, ...rest } = base; const v = byDir[dirOf(prop)]; base = v ? { ...rest, ...v } : null; }
  if (!base || base.decal) return null;
  const fp = { ...base };
  if (base.anchors) fp.anchors = clone(base.anchors);
  if (base.walk === 'edge') {
    const run = edgeRun(prop);
    Object.assign(fp, { w: run.dir === 'x' ? run.len : 1, h: run.dir === 'x' ? 1 : run.len, run });
  } else if (base.run) fp.run = { ...base.run };
  return fp;
}

/** The footprint's top-left tile (plan tiles) for a prop at its foot point. Fences: the tile that owns the run's first edge. */
export function originTile(prop, fp) {
  if (fp.walk === 'edge') return { tx: Math.floor(prop.x + EPS), ty: Math.floor(prop.y + EPS) };
  return { tx: Math.floor(prop.x - fp.w / 2 + 0.5 + EPS), ty: Math.floor(prop.y - fp.h / 2 + 0.5 + EPS) };
}
