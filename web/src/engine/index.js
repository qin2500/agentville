// Village engine v2 entry (design §6.1).
// createEngine(app) returns the same object as createVillage(app) (village.js), so main.js swaps one line
// behind ?engine=2. M1 draws the debug grid only (flat tiles, walkability and cover heatmaps: &grid=ground|walk|cover|lot).
//
// Dev params: ?fixture=<name> (frozen e2e/fixtures/engine/<name>.json served by the art harness vite config),
// ?citydemo=1, ?citytier=N, ?seed=N (world seed), ?t=<sec> (pinned sim clock, used from M3), ?grid=<mode>.
import { store, icon } from '../ui.js';
import { cityDemo, isDemoId } from '../city-demo.js';
import { toView, makeView, viewFromFixture } from './snapshot.js';
import { loadWorld, saveWorld, loadSalt } from './world/persist.js';
import { createBuildCache } from './world/cache.js';
import { createRulesMemo } from './world/rules-memo.js';
import { worldSteps } from './world/world-steps.js';
import { drainSync, drainSliced } from './core/slices.js';
import { venueSig, venueAssignments } from './world/venue.js';
import { resolveMod, modCtx, listMods, DEFAULT_MOD } from './mod/registry.js';
import { pickWorld } from '../worlds.js';
import { toWorldInput, createInputReuse } from './mod/input.js';
import { drawGridDebug } from './debug/grid-view.js';
import { createRenderer } from './render/renderer.js';
import { runEvents, createEventFx } from './render/event-fx.js';
import { PANEL_HIT_KINDS, openPrPanel, venueParams, venueDebug } from '../engine-host.js';
import { createNav } from './nav/index.js';
import { createSim } from './sim/world-sim.js';
import { pick as pickHit, imageAlphaAt } from './render/pick.js';
import { toScreen } from './core/coords.js';
import { worldToCss } from './camera.js';
import { createCameraCtl, isActive } from './camera-ctl.js';
import { attachInput, bindZoomButtons, villageAtTile } from './input-ctl.js';
import { labelCands, labelBlockers, layoutLabels } from './overlay/labels.js';
import { createLabelLayer } from './overlay/dom-labels.js';
import { layoutBadges, drawBadges } from './overlay/badges.js';
import { nightFrame, ariaSummary, artState, nextFrame, bucketOrder, projectCounts, townWater, debugItems, debugHomes,
  debugOutdoors, debugHits, debugWalkers, debugClusters, prNumber, devParams } from './debug/compat.js';

const BG = '#1b4a7a';   // behind the grid when the mod's terrain class 0 has no colour
const MODES = new Set(['town', 'ground', 'walk', 'cover', 'lot']);   // 'town' = the M2/M3 renderer; the rest are M1 debug grids
const STEP_S = 0.05;
const ONSCREEN_MARGIN = 4;   // tiles round the view the sim still counts as on screen (walk vs fade, design §4)

export function createEngine(app) {
  const { S } = app;
  const host = document.getElementById('village');
  const cv = document.getElementById('cv');
  const labels = document.getElementById('labels');
  const quietNote = document.getElementById('quiet-note');
  const ctx = cv.getContext('2d');
  const params = new URLSearchParams(location.search);
  const dev = devParams(location.search);
  const DEMO = dev.demo;
  const fixtureName = /^[a-z0-9-]+$/.test(params.get('fixture') || '') ? params.get('fixture') : null;
  const forcedTier = dev.tier;   // the mod's tier hook clamps to its own tier count
  const forcedStyle = dev.style, seedParam = dev.seed, simT = dev.t;
  let mode = MODES.has(params.get('grid')) ? params.get('grid') : 'town';
  const nightParam = params.get('night');   // '1' | '0' | null (null: local time)

  cv.dataset.art = 'loading';   // ready | failed once the art is in (classic contract); data-engine keeps the engine state
  cv.dataset.engine = 'loading';
  if (labels) labels.replaceChildren();
  const labelLayer = labels ? createLabelLayer(labels, { icon }) : null;
  const measureCtx = document.createElement('canvas').getContext('2d'), textW = new Map();
  const measure = (text, font) => { const k = font + text; if (!textW.has(k)) { measureCtx.font = font; textW.set(k, measureCtx.measureText(text).width); } return textW.get(k); };

  // ?world=<id> picks a bundled mod for the session; else Settings (va.world.mod); else the default (village-mods.md §5.2).
  // pickWorld never throws: an invalid or unknown id falls back to the default world.
  const picked = pickWorld(params.get('world'), store.get('va.world.mod', undefined), listMods().map(m => m.id));
  let mod;
  try { mod = resolveMod(picked); }   // a world that fails to load (bad apiVersion, missing parent) falls back to the default
  catch (e) { console.warn(`world ${picked} failed to load, using ${DEFAULT_MOD}: ${e.message}`); mod = resolveMod(DEFAULT_MOD); }
  const CAM_KEY = mod.id === DEFAULT_MOD ? 'va.cam.e2' : `va.cam.e2.${mod.id}`;   // each world keeps its own camera
  const BG_COL = mod.terrain?.classes?.find(c => c.code === 0)?.color || BG;   // outside the grid is terrain class 0
  const persisted = loadWorld(store, { demo: DEMO || !!fixtureName, now: Date.now(), mod, adopt: !fixtureName });   // a classic import is kept at once
  const salt = loadSalt(store);              // secret, never in WorldInput (review M1): opaque ids are not a public hash of the seed
  const buildCache = createBuildCache();     // incremental rebuilds: only changed projects re-plan and re-stamp
  let fixture = null, fixtureState = fixtureName ? 'loading' : 'none', demo = null;
  if (fixtureName) {
    fetch(`${import.meta.env?.BASE_URL ?? '/'}__fixtures/engine/${fixtureName}.json`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(fx => { fixture = fx; fixtureState = 'ready'; rebuild(); })
      .catch(e => { fixtureState = 'failed'; console.warn(`engine: fixture ${fixtureName} unavailable: ${e.message}`); cv.dataset.engine = 'failed'; });
  }

  const vp = () => ({ w: host.clientWidth, h: host.clientHeight });
  // parity: camera.persisted
  const camera = createCameraCtl({ vp, store, key: CAM_KEY, reduceMotion: () => !!S.reduceMotion, now: () => performance.now() });
  const saved = store.get(CAM_KEY, null);
  if (saved && saved.v === 2) camera.set(saved);
  let firstFit = !saved;
  // perf (debug): buildMs = buildWorld, rebuildMs = a whole rebuild that built a world (rules, plan, build, nav, sim),
  // pollMs = the last rebuild that kept the world (status changes only), drawMs = the last frame
  let world = null, sig = '', view = null, selected = null, lastError = null, perf = { buildMs: 0, rebuildMs: 0, pollMs: 0, drawMs: 0 };
  // frame times of the last FRAME_RING draws, and the longest main-thread task (longtask entries, ?debug only)
  // simMs: the sim tick inside each of those frames (its fixed 50 ms steps), so the render share is frame - sim
  const FRAME_RING = 600, frameMs = new Float32Array(FRAME_RING), simMs = new Float32Array(FRAME_RING);
  let frameN = 0, longestTaskMs = null, lastSimMs = 0;
  let trace = null;   // ?debug only (villagePerf.trace): one row per drawn frame, for the perf harness's --trace
  if (params.has('debug') && typeof PerformanceObserver === 'function') {
    try {
      new PerformanceObserver(l => { for (const e of l.getEntries()) longestTaskMs = Math.max(longestTaskMs ?? 0, e.duration); })
        .observe({ type: 'longtask', buffered: true });
      longestTaskMs = 0;
    } catch { /* no longtask entries in this browser */ }
  }
  function frameStats(ring = frameMs) {
    const n = Math.min(frameN, FRAME_RING);
    if (!n) return { n: 0, p50: 0, p95: 0, max: 0 };
    const a = Array.from(ring.subarray(0, n)).sort((x, y) => x - y), q = p => +a[Math.min(n - 1, Math.floor(p * n))].toFixed(2);
    return { n, p50: q(0.5), p95: q(0.95), max: +a[n - 1].toFixed(2) };
  }
  /** The sim's own cost over the frame ring (debug perf block): summed sim and frame ms since reset(), the sim's share of
   *  the frame time, and the sim's ambient LOD state. Frame times INCLUDE the sim (draw() times it inside the frame). */
  function simStats() {
    const n = Math.min(frameN, FRAME_RING);
    let simSum = 0, frameSum = 0;
    for (let i = 0; i < n; i++) { simSum += simMs[i]; frameSum += frameMs[i]; }
    return { n, simSumMs: +simSum.toFixed(2), frameSumMs: +frameSum.toFixed(2), meanMs: n ? +(simSum / n).toFixed(3) : 0,
      share: frameSum > 0 ? +(simSum / frameSum).toFixed(3) : 0, lod: sim?.lod ?? null };
  }
  // M6 world events: sim events -> mod.events -> active effects (render/event-fx.js). newObjects: ids new in the last world build.
  const evfx = createEventFx();
  let prevObjIds = null, newObjects = [], evStats = { status: 'none', ms: 0, specs: 0 };
  let berths = null;                         // venueAssignments(): PR -> venue berth, per poll (no rebuild)
  let raf = 0, renderer = null, nav = null, sim = null, hits = [], lastT = 0, simPinned = false;
  // Rebuild-cost memos (M3, per project since M7): the rules phase per project whose rule inputs are unchanged
  // (world/rules-memo.js; unchanged input records come back as the same objects, mod/input.js createInputReuse), and the
  // nav for unchanged nav content.
  const rulesMemo = createRulesMemo(), inputReuse = createInputReuse();
  let navMemo = '';                          // the nav's world key, or a function giving it (world/world-steps.js)
  const reuse = { rules: 0, nav: 0, builds: 0 };
  // id maps of the latest WorldInput (sim actors carry opaque ids; the app selects by server id)
  let toServerId = id => id, toOpaqueId = id => id;
  let stepped = false;                       // window.villageStep took over the clock: frames stop ticking in real time
  const alphaAt = imageAlphaAt();
  // load timeline for captures and debugging (ms since createEngine): world built, first frame drawn, sprites settled
  const T0 = performance.now(), timing = { builtMs: null, readyMs: null, settledMs: null, pinMs: 0, frames: 0 };

  // parity: loop.visibility-rules
  const active = () => isActive({ hidden: document.hidden, panel: S.panel, peek: S.peek, villageOnly: document.body.classList.contains('village-only'), width: host.clientWidth });

  function currentView() {
    const now = fixture?.now ?? Date.now();
    if (fixture) return venueParams(viewFromFixture(fixture, { now }), location.search);
    if (DEMO) { demo ||= cityDemo(now); return makeView({ agents: demo.agents, projects: demo.projects }, { now, demo: true }); }
    return toView(S, { selected, now });
  }
  // parity: world.quiet-note-show
  function updateQuietNote() {
    if (!quietNote) return;
    const quiet = view?.quiet || [], n = quiet.length;
    quietNote.hidden = !n;
    if (!n || quietNote.dataset.n === String(n)) return;
    quietNote.dataset.n = String(n);
    quietNote.innerHTML = `<span>${n} quiet project${n === 1 ? '' : 's'} hidden</span><button type="button" class="ghost">Show</button>`;
  }
  quietNote?.addEventListener('click', e => { if (e.target.closest('button')) app.setHideQuiet(false); });

  // The cold build (no world yet) runs in slices (core/slices.js): the rules, the world build, the nav, the sim and the
  // first snapshot each end a task, so no frame or input waits behind all of them at once. A rebuild asked for while it
  // runs is done after it. Every later rebuild runs at once (polls and growth must be visible on return). ?slice=0: never.
  const SLICE_COLD = params.get('slice') !== '0';
  let building = null;
  function rebuild() {
    if (fixtureState === 'loading') return;
    if (building) { building.again = true; return; }
    if (world || !SLICE_COLD) { drainSync(rebuildSteps()); return; }
    const b = building = { again: false };
    // 16 ms slices: a slice ends after the step that crosses the budget, so the longest task is about the budget plus the
    // longest step (~25 ms, the road graph, on the 1,000-agent town), inside the 50 ms long-task budget
    drainSliced(rebuildSteps(), { budgetMs: 16 })
      .catch(e => { lastError = e.message; console.warn(`engine: world build failed: ${e.message}`); cv.dataset.engine = 'failed'; })
      .finally(() => { building = null; if (b.again) rebuild(); });
  }
  function* rebuildSteps() {
    const r0 = performance.now();
    view = currentView();
    updateQuietNote();
    if (!view.agents.length) { world = null; sig = ''; cv.dataset.engine = 'empty'; invalidate(); return; }
    try {
      const seed = seedParam ?? persisted.seed ?? 0;
      const { input, serverId, opaqueId } = toWorldInput(view, { seed, salt, env: { reduceMotion: view.reduceMotion, zoom: camera.cam.z }, features: mod.features, reuse: inputReuse });
      renderer?.noteSeen?.(input.agents.map(a => a.id));   // first-seen order (stable looks), in snapshot order
      // ctx.time.now is the only clock a rule hook sees; the rules memo records per project whether a hook read it
      const ctxFor = projectKey => modCtx(mod, { seed, now: view.now, projectKey, forcedTier, forcedStyle });
      // every mod hook runs once here (plain data); the sig check and the build both consume the same rules.
      // Per project, skipped when nothing its hooks read changed (world/rules-memo.js: its project record, agents and PRs,
      // persisted block + held lots, mod, seed, forced tier/style; plus `now` when a hook read the clock last time), so a
      // status flip re-runs only the projects whose agents flipped.
      const opts = { now: view.now, seed, forcedTier, forcedStyle, serverId, ctxFor };
      const { rules, pv, ran } = rulesMemo.run({ input, persisted, mod, opts, cache: buildCache });
      if (!ran.length) reuse.rules++;
      if (!world) yield 'rules';
      // a venue level change rebuilds too (its plan changes); berths are reassigned every poll without a rebuild
      toServerId = serverId; toOpaqueId = opaqueId;
      const vsig = venueSig(input, mod, persisted, ctxFor(''));
      const fullSig = vsig ? `${pv.sig}|${vsig}` : pv.sig;
      if (fullSig === sig && world) {
        berths = venueAssignments(world, input, mod, persisted, ctxFor('')); sim?.applySnapshot(input, { berths: berths.prs }); syncSelection();
        perf.pollMs = +(performance.now() - r0).toFixed(2);
        return;
      }
      // build, nav, sim and the first snapshot (world/world-steps.js). `world` is set only once all of them are done, so a
      // frame drawn between slices of the cold build never sees a world without its sim.
      const out = yield* worldSteps({
        input, persisted, mod, build: { now: view.now, seed, forcedTier, forcedStyle, serverId, rules, cache: buildCache },
        nav, navMemo, sim, berthCtx: ctxFor(''),
        createNav, createSim: (w, n) => createSim({ world: w, nav: n, seed, mod, serverId, clock: simT != null ? () => (simT / 480) % 1 : undefined }),
        onWorld: (w, ms) => {
          perf.buildMs = Math.round(ms);
          { const v2 = venueSig(input, mod, persisted, ctxFor('')); sig = v2 ? `${pv.sig}|${v2}` : pv.sig; }   // after the build: persisted.venues now holds every venue
          lastError = null;
          // M2/M3: renderer, nav and sim follow the world; the sim keeps its actors across rebuilds
          renderer ||= createRenderer({ canvas: cv, mod, debug: params.has('debug') });
          renderer.setWorld(w);
          { const ids = new Set(w.objects.keys()); newObjects = prevObjIds ? [...ids].filter(id => !prevObjIds.has(id)).map(id => { const o = w.objects.get(id); return { id, project: o.project ?? null, kind: o.kind, model: o.model }; }) : []; prevObjIds = ids; }
          syncArt();
          reuse.builds++;
        },
      });
      ({ world, nav, sim, berths } = out); navMemo = out.navMemo;
      if (out.navReused) reuse.nav++;
      pumpEvents();   // P4: the sim read opts.berths in worldSteps' first snapshot
      if (simT != null && !simPinned) {   // ?t pins the clock
        simPinned = true;
        const p0 = performance.now();
        if (sim.step) sim.step(simT); else for (let i = 0, n = Math.round(simT / STEP_S); i < n; i++) sim.tick(STEP_S);
        timing.pinMs = Math.round(performance.now() - p0);
      }
      syncSelection();
      timing.builtMs ??= Math.round(performance.now() - T0);
      // Built but not on screen (the panel is full width and the village is not peeked or zen): nothing draws, so say
      // so rather than look stuck in 'loading'. The first frame drawn sets 'ready'.
      if (cv.dataset.engine !== 'ready' && !active()) cv.dataset.engine = 'hidden';
      if (!fixtureName) saveWorld(store, persisted, { demo: DEMO, mod });
      // parity: camera.home-fit
      // parity: camera.auto-refit
      // What a fit shows: the layout's camera focus (api.js LayoutResult.focus; the engine defaults it to the bounds).
      camera.setRects(world.focus ?? world.bounds, world.bounds);
      cv.dataset.villages = String(world.villages.length);
      if (firstFit || (!camera.userMoved && !selected)) { if (camera.home({ animate: false })) firstFit = false; }
      perf.rebuildMs = Math.round(performance.now() - r0);
    } catch (e) {
      lastError = e.message;
      console.warn(`engine: world build failed: ${e.message}`);
      cv.dataset.engine = 'failed';
    }
    invalidate();
  }

  // ---------- drawing ----------
  // parity: loop.fps-8-on-demand
  // Frames run at 8 fps while visible and animating (a live sim), every animation frame during a camera tween or while
  // sprites stream in, and on demand otherwise (a pinned ?t, a stepped capture, reduced motion with nothing moving).
  let timer = 0;
  function invalidate() { if (!raf && active()) { clearTimeout(timer); timer = 0; raf = requestAnimationFrame(frame); } }
  function schedule() {
    const animating = !!world && mode === 'town' && simT == null && !stepped && !S.reduceMotion;
    const next = nextFrame({ active: active(), tweening: camera.tweening, streaming: !!world && streaming(), animating });
    clearTimeout(timer); timer = 0;
    if (next === 'raf') raf = requestAnimationFrame(frame);
    else if (next != null) timer = setTimeout(() => { timer = 0; if (!raf) raf = requestAnimationFrame(frame); }, next);
  }
  function frame() { raf = 0; draw(); schedule(); rasterSoon(); prefetchSoon(); }
  // Sprites still queued after a frame are built between frames, a slice at a time (renderer.rasterIdle), never inside
  // one; a slice that built anything asks for a frame to show it.
  const RASTER_SLICE_MS = 8;
  let rasterTimer = 0;
  function rasterSoon() {
    if (rasterTimer || !renderer?.rasterIdle) return;
    const st = renderer.stats?.();
    if (!(st?.queued > 0 || st?.groundPending > 0)) return;
    rasterTimer = setTimeout(() => {
      rasterTimer = 0;
      if (!active() || mode !== 'town') return;
      const n = renderer.rasterIdle(RASTER_SLICE_MS);
      if (n > 0) invalidate();
      // queued sprites keep the slices going; flat ground only while a slice still bakes (frames ask again anyway)
      if (n > 0 || renderer.stats?.().queued > 0) rasterSoon();
    }, 0);
  }
  // Once the view shows everything (nothing queued, pending or flat), idle time pre-rasters the next zoom step and the pan
  // margin (renderer.prefetchIdle), a few ms per idle callback. It draws nothing, so it never asks for a frame.
  const PREFETCH_SLICE_MS = 6;
  let prefetchId = 0;
  const idle = typeof requestIdleCallback === 'function'
    ? cb => requestIdleCallback(d => cb(Math.min(PREFETCH_SLICE_MS, Math.max(1, d.timeRemaining()))), { timeout: 1000 })
    : cb => setTimeout(() => cb(PREFETCH_SLICE_MS), 16);
  function prefetchSoon() {
    if (prefetchId || rasterTimer || !renderer?.wantsPrefetch?.()) return;
    prefetchId = idle(ms => {
      prefetchId = 0;
      if (!active() || mode !== 'town' || !renderer?.wantsPrefetch?.()) return;
      if (renderer.prefetchIdle(ms).more) prefetchSoon();
    });
  }
  /** Drains the sim's events into the mod's events hook (10 ms deadline, throw-safe) and stamps the specs at the sim clock. */
  function pumpEvents() {
    if (!sim?.events?.drain) return;
    const diff = sim.events.drain();
    if (!diff.length || typeof mod.events !== 'function') return;
    const t = sim.now ?? 0, accents = renderer?.accents?.();
    const ctx = { ...modCtx(mod, { seed: seedParam ?? persisted.seed ?? 0, now: view?.now ?? 0 }), newObjects,
      accentOf: p => accents?.get(p) ?? world?.villages?.find(v => v.name === p)?.accent ?? null,
      actorsOf: p => [...sim.actors.values()].filter(a => a.kind === 'agent' && a.project === p).map(a => String(a.id)) };
    const r = runEvents(mod.events, diff.map(e => Object.freeze({ ...e })), ctx);
    evfx.add(r.specs, t);
    evStats = { status: r.status, ms: +r.ms.toFixed(2), specs: r.specs.length };
  }
  /** The app's selection (server id) on the sim (opaque actor ids). */
  function syncSelection() { sim?.select?.(selected != null ? toOpaqueId(selected) : null); }
  /** Sim on-screen test in tile coords: the view rect plus a margin (off-screen trips fade, on-screen ones walk). */
  function onScreenFn(w, h, margin = ONSCREEN_MARGIN) {
    const cam = camera.cam;
    const c = toScreen(cam.x, cam.y), hw = w / 2 / cam.z, hh = h / 2 / cam.z, mx = margin * 32, my = margin * 16;
    const x0 = c.sx - hw - mx, x1 = c.sx + hw + mx, y0 = c.sy - hh - my, y1 = c.sy + hh + my;
    return (x, y) => { const sx = (x - y) * 16, sy = (x + y) * 8; return sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1; };
  }
  const actorList = () => (sim ? [...sim.actors.values()] : []);
  /** Actors outdoors inside the view rect (no margin), for the debug perf block. */
  function onScreenCount(actors, w, h) {
    if (!w || !h) return 0;
    const inView = onScreenFn(w, h, 0);
    let n = 0;
    for (const a of actors) if (!(a.flags & 8) && Number.isFinite(a.x) && inView(a.x, a.y)) n++;
    return n;
  }
  const agentOf = id => view?.byId?.get(id) ?? view?.agents?.find(a => a.id === id) ?? null;
  // overlay state: input hover/cursor, Alt, bubbles; and the last frame's badges / placed labels (debug)
  let hover = null, hoverVil = null, hoverPanel = null, cursor = null, alt = false, bubbles = true;
  let badges = [], placed = [];

  function draw(arg) {
    const tickReal = !(arg && arg.tick === false) && !stepped;
    const { w, h } = vp(), dpr = window.devicePixelRatio || 1;
    if (!w || !h) return;
    if (camera.tick(performance.now())) { /* tween in flight: schedule() keeps rAF going */ }
    const cam = camera.cam;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = BG_COL;
    ctx.fillRect(0, 0, w, h);
    const t0 = performance.now();
    badges = [];
    if (world && mode === 'town' && renderer) {
      const now = performance.now(), dt = lastT ? Math.min(0.25, (now - lastT) / 1000) : 0;
      lastT = now;
      try {
        sim?.setOnScreen?.(onScreenFn(w, h));
        sim?.setView?.({ zoom: cam.z });           // ambient LOD (sim/world-sim.js): zoomed out or off screen ticks less
        const s0 = performance.now();
        if (sim && simT == null && tickReal) sim.tick(dt);
        lastSimMs = performance.now() - s0;
        pumpEvents();
        evfx.prune(sim?.now ?? 0);
        // parity: night.amount-by-local-time
        const nf = nightFrame(nightParam);
        const actors = actorList();
        hits = renderer.draw({ cam, view: { cssW: w, cssH: h, dpr }, actors, t: sim?.now ?? 0, fx: evfx.active(sim?.now ?? 0), berths: berths?.prs, night: nf.night, phase: nf.phase ?? undefined,
          mode: cam.z <= 0.25 ? 'map' : 'town', alpha: sim?.alpha ?? 1, selected: sim?.selected ?? null, hoverPanel,
          still: !!S.reduceMotion || simT != null });
        overlays(actors, { w, h, dpr, cam });
      } catch (e) { lastError = e.message; console.warn(`engine: frame failed: ${e.message}`); }
    } else if (world) {
      try { drawGridDebug(ctx, world, { cam, cssW: w, cssH: h, mode }); } catch (e) { lastError = e.message; }
      labelLayer?.render([]);
    } else labelLayer?.render([]);
    perf.drawMs = +(performance.now() - t0).toFixed(2);
    if (trace && trace.length < 4000) { const st = renderer?.stats?.(); trace.push([+t0.toFixed(1), perf.drawMs, cam.z, st?.rasterN ?? 0, st?.rasterMs ?? 0, st?.queued ?? 0, st?.pending ?? 0, st?.phase ?? null, st?.way ?? null]); }
    if (world) { frameMs[frameN % FRAME_RING] = perf.drawMs; simMs[frameN % FRAME_RING] = lastSimMs; frameN++; }
    lastSimMs = 0;
    if (lastError) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = '11px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.75)';
      ctx.fillText(`New village engine (beta) · ${lastError}`, 8, h - 8);
    }
    timing.frames++;
    syncArt();
    cv.dataset.zoom = String(cam.z);
    updateAria();
    if (world && !lastError) {
      if (cv.dataset.engine !== 'ready') timing.readyMs ??= Math.round(performance.now() - T0);
      cv.dataset.engine = 'ready';
      if (timing.readyMs != null && timing.settledMs == null && mode === 'town' && !streaming()) timing.settledMs = Math.round(performance.now() - T0);
    }
  }
  // parity: aria.dataset-art-villages-zoom
  // data-art follows the art loading, drawn or not (classic sets it when the sheets load, even under a full panel)
  let artTimer = 0;
  function syncArt() {
    const art = renderer ? artState(renderer.stats?.()) : 'loading';
    if (art !== 'loading') { if (cv.dataset.art !== art) cv.dataset.art = art; return true; }
    if (!artTimer && renderer) artTimer = setTimeout(() => { artTimer = 0; syncArt(); }, 200);
    return false;
  }
  function streaming() {
    const s = renderer?.stats?.();
    return !!s && (!s.artReady || s.pending > 0 || s.queued > 0 || s.groundPending > 0);   // groundPending: chunks still flat (bake budget)
  }

  // ---------- overlays: badges (canvas, device px) and DOM labels ----------
  const toCss = (cam, w, h) => (tx, ty) => worldToCss(cam, { w, h }, tx, ty);
  function overlays(actors, { w, h, dpr, cam }) {
    const css = toCss(cam, w, h), z = cam.z;
    // badges and labels only ever look up the agents the frame drew (hits), so only those are resolved (PERF M7: not every
    // agent actor on every frame, which at map zoom was most of this function)
    const byOpaque = new Map(), agentHits = new Map();
    for (const hh of hits) {
      if (hh.kind !== 'agent' || agentHits.has(hh.id)) continue;
      agentHits.set(hh.id, hh);
      if (sim?.actors.get(hh.id)?.kind !== 'agent') continue;
      const ag = agentOf(toServerId(hh.id));
      if (ag) byOpaque.set(hh.id, ag);
    }
    // parity: vil.status-badges
    // parity: vil.badges-hidden-bubbles-off
    const keep = new Set([hover, selected, cursor].filter(Boolean).map(id => toOpaqueId(id)));
    const bs = z >= 1 ? layoutBadges(hits, byOpaque, { zoom: z, bubbles, keep, frame: Math.floor((sim?.now ?? 0) * 2) }) : [];
    if (bs.length) { ctx.setTransform(1, 0, 0, 1, 0, 0); drawBadges(ctx, bs, { dpr, zoom: z }); }
    badges = bs.map(b => ({ ...b, id: toServerId(b.id) ?? b.id }));
    const badgeOf = new Map(badges.map(b => [b.id, b]));
    // labels: the tag sits on the badge top when there is one, else the drawn sprite's head
    const agents = [];
    for (const [oid, hh] of agentHits) {
      const sid = toServerId(oid) ?? oid, ag = byOpaque.get(oid);
      if (!ag) continue;
      const b = badgeOf.get(sid), [x0, y0, x1] = hh.rect;
      agents.push({ id: sid, name: ag.name, bucket: ag.bucket, severity: ag.severity, prompt: ag.prompt, since: ag.since,
        rect: { x: x0, y: b ? b.t : y0, w: x1 - x0 }, ...(b ? { badge: { l: b.l, t: b.t, r: b.r, b: b.b } } : {}) });
    }
    const counts = z < 1 ? projectCounts(view?.agents) : null;
    const villages = world.villages.map(v => {
      const pz = v.plaza || { x: v.block.x, y: v.block.y, w: v.block.w };
      const p = css(pz.x + pz.w / 2, pz.y + 1);
      return { name: v.name, accent: renderer?.accents?.().get(v.name) ?? v.accent, x: p.x, y: p.y, ...(counts ? { counts: counts.get(v.name) } : {}) };
    });
    const prs = [];
    // tags on the hulls at zoom 3 (the PR number of the item a token carries), at the top of its sprite
    if (z >= 3) for (const hh of hits) {
      if (!PANEL_HIT_KINDS.has(hh.kind)) continue;
      const a = sim?.actors.get(hh.id), n = a?.kind === 'token' ? prNumber(a.item) : null;
      if (n == null) continue;
      const x = (hh.rect[0] + hh.rect[2]) / 2, y = hh.rect[1];
      if (x < -60 || y < -60 || x > w + 60 || y > h + 60) continue;
      prs.push({ id: hh.id, pr: n, x, y });
    }
    if (z >= 3) for (const o of world.objects.values()) {
      if (o.kind !== 'building' || o.data?.owner !== 'pr') continue;
      const n = prNumber(o.data.pr);
      if (n == null) continue;
      const p = css((o.door?.tx ?? o.tx + o.w / 2) + 0.5, o.ty + o.h + 0.875);
      if (p.x < -60 || p.y < -60 || p.x > w + 60 || p.y > h + 60) continue;
      prs.push({ id: o.id, pr: n, x: p.x, y: p.y });
    }
    // the selected agent indoors : its tag by the home's door
    let indoorsSel = null;
    const selA = sim?.selected != null ? sim.actors.get(sim.selected) : null;
    const selHome = selA ? selA.home ?? selA._target?.homeId : null;
    if (selA && (selA.flags & 8) && selHome != null && z >= 1) {
      const ho = world.objects.get(selHome), ag = agentOf(selected);
      if (ho && ag) { const p = css((ho.door?.tx ?? ho.tx) + 0.5, ho.ty - 0.25); indoorsSel = { id: selected, name: ag.name, x: p.x, y: p.y }; }
    }
    const cands = labelCands({ zoom: z, agents, villages, prs, indoorsSel, selected, cursor, hover, hoverVil, alt, bubbles });
    placed = layoutLabels(cands, labelBlockers(agents, z), { w, h, measure });
    labelLayer?.render(placed);
  }

  // parity: aria.summary-label
  function updateAria() {
    const loading = !view || (fixtureName && fixtureState === 'loading');
    const label = ariaSummary({ loading, total: view?.agents?.length ?? 0, counts: S.data?.counts || {}, cursor: cursor ? agentOf(cursor) : null });
    if (cv.getAttribute('aria-label') !== label) cv.setAttribute('aria-label', label);
  }

  // ---------- input (input-ctl.js): click select, dblclick terminal, menus, keys, hover, wheel, drag ----------
  /** What a CSS point on the canvas is (pick.js over the last frame's hits), or null. */
  function pickAt(x, y) {
    if (!world || mode !== 'town') return null;
    const h = pickHit(hits, x, y, { alphaAt });
    return h ? describe(h) : null;
  }
  function describe(h) {
    if (h.kind === 'agent') return { kind: 'agent', id: toServerId(h.id) ?? h.id, actor: h.id, occluded: !!h.occluded };
    const o = world.objects.get(h.id);
    if (h.kind === 'house') return { kind: 'house', id: o?.data?.owner === 'home' ? o.data.agentId ?? null : null, object: h.id };
    return { kind: h.kind, id: null, object: h.id, href: o?.data?.href ?? null, ...(o ? {} : { actor: h.id }) };
  }
  // parity: inp.click-select
  /** A hit -> what input-ctl acts on: an agent (or the home of one), a host panel venue/token, or nothing. */
  function resolve(h) {
    if (!world || mode !== 'town') return null;
    const p = describe(h);
    if (p.kind === 'agent') return { id: p.id };
    // a home picks its agent only while that agent is indoors (classic houseHits: resting homes only)
    if (p.kind === 'house') { const a = p.id ? sim?.actors.get(toOpaqueId(p.id)) : null; return a && (a.flags & 8) ? { id: p.id, house: true } : null; }
    if (PANEL_HIT_KINDS.has(p.kind)) return { panel: p.href ? `link:${p.href}` : p.actor ? `${p.kind}:${p.actor}` : p.kind };
    return null;
  }
  const centerOfId = id => {
    const a = sim?.actors.get(toOpaqueId(id));
    if (!a) return null;
    if ((a.flags & 8) && a.home != null) { const o = world?.objects.get(a.home); if (o?.door) return { x: o.door.tx + 0.5, y: o.door.ty + 0.5 }; }
    return { x: a.x, y: a.y - 0.5 };
  };
  function screenAt(id) {
    const r = cv.getBoundingClientRect(), oid = toOpaqueId(id), hh = hits.find(x => x.kind === 'agent' && x.id === oid);
    if (!hh) return { el: cv };
    return { x: r.left + (hh.rect[0] + hh.rect[2]) / 2, y: r.top + hh.rect[3] };
  }
  const input = attachInput({
    cv, host, camera, alphaAt, resolve, app, screenAt, centerOf: centerOfId,
    getHits: () => hits, pick: pickHit,
    villageAt: (x, y) => {   // Map zoom only: a click on a neighbourhood zooms into it
      if (!world || camera.cam.z >= 1) return null;
      const t = camera.cssToTile(x, y), v = villageAtTile(world.villages, t.x, t.y, 1);
      return v ? { name: v.name, x: v.block.x + v.block.w / 2, y: v.block.y + v.block.h / 2 } : null;
    },
    order: () => bucketOrder(view?.agents || [], id => !!sim?.actors.has(toOpaqueId(id))),
    selected: () => selected,
    isDemoId: id => DEMO && isDemoId(id),
    openPanel: href => openPrPanel(href),
    onChange: s => {
      const vis = s.hover !== hover || s.hoverVil !== hoverVil || s.hoverPanel !== hoverPanel || s.cursor !== cursor;
      ({ hover, hoverVil, hoverPanel, cursor } = s);
      if (vis || camera.userMoved) invalidate();
    },
  });
  // every camera move goes through these events or the zoom buttons: draw the next frame
  for (const ev of ['wheel', 'pointermove', 'pointerup', 'keydown']) cv.addEventListener(ev, () => invalidate(), { passive: true });
  bindZoomButtons(document, camera);
  for (const id of ['zoom-in', 'zoom-out', 'zoom-reset']) document.getElementById(id)?.addEventListener('click', () => invalidate());
  // parity: camera.refit-after-peek
  // parity: camera.fit-waits-hidden
  new ResizeObserver(() => { if (world) camera.onResize(); invalidate(); }).observe(host);
  document.addEventListener('visibilitychange', () => invalidate());

  // parity: vil.resting-indoors
  // Resting stays classic: the sim keeps a resting agent INDOORS (not drawn), its home window lit at night
  // (renderer statusOf -> lighting), zZ over the home at night (effects), and the selected one shown as a ghost at
  // the door (marks) with its tag "(indoors)" there.
  /** Rebuild when the selected agent's project is hidden (quiet): toView keeps the selected agent's project. */
  function ensureShown(id) {
    if (!id || DEMO || fixture) return;
    if (!view?.agents?.some(a => a.id === id) && S.byId?.has?.(id)) rebuild();
  }

  const api = {
    update() { rebuild(); invalidate(); },
    // Town plan sync (main.js "Keep this one"): save this tab's in-memory layout again, so the push sends this tab's town.
    saveLayout() { if (!fixtureName) saveWorld(store, persisted, { demo: DEMO, mod }); },
    // parity: camera.center-on-selected
    setSelected(id, { pan = true } = {}) {
      selected = id;
      cursor = null;
      ensureShown(id);
      syncSelection();
      if (id && pan && (S.panel !== 'full' || S.peek)) { const c = centerOfId(id); if (c) camera.centerOn(c, { animate: true, zoomIn: true }); }
      invalidate();
    },
    setActive() { if (active()) invalidate(); else { cancelAnimationFrame(raf); raf = 0; clearTimeout(timer); timer = 0; } },
    refit() { if (!camera.userMoved && !selected) camera.home({ animate: false }); invalidate(); },
    // parity: camera.keys
    key(k) { if (camera.key(k)) invalidate(); },
    // parity: lbl.alt-shows-all-tags
    showAllTags(on) { alt = !!on; invalidate(); },
    setBubbles(on) { bubbles = !!on; invalidate(); },
    // parity: camera.terminal-save-restore
    camera: () => camera.get(),
    // Accepts the engine's own { v: 2, x, y, z } (tiles); a classic camera (world px) only restores the zoom level.
    setCamera(c) { camera.set(c); try { store.set(CAM_KEY, camera.get()); } catch { /* storage unavailable */ } invalidate(); },
    setGridMode(m) { if (MODES.has(m)) { mode = m; invalidate(); } },
    // parity: debug.villagedebug
    // The classic villageDebug() shape the e2e specs read (view, hits and badges in canvas css px, clusters, items in
    // tiles with wet, townWater, outdoors, homes, iso), plus the engine's own fields.
    debug: () => {
      const actors = actorList(), { w, h } = vp(), cam = camera.cam, toS = id => toServerId(id);
      return Object.defineProperty({
        engine: 2, iso: true, world: mod.id, zoom: cam.z, cam: { ...cam }, mode, demo: DEMO, fixture: fixtureName, t: simT, error: lastError,
        perf: { ...perf, frames: frameStats(), simFrames: frameStats(simMs), sim: simStats(), longestTaskMs, spriteBytes: renderer?.stats?.().bytes ?? 0, onScreen: onScreenCount(actors, w, h) },
        view: { vx: 0, vy: 0, k: 1, px: 1, bw: w, bh: h },
        grid: world ? { ox: world.grid.ox, oy: world.grid.oy, w: world.grid.w, h: world.grid.h, version: world.grid.version } : null,
        villages: world ? world.villages.map(v => ({ name: v.name, tier: v.tier, cap: v.cap, block: { x: v.block.x, y: v.block.y, w: v.block.w, h: v.block.h },
          plaza: v.plaza ?? null, accent: renderer?.accents?.().get(v.name) ?? v.accent ?? null, cx: v.cx, cy: v.cy })) : [],
        square: world?.square ?? null, venues: world?.venues ?? null, berths: berths?.venues ?? null, bounds: world?.bounds ?? null, focus: world?.focus ?? null,
        lint: world ? world.lint : [], objects: world ? world.objects.size : 0, quiet: view?.quiet ?? [],
        events: { active: evfx.size, ...evStats }, actors: sim ? sim.actors.size : 0, hitAreas: hits.length, reuse: { ...reuse },
        hits: debugHits(hits, id => sim?.actors.get(id), toS, PANEL_HIT_KINDS), ...(world ? venueDebug({ world, actors }) : {}), badges: badges.map(({ id, kind, l, t, r, b }) => ({ id, kind, l, t, r, b })),
        clusters: debugClusters(placed), labels: placed.map(p => ({ key: p.key, cls: p.cls, text: p.text })),
        items: world ? debugItems(world, mod) : [], townWater: world ? townWater(world, mod) : null,
        outdoors: debugOutdoors(actors, toS), homes: debugHomes(world), walkers: debugWalkers(actors, sim?.now ?? 0),
        selected: sim?.selected != null ? toS(sim.selected) ?? sim.selected : null, cursor, hover, stepped, sprites: renderer?.stats?.() ?? null,
        art: cv.dataset.art,
        // active: false means the village is not on screen (e.g. the panel is full width): nothing draws
        active: active(), timing: { ...timing },
      // pick(x, y): what a CSS point on the canvas is ({ kind, id, ... } | null). Not enumerable, so the snapshot stays
      // serialisable (page.evaluate).
      }, 'pick', { value: (x, y) => pickAt(x, y), enumerable: false });
    },
  };
  // ?debug: deterministic stepping for captures (tools/artpass/lapse.mjs). villageStep(s) advances the sim s seconds in
  // fixed steps, draws once and returns debug(); from the first call on, frames no longer tick the sim in real time.
  if (params.has('debug')) {
    // perf harness (tools/perf/engine-perf.mjs): reset() clears the frame ring and the longest task; poll(flip) flips
    // `flip` fixture agents between two working statuses (no layout change) and runs one poll, returning its ms
    let pollTurn = 0;
    window.villagePerf = {
      reset() { frameN = 0; if (longestTaskMs != null) longestTaskMs = 0; },
      // trace(true) starts a per-frame log [t, drawMs, zoom, rasterN, rasterMs, queued, pending]; trace(false) returns it
      trace(on = true) { const t = trace; trace = on ? [] : null; return t; },
      // keep(false): the renderer always draws the whole view (no kept layers), for A/B checks; keep(true) restores
      keep(on = true) { renderer?.setKeep?.(on); invalidate(); },
      poll(flip = 0) {
        const list = fixture?.agents ?? [];
        for (let i = 0, k = 0; i < list.length && k < flip; i++) {
          const a = list[(i * 7 + pollTurn) % list.length];
          if (a.bucket === 'building' || a.bucket === 'waiting') { a.bucket = a.bucket === 'building' ? 'waiting' : 'building'; k++; }
        }
        pollTurn++;
        const t0 = performance.now();
        api.update();
        return +(performance.now() - t0).toFixed(3);
      },
    };
    window.villageStep = s => {
      stepped = true;
      if (sim) { if (sim.step) sim.step(s); else for (let i = 0, n = Math.round((+s || 0) / STEP_S); i < n; i++) sim.tick(STEP_S); }
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      draw({ tick: false });
      return api.debug();
    };
  }
  void input;
  return api;
}
