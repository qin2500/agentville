#!/usr/bin/env node
// Engine v2 perf harness (M7 P3): measures the design budgets (docs/village-engine-v2.md §2.5, §3.1) on the 1,000-agent
// stress fixture loaded WITH its nested growth history (design decision), plus the 400-agent busy row.
//
//   node tools/perf/engine-perf.mjs [--fixture stress] [--layout e2e/fixtures/engine/stress-nested.layout.json]
//        [--busy busy] [--runs 3] [--port 5403] [--window 10] [--out /tmp/enginev2/m7-perf.json] [--no-profile]
//
// Browser rows run in a hidden headless Chromium (never a visible window, never focus) at 1440x900, against the art-pass
// vite dev server (tools/artpass/vite.config.mjs), which this script starts on --port and stops when done. Each run is a
// fresh browser context (empty storage) seeded before the first script with the nested layout (va.engine2.world.demo,
// the key fixture pages read), va.engine2.seed and va.engine2.salt, so the page loads the grown town with no re-plan.
// Steady CPU = CDP Performance.getMetrics TaskDuration (main thread) over wall time. Frame figures come from the engine's
// own debug perf block (draw() time of the last 600 frames). Road graph and path requests are pure: they are timed in
// node (same V8) on the same world the page builds. Each row's value is the median of the per-run values.
// The sim tick is also timed on its own (report.sim, and a "sim" line per run): its ms per frame, share of the frame and
// share of the steady CPU. That is a breakdown only: the frame and CPU rows still include the sim.
// Never touches real sessions, ~/.claude, ~/.codex, ~/.config or the network (the page runs the dev mock API).
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../test/support/ensure-mods-index.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
const flag = k => args.includes(`--${k}`);
const FIXTURE = opt('fixture', 'stress'), BUSY = opt('busy', 'busy');
const LAYOUT = path.resolve(ROOT, opt('layout', 'e2e/fixtures/engine/stress-nested.layout.json'));
const RUNS = Math.max(1, +opt('runs', 3)), PORT = +opt('port', 5403), WINDOW_S = +opt('window', 10);
const OUT = path.resolve(opt('out', '/tmp/enginev2/m7-perf.json'));
const PROFILE = !flag('no-profile');
const TRACE = flag('trace');   // per-frame log of the pan/zoom gesture (villagePerf.trace) in each run's panzoomTrace
// GPU: Playwright's default headless shell rasterises on SwiftShader (CPU), which is not the MacBook-class Chromium the
// budgets name. The new headless mode (channel 'chromium', still no window) with ANGLE Metal uses the real GPU.
// --swiftshader measures the software path instead.
const LAUNCH = flag('swiftshader') ? { headless: true }
  : { headless: true, channel: 'chromium', args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] };
const VW = 1440, VH = 900, BASE = `http://127.0.0.1:${PORT}/`;
const MB = 1 << 20;

const BUDGETS = [
  // id, scenario, metric, budget, unit
  ['stress-2x.frame', '2x, 1,000 agents, ~300 on screen', 'frame p95', 8, 'ms'],
  ['stress-2x.cpu', '2x, 1,000 agents, ~300 on screen', 'steady CPU', 5, '%'],
  ['stress-2x.sprites', '2x, 1,000 agents, ~300 on screen', 'sprite cache', 64, 'MB'],
  ['map.frame', 'Map zoom, whole world', 'frame p95', 3, 'ms'],
  ['map.cpu', 'Map zoom, whole world', 'steady CPU', 3.5, '%'],   // design decision (was 2)
  ['panzoom.frame', 'Pan or zoom gesture (2x)', 'frame p95', 8, 'ms'],
  ['cold.total', 'Cold world build (nested)', 'total', 375, 'ms'],   // design decision (was 300; slicing overhead)
  ['cold.task', 'Cold world build (nested)', 'longest task', 50, 'ms'],
  ['poll', 'Per poll (status change only)', 'p95', 3, 'ms'],
  ['roadgraph', 'Road graph build', 'median', 15, 'ms'],
  ['path.avg', 'Path request', 'avg', 0.3, 'ms'],
  ['path.p99', 'Path request', 'p99', 2, 'ms'],
  ['busy-2x.frame', '2x, 40 projects, 400 agents, ~120 on screen', 'frame p95', 4, 'ms'],
  ['busy-2x.cpu', '2x, 40 projects, 400 agents, ~120 on screen', 'steady CPU', 3, '%'],   // design decision (was 2.5)
  ['busy-2x.sprites', '2x, 40 projects, 400 agents, ~120 on screen', 'sprite cache', 48, 'MB'],
];

const median = xs => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const q = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null; };
const r2 = v => (v == null ? null : Math.round(v * 100) / 100);
const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const simLine = s => (s ? `${s.meanMs} ms/frame (p95 ${s.p95Ms}), ${Math.round((s.frameShare ?? 0) * 100)}% of frame, ${s.cpuPct}% cpu (${Math.round((s.cpuShare ?? 0) * 100)}% of cpu)` : 'n/a');

// ---------- node rows: road graph, path requests (pure, same world the page builds) ----------
async function nodeRows(layout) {
  const { buildWorld } = await import('../../web/src/engine/world/build.js');
  const { viewFromFixture } = await import('../../web/src/engine/snapshot.js');
  const { toWorldInput } = await import('../../web/src/engine/mod/input.js');
  const { buildRoadGraph } = await import('../../web/src/engine/nav/roadgraph.js');
  const { createNav } = await import('../../web/src/engine/nav/index.js');
  const { default: fantasy } = await import('../../mods/agentville.fantasy/index.js');
  const fx = JSON.parse(fs.readFileSync(path.join(ROOT, `e2e/fixtures/engine/${FIXTURE}.json`), 'utf8'));
  const persisted = JSON.parse(JSON.stringify(layout.persisted));
  const before = JSON.stringify(persisted.blocks);
  const { input, serverId } = toWorldInput(viewFromFixture(fx, { now: fx.now }), { seed: layout.seed, salt: layout.salt, features: fantasy.features });
  const t0 = performance.now();
  const world = buildWorld(input, persisted, { mod: fantasy, now: fx.now, seed: layout.seed, serverId });
  const buildMs = performance.now() - t0;
  const relaid = Object.keys(persisted.blocks).filter(k => JSON.stringify(persisted.blocks[k]) !== JSON.stringify(JSON.parse(before)[k])).length;
  // road graph: one cold build, then 7 more; the median of all 8
  const rg = [];
  let graph = null;
  for (let i = 0; i < 8; i++) { const s = performance.now(); graph = buildRoadGraph(world); rg.push(performance.now() - s); }
  // path requests: 2,000 deterministic trips between building stand tiles (60% within one settlement, 40% anywhere),
  // on a fresh nav (cold route cache, as after a world change)
  let st = 7 >>> 0;
  const rnd = () => { st = (st + 0x6D2B79F5) >>> 0; let t = st; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const doors = [...world.objects.values()].filter(o => o.kind === 'building' && o.anchors?.stand?.length)
    .map(o => ({ p: o.project ?? '', x: o.anchors.stand[0].tx + 0.5, y: o.anchors.stand[0].ty + 0.5 }));
  const byP = new Map();
  for (const d of doors) { if (!byP.has(d.p)) byP.set(d.p, []); byP.get(d.p).push(d); }
  const nav = createNav(world);
  nav.graph;   // the road graph is built lazily: build it outside the timed requests (it is its own row)
  const pick = a => a[Math.floor(rnd() * a.length)];
  const times = [];
  let nulls = 0;
  for (let i = 0; i < 2000; i++) {
    const a = pick(doors), b = rnd() < 0.6 ? pick(byP.get(a.p)) : pick(doors);
    const s = performance.now();
    const r = nav.path(a, b);
    times.push(performance.now() - s);
    if (!r) nulls++;
  }
  return {
    world: { objects: world.objects.size, grid: [world.grid.w, world.grid.h], villages: world.villages.length, buildMs: r2(buildMs), relaidBlocks: relaid,
      graph: { nodes: graph.nodes?.length ?? null, edges: graph.edges?.length ?? null }, doors: doors.length },
    roadgraph: { coldMs: r2(rg[0]), medianMs: r2(median(rg)), runs: rg.map(r2) },
    path: { n: times.length, avgMs: r2(times.reduce((s, v) => s + v, 0) / times.length * 100) / 100, p50Ms: r2(q(times, 0.5)), p99Ms: r2(q(times, 0.99)),
      maxMs: r2(Math.max(...times)), nulls },
  };
}

// ---------- vite ----------
async function startVite() {
  const vite = spawn(path.join(ROOT, 'node_modules/.bin/vite'), ['-c', 'tools/artpass/vite.config.mjs', '--logLevel', 'info'],
    { cwd: ROOT, env: { ...process.env, ARTPASS_PORT: String(PORT), BROWSER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let err = '';
  vite.stderr.on('data', d => { err += d; });
  // a dependency re-optimisation or a watched file change reloads the page under test: say so in the log
  vite.stdout.on('data', d => { for (const l of String(d).split('\n')) if (/reload|optimiz|hmr|changed/i.test(l)) log(`  vite: ${l.trim()}`); });
  const stop = () => { try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* gone */ } };
  process.on('exit', stop);
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stop(); process.exit(130); });
  for (let i = 0; i < 300; i++) {
    if (vite.exitCode != null) throw new Error(`vite exited (${vite.exitCode}): ${err.slice(-800)}`);
    try { const r = await fetch(BASE); if (r.ok) return stop; } catch { /* not up yet */ }
    await sleep(100);
  }
  stop();
  throw new Error(`vite did not come up on ${BASE}: ${err.slice(-800)}`);
}

// ---------- browser ----------
async function openPage(browser, fixture, layout) {
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  await ctx.addInitScript(seed => {
    try {
      localStorage.setItem('va.bubbles', '0');
      if (seed) {
        localStorage.setItem('va.engine2.world.demo', JSON.stringify(seed.persisted));
        localStorage.setItem('va.engine2.seed', JSON.stringify(seed.seed));
        localStorage.setItem('va.engine2.salt', JSON.stringify(seed.salt));
      }
    } catch { /* storage blocked */ }
    document.addEventListener('DOMContentLoaded', () => document.body.classList.add('village-only'));
  }, layout ? { persisted: layout.persisted, seed: layout.seed, salt: layout.salt } : null);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' || /engine:/.test(m.text())) errors.push(m.text()); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
  return { ctx, page, cdp, errors, url: `${BASE}?mock&engine=2&debug&night=0&fixture=${fixture}${layout ? `&seed=${layout.seed}` : ''}` };
}
const dbg = page => page.evaluate(() => { const d = window.villageDebug(); return { perf: d.perf, timing: d.timing, sprites: d.sprites, grid: d.grid, cam: d.cam,
  villages: d.villages, actors: d.actors, objects: d.objects, reuse: d.reuse, error: d.error, zoom: d.zoom }; });
// settled: every sprite and ground chunk of the view is drawn, and the idle prefetch (next zoom step, pan margin) is done
async function settle(page, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    const s = await page.evaluate(() => { const s = window.villageDebug().sprites; return s && s.artReady && !s.pending && !s.queued && !s.groundPending && !(s.prefetch && !s.prefetch.done); });
    if (s || Date.now() - t0 > timeout) return !!s;
    await sleep(100);
  }
}
async function setCam(page, cam) {
  await page.evaluate(c => window.villageSetCamera({ v: 2, ...c }), cam);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}
async function metrics(cdp) {
  const { metrics: m } = await cdp.send('Performance.getMetrics');
  const o = Object.fromEntries(m.map(x => [x.name, x.value]));
  return { task: o.TaskDuration, script: o.ScriptDuration, layout: o.LayoutDuration, timestamp: o.Timestamp, heapMB: o.JSHeapUsedSize / MB };
}
/** Steady window: reset the frame ring, let the engine run WINDOW_S seconds on its own clock, read frames + CPU.
 *  `sim` is the sim tick's own cost in the same window (the engine's debug perf block times it inside each frame):
 *  ms per frame (mean, p95), its share of the frame time, its CPU % of wall time and its share of the steady CPU. It is
 *  reported beside the rows, never subtracted: the frame and CPU rows still include the sim. */
async function steady(page, cdp, seconds = WINDOW_S) {
  await page.evaluate(() => window.villagePerf.reset());
  const m0 = await metrics(cdp);
  await sleep(seconds * 1000);
  const m1 = await metrics(cdp), d = await dbg(page);
  const wall = m1.timestamp - m0.timestamp, cpuPct = ((m1.task - m0.task) / wall) * 100;
  const st = d.perf.sim, simCpuPct = st ? (st.simSumMs / 1000 / wall) * 100 : null;
  const sim = st ? { meanMs: st.meanMs, p95Ms: d.perf.simFrames?.p95 ?? null, frameShare: st.share, cpuPct: r2(simCpuPct),
    cpuShare: cpuPct > 0 ? r2(simCpuPct / cpuPct) : null, lod: st.lod } : null;
  return { frames: d.perf.frames, cpuPct: r2(cpuPct), scriptPct: r2(((m1.script - m0.script) / wall) * 100),
    spriteMB: r2(d.perf.spriteBytes / MB), onScreen: d.perf.onScreen, heapMB: r2(m1.heapMB), longestTaskMs: d.perf.longestTaskMs, sim };
}
/** Camera at zoom 2 over the settlement showing the most actors outdoors (tries the biggest settlements first). */
async function busiestCam(page, villages) {
  const cands = [...villages].sort((a, b) => b.tier - a.tier || b.block.w * b.block.h - a.block.w * a.block.h).slice(0, 16);
  let best = null;
  for (const v of cands) {
    for (const [fx, fy] of [[0.5, 0.5], [0.35, 0.35], [0.65, 0.65]]) {
      const cam = { x: v.block.x + v.block.w * fx, y: v.block.y + v.block.h * fy, z: 2 };
      await setCam(page, cam);
      const n = (await dbg(page)).perf.onScreen;
      if (!best || n > best.onScreen) best = { cam, onScreen: n, village: v.name, tier: v.tier };
    }
  }
  return best;
}
/** CDP self-time profile over `fn`: the top functions by self ms. */
async function profile(cdp, fn, top = 10) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  await fn();
  const { profile: p } = await cdp.send('Profiler.stop');
  return selfTop(p, top);
}
function selfTop(p, top = 10) {
  const dt = new Map();
  for (let i = 0; i < p.samples.length; i++) dt.set(p.samples[i], (dt.get(p.samples[i]) || 0) + (p.timeDeltas[i + 1] ?? 0) / 1000);
  const self = new Map();
  for (const n of p.nodes) {
    const ms = dt.get(n.id) || 0;
    if (!ms) continue;
    const cf = n.callFrame, file = cf.url ? cf.url.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '') : '';
    const k = `${cf.functionName || '(anon)'} ${file}${file ? `:${cf.lineNumber + 1}` : ''}`;
    self.set(k, (self.get(k) || 0) + ms);
  }
  const total = [...self.values()].reduce((s, v) => s + v, 0);
  return [...self.entries()].filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k) || /garbage/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([k, ms]) => ({ fn: k, selfMs: r2(ms), pct: r2((ms / total) * 100) }));
}

async function stressRun(browser, layout, run, wantProfile) {
  const P = await openPage(browser, FIXTURE, layout), { page, cdp } = P, out = { run };
  // cold build: navigation -> world built and first frame drawn; the rebuild is one synchronous task
  const coldLoad = async () => {
    await page.goto(P.url);
    await page.waitForFunction(() => document.getElementById('cv')?.dataset.engine === 'ready' && window.villageDebug?.().engine === 2, null, { timeout: 120000 });
  };
  if (wantProfile) out.profileCold = await profile(cdp, coldLoad);
  else await coldLoad();
  let d = await dbg(P.page);
  if (d.error) throw new Error(`engine error: ${d.error}`);
  // the nested layout must have loaded as saved: every block keeps its rect, tier and chain (no re-plan on load)
  const saved = layout.persisted.blocks;
  const moved = d.villages.filter(v => { const b = saved[v.name]; return !b || b.x !== v.block.x || b.y !== v.block.y || b.w !== v.block.w || b.h !== v.block.h || b.tier !== v.tier; });
  out.world = { objects: d.objects, actors: d.actors, villages: d.villages.length, tiers: [0, 1, 2, 3].map(t => d.villages.filter(v => v.tier === t).length),
    grid: d.grid && [d.grid.w, d.grid.h], relaidOnLoad: moved.map(v => v.name) };
  out.cold = { rebuildMs: d.perf.rebuildMs, buildMs: d.perf.buildMs, longestTaskMs: d.perf.longestTaskMs, builtMs: d.timing.builtMs, readyMs: d.timing.readyMs };
  out.cold.settled = await settle(page, 60000);
  out.cold.settledMs = (await dbg(page)).timing.settledMs;

  // 2x over the busiest city
  const best = await busiestCam(page, d.villages);
  await setCam(page, best.cam);
  const s2 = await settle(page);
  out.stress2x = { settled: s2, cam: best.cam, village: best.village, tier: best.tier, ...(await steady(page, cdp)) };
  if (wantProfile) out.profile2x = await profile(cdp, () => sleep(4000));

  // pan + zoom gesture at 2x: a 2 s drag (60 Hz pointer moves) then 1.5 s of wheel steps out and back in
  await setCam(page, best.cam);
  await settle(page);
  await page.evaluate(() => window.villagePerf.reset());
  if (TRACE) await page.evaluate(() => window.villagePerf.trace?.(true));
  const origin0 = await page.evaluate(() => performance.timeOrigin);   // a page reload mid-gesture voids the row
  const cx = VW / 2, cy = VH / 2, mouse = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
  if (wantProfile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
  const g0 = Date.now();
  await mouse('mousePressed', cx, cy, { buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    await mouse('mouseMoved', cx + Math.sin(a) * 300, cy + (1 - Math.cos(a)) * 120, { buttons: 1 });
    await sleep(16);
  }
  await mouse('mouseReleased', cx, cy, { buttons: 0, clickCount: 1 });
  for (const dy of [120, 120, -120, -120]) {   // 2x -> 1x -> 0.5x -> 1x -> 2x, each step's tween drawn at rAF
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: dy });
    await sleep(350);
  }
  await sleep(200);
  const gs = (Date.now() - g0) / 1000;
  d = await dbg(page);
  if (wantProfile) { const { profile: pr } = await cdp.send('Profiler.stop'); out.profilePan = selfTop(pr); }
  const reloaded = (await page.evaluate(() => performance.timeOrigin)) !== origin0;
  if (reloaded) log('  WARNING: the page reloaded during the pan/zoom gesture (vite?): this run\'s pan/zoom row is not valid');
  out.panzoom = { seconds: r2(gs), frames: d.perf.frames, fps: r2(d.perf.frames.n / gs), zoomAfter: d.zoom, reloaded };
  if (TRACE) {
    // [t, drawMs, zoom, rasterN, rasterMs, queued, pending]: the slowest frames, with the rasters each one did
    const tr = (await page.evaluate(() => window.villagePerf.trace?.(false))) || [];
    const rows = tr.map((f, i) => ({ t: f[0] - (tr[0]?.[0] ?? 0), ms: f[1], z: f[2], rasters: i ? f[3] - tr[i - 1][3] : 0, rasterMs: i ? f[4] - tr[i - 1][4] : 0, queued: f[5], pending: f[6], phase: f[7], way: f[8] }));
    out.panzoomTrace = { slowest: [...rows].sort((a, b) => b.ms - a.ms).slice(0, 15).map(r => ({ ...r, t: Math.round(r.t) })),
      byZoom: Object.fromEntries([...new Set(rows.map(r => r.z))].map(z => { const at = rows.filter(r => r.z === z), ms = at.map(r => r.ms), ph = at.filter(r => r.phase);
        // mean ms of each renderer phase over the zoom's frames, and how the frames were drawn (full / keep / kept)
        const phase = ph.length ? Object.fromEntries(Object.keys(ph[0].phase).map(k => [k, r2(ph.reduce((s, r) => s + (r.phase[k] || 0), 0) / ph.length)])) : null;
        const ways = {}; for (const r of at) ways[r.way] = (ways[r.way] || 0) + 1;
        return [z, { n: ms.length, p50: q(ms, 0.5), p95: q(ms, 0.95), max: Math.max(...ms), phase, ways }]; })),
      rasters: rows.reduce((n, r) => n + r.rasters, 0) };
  }

  // Map zoom: the whole world at 0.25
  await setCam(page, { x: d.grid.ox + d.grid.w / 2, y: d.grid.oy + d.grid.h / 2, z: 0.25 });
  const mapSettled = await settle(page, 30000);
  out.map = { settled: mapSettled, ...(await steady(page, cdp)) };
  if (wantProfile) out.profileMap = await profile(cdp, () => sleep(4000));

  // per poll: 30 polls flipping 20 agents' working status each (no layout change), back at 2x
  await setCam(page, best.cam);
  await settle(page);
  const builds0 = (await dbg(page)).reuse.builds, polls = [];
  for (let i = 0; i < 30; i++) { polls.push(await page.evaluate(() => window.villagePerf.poll(20))); await sleep(50); }
  if (wantProfile) out.profilePoll = await profile(cdp, async () => { for (let i = 0; i < 10; i++) await page.evaluate(() => window.villagePerf.poll(20)); });
  out.poll = { n: polls.length, medianMs: r2(median(polls)), p95Ms: r2(q(polls, 0.95)), maxMs: r2(Math.max(...polls)), rebuilt: (await dbg(page)).reuse.builds - builds0 };
  out.errors = P.errors.slice(0, 10);
  await P.ctx.close();
  return out;
}

async function busyRun(browser, run) {
  const P = await openPage(browser, BUSY, null), { page, cdp } = P;
  await page.goto(P.url);
  await page.waitForFunction(() => document.getElementById('cv')?.dataset.engine === 'ready' && window.villageDebug?.().engine === 2, null, { timeout: 120000 });
  await settle(page, 60000);
  const d = await dbg(page);
  const best = await busiestCam(page, d.villages);
  await setCam(page, best.cam);
  await settle(page);
  const out = { run, world: { objects: d.objects, actors: d.actors, villages: d.villages.length }, cold: { rebuildMs: d.perf.rebuildMs, longestTaskMs: d.perf.longestTaskMs },
    busy2x: { cam: best.cam, village: best.village, ...(await steady(page, cdp)) }, errors: P.errors.slice(0, 10) };
  await P.ctx.close();
  return out;
}

// ---------- main ----------
const layout = JSON.parse(fs.readFileSync(LAYOUT, 'utf8'));
if (layout.fixture !== FIXTURE) throw new Error(`layout ${LAYOUT} is for fixture ${layout.fixture}, not ${FIXTURE}`);
log(`node rows (road graph, path requests) on the ${FIXTURE} world + nested layout ...`);
const node = await nodeRows(layout);
log(`  world ${node.world.objects} objects, grid ${node.world.grid.join('x')}, graph ${node.world.graph.nodes} nodes; road graph median ${node.roadgraph.medianMs} ms; path avg ${node.path.avgMs} p99 ${node.path.p99Ms} ms`);

const stopVite = await startVite();
const browser = await chromium.launch(LAUNCH);
const chromiumVersion = browser.version();
const runs = [], busy = [];
let profiles = null;
try {
  log('warm-up load (vite transforms, not counted) ...');
  { const P = await openPage(browser, FIXTURE, layout); await P.page.goto(P.url); await P.page.waitForFunction(() => document.getElementById('cv')?.dataset.engine === 'ready', null, { timeout: 180000 }); await P.ctx.close(); }
  for (let i = 1; i <= RUNS; i++) {
    log(`run ${i}/${RUNS}: ${FIXTURE} (nested) ...`);
    const r = await stressRun(browser, layout, i, false);
    runs.push(r);
    log(`  cold ${r.cold.rebuildMs} ms (task ${r.cold.longestTaskMs}), 2x p95 ${r.stress2x.frames.p95} ms cpu ${r.stress2x.cpuPct}% on screen ${r.stress2x.onScreen}, map p95 ${r.map.frames.p95}, pan p95 ${r.panzoom.frames.p95}, poll p95 ${r.poll.p95Ms}`);
    log(`  sim: 2x ${simLine(r.stress2x.sim)}; map ${simLine(r.map.sim)}`);
    log(`run ${i}/${RUNS}: ${BUSY} ...`);
    const b = await busyRun(browser, i);
    busy.push(b);
    log(`  busy 2x p95 ${b.busy2x.frames.p95} ms cpu ${b.busy2x.cpuPct}% on screen ${b.busy2x.onScreen}; sim ${simLine(b.busy2x.sim)}`);
  }
  if (PROFILE) {   // an extra, uncounted run under the CDP sampling profiler: where the time goes
    log('profile run (not counted) ...');
    const r = await stressRun(browser, layout, 'profile', true);
    profiles = { cold: r.profileCold, stress2x: r.profile2x, panzoom: r.profilePan, map: r.profileMap, poll: r.profilePoll };
  }
} finally {
  await browser.close();
  stopVite();
}

const pick = (list, f) => median(list.map(f));
const values = {
  'stress-2x.frame': pick(runs, r => r.stress2x.frames.p95), 'stress-2x.cpu': pick(runs, r => r.stress2x.cpuPct), 'stress-2x.sprites': pick(runs, r => r.stress2x.spriteMB),
  'map.frame': pick(runs, r => r.map.frames.p95), 'map.cpu': pick(runs, r => r.map.cpuPct),
  'panzoom.frame': pick(runs, r => r.panzoom.frames.p95),
  'cold.total': pick(runs, r => r.cold.rebuildMs), 'cold.task': pick(runs, r => r.cold.longestTaskMs),
  poll: pick(runs, r => r.poll.p95Ms),
  roadgraph: node.roadgraph.medianMs, 'path.avg': node.path.avgMs, 'path.p99': node.path.p99Ms,
  'busy-2x.frame': pick(busy, r => r.busy2x.frames.p95), 'busy-2x.cpu': pick(busy, r => r.busy2x.cpuPct), 'busy-2x.sprites': pick(busy, r => r.busy2x.spriteMB),
};
// The sim's share of the steady rows, reported separately (informational: the budget rows above still include the sim).
const simOf = (list, f) => {
  const xs = list.map(f).filter(Boolean);
  return xs.length ? { meanMs: r2(median(xs.map(x => x.meanMs))), p95Ms: r2(median(xs.map(x => x.p95Ms))), frameShare: r2(median(xs.map(x => x.frameShare))),
    cpuPct: r2(median(xs.map(x => x.cpuPct))), cpuShare: r2(median(xs.map(x => x.cpuShare))), lod: xs[xs.length - 1].lod } : null;
};
const simRows = { 'stress-2x': simOf(runs, r => r.stress2x.sim), map: simOf(runs, r => r.map.sim), 'busy-2x': simOf(busy, r => r.busy2x.sim) };
const rows = BUDGETS.map(([id, scenario, metric, budget, unit]) => {
  const value = r2(values[id]);
  return { id, scenario, metric, value, budget, unit, pass: value != null && value <= budget, overBy: value != null && value > budget ? r2(value - budget) : 0 };
});
const gpuRenderer = await (async () => { const b = await chromium.launch(LAUNCH); try { const pg = await b.newPage(); return await pg.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl'); const e = gl?.getExtension('WEBGL_debug_renderer_info'); return gl ? gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : null; }); } finally { await b.close(); } })();
const report = {
  at: new Date().toISOString(), host: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, load: os.loadavg().map(r2), node: process.version, chromium: chromiumVersion, gpu: gpuRenderer },
  fixture: FIXTURE, layout: path.relative(ROOT, LAYOUT), layoutFacts: { steps: layout.steps, fractions: layout.fractions, seed: layout.seed,
    tiers: [0, 1, 2, 3].map(t => (layout.projects || []).filter(p => p.tier === t).length),
    cityPaths: [...new Set((layout.projects || []).filter(p => p.tier === 3).map(p => p.tiers.join('>')))],
    chainDepths: (layout.projects || []).reduce((m, p) => ((m[p.chainDepth] = (m[p.chainDepth] || 0) + 1), m), {}) },
  viewport: [VW, VH], runs: RUNS, windowS: WINDOW_S,
  pass: rows.every(r => r.pass), misses: rows.filter(r => !r.pass).map(r => r.id),
  rows, sim: simRows, node, stress: runs, busy, profiles,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
log('\nscenario                                         metric          value     budget  pass');
for (const r of rows) log(`${r.scenario.padEnd(48)} ${r.metric.padEnd(14)} ${String(r.value).padStart(8)} ${r.unit.padEnd(2)} <= ${String(r.budget).padEnd(5)} ${r.pass ? 'ok' : `MISS (+${r.overBy})`}`);
log('\nsim tick (inside the rows above, not subtracted)   ms/frame   p95   frame share   cpu %   cpu share');
for (const [k, v] of Object.entries(simRows)) if (v) log(`${k.padEnd(48)} ${String(v.meanMs).padStart(8)} ${String(v.p95Ms).padStart(5)} ${String(v.frameShare).padStart(13)} ${String(v.cpuPct).padStart(7)} ${String(v.cpuShare).padStart(11)}`);
log(`\n→ ${OUT}`);
process.exit(0);
