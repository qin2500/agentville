#!/usr/bin/env node
// Map zoom fill harness (design §3.5): how long the first visit to Map zoom (1/4) takes to bake every tile of the view,
// the longest main-thread task while it does, the frame p95 of a pan through unbaked tiles, and the same fill again
// after a relaunch of the browser on the same profile (persisted tiles, map-tile-store.js).
//
//   node tools/perf/map-fill.mjs [--root <checkout>] [--fixture stress|busy] [--runs 3] [--port 5493]
//        [--out /tmp/enginev2/map-fill.json] [--timeout 400] [--profile]
//
// --root measures another checkout with this same script (a control branch): its vite serves its own web/. Each run
// gets a fresh browser profile (empty storage, empty IndexedDB) in a temp dir; the warm row relaunches the browser on
// that profile. Hidden headless Chromium (new headless, GPU), never a window, never focus. The page runs the dev mock
// API: no real sessions, ~/.claude, ~/.codex or ~/.config, no network.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
const flag = k => args.includes(`--${k}`);
const ROOT = path.resolve(opt('root', HERE));
const FIXTURE = opt('fixture', 'stress');
const LAYOUT = FIXTURE === 'stress' ? path.resolve(HERE, opt('layout', 'e2e/fixtures/engine/stress-nested.layout.json')) : null;
const RUNS = Math.max(1, +opt('runs', 3)), PORT = +opt('port', 5493), TIMEOUT_S = +opt('timeout', 400);
const OUT = path.resolve(opt('out', `/tmp/enginev2/map-fill-${FIXTURE}.json`));
const PROFILE = flag('profile');
const LAUNCH = { headless: true, channel: 'chromium', args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] };
const VW = 1440, VH = 900, BASE = `http://127.0.0.1:${PORT}/`;
const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null; };
const r1 = v => (v == null ? null : Math.round(v * 10) / 10);

async function startVite() {
  const vite = spawn(path.join(HERE, 'node_modules/.bin/vite'), ['-c', 'tools/artpass/vite.config.mjs', '--logLevel', 'warn'],
    { cwd: ROOT, env: { ...process.env, ARTPASS_PORT: String(PORT), BROWSER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let err = '';
  vite.stderr.on('data', d => { err += d; });
  const stop = () => { try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* gone */ } };
  process.on('exit', stop);
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stop(); process.exit(130); });
  for (let i = 0; i < 300; i++) {
    if (vite.exitCode != null) throw new Error(`vite exited (${vite.exitCode}): ${err.slice(-800)}`);
    try { const r = await fetch(BASE); if (r.ok) return stop; } catch { /* not up yet */ }
    await sleep(100);
  }
  stop();
  throw new Error(`vite did not come up on ${BASE}`);
}

const layout = LAYOUT ? JSON.parse(fs.readFileSync(LAYOUT, 'utf8')) : null;
const url = `${BASE}?mock&engine=2&debug&night=0${flag("no-store") ? "" : "&tilestore"}&fixture=${FIXTURE}${layout ? `&seed=${layout.seed}` : ''}`;

/** A browser on profile dir `dir`, the page loaded and the engine ready. Long tasks are logged from the first script. */
async function open(dir) {
  const ctx = await chromium.launchPersistentContext(dir, { ...LAUNCH, viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
  await ctx.addInitScript(seed => {
    window.__lt = [];
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch { /* none */ }
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
  const page = ctx.pages()[0] ?? await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' || /engine:|map-tiles/.test(m.text())) errors.push(m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('cv')?.dataset.engine === 'ready' && window.villageDebug?.().engine === 2, null, { timeout: 180000 });
  return { ctx, page, errors };
}
const sprites = page => page.evaluate(() => window.villageDebug().sprites);
async function setCam(page, cam) {
  await page.evaluate(c => window.villageSetCamera({ v: 2, ...c }), cam);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}
/** Wait until the Map view has every tile fresh (no pending tile or ground, no queued sprite). */
async function filled(page, t0, timeoutS) {
  for (;;) {
    const s = await sprites(page);
    if (!s.queued && !s.groundPending && !s.pending) return { ms: Date.now() - t0, done: true, s };
    if (Date.now() - t0 > timeoutS * 1000) return { ms: Date.now() - t0, done: false, s };
    await sleep(100);
  }
}
const longTasks = (page, since) => page.evaluate(t => (window.__lt || []).filter(e => e[0] >= t).map(e => e[1]), since);
const pnow = page => page.evaluate(() => performance.now());

/** The fill of the whole-world Map view at 1/4: { fillMs, done, longest, over50, frames } */
async function fill(page, cam) {
  await page.evaluate(() => window.villagePerf.reset());
  const since = await pnow(page), t0 = Date.now();
  await setCam(page, cam);
  const f = await filled(page, t0, TIMEOUT_S);
  const lt = await longTasks(page, since), d = await page.evaluate(() => window.villageDebug().perf.frames);
  return { fillMs: f.ms, done: f.done, longest: r1(Math.max(0, ...lt)), over50: lt.filter(x => x > 50).length, frameP95: d.p95, mapBake: f.s.mapBake, mapTiles: f.s.mapTiles, store: f.s.mapStore ?? null };
}
/** A 2 s drag at Map zoom across the world (into tiles not baked yet), then the frames of it. */
async function pan(page, cdp) {
  await page.evaluate(() => window.villagePerf.reset());
  const since = await pnow(page);
  const cx = VW / 2, cy = VH / 2, mouse = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
  await mouse('mousePressed', cx, cy, { buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 120; i++) {
    const a = (i / 120) * Math.PI * 2;
    await mouse('mouseMoved', cx + Math.sin(a) * 600, cy + (1 - Math.cos(a)) * 350, { buttons: 1 });
    await sleep(16);
  }
  await mouse('mouseReleased', cx, cy, { buttons: 0, clickCount: 1 });
  await sleep(300);
  const d = await page.evaluate(() => window.villageDebug().perf.frames), lt = await longTasks(page, since);
  return { frames: d, longest: r1(Math.max(0, ...lt)), over50: lt.filter(x => x > 50).length };
}

const stopVite = await startVite();
const report = { at: new Date().toISOString(), root: ROOT, fixture: FIXTURE, load: os.loadavg().map(r1), runs: [] };
try {
  log(`map-fill ${FIXTURE} @ ${ROOT}`);
  { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapfill-warmup-')); const P = await open(dir); await P.ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  for (let i = 1; i <= RUNS; i++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapfill-'));
    const run = { run: i, load0: os.loadavg()[0] };
    // cold: a fresh profile; the street view settles first, then the whole world at 1/4
    let P = await open(dir);
    const grid = (await P.page.evaluate(() => window.villageDebug().grid));
    const cam = { x: grid.ox + grid.w / 2, y: grid.oy + grid.h / 2, z: 0.25 };
    await sleep(1500);
    let cdp = PROFILE ? await P.ctx.newCDPSession(P.page) : null;
    if (PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); }
    run.cold = await fill(P.page, cam);
    if (PROFILE) { const { profile: pr } = await cdp.send('Profiler.stop'); run.profile = selfTop(pr, 25); }
    log(`  run ${i} cold: fill ${run.cold.fillMs} ms${run.cold.done ? '' : ' (TIMEOUT)'}, longest task ${run.cold.longest} ms (${run.cold.over50} > 50), frame p95 ${run.cold.frameP95}`);
    log(`    bake ${JSON.stringify(run.cold.mapBake)}`);
    cdp ??= await P.ctx.newCDPSession(P.page);
    run.pan = await pan(P.page, cdp);
    log(`  run ${i} pan: p95 ${run.pan.frames.p95} ms (n ${run.pan.frames.n}), longest task ${run.pan.longest} ms (${run.pan.over50} > 50)`);
    // let the panned tiles finish, so the profile holds them too, then close (persisted writes flush on their own)
    await filled(P.page, Date.now(), 120);
    await sleep(2000);
    run.errors = P.errors.slice(0, 10);
    await P.ctx.close();
    // warm: the same profile, a new browser
    P = await open(dir);
    await sleep(1500);
    run.warm = await fill(P.page, cam);
    log(`  run ${i} warm: fill ${run.warm.fillMs} ms${run.warm.done ? '' : ' (TIMEOUT)'}, longest task ${run.warm.longest} ms (${run.warm.over50} > 50); store ${JSON.stringify(run.warm.store)}`);
    run.errors.push(...P.errors.slice(0, 10));
    await P.ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
    report.runs.push(run);
  }
} finally {
  stopVite();
}
const med = f => { const a = report.runs.map(f).filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
report.summary = { coldFillMs: med(r => r.cold.fillMs), coldLongest: med(r => r.cold.longest), panP95: med(r => r.pan.frames.p95), panLongest: med(r => r.pan.longest), warmFillMs: med(r => r.warm.fillMs), warmLongest: med(r => r.warm.longest) };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
log(`summary ${JSON.stringify(report.summary)}\n→ ${OUT}`);
process.exit(0);

function selfTop(p, top) {
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
  return [...self.entries()].filter(([k]) => !/^\((idle|program)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, top).map(([fn, ms]) => ({ fn, ms: Math.round(ms) }));
}
