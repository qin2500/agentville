// Host debug glue: the classic villageDebug().dock shape (tier, rect, berths, sails, walkers, lights) read off the v2 world
// and sim. Outside web/src/engine/** because the key and the model names are the classic app's (test/mod-ready-ratchet).
// Pure: no DOM.
import { decodeLevel } from '../../../mods/agentville.fantasy/venues.js';
const LIGHT_MODELS = new Set(['lamp', 'lighthouse', 'beacon', 'buoy']);
const HARBOUR_KIND = 'harbour';

/** The harbour venue of a world: the one named 'dock', else the first of kind 'harbour'. */
export function harbourOf(world) {
  const vs = world?.venues && typeof world.venues === 'object' ? world.venues : {};
  return vs.dock ?? Object.values(vs).find(v => v?.kind === HARBOUR_KIND) ?? null;
}

/**
 * @param {{ world: object, actors: Iterable<object>, now?: number }} src
 * @returns {{ dock: object } | {}} spread into the engine's debug() snapshot
 */
export function venueDebug({ world, actors = [] } = {}) {
  const v = harbourOf(world);
  if (!v) return {};
  const list = [...actors], lights = [];
  for (const o of world.objects?.values?.() ?? []) {
    if (o?.data?.venue !== v.id || !LIGHT_MODELS.has(o.model)) continue;
    lights.push({ model: o.model, tx: o.tx, ty: o.ty });
  }
  const here = a => a.venue === v.id;
  return { dock: {
    id: v.id, tier: decodeLevel(v.level).tier, level: v.level, rect: { x: v.rect.x, y: v.rect.y, w: v.rect.w, h: v.rect.h },
    cx: v.tx, foot: v.ty, berths: v.berths.map(b => ({ id: b.id, tx: b.tx, ty: b.ty })),
    sails: list.filter(a => a.kind === 'token' && here(a)).map(a => ({ id: a.id, item: a.item, berth: a.berth ?? null, state: a.state ?? null })),
    walkers: list.filter(a => a.kind === 'porter' && here(a) && ((a.flags | 0) & 1)).map(a => ({ id: a.id, state: a.state ?? null, carry: !!a.carry })),
    // the same porters with where they are (tiles), whether they are fading and where their trip starts (captures, e2e)
    porters: list.filter(a => a.kind === 'porter' && here(a) && ((a.flags | 0) & 1)).map(a => ({ id: a.id, state: a.state ?? null,
      x: Number.isFinite(a.x) ? a.x : null, y: Number.isFinite(a.y) ? a.y : null, fade: !!a.fade, alpha: a.alpha ?? 1,
      origin: a.origin ? { x: a.origin.x, y: a.origin.y } : null })),
    lights,
  } };
}
