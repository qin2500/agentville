#!/usr/bin/env node
// City footprint report (city-compact, 2026-11-17): how much ground each city and the whole world take, and how much of
// it is greens. Builds the world the engine page builds (makeView -> toWorldInput -> buildWorld, fantasy mod) for:
//   --fixture busy|stress  a town that GREW to the fixture's peak before the city cap existed (fractions 0.006 .. 1, no
//                          cap), then "today": the cap on (40), three weeks later, only the boss and 30% of each
//                          project's other agents still about (the rest gone, their holds run out). That is a typical
//                          situation: plans laid out for the historic peak, few homes in use.
//   --live <layout.json> <agents.json>  a saved layout (persisted, read only) and an /api/agents snapshot (read only).
// Per city: tier, nest chain, block w x h and tiles, plan lots, lots in use (homes + PRs), free houses, greens and the
// green share. World: the bounding box of the shown blocks and the square, the sum of block tiles, the grid bounds.
// --root <checkout> runs another checkout's engine (e.g. main, for "before"). Pure, node only: no store, no network.
//   node tools/engine/footprint.mjs --fixture busy [--root ../agentville] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const HERE = fileURLToPath(new URL('../../', import.meta.url));
const ROOT = path.resolve(arg('--root', HERE)) + '/';
const imp = p => import(pathToFileURL(ROOT + p).href);
const { writeModsIndex } = await imp('tools/mods-index.mjs');
writeModsIndex(ROOT);
const { buildWorld } = await imp('web/src/engine/world/build.js');
const { makeView } = await imp('web/src/engine/snapshot.js');
const { toWorldInput } = await imp('web/src/engine/mod/input.js');
const { default: fantasy } = await imp('mods/agentville.fantasy/index.js');
const { modCtx } = await imp('web/src/engine/mod/registry.js');

const DAY = 864e5, SEED = 7, SALT = '5eed0007c0ffee00d00dfeed0000beef', CAP = 40;

/** One build the way the page runs it. */
export function buildOnce(src, persisted, now, { cityCap = CAP, seed = persisted.seed ?? SEED, hideQuiet = false } = {}) {
  const view = makeView({ ...src, hideQuiet }, { now, demo: !hideQuiet });
  const { input, serverId } = toWorldInput(view, { seed, salt: SALT });
  const ctxFor = projectKey => modCtx(fantasy, { seed, now, projectKey });
  return buildWorld(input, persisted, { mod: fantasy, now, seed, serverId, ctxFor, cityCap });
}

/** The fixture cut to fraction f of its agents (boss always) and PRs; stats too unless `keepStats`. */
export function slice(fx, f, dt, keepStats = false) {
  const projects = fx.projects.map(p => (keepStats ? { ...p } : { ...p, prs: p.prs.slice(0, Math.ceil(f * p.prs.length)),
    agentsEver: Math.ceil(f * (p.agentsEver || 0)), transcriptBytes: Math.round(f * (p.transcriptBytes || 0)) }));
  const keptPrs = new Set(projects.flatMap(p => p.prs.map(r => r.id)));
  const by = new Map();
  for (const a of fx.agents) { if (!by.has(a.project)) by.set(a.project, []); by.get(a.project).push(a); }
  const keep = new Set();
  for (const list of by.values()) {
    for (const a of list) if (a.role === 'boss') keep.add(a.id);
    for (const a of list.filter(a => a.role !== 'boss').slice(0, Math.ceil(f * (list.length - 1)))) keep.add(a.id);
  }
  const shift = v => (typeof v === 'number' ? v + dt : v);
  const agents = fx.agents.filter(a => keep.has(a.id)).map(a => ({ ...a, since: shift(a.since), lastActivityAt: shift(a.lastActivityAt), prs: (a.prs || []).filter(r => keptPrs.has(r.id)) }));
  return { ...fx, now: fx.now + dt, agents, projects, dock: undefined };
}

/** History to the peak (no cap), then today (cap on, 30% of agents, holds run out). Returns { persisted, world, now }. */
export function grownThenQuiet(fx, { today = 0.3, cityCap = CAP, grown = null, onGrown = null } = {}) {
  const persisted = grown ? JSON.parse(JSON.stringify(grown)) : { v: 1, seed: SEED, blocks: {}, lots: {} };
  const fr = [0.006, 0.06, 0.2, 1];
  if (!grown) fr.forEach((f, i) => { const s = slice(fx, f, (i - fr.length + 1) * DAY); buildOnce(s, persisted, s.now, { cityCap: null }); });
  onGrown?.(JSON.parse(JSON.stringify(persisted)));
  let world, now;
  for (const dt of [21 * DAY, 21 * DAY + 13 * 3600e3]) {
    const s = slice(fx, today, dt, true);
    now = s.now;
    world = buildOnce(s, persisted, now, { cityCap });
  }
  return { persisted, world, now };
}

/** The footprint of a built world. */
export function footprint(world) {
  const cities = [];
  let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity, tiles = 0, lots = 0, greens = 0, used = 0;
  const sq = world.square;
  for (const r of [sq, ...world.villages.map(v => v.block)]) { X0 = Math.min(X0, r.x); Y0 = Math.min(Y0, r.y); X1 = Math.max(X1, r.x + r.w); Y1 = Math.max(Y1, r.y + r.h); }
  for (const v of world.villages) {
    const b = v.block, pl = v.plan.lots, ids = pl.map(l => `lot:${v.name}:${l.id}`);
    const inUse = ids.filter(id => ['home', 'pr'].includes(world.objects.get(id)?.data?.owner)).length;
    const free = ids.filter(id => world.objects.get(id)?.data?.owner === 'house').length;
    const g = ids.filter(id => world.greens.has(id)).length;
    cities.push({ name: v.name, tier: v.tier, chain: b.nest ?? null, w: b.w, h: b.h, tiles: b.w * b.h, lots: pl.length, inUse, free, greens: g, greenShare: +(g / Math.max(1, pl.length)).toFixed(2) });
    tiles += b.w * b.h; lots += pl.length; greens += g; used += inUse;
  }
  cities.sort((a, b) => b.tiles - a.tiles);
  const B = world.bounds;
  return { cities, world: { cities: cities.length, bbox: `${X1 - X0}x${Y1 - Y0}`, bboxTiles: (X1 - X0) * (Y1 - Y0), blockTiles: tiles, lots, inUse: used, greens,
    greenShare: +(greens / Math.max(1, lots)).toFixed(2), grid: B ? `${B.w ?? B.x1 - B.x0}x${B.h ?? B.y1 - B.y0}` : null } };
}

function print(label, fp) {
  console.log(`\n== ${label}`);
  console.log('city'.padEnd(28), 'tier chain'.padEnd(26), 'block'.padEnd(8), 'tiles'.padStart(6), 'lots'.padStart(5), 'used'.padStart(5), 'free'.padStart(5), 'greens'.padStart(7), 'share'.padStart(6));
  for (const c of fp.cities) console.log(c.name.slice(0, 27).padEnd(28), `${c.tier} ${c.chain ?? ''}`.slice(0, 25).padEnd(26), `${c.w}x${c.h}`.padEnd(8), String(c.tiles).padStart(6), String(c.lots).padStart(5), String(c.inUse).padStart(5), String(c.free).padStart(5), String(c.greens).padStart(7), String(c.greenShare).padStart(6));
  console.log('world', JSON.stringify(fp.world));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const out = {};
  const fx = arg('--fixture', null);
  if (fx) for (const name of fx.split(',')) {
    const data = JSON.parse(fs.readFileSync(`${HERE}e2e/fixtures/engine/${name}.json`, 'utf8'));
    // --grown <dir>: read <dir>/<fixture>.grown.json (the peak layout another checkout grew, e.g. main) instead of growing
    // it here; --save-grown <dir>: write the peak layout this checkout grew
    const gDir = arg('--grown', null), sDir = arg('--save-grown', null);
    const grown = gDir ? JSON.parse(fs.readFileSync(path.join(gDir, `${name}.grown.json`), 'utf8')) : null;
    const { world, persisted, now } = grownThenQuiet(data, { grown, onGrown: sDir ? p => { fs.mkdirSync(sDir, { recursive: true }); fs.writeFileSync(path.join(sDir, `${name}.grown.json`), JSON.stringify(p)); } : null });
    out[name] = footprint(world);
    const again = footprint(buildOnce(slice(data, 0.3, 21 * DAY + 14 * 3600e3, true), persisted, now + 3600e3));
    out[name].stableAfterHour = JSON.stringify(again.cities) === JSON.stringify(out[name].cities);
  }
  const live = argv.indexOf('--live');
  if (live >= 0) {
    const persisted = JSON.parse(fs.readFileSync(argv[live + 1], 'utf8')), src = JSON.parse(fs.readFileSync(argv[live + 2], 'utf8'));
    const now = src.serverTime ?? Date.now();
    out.live = footprint(buildOnce(src, persisted, now, { hideQuiet: true }));
    out.live.stableAfterMinute = JSON.stringify(footprint(buildOnce(src, persisted, now + 60_000, { hideQuiet: true })).cities) === JSON.stringify(out.live.cities);
    if (arg('--save', null)) fs.writeFileSync(arg('--save'), JSON.stringify(persisted));
  }
  if (argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
  else for (const [k, v] of Object.entries(out)) print(`${k} (${path.basename(ROOT)})`, v);
}
