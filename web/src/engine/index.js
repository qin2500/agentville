// Village engine v2 entry (design §6.1).
// createEngine(app) returns the same object as createVillage(app) (village.js), so main.js swaps one line
// behind ?engine=2. M1 draws the debug grid only (flat tiles, walkability and cover heatmaps: &grid=ground|walk|cover|lot).
//
// Dev params: ?fixture=<name> (frozen e2e/fixtures/engine/<name>.json served by the art harness vite config),
// ?citydemo=1, ?citytier=N, ?seed=N (world seed), ?t=<sec> (pinned sim clock, used from M3), ?grid=<mode>.
import { store } from '../ui.js';
import { cityDemo } from '../city-demo.js';
import { toView, makeView, viewFromFixture } from './snapshot.js';
import { loadWorld, saveWorld, loadSalt } from './world/persist.js';
import { createBuildCache } from './world/cache.js';
import { buildWorld } from './world/build.js';
import { venueSig, venueAssignments } from './world/venue.js';
import { planSettlements } from './world/sites.js';
import { runRules } from './world/rules-phase.js';
import { resolveMod, modCtx, listMods, DEFAULT_MOD } from './mod/registry.js';
import { pickWorld } from '../worlds.js';
import { toWorldInput } from './mod/input.js';
import { drawGridDebug } from './debug/grid-view.js';
import { createRenderer } from './render/renderer.js';
import { createNav } from './nav/index.js';
import { createSim } from './sim/world-sim.js';
import { ZOOMS, fitCamera, stepZoom, zoomAt, clampCamera, cssToWorld } from './camera.js';

const BG = '#1b4a7a';   // behind the grid when the mod's terrain class 0 has no colour
const MODES = new Set(['town', 'ground', 'walk', 'cover', 'lot']);   // 'town' = the M2/M3 renderer; the rest are M1 debug grids
const STEP_S = 0.05;

export function createEngine(app) {
  const { S } = app;
  const host = document.getElementById('village');
  const cv = document.getElementById('cv');
  const labels = document.getElementById('labels');
  const quietNote = document.getElementById('quiet-note');
  const ctx = cv.getContext('2d');
  const params = new URLSearchParams(location.search);
  const DEMO = params.get('citydemo') === '1';
  const fixtureName = /^[a-z0-9-]+$/.test(params.get('fixture') || '') ? params.get('fixture') : null;
  const forcedTier = params.get('citytier') == null || params.get('citytier') === '' || Number.isNaN(+params.get('citytier'))
    ? null : Math.max(0, Math.round(+params.get('citytier')));   // the mod's tier hook clamps to its own tier count
  const forcedStyle = params.get('citystyle') != null && params.get('citystyle') !== '' && !Number.isNaN(+params.get('citystyle')) ? +params.get('citystyle') : null;
  const seedParam = params.get('seed') != null && Number.isFinite(+params.get('seed')) ? (+params.get('seed') >>> 0) : null;
  const simT = params.get('t') != null && Number.isFinite(+params.get('t')) ? +params.get('t') : null;
  let mode = MODES.has(params.get('grid')) ? params.get('grid') : 'town';
  const night = params.get('night') === '1' ? 1 : 0;

  cv.dataset.art = 'engine2';
  cv.dataset.engine = 'loading';
  if (labels) labels.replaceChildren();

  // ?world=<id> picks a bundled mod for the session; else Settings (va.world.mod); else the default (village-mods.md §5.2).
  // pickWorld never throws: an invalid or unknown id falls back to the default world.
  const mod = resolveMod(pickWorld(params.get('world'), store.get('va.world.mod', undefined), listMods().map(m => m.id)));
  const CAM_KEY = mod.id === DEFAULT_MOD ? 'va.cam.e2' : `va.cam.e2.${mod.id}`;   // each world keeps its own camera
  const BG_COL = mod.terrain?.classes?.find(c => c.code === 0)?.color || BG;   // outside the grid is terrain class 0
  const persisted = loadWorld(store, { demo: DEMO || !!fixtureName, now: Date.now(), mod });
  const salt = loadSalt(store);              // secret, never in WorldInput (review M1): opaque ids are not a public hash of the seed
  const buildCache = createBuildCache();     // incremental rebuilds: only changed projects re-plan and re-stamp
  let fixture = null, fixtureState = fixtureName ? 'loading' : 'none', demo = null;
  if (fixtureName) {
    fetch(`${import.meta.env?.BASE_URL ?? '/'}__fixtures/engine/${fixtureName}.json`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(fx => { fixture = fx; fixtureState = 'ready'; rebuild(); })
      .catch(e => { fixtureState = 'failed'; console.warn(`engine: fixture ${fixtureName} unavailable: ${e.message}`); cv.dataset.engine = 'failed'; });
  }

  const saved = store.get(CAM_KEY, null);
  let cam = saved && saved.v === 2 && ZOOMS.includes(saved.z) ? { x: saved.x, y: saved.y, z: saved.z } : { x: 0, y: 0, z: 1 };
  let userMoved = !!saved, firstFit = !saved;
  let world = null, sig = '', view = null, selected = null, lastError = null, perf = { buildMs: 0, drawMs: 0 };
  let berths = null;                         // venueAssignments(): PR -> venue berth, per poll (no rebuild)
  let raf = 0, renderer = null, nav = null, sim = null, hits = [], lastT = 0, simPinned = false;
  // load timeline for captures and debugging (ms since createEngine): world built, first frame drawn, sprites settled
  const T0 = performance.now(), timing = { builtMs: null, readyMs: null, settledMs: null, pinMs: 0, frames: 0 };

  const vp = () => ({ w: host.clientWidth, h: host.clientHeight });
  const active = () => !document.hidden && (S.panel !== 'full' || S.peek || document.body.classList.contains('village-only')) && host.clientWidth > 0;
  const remember = () => store.set(CAM_KEY, { v: 2, ...cam });
  // What a fit shows: the layout's camera focus (api.js LayoutResult.focus; the engine defaults it to the bounds).
  const townRect = () => (world ? world.focus ?? world.bounds : null);
  function home() {
    const r = townRect();
    if (!r || !host.clientWidth) return;
    cam = fitCamera(r, vp());
    invalidate();
  }

  function currentView() {
    const now = fixture?.now ?? Date.now();
    if (fixture) return viewFromFixture(fixture, { now });
    if (DEMO) { demo ||= cityDemo(now); return makeView({ agents: demo.agents, projects: demo.projects }, { now, demo: true }); }
    return toView(S, { selected, now });
  }
  function updateQuietNote() {
    if (!quietNote) return;
    const quiet = view?.quiet || [], n = quiet.length;
    quietNote.hidden = !n;
    if (!n || quietNote.dataset.n === String(n)) return;
    quietNote.dataset.n = String(n);
    quietNote.innerHTML = `<span>${n} quiet project${n === 1 ? '' : 's'} hidden</span><button type="button" class="ghost">Show</button>`;
  }
  quietNote?.addEventListener('click', e => { if (e.target.closest('button')) app.setHideQuiet(false); });

  function rebuild() {
    if (fixtureState === 'loading') return;
    view = currentView();
    updateQuietNote();
    if (!view.agents.length) { world = null; sig = ''; cv.dataset.engine = 'empty'; invalidate(); return; }
    try {
      const seed = seedParam ?? persisted.seed ?? 0;
      const { input, serverId } = toWorldInput(view, { seed, salt, env: { reduceMotion: view.reduceMotion, zoom: cam.z } });
      const ctxFor = projectKey => modCtx(mod, { seed, now: view.now, projectKey, forcedTier, forcedStyle });
      // every mod hook runs once here (plain data); the sig check and the build both consume the same rules
      const opts = { now: view.now, seed, forcedTier, forcedStyle, serverId, ctxFor };
      const rules = runRules(input, persisted, mod, opts);
      const pv = planSettlements(input, persisted, mod, opts, rules);
      // a venue level change rebuilds too (its plan changes); berths are reassigned every poll without a rebuild
      const vsig = venueSig(input, mod, persisted, ctxFor(''));
      const fullSig = vsig ? `${pv.sig}|${vsig}` : pv.sig;
      if (fullSig === sig && world) { berths = venueAssignments(world, input, mod, persisted, ctxFor('')); sim?.applySnapshot(input, { berths: berths.prs }); return; }
      const t0 = performance.now();
      world = buildWorld(input, persisted, { mod, now: view.now, seed, forcedTier, forcedStyle, serverId, rules, cache: buildCache });
      perf.buildMs = Math.round(performance.now() - t0);
      { const v2 = venueSig(input, mod, persisted, ctxFor('')); sig = v2 ? `${pv.sig}|${v2}` : pv.sig; }   // after the build: persisted.venues now holds every venue
      lastError = null;
      // M2/M3: renderer, nav and sim follow the world; the sim keeps its actors across rebuilds
      renderer ||= createRenderer({ canvas: cv, mod });
      renderer.setWorld(world);
      nav = createNav(world);
      if (!sim) sim = createSim({ world, nav, seed, mod, serverId, clock: simT != null ? () => (simT / 480) % 1 : undefined });
      else sim.setWorld(world, nav);
      berths = venueAssignments(world, input, mod, persisted, ctxFor(''));
      sim.applySnapshot(input, { berths: berths.prs });   // P4: the sim reads opts.berths (prId -> { venue, berth, tx, ty, face, model?, tint? })
      if (simT != null && !simPinned) {   // ?t pins the clock
        simPinned = true;
        const p0 = performance.now();
        for (let i = 0, n = Math.round(simT / STEP_S); i < n; i++) sim.tick(STEP_S);
        timing.pinMs = Math.round(performance.now() - p0);
      }
      timing.builtMs ??= Math.round(performance.now() - T0);
      // Built but not on screen (the panel is full width and the village is not peeked or zen): nothing draws, so say
      // so rather than look stuck in 'loading'. The first frame drawn sets 'ready'.
      if (cv.dataset.engine !== 'ready' && !active()) cv.dataset.engine = 'hidden';
      if (!fixtureName) saveWorld(store, persisted, { demo: DEMO, mod });
      if (firstFit || !userMoved) { firstFit = false; home(); }
    } catch (e) {
      lastError = e.message;
      console.warn(`engine: world build failed: ${e.message}`);
      cv.dataset.engine = 'failed';
    }
    invalidate();
  }

  // ---------- drawing (on demand; M1 has nothing animating) ----------
  function invalidate() { if (!raf && active()) raf = requestAnimationFrame(draw); }
  function draw() {
    raf = 0;
    const { w, h } = vp(), dpr = window.devicePixelRatio || 1;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = BG_COL;
    ctx.fillRect(0, 0, w, h);
    const t0 = performance.now();
    if (world && mode === 'town' && renderer) {
      const now = performance.now(), dt = lastT ? Math.min(0.25, (now - lastT) / 1000) : 0;
      lastT = now;
      try {
        if (sim && simT == null) sim.tick(dt);
        hits = renderer.draw({ cam, view: { cssW: w, cssH: h, dpr }, actors: sim ? [...sim.actors.values()] : [], t: sim?.now ?? 0, night, mode: cam.z <= 0.25 ? 'map' : 'town' });
      } catch (e) { lastError = e.message; }
      // animate while active. A pinned ?t stays still, but keeps drawing while sprites stream in (queued or still
      // placeholders in view): nothing else would invalidate, and captures would show the grey boxes.
      if (simT == null || streaming()) invalidate();
    } else if (world) {
      try { drawGridDebug(ctx, world, { cam, cssW: w, cssH: h, mode }); } catch (e) { lastError = e.message; }
    }
    perf.drawMs = +(performance.now() - t0).toFixed(2);
    ctx.font = '11px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillText(`New village engine (preview) · ${mode === 'town' ? 'M3' : 'M1 grid'} · ${mode}${lastError ? ` · ${lastError}` : ''}`, 8, h - 8);
    timing.frames++;
    if (world && !lastError) {
      if (cv.dataset.engine !== 'ready') timing.readyMs ??= Math.round(performance.now() - T0);
      cv.dataset.engine = 'ready';
      if (timing.readyMs != null && timing.settledMs == null && mode === 'town' && !streaming()) timing.settledMs = Math.round(performance.now() - T0);
    }
  }
  function streaming() {
    const s = renderer?.stats?.();
    return !!s && (!s.artReady || s.pending > 0 || s.queued > 0);
  }

  // ---------- input: wheel zoom at the pointer, drag pan (4 px threshold), zoom buttons ----------
  const setZoom = (z, anchor) => {
    if (!ZOOMS.includes(z) || z === cam.z) return;
    cam = zoomAt(cam, vp(), z, anchor);
    userMoved = true; remember(); invalidate();
  };
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    setZoom(stepZoom(cam.z, e.deltaY < 0 ? 1 : -1), { x: e.clientX - r.left, y: e.clientY - r.top });
  }, { passive: false });
  let drag = null;
  cv.addEventListener('pointerdown', e => { if (e.button === 0) drag = { x: e.clientX, y: e.clientY, cam: { ...cam }, moved: false }; });
  window.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    const v = vp(), a = cssToWorld(drag.cam, v, v.w / 2, v.h / 2), b = cssToWorld(drag.cam, v, v.w / 2 - dx, v.h / 2 - dy);
    cam = { ...drag.cam, x: drag.cam.x + (b.tx - a.tx), y: drag.cam.y + (b.ty - a.ty) };
    if (world) cam = clampCamera(cam, world.bounds);
    userMoved = true; invalidate();
  });
  window.addEventListener('pointerup', () => { if (drag?.moved) remember(); drag = null; });
  document.getElementById('zoom-in')?.addEventListener('click', () => setZoom(stepZoom(cam.z, 1)));
  document.getElementById('zoom-out')?.addEventListener('click', () => setZoom(stepZoom(cam.z, -1)));
  document.getElementById('zoom-reset')?.addEventListener('click', () => { userMoved = false; home(); remember(); });
  new ResizeObserver(() => { if (!userMoved) home(); invalidate(); }).observe(host);
  document.addEventListener('visibilitychange', () => invalidate());

  return {
    update() { rebuild(); invalidate(); },
    setSelected(id) { selected = id; invalidate(); },
    setActive() { if (active()) invalidate(); else { cancelAnimationFrame(raf); raf = 0; } },
    refit() { if (!userMoved && !selected) home(); else invalidate(); },
    key(k) { if (k === '+' || k === '=') setZoom(stepZoom(cam.z, 1)); else if (k === '-') setZoom(stepZoom(cam.z, -1)); else if (k === '0') { userMoved = false; home(); remember(); } },
    showAllTags() {},
    setBubbles() {},
    camera: () => ({ v: 2, ...cam }),
    // Accepts the engine's own { v: 2, x, y, z } (tiles); a classic camera (world px) only restores the zoom level.
    setCamera(c) {
      if (!c) return;
      if (c.v === 2) cam = { x: +c.x, y: +c.y, z: ZOOMS.includes(c.z) ? c.z : cam.z };
      else if (ZOOMS.includes(c.z)) cam = { ...cam, z: c.z };
      userMoved = true; invalidate();
    },
    setGridMode(m) { if (MODES.has(m)) { mode = m; invalidate(); } },
    debug: () => ({
      engine: 2, world: mod.id, zoom: cam.z, cam: { ...cam }, mode, demo: DEMO, fixture: fixtureName, t: simT, error: lastError, perf: { ...perf },
      grid: world ? { ox: world.grid.ox, oy: world.grid.oy, w: world.grid.w, h: world.grid.h, version: world.grid.version } : null,
      villages: world ? world.villages.map(v => ({ name: v.name, tier: v.tier, cap: v.cap, block: { x: v.block.x, y: v.block.y, w: v.block.w, h: v.block.h } })) : [],
      square: world?.square ?? null, venues: world?.venues ?? null, berths: berths?.venues ?? null, bounds: world?.bounds ?? null, focus: world?.focus ?? null,
      lint: world ? world.lint : [], objects: world ? world.objects.size : 0, quiet: view?.quiet ?? [],
      actors: sim ? sim.actors.size : 0, hits: hits.length, sprites: renderer?.stats?.() ?? null,
      // active: false means the village is not on screen (e.g. the panel is full width): nothing draws, so
      // dataset.engine stays 'loading' until it is shown
      active: active(), timing: { ...timing },
    }),
  };
}
