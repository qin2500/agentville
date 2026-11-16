#!/usr/bin/env node
// Mean luminance of the classic (left) and engine (right) halves of side-by-side captures.
//   node tools/artpass/luminance.mjs <dir-with-sbs-<fixture>-classic.png/-engine.png> [fixture=busy]
// Needs the @playwright/test chromium (decodes the PNGs in a hidden headless page; no extra deps).
import fs from 'node:fs';
import path from 'node:path';
const [dir, fixture = 'busy'] = process.argv.slice(2);
if (!dir) throw new Error('usage: luminance.mjs <dir> [fixture]');
const { chromium } = await import('@playwright/test');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const out = {};
for (const k of ['classic', 'engine']) {
  const b64 = fs.readFileSync(path.join(dir, `sbs-${fixture}-${k}.png`)).toString('base64');
  out[k] = await page.evaluate(async src => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data; let s = 0, bright = 0, n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; s += y; if (y > 200) bright++; }
    return { mean: +(s / n).toFixed(2), brightFrac: +(bright / n).toFixed(4) };
  }, `data:image/png;base64,${b64}`);
}
await browser.close();
out.ratio = +(out.engine.mean / out.classic.mean).toFixed(3);
console.log(JSON.stringify(out));
