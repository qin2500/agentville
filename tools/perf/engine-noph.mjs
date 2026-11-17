#!/usr/bin/env node
// No placeholder, no flat ground (M7 noph): pans and zooms the busy fixture through several steps (pans at 2x, 1x, 1/2
// and Map zoom; 2x -> 1x -> 1/2 -> 1x -> Map -> 1x (at the pointer) and back to 2x) and counts, through the renderer's ?debug draw
// counters (renderer.stats().draws), every sprite drawn as a placeholder box and every ground chunk drawn flat, during
// each step and until the view settles after it. The whole sequence runs twice: the first pass warms the caches, the
// second (sprites warm) must draw zero placeholders and zero flat chunks. Exit code 1 when it does not.
//
//   node tools/perf/engine-noph.mjs [--fixture busy] [--port 5487] [--out /tmp/enginev2/m7-noph.json] [--passes 2]
//
// Hidden headless Chromium only (never a window), against the art-pass vite dev server (tools/artpass/vite.config.mjs),
// which this script starts on --port and stops. The page runs the dev mock API: no real sessions, ~/.claude, ~/.codex,
// ~/.config or network. Heavy: run it through ~/.claude/heavy-job.sh.
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
const FIXTURE = opt('fixture', 'busy'), PORT = +opt('port', 5487), PASSES = Math.max(1, +opt('passes', 2));
const OUT = path.resolve(opt('out', '/tmp/enginev2/m7-noph.json'));
const LAUNCH = { headless: true, channel: 'chromium', args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] };
const VW = 1440, VH = 900, BASE = `http://127.0.0.1:${PORT}/`;
const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function startVite() {
  const vite = spawn(path.join(ROOT, 'node_modules/.bin/vite'), ['-c', 'tools/artpass/vite.config.mjs', '--logLevel', 'info'],
    { cwd: ROOT, env: { ...process.env, ARTPASS_PORT: String(PORT), BROWSER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let err = '';
  vite.stderr.on('data', d => { err += d; });
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

const sprites = page => page.evaluate(() => window.villageDebug().sprites);
const zoomOf = page => page.evaluate(() => window.villageDebug().zoom);
// settled: the view drew a frame since the last camera change, shows every sprite and ground chunk, and (at street
// zoom: the renderer prefetches nothing at Map zoom) its idle prefetch is done
async function settle(page, timeout = 30000) {
  const t0 = Date.now();
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  for (;;) {
    const ok = await page.evaluate(() => { const d = window.villageDebug(), s = d.sprites; return !!s && s.artReady && !s.pending && !s.queued && !s.groundPending && (d.zoom <= 0.25 ? !s.prefetch : !!s.prefetch?.done); });
    if (ok || Date.now() - t0 > timeout) return ok;
    await sleep(100);
  }
}

async function main() {
  const stopVite = await startVite();
  const browser = await chromium.launch(LAUNCH);
  const report = { at: new Date().toISOString(), fixture: FIXTURE, load: os.loadavg().map(v => +v.toFixed(2)), passes: [], errors: [] };
  try {
    const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
    await ctx.addInitScript(() => {
      try { localStorage.setItem('va.bubbles', '0'); } catch { /* storage blocked */ }
      document.addEventListener('DOMContentLoaded', () => document.body.classList.add('village-only'));
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => report.errors.push(e.message));
    const cdp = await ctx.newCDPSession(page);
    await page.goto(`${BASE}?mock&engine=2&debug&night=0&fixture=${FIXTURE}`);
    await page.waitForFunction(() => document.getElementById('cv')?.dataset.engine === 'ready' && window.villageDebug?.().engine === 2, null, { timeout: 120000 });
    await settle(page, 60000);
    if (!(await sprites(page))?.draws) throw new Error('no draw counters: the renderer was not created with ?debug');
    // start at 2x over the biggest settlement
    const vs = (await page.evaluate(() => window.villageDebug().villages)).sort((a, b) => b.block.w * b.block.h - a.block.w * a.block.h);
    const v0 = vs[0];
    await page.evaluate(c => window.villageSetCamera({ v: 2, ...c }), { x: v0.block.x + v0.block.w / 2, y: v0.block.y + v0.block.h / 2, z: 2 });
    await settle(page, 60000);

    const cx = VW / 2, cy = VH / 2;
    const mouse = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
    const drag = async (dx, dy, n = 30) => {
      await mouse('mousePressed', cx, cy, { buttons: 1, clickCount: 1 });
      for (let i = 1; i <= n; i++) { await mouse('mouseMoved', cx + (dx * i) / n, cy + (dy * i) / n, { buttons: 1 }); await sleep(16); }
      await mouse('mouseReleased', cx + dx, cy + dy, { buttons: 0, clickCount: 1 });
    };
    const wheel = async (dy, x = cx, y = cy) => { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy }); await sleep(400); };
    // camera.js stepZoom: a wheel step out of 1x goes to Map zoom (the busy town's fit level); 1/2 is set directly
    const half = async z => { const c = await page.evaluate(() => window.villageDebug().cam); await page.evaluate(q => window.villageSetCamera({ v: 2, ...q }), { x: c.x, y: c.y, z }); };
    const STEPS = [
      ['pan 2x', () => drag(-420, -160)],
      ['2x -> 1x', () => wheel(120)],
      ['pan 1x', () => drag(380, 200)],
      ['1x -> 1/2', () => half(0.5)],
      ['pan 1/2', () => drag(-300, 120)],
      ['1/2 -> 1x', () => half(1)],
      ['1x -> Map', () => wheel(120)],
      ['pan Map', () => drag(200, -100)],
      ['Map -> 1x', () => wheel(-120, cx + 120, cy - 80)],
      ['pan 1x', () => drag(-380, -200)],
      ['1x -> Map', () => wheel(120)],
      ['Map -> 1x', () => wheel(-120)],
      ['1x -> 2x', () => wheel(-120)],
      ['pan 2x back', () => drag(420, 160)],
    ];
    for (let p = 1; p <= PASSES; p++) {
      const rows = [];
      for (const [name, act] of STEPS) {
        await settle(page);
        const s0 = await sprites(page), a = s0.draws, pf = s0.prefetch;
        await act();
        await sleep(700);            // the move window (MOVE_MS) and the frames after it
        const settled = await settle(page);
        const b = (await sprites(page)).draws, z = await zoomOf(page);
        const d = Object.fromEntries(Object.keys(b).map(k => [k, b[k] - (a[k] ?? 0)]));
        rows.push({ step: name, zoom: z, settled, prefetch: pf, ...d });
        log(`pass ${p} ${name.padEnd(12)} z=${z} frames ${d.frames} placeholder ${d.placeholder} (actors ${d.actorPlaceholder}) flat ${d.flat} soft ${d.soft} softGround ${d.softGround} failed ${d.failed}${settled ? '' : ' (NOT settled)'}`);
      }
      report.passes.push(rows);
    }
    await ctx.close();
  } finally {
    await browser.close();
    stopVite();
  }
  const warm = report.passes.at(-1);
  const bad = warm.filter(r => r.placeholder || r.flat);
  report.pass = bad.length === 0 && warm.every(r => r.settled);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  log(report.pass ? `PASS: warm pass drew 0 placeholders and 0 flat chunks (${OUT})` : `FAIL: ${bad.map(r => `${r.step}: ${r.placeholder} placeholder, ${r.flat} flat`).join('; ') || 'a step did not settle'} (${OUT})`);
  process.exit(report.pass ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(2); });
