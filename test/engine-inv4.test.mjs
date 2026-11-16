// Invariant 4 (walk-through) over 600 ticks, design docs/village-engine-v2.md §2 and §7.3 M3 gate. Written from the spec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { present, loadFixture, makeSim, buildFrom, inputOf, advance, agentsOf, visible, fading, frozen, SEED } from './engine-support/sim-harness.mjs';

const { EDGE } = await import('../web/src/engine/core/grid.js');
const TICKS = 600;
const frames = name => { const f = loadFixture(name); return f ? (f.frames ?? [f]) : null; };

// does the straight move a->b enter an occupied tile or cross a blocked edge? Sampled finely; each tile change is checked.
function badMove(grid, x0, y0, x1, y1) {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.05));
  let tx = Math.floor(x0), ty = Math.floor(y0);
  for (let i = 1; i <= n; i++) {
    const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n;
    const nx = Math.floor(x), ny = Math.floor(y);
    if (nx === tx && ny === ty) continue;
    if (!grid.inBounds(nx, ny)) return `left grid at ${nx},${ny}`;
    if (grid.get('occ', nx, ny) !== 0) return `entered occupied tile ${nx},${ny}`;
    const dx = nx - tx, dy = ny - ty;
    const out = dx > 0 ? EDGE.E : dx < 0 ? EDGE.W : dy > 0 ? EDGE.S : dy < 0 ? EDGE.N : 0;
    const back = dx > 0 ? EDGE.W : dx < 0 ? EDGE.E : dy > 0 ? EDGE.N : EDGE.S;
    if (!(dx && dy) && out && (grid.edgeBlocked(tx, ty, out) || grid.edgeBlocked(nx, ny, back))) return `crossed blocked edge ${tx},${ty}->${nx},${ny}`;
    tx = nx; ty = ny;
  }
  return null;
}

function check(sim, world, last, tick, label, frozenPos) {
  const g = world.grid, seen = new Map();
  for (const a of agentsOf(sim)) {
    if (!visible(a)) { last.delete(a.id); continue; }
    const tx = Math.floor(a.x), ty = Math.floor(a.y), who = `${label} tick ${tick}: ${a.id}`;
    assert.ok(g.inBounds(tx, ty), `${who} out of bounds at ${a.x},${a.y}`);
    assert.ok(g.get('cost', tx, ty) < 255, `${who} on cost-255 tile ${tx},${ty}`);
    assert.equal(g.get('occ', tx, ty), 0, `${who} on occupied tile ${tx},${ty}`);
    const p = last.get(a.id);
    // a fade jumps at its midpoint and a placement/warp is a jump: only continuous moves are checked
    if (p && !fading(a) && !p.fading && (p.x !== a.x || p.y !== a.y)) {
      const bad = badMove(g, p.x, p.y, a.x, a.y);
      assert.ok(!bad, `${who} ${bad} (moved ${p.x},${p.y} -> ${a.x},${a.y})`);
    }
    last.set(a.id, { x: a.x, y: a.y, fading: fading(a) });
    if (!fading(a) && !a.path && a.slot) {
      const k = `${a.slot.tx},${a.slot.ty},${a.slot.sub}`;
      assert.ok(!seen.has(k), `${who} shares slot ${k} with ${seen.get(k)}`);
      seen.set(k, a.id);
    }
    if (frozen(a)) {
      const f = frozenPos.get(a.id);
      if (f) assert.ok(f.x === a.x && f.y === a.y, `${who} (stalled/error) moved ${f.x},${f.y} -> ${a.x},${a.y}`);
      else if (!fading(a)) frozenPos.set(a.id, { x: a.x, y: a.y });
    } else frozenPos.delete(a.id);
  }
}

function rebuildInput(frame) { return buildFrom(frame, SEED); }

for (const name of ['citydemo.json', 'busy.json', 'harbour-6.json']) {
  const fr = frames(name);
  test(`inv4 ${name}: 600 ticks incl. one mid-run rebuild`, { skip: (!present || !fr) && 'sim or fixture missing' }, () => {
    let { sim, world } = makeSim(fr[0]);
    const last = new Map(), fz = new Map();
    for (let i = 0; i < TICKS; i++) {
      if (i === 300) {
        const nb = rebuildInput(fr[0]);
        sim.setWorld(nb.world, nb.nav);
        world = nb.world; last.clear(); fz.clear();
      }
      advance(sim);
      check(sim, world, last, i, name, fz);
    }
  });
}

{
  const fr = frames('sequence-50.json');
  test('inv4 sequence-50: replay, one snapshot per 12 ticks, mid-run rebuild', { skip: (!present || !fr) && 'sim or fixture missing' }, () => {
    let { sim, world } = makeSim(fr[0]);
    const last = new Map(), fz = new Map();
    let fi = 0;
    for (let i = 0; i < TICKS; i++) {
      if (i > 0 && i % 12 === 0) { fi = Math.min(fr.length - 1, fi + 1); sim.applySnapshot(inputOf(fr[fi]).input); }
      if (i === 300) {
        const nb = rebuildInput(fr[fi]);
        sim.setWorld(nb.world, nb.nav); world = nb.world; last.clear(); fz.clear();
      }
      advance(sim);
      check(sim, world, last, i, 'sequence-50', fz);
    }
  });
}
