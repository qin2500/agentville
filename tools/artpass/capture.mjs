#!/usr/bin/env node
// Art-pass capture harness: screenshots the village up close, tile by tile, in a hidden headless
// Chromium (never a visible window). It talks to a vite dev server started with
//   node_modules/.bin/vite -c tools/artpass/vite.config.mjs
// and uses the dev mock API (?mock), so it never touches real sessions, ~/.claude, or the network.
//
//   node tools/artpass/capture.mjs --q 'mock&citydemo=1' --tag demo --zoom 3 [--night] [--anim]
//        [--only Town] [--region x0,y0,x1,y1 (view px)] [--dock] [--labels] [--bubbles] [--out /tmp/artpass]
//        [--frames N --every ms]   (with --anim: N shots of the region's centre, a time-lapse)
//   node tools/artpass/capture.mjs --sheet [--night]        the sprite sheet page (?artsheet)
//
// Output: <out>/<tag>/overview.png (zoom 1, whole town) and r<row>c<col>.png tiles at --zoom, plus
// index.json (each tile's view-px rect, and each settlement's rect).
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
const flag = k => args.includes(`--${k}`);
const PORT = process.env.ARTPASS_PORT || 5391, BASE = `http://127.0.0.1:${PORT}/`;
const out = path.join(opt('out', '/tmp/artpass'), opt('tag', 'shot'));
const zoom = +opt('zoom', 3), VW = +opt('vw', 1536), VH = +opt('vh', 1020);
const T = 16, ISO = 0.8, isoP = (x, y) => [(x - y) * ISO, (x + y) * ISO / 2];
const box = ([x0, y0, x1, y1]) => {
  const cs = [isoP(x0 * T, y0 * T), isoP((x1 + 1) * T, y0 * T), isoP(x0 * T, (y1 + 1) * T), isoP((x1 + 1) * T, (y1 + 1) * T)];
  return [Math.min(...cs.map(c => c[0])), Math.min(...cs.map(c => c[1])), Math.max(...cs.map(c => c[0])), Math.max(...cs.map(c => c[1]))];
};

fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1, reducedMotion: flag('anim') ? 'no-preference' : 'reduce' });
const page = await ctx.newPage();
page.on('pageerror', e => console.error('pageerror:', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('console:', m.text()); });

if (flag('sheet')) {
  await page.goto(`${BASE}?mock&artsheet=1${flag('night') ? '&night=1' : ''}${opt('q') ? `&${opt('q')}` : ''}`);
  await page.waitForFunction(() => window.artSheetReady === true, null, { timeout: 60000 });
  const n = await page.evaluate(() => window.artSheetPages.length);
  for (let i = 0; i < n; i++) {
    const data = await page.evaluate(i => window.artSheetPages[i].canvas.toDataURL('image/png'), i);
    const name = await page.evaluate(i => window.artSheetPages[i].name, i);
    fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(data.split(',')[1], 'base64'));
  }
  console.log(`${n} sheet pages → ${out}`);
  await browser.close();
  process.exit(0);
}

const q = `${opt('q', 'mock&citydemo=1')}&debug${flag('night') ? '&night=1' : '&night=0'}`;
await page.addInitScript(bubbles => { try { localStorage.setItem('va.cam.iso', JSON.stringify({ x: 0, y: 0, z: 1 })); if (!bubbles) localStorage.setItem('va.bubbles', '0'); } catch { /* fine */ } }, flag('bubbles'));
await page.goto(`${BASE}?${q}`);
await page.waitForFunction(() => document.getElementById('cv')?.dataset.art === 'ready' && window.villageDebug?.().villages?.length > 0, null, { timeout: 60000 });
await page.evaluate(labels => {
  document.body.classList.add('village-only');
  if (!labels) { const s = document.createElement('style'); s.textContent = '#labels, .zenpill, .zoom, #quiet-note { display: none !important; }'; document.head.append(s); }
}, flag('labels'));
const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))));
await settle();
const dbg = await page.evaluate(() => { const d = window.villageDebug(); return { town: d.town, dock: d.dock?.rect, villages: d.villages, square: d.square }; });

// What to cover: the whole town (and harbour), one settlement (--only), or an explicit view-px region.
let region;
if (opt('region')) region = opt('region').split(',').map(Number);
else if (opt('only')) {
  const v = dbg.villages.find(v => v.name === opt('only'));
  if (!v) throw new Error(`no settlement ${opt('only')}: ${dbg.villages.map(v => v.name)}`);
  region = box([v.block.x - 2, v.block.y - 2, v.block.x + v.block.w + 1, v.block.y + v.block.h + 1]);
} else if (flag('dock') && dbg.dock) region = box(dbg.dock);
else {
  let t = dbg.town;
  if (dbg.dock) t = [Math.min(t[0], dbg.dock[0]), Math.min(t[1], dbg.dock[1]), Math.max(t[2], dbg.dock[2]), Math.max(t[3], dbg.dock[3])];
  region = box(t);
}
region = [region[0] - 24, region[1] - 60, region[2] + 24, region[3] + 24];

const shot = async (name, cam) => {
  await page.evaluate(c => window.villageSetCamera(c), cam);
  await settle();
  const got = await page.evaluate(() => window.villageDebug().view);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  return [got.vx, got.vy, got.vx + got.bw, got.vy + got.bh];
};
const index = { q, zoom, region, villages: dbg.villages.map(v => ({ name: v.name, tier: v.tier, rect: box([v.block.x, v.block.y, v.block.x + v.block.w - 1, v.block.y + v.block.h - 1]) })), tiles: {} };
// --frames N [--every ms] with --anim: a time-lapse of one view (the region's centre), for walkers.
if (opt('frames')) {
  const cam = { x: (region[0] + region[2]) / 2, y: (region[1] + region[3]) / 2 + 18, z: zoom };
  for (let i = 0; i < +opt('frames'); i++) { index.tiles[`f${i}`] = await shot(`f${String(i).padStart(2, '0')}`, cam); await page.waitForTimeout(+opt('every', 1500)); }
  fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index, null, 1));
  console.log(`${opt('frames')} frames at ${zoom}x → ${out}`);
  await browser.close();
  process.exit(0);
}
if (!flag('no-overview')) index.tiles.overview = await shot('overview', { x: (region[0] + region[2]) / 2, y: (region[1] + region[3]) / 2, z: 1 });
const tw = VW / zoom, th = VH / zoom, ov = 24; // tiles overlap a little so nothing is cut at a seam
const cols = Math.max(1, Math.ceil((region[2] - region[0] - ov) / (tw - ov))), rows = Math.max(1, Math.ceil((region[3] - region[1] - ov) / (th - ov)));
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
  const x = region[0] + c * (tw - ov) + tw / 2, y = region[1] + r * (th - ov) + th / 2;
  index.tiles[`r${r}c${c}`] = await shot(`r${r}c${c}`, { x, y, z: zoom });
}
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index, null, 1));
console.log(`${rows}x${cols} tiles at ${zoom}x → ${out}`);
await browser.close();
