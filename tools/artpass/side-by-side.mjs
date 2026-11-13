#!/usr/bin/env node
// Side-by-side: the classic village and the ?engine=2 village for one frozen fixture, at the same
// camera, in a hidden headless Chromium (never a visible window). Needs the art-pass vite server:
//   node_modules/.bin/vite -c tools/artpass/vite.config.mjs        (default http://127.0.0.1:5391)
//
//   node tools/artpass/side-by-side.mjs --fixture busy [--zoom 1] [--night] [--size 1280x800] [--t 120]
//        [--out-dir /tmp] [--village <name>] [--base http://127.0.0.1:5391] [--dry-run]
//
// Output: <out-dir>/sbs-<fixture>-classic.png, -engine.png, -sbs.png (classic left, engine right).
//
// Camera: --zoom is the ENGINE zoom (one of 0.25 0.5 1 2 3 4, the engine's own steps). The classic
// projection is 0.8 of the engine's 32x16 tile, so classic zoom = engine zoom / 0.8 (same on-screen
// size). Centre: the middle of the same settlement's block on each side (the first village by
// default, or --village <name>); classic and engine plan their own layouts, so "same point" means
// "same settlement", not the same pixel of ground. Classic camera is in iso px: tile (tx,ty) is at
// ((tx-ty)*16*0.8, (tx+ty)*8*0.8); engine camera is in tiles { v: 2, x, y, z }.
// The classic page gets the fixture through a page.route on /api/** (no ?mock), so it never touches
// real sessions or the network. Prints only counts, never page text.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
const flag = k => args.includes(`--${k}`);
const fixture = opt('fixture', 'busy');
if (!/^[a-z0-9-]+$/.test(fixture)) throw new Error(`bad --fixture ${fixture}`);
const BASE = (opt('base') || `http://127.0.0.1:${process.env.ARTPASS_PORT || 5391}`).replace(/\/$/, '') + '/';
const outDir = opt('out-dir', '/tmp');
const ez = +opt('zoom', 1);
if (![0.25, 0.5, 1, 2, 3, 4].includes(ez)) throw new Error(`--zoom must be one of 0.25 0.5 1 2 3 4 (got ${opt('zoom')})`);
const cz = ez / 0.8;
const [VW, VH] = opt('size', '1280x800').split('x').map(Number);
if (!(VW > 0 && VH > 0)) throw new Error(`bad --size ${opt('size')}`);
const t = opt('t');
if (t !== undefined && !Number.isFinite(+t)) throw new Error(`bad --t ${t}`);
const night = flag('night') ? 1 : 0, village = opt('village');
const fixFile = path.resolve(new URL('../../e2e/fixtures/engine/', import.meta.url).pathname, `${fixture}.json`);
if (!fs.existsSync(fixFile)) throw new Error(`no fixture ${fixture} at ${fixFile}`);

const classicQ = `debug&night=${night}`;
const engineQ = ['mock', 'engine=2', 'debug', `night=${night}`, `fixture=${fixture}`, ...(t !== undefined ? [`t=${encodeURIComponent(t)}`] : [])].join('&');
const classicUrl = `${BASE}?${classicQ}`, engineUrl = `${BASE}?${engineQ}`;
const files = ['classic', 'engine', 'sbs'].map(k => path.join(outDir, `sbs-${fixture}-${k}.png`));

if (flag('dry-run')) {
  console.log(JSON.stringify({ classicUrl, engineUrl, viewport: [VW, VH], engineZoom: ez, classicZoom: cz,
    centre: village ? `block centre of village "${village}" on each side` : 'block centre of the first village on each side',
    classicCamera: '{ x: (bx-by+... iso px of block centre), y, z: ' + cz + ' }  via window.villageSetCamera',
    engineCamera: `{ v: 2, x: block centre tile x, y: block centre tile y, z: ${ez} }  via window.villageSetCamera`,
    classicData: `page.route('**/api/**') serving ${path.relative(process.cwd(), fixFile)} (agents/projects/dock)`, files }, null, 1));
  process.exit(0);
}

const { chromium } = await import('@playwright/test');
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = { classic: [], engine: [] };
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120)))));
const newPage = async which => {
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors[which].push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors[which].push(`console: ${m.text()}`.slice(0, 200)); });
  await page.addInitScript(() => { try { localStorage.setItem('va.bubbles', '0'); } catch { /* fine */ } });
  await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => document.body.classList.add('village-only')));
  return page;
};
const hide = page => page.evaluate(() => {
  document.body.classList.add('village-only');
  const s = document.createElement('style'); s.textContent = '#labels, .zenpill, .zoom, #quiet-note { display: none !important; }'; document.head.append(s);
});
const pickVillage = vs => (village ? vs.find(v => v.name === village) : vs[0]) || (() => { throw new Error(`no village ${village ?? '(any)'}: ${vs.map(v => v.name)}`); })();
const centre = v => ({ x: v.block.x + v.block.w / 2, y: v.block.y + v.block.h / 2 });

// ---- classic
const fx = JSON.parse(fs.readFileSync(fixFile, 'utf8'));
const apiBody = JSON.stringify({ agents: fx.agents, projects: fx.projects || [], dock: fx.dock, hideQuiet: false });
const cp = await newPage('classic');
await cp.addInitScript(() => { try { localStorage.setItem('va.cam.iso', JSON.stringify({ x: 0, y: 0, z: 1 })); } catch { /* fine */ } });
await cp.route('**/api/**', route => route.request().url().includes('/api/agents')
  ? route.fulfill({ status: 200, contentType: 'application/json', body: apiBody })
  : route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
await cp.goto(classicUrl);
await cp.waitForFunction(() => document.getElementById('cv')?.dataset.art === 'ready' && window.villageDebug?.().villages?.length > 0, null, { timeout: 60000 });
await hide(cp); await settle(cp);
const cd = await cp.evaluate(() => { const d = window.villageDebug(); return { villages: d.villages.map(v => ({ name: v.name, block: v.block })) }; });
const cv = pickVillage(cd.villages), cc = centre(cv), ISO = 0.8;
const ccam = { x: (cc.x - cc.y) * 16 * ISO, y: (cc.x + cc.y) * 8 * ISO, z: cz };
await cp.evaluate(c => window.villageSetCamera(c), ccam);
await settle(cp);
await cp.screenshot({ path: files[0] });
const cdbg = await cp.evaluate(() => { const d = window.villageDebug(); return { villages: d.villages.length, walkers: (d.walkers || []).length, hits: (d.hits || []).length }; });

// ---- engine
const ep = await newPage('engine');
await ep.goto(engineUrl);
await ep.waitForFunction(() => document.getElementById('cv')?.dataset.engine === 'ready' && window.villageDebug?.().engine === 2, null, { timeout: 60000 });
// sprites stream in over frames: wait until no placeholder is left (in the drawn chunks) and the cache queue is empty.
// The engine keeps drawing while sprites stream in, even with a pinned ?t. Wait again after the camera move: the new
// view can hold chunks the first one did not.
const spritesIn = (label, ms) => ep.waitForFunction(() => { const s = window.villageDebug?.().sprites; return !s || (s.artReady && s.pending === 0 && !s.queued); }, null, { timeout: ms, polling: 100 })
  .then(() => true, () => { console.error(`engine: sprites still pending ${label} after ${ms / 1000} s`); return false; });
const tSprites0 = Date.now();
await spritesIn('at the first camera', 90000);
await hide(ep); await settle(ep);
const ed = await ep.evaluate(() => window.villageDebug());
const ev = pickVillage(ed.villages), ec = centre(ev);
await ep.evaluate(c => window.villageSetCamera(c), { v: 2, x: ec.x, y: ec.y, z: ez });
await settle(ep);
await spritesIn('at the capture camera', 30000);
await settle(ep);
const spritesWaitMs = Date.now() - tSprites0;
await ep.screenshot({ path: files[1] });
const after = await ep.evaluate(() => window.villageDebug());

// ---- composite: both PNGs in a blank page, screenshotted
const b64 = f => fs.readFileSync(f).toString('base64');
const comp = await browser.newPage({ viewport: { width: VW * 2 + 12, height: VH + 28 } });
await comp.setContent(`<body style="margin:0;background:#111;color:#ddd;font:14px monospace">
<div style="display:flex;gap:12px"><div><div style="height:28px;line-height:28px;padding-left:6px">classic z${cz.toFixed(3)}</div><img src="data:image/png;base64,${b64(files[0])}"></div>
<div><div style="height:28px;line-height:28px;padding-left:6px">engine 2 z${ez} · ${fixture}</div><img src="data:image/png;base64,${b64(files[1])}"></div></div></body>`);
await comp.waitForFunction(() => [...document.images].every(i => i.complete && i.naturalWidth > 0));
await comp.screenshot({ path: files[2] });
await browser.close();

console.log(JSON.stringify({ files, classic: { village: cv.name, camera: ccam, ...cdbg, errors: errors.classic.length },
  engine: { village: ev.name, camera: { x: ec.x, y: ec.y, z: ez }, actors: after.actors, hits: after.hits, objects: after.objects, lint: (after.lint || []).length, error: after.error, errors: errors.engine.length,
    timing: after.timing ?? null, spritesWaitMs, sprites: after.sprites ? { entries: after.sprites.entries, keys: after.sprites.keys, rasterN: after.sprites.rasterN,
      rasterMs: after.sprites.rasterMs, failed: after.sprites.failed, bytes: after.sprites.bytes, evictions: after.sprites.evictions, pending: after.sprites.pending, queued: after.sprites.queued } : null } }, null, 1));
for (const w of ['classic', 'engine']) for (const e of errors[w].slice(0, 10)) console.error(`${w} ${e}`);
