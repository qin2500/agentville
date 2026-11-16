#!/usr/bin/env node
// Time-lapse capture for the M3 gate: N frames of one settlement, engine v2, hidden headless Chromium (never a visible window).
// Needs the art-pass vite server:  node_modules/.bin/vite -c tools/artpass/vite.config.mjs --port 5391
//   node tools/artpass/lapse.mjs --fixture busy [--citytier N] [--seed 7] [--seconds 30] [--fps 10] [--zoom 2]
//        [--only <village>] [--night] [--out /tmp/m3shots/lapse] [--tag name] [--vw 1536 --vh 1020] [--gifscale 0.5]
// Stepping: uses window.villageStep(1/fps) per frame when present (deterministic sim time). Otherwise it falls back to real-time waits of
// 1/fps between screenshots (stepping: "realtime" in index.json). Output <out>/<tag>/: f0000.png.., <tag>.gif, index.json.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { encodeGif } from './gif.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
const flag = k => args.includes(`--${k}`);
const PORT = process.env.ARTPASS_PORT || 5391, BASE = `http://127.0.0.1:${PORT}/`;
const fixture = opt('fixture', 'busy'), seed = opt('seed', '7'), seconds = +opt('seconds', 30), fps = +opt('fps', 10), zoom = +opt('zoom', 2);
const tag = opt('tag', `${fixture}${flag('night') ? '-night' : ''}`), out = path.join(opt('out', '/tmp/m3shots/lapse'), tag);
const VW = +opt('vw', 1536), VH = +opt('vh', 1020), gifScale = +opt('gifscale', 0.5);
if (![0.25, 0.5, 1, 2, 3, 4].includes(zoom)) throw new Error(`--zoom must be one of 0.25 0.5 1 2 3 4 (got ${opt('zoom')})`);
if (!(fps > 0) || !(seconds > 0)) throw new Error('--fps and --seconds must be positive');
const nFrames = Math.max(1, Math.round(seconds * fps));
fs.mkdirSync(out, { recursive: true });

const q = ['mock', 'engine=2', 'debug', `fixture=${encodeURIComponent(fixture)}`, 't=0', `seed=${encodeURIComponent(seed)}`];
if (opt('citytier') !== undefined) q.push(`citytier=${encodeURIComponent(opt('citytier'))}`);
if (flag('night')) q.push('night=1');
const query = q.join('&');

const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  await ctx.clock.setFixedTime(Number(process.env.ARTPASS_NOW) || Date.UTC(2026, 0, 15, 12, 0, 0));
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error('pageerror:', e.message));
  page.on('console', m => { if (m.type() === 'error') console.error('console:', m.text()); });
  await page.addInitScript(() => { try { localStorage.setItem('va.bubbles', '0'); } catch { /* fine */ } });
  await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => document.body.classList.add('village-only')));
  await page.goto(`${BASE}?${query}`);
  await page.waitForFunction(() => document.getElementById('cv')?.dataset.engine === 'ready' && window.villageDebug?.().engine === 2, null, { timeout: 60000 });
  await page.evaluate(() => {
    document.body.classList.add('village-only');
    const s = document.createElement('style'); s.textContent = '#labels, .zenpill, .zoom, #quiet-note { display: none !important; }'; document.head.append(s);
  });
  // art ready: sprite atlas baked and no chunk/sprite still streaming, so frame 0 has no grey placeholder boxes
  await page.waitForFunction(() => { const s = window.villageDebug?.().sprites; return !!s && !!s.artReady && !s.pending && !s.queued && !s.groundPending; }, null, { timeout: 120000, polling: 100 });
  const dbg = await page.evaluate(() => window.villageDebug());
  const v = opt('only') ? dbg.villages.find(x => x.name === opt('only')) : dbg.villages[0];
  if (!v) throw new Error(`no settlement ${opt('only') ?? '(any)'}: ${(dbg.villages || []).map(x => x.name)}`);
  const cam = { v: 2, x: v.block.x + v.block.w / 2, y: v.block.y + v.block.h / 2, z: zoom };
  await page.evaluate(c => window.villageSetCamera(c), cam);
  const stepped = await page.evaluate(() => typeof window.villageStep === 'function');
  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await settle();

  const gw = Math.max(1, Math.round(VW * gifScale)), gh = Math.max(1, Math.round(VH * gifScale)), frames = [], files = [];
  for (let i = 0; i < nFrames; i++) {
    if (i > 0) {
      if (stepped) await page.evaluate(s => window.villageStep(s), 1 / fps);
      else await page.waitForTimeout(1000 / fps);
    }
    await settle();
    const png = await page.screenshot();
    const file = `f${String(i).padStart(4, '0')}.png`;
    fs.writeFileSync(path.join(out, file), png);
    files.push(file);
    // decode in the page (no PNG decoder in node deps), downscaled to the gif size; ship RGBA back as base64
    const b64 = await page.evaluate(async ([data, w, h]) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const c = new OffscreenCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true });
      x.imageSmoothingQuality = 'high'; x.drawImage(bmp, 0, 0, w, h);
      const px = x.getImageData(0, 0, w, h).data; let s = '';
      for (let o = 0; o < px.length; o += 0x8000) s += String.fromCharCode.apply(null, px.subarray(o, o + 0x8000));
      return btoa(s);
    }, [png.toString('base64'), gw, gh]);
    frames.push({ rgba: new Uint8Array(Buffer.from(b64, 'base64')) });
  }
  const gifPath = path.join(out, `${tag}.gif`);
  fs.writeFileSync(gifPath, encodeGif({ width: gw, height: gh, frames, delay: Math.round(1000 / fps), loop: 0 }));
  const after = await page.evaluate(() => window.villageDebug());
  fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ query, fixture, seed, seconds, fps, zoom, frames: nFrames, viewport: [VW, VH], gif: path.basename(gifPath), gifSize: [gw, gh],
    stepping: stepped ? 'villageStep' : 'realtime (window.villageStep absent: frames are real-time waits of 1/fps, sim time is not deterministic)',
    village: v.name, camera: cam, files, debug: { engine: after.engine, lint: (after.lint || []).length, objects: after.objects } }, null, 1));
  console.log(`lapse: ${nFrames} frames (${stepped ? 'villageStep' : 'realtime fallback'}) → ${gifPath}`);
} finally { await browser.close(); }
