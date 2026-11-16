// Helpers for the M3 sim regression tests: build world + nav + sim from an engine fixture, in node, no DOM.
import '../support/ensure-mods-index.mjs';
import fs from 'node:fs';
const { buildWorld } = await import('../../web/src/engine/world/build.js');
const { resolveMod } = await import('../../web/src/engine/mod/registry.js');
const { toWorldInput } = await import('../../web/src/engine/mod/input.js');
const { loadFixture, viewFromFixture } = await import('./world-views.mjs');
const { default: fantasy } = await import('../../mods/agentville.fantasy/index.js');
const SIM_URL = new URL('../../web/src/engine/sim/world-sim.js', import.meta.url);
const NAV_URL = new URL('../../web/src/engine/nav/index.js', import.meta.url);
export const present = fs.existsSync(SIM_URL) && fs.existsSync(NAV_URL);
export const SEED = 7, DT = 0.05;
export { loadFixture };
export const simMod = await import(SIM_URL.href).catch(() => ({}));
export const navMod = await import(NAV_URL.href).catch(() => ({}));

export function fantasyMod() {
  const m = resolveMod();
  return { ...m, behaviour: m.behaviour ?? fantasy.behaviour, represent: m.represent ?? fantasy.represent, ambient: m.ambient ?? fantasy.ambient };
}
export const inputOf = (frame, seed = SEED) => toWorldInput(viewFromFixture(frame), { seed, salt: String(seed) });
export function buildFrom(frame, seed = SEED) {
  const { input, serverId } = inputOf(frame, seed);
  const world = buildWorld(input, { v: 1, seed, blocks: {}, lots: {} }, { now: frame.now, seed, serverId });
  return { world, nav: navMod.createNav(world), input, serverId };
}
export function makeSim(frame, { seed = SEED, mutate } = {}) {
  const { world, nav, input, serverId } = buildFrom(frame, seed);
  const sim = simMod.createSim({ world, nav, seed, mod: fantasyMod(), serverId, clock: { dayLength: 60, phase0: 0.3 } });
  sim.applySnapshot(mutate ? mutate(input) : input);
  return { sim, world, nav, input, serverId };
}
/** one fixed step: the spec seam sim.step(seconds), falling back to tick(dt) */
export const advance = (sim, dt = DT) => (sim.step ? sim.step(dt) : sim.tick(dt));
export const agentsOf = sim => [...sim.actors.values()].filter(a => a.kind === 'agent');
export const visible = a => (a.flags & 1) !== 0;
export const fading = a => a.fade != null || (a.alpha != null && a.alpha < 1);
export const statusOf = a => a.input?.status ?? a.status?.bucket ?? a.status;
export const frozen = a => { const s = statusOf(a); return s === 'stalled' || s === 'error'; };
