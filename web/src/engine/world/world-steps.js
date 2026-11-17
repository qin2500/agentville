// The stages of a world rebuild after the rules phase, as a step generator (PERF M7).
// Pure, no DOM. index.js drives it with core/slices.js: all at once for a rebuild while a world is showing, in slices for
// the cold build so the nav, the sim and the first snapshot each run in their own task after the world build.
// The work and its order are the same either way; only where the main thread is handed back differs.
//
//   worldSteps({ input, persisted, mod, build, nav?, navMemo?, sim?, createNav, createSim, berthCtx, onWorld? })
//     yields: the world build's own stage labels (build.js buildWorldSteps; as yield* would), then after: 'build' (the
//     build done), 'world' (onWorld), 'nav' (nav kept or made), 'graph' (a new nav's road graph), 'sim' (sim created or re-pointed),
//     then 'snapshot' every few hundred agents of the first snapshot (sim applySnapshotSteps)
//     returns { world, nav, navMemo, navReused, sim, berths, buildMs }   navMemo: () => navKey(world), computed once on demand
//   build: buildWorld's opts minus mod ({ now, seed, forcedTier, forcedStyle, serverId, rules, cache })
//   onWorld(world, buildMs): called right after the build's slice (the renderer takes the world there)
import { buildWorldSteps } from './build.js';
import { navKey } from './cache.js';
import { venueAssignments } from './venue.js';

export function* worldSteps({ input, persisted, mod, build, nav = null, navMemo = '', sim = null, createNav, createSim, berthCtx = {}, onWorld = null }) {
  // the world build in its own stages (build.js buildWorldSteps; the same work and order as buildWorld). buildMs is the SUM
  // of the build's slices (the time spent inside the generator), not the wall time from the first slice to the last: a
  // sliced cold build's wall time also counts whatever else ran while it handed the thread back.
  const bg = buildWorldSteps(input, persisted, { mod, ...build });
  let buildMs = 0, t = performance.now(), r = bg.next();
  buildMs += performance.now() - t;
  while (!r.done) {
    yield r.value;   // forwarded as yield* would; the loop is only here to time the slices
    t = performance.now(); r = bg.next(); buildMs += performance.now() - t;
  }
  const world = r.value;
  yield 'build';
  onWorld?.(world, buildMs);   // its own slice: the renderer taking a new world is not added to the world build's task
  yield 'world';
  // keep the nav (road graph, labels, flow fields, routes, queued path requests) when everything it reads is unchanged.
  // Its slot claims are dropped so they match the fresh state sim.setWorld expects (it forgets every held slot).
  // navMemo may be the key itself or a function giving it (the key of the world the nav was made for, worked out only
  // when a later rebuild compares: the cold build has no nav to keep, so it never pays for a key)
  let navReused = false, nk = null;
  const keyOfThis = () => (nk ??= navKey(world));
  if (nav && keyOfThis() === (typeof navMemo === 'function' ? navMemo() : navMemo)) {
    navReused = true;
    if (sim) for (const id of sim.actors.keys()) nav.slots?.release?.(id);
    yield 'nav';
  } else {
    nav = createNav(world);
    yield 'nav';
    // the road graph is built lazily on the first path request, which is the first frame's sim tick: build it here, in a
    // step of its own, so that frame's task does not carry it too. The same graph either way (a pure function of the world).
    void nav.graph;
    yield 'graph';
  }
  if (!sim) sim = createSim(world, nav);
  else sim.setWorld(world, nav);
  yield 'sim';
  const berths = venueAssignments(world, input, mod, persisted, berthCtx);
  // the sim reads opts.berths (prId -> { venue, berth, tx, ty, face, model?, tint? }). The first snapshot of a big town
  // spawns every actor: its step form yields every few hundred agents (a sim without one does it in one step)
  if (typeof sim.applySnapshotSteps === 'function') yield* sim.applySnapshotSteps(input, { berths: berths.prs });
  else sim.applySnapshot(input, { berths: berths.prs });
  return { world, nav, navMemo: keyOfThis, navReused, sim, berths, buildMs };
}
