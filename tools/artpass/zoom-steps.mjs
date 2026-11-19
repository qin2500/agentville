#!/usr/bin/env node
// Zoom-step capture (engine v2): the same view centre shot at every zoom step, near to far, in a hidden headless
// Chromium (never a visible window, never focus). Talks to the art-pass vite dev server
// (node_modules/.bin/vite -c tools/artpass/vite.config.mjs, ARTPASS_PORT) and its dev mock API, so it never touches real
// sessions, ~/.claude, ~/.codex, ~/.config or the network.
//
//   node tools/artpass/zoom-steps.mjs [--fixture busy] [--layout e2e/fixtures/engine/stress-nested.layout.json]
//        [--zooms 2,1,0.5,0.25,0.125] [--dpr 2] [--vw 1440 --vh 900] [--only <village>] [--night] [--out /tmp/zoomsteps]
//        [--tag before] [--gpu] [--centre grid] [--timeout ms]
//   Output <out>/<tag>/z<zoom>.png, plus index.json (camera, renderer stats per shot).
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
const flag = k => args.includes(`--${k}`);
const PORT = process.env.ARTPASS_PORT || 5391, BASE = `http://127.0.0.1:${PORT}/`;
const out = path.join(opt('out', '/tmp/zoomsteps'), opt('tag', 'shot'));
const VW = +opt('vw', 1440), VH = +opt('vh', 900), DPR = +opt('dpr', 2);
const ZOOMS = String(opt('zooms', '2,1,0.5,0.25,0.125')).split(',').map(Number);
const layout = opt('layout') ? JSON.parse(fs.readFileSync(path.resolve(ROOT, opt('layout')), 'utf8')) : null;
fs.mkdirSync(out, { recursive: true });

const FIXED_NOW = Number(process.env.ARTPASS_NOW) || Date.UTC(2026, 0, 15, 12, 0, 0);
// --gpu: the new headless mode with ANGLE Metal (still no window), as the perf harness runs (tools/perf/engine-perf.mjs)
const browser = await chromium.launch(flag('gpu')
  ? { headless: true, channel: 'chromium', args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] }
  : { headless: true });
const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: DPR, reducedMotion: 'reduce' });
await ctx.clock.setFixedTime(FIXED_NOW);
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
page.on('pageerror', e => console.error('pageerror:', e.message));
page.on('console', m => { if (m.type() === 'error' || (m.type() === 'warning' && /canvas|memory|context/i.test(m.text()))) console.error('console:', m.type(), m.text().slice(0, 200)); });

const q = ['mock', 'engine=2', 'debug', flag('night') ? 'night=1' : 'night=0', 't=120', `fixture=${opt('fixture', 'busy')}`];
if (layout) q.push(`seed=${layout.seed}`);
await page.goto(`${BASE}?${q.join('&')}`);
await page.waitForFunction(() => document.getElementById('cv')?.dataset.engine === 'ready' && window.villageDebug?.().engine === 2, null, { timeout: 60000 });
await page.evaluate(() => { const s = document.createElement('style'); s.textContent = '#labels, .zenpill, .zoom, #quiet-note { display: none !important; }'; document.head.append(s); });
const frames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80)))));
await frames();
const dbg = await page.evaluate(() => window.villageDebug());
const vs = [...dbg.villages].sort((a, b) => b.tier - a.tier || b.block.w * b.block.h - a.block.w * a.block.h);
const v = opt('only') ? dbg.villages.find(x => x.name === opt('only')) : vs[0];
const centre = opt('centre') === 'grid' ? { x: dbg.grid.ox + dbg.grid.w / 2, y: dbg.grid.oy + dbg.grid.h / 2 } : { x: v.block.x + v.block.w / 2, y: v.block.y + v.block.h / 2 };
const shots = [];
for (const z of ZOOMS) {
  const t0 = Date.now(), prof = flag('profile') && z === ZOOMS.at(-1) ? await page.context().newCDPSession(page) : null;
  if (prof) { await prof.send('Profiler.enable'); await prof.send('Profiler.start'); }
  await page.evaluate(c => window.villageSetCamera({ v: 2, ...c }), { ...centre, z });
  await frames();
  await page.waitForFunction(() => { const s = window.villageDebug?.().sprites; return !s || (s.artReady && !s.pending && !s.queued && !s.groundPending); }, null, { timeout: +opt('timeout', 45000), polling: 100 })
    .catch(() => console.error(`warn: still pending at z ${z} (shooting anyway)`));
  const settleMs = Date.now() - t0;
  if (prof) {   // --profile: self time by function over the last step's fill (top 25)
    const { profile: pr } = await prof.send('Profiler.stop'), self = new Map(), dt = pr.timeDeltas || [];
    const byId = new Map(pr.nodes.map(n => [n.id, n]));
    (pr.samples || []).forEach((id, i) => { const n = byId.get(id), k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + (dt[i] || 0) / 1000); });
    console.log([...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, ms]) => `${Math.round(ms)} ms  ${k}`).join('\n'));
  }
  await frames(); await frames();
  const file = `z${z}.png`;
  await page.screenshot({ path: path.join(out, file) });
  const s = await page.evaluate(() => { const d = window.villageDebug(); const s = d.sprites || {}; return { way: s.way, bytes: s.bytes, entries: s.entries, rasterN: s.rasterN, rasterMs: s.rasterMs, groundPending: s.groundPending, mapTiles: s.mapTiles ?? null, mapBake: s.mapBake ?? null }; });
  s.settleMs = settleMs;
  shots.push({ file, cam: { ...centre, z }, ...s });
  console.log(`z ${z}: ${file} ${JSON.stringify(s)}`);
}
// --steady S: after the last step settles, the steady frames (villagePerf) and self time by function over S seconds
if (opt('steady')) {
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => window.villagePerf?.reset?.());
  await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
  await new Promise(r => setTimeout(r, +opt('steady') * 1000));
  const { profile: pr } = await cdp.send('Profiler.stop'), self = new Map(), dt = pr.timeDeltas || [];
  const byId = new Map(pr.nodes.map(n => [n.id, n]));
  (pr.samples || []).forEach((id, i) => { const n = byId.get(id), k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop().replace(/\?.*$/, '')}:${n.callFrame.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + (dt[i] || 0) / 1000); });
  const d = await page.evaluate(() => { const d = window.villageDebug(); return { frames: d.perf?.frames, phase: d.perf?.phase, onScreen: d.perf?.onScreen, way: d.sprites?.way }; });
  console.log('steady', JSON.stringify(d));
  console.log([...self].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, ms]) => `${Math.round(ms)} ms  ${k}`).join('\n'));
}
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ q, village: v?.name, viewport: [VW, VH], dpr: DPR, shots }, null, 1));
await browser.close();
