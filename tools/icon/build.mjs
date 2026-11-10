#!/usr/bin/env node
/**
 * Render the app icon (tools/icon/art.mjs) into every file that uses it:
 *
 *   desktop/icons/icon.icns              the desktop app's icon (electron-builder mac.icon)
 *   desktop/icons/icon-<size>.png        16 … 1024
 *   web/public/icon-16.png, icon-32.png  favicon and the mark next to the name in the top bar
 *
 *   node tools/icon/build.mjs            write them
 *   node tools/icon/build.mjs --check    exit 1 when a committed file differs from a fresh render
 *
 * Sizes from 64 up are the 1024 px picture shrunk; 16 and 32 use the hand-tuned 16×16 picture.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Img, roundRectCoverage, shadow, encodeICNS } from './raster.mjs'
import { big, small } from './art.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The 1024 px macOS icon: the picture in a rounded tile (824 px, radius 185) over a soft shadow. */
export function renderBig() {
  const S = 1024, tile = roundRectCoverage(100, 100, 824, 824, 185)
  const img = new Img(S, S)
  img.over(shadow(S, S, tile, { dy: 12, blur: 10, alpha: 0.35 }))
  const body = new Img(S, S)
  body.grid(big(), 0, 0, 16, tile)
  img.over(body)
  return img
}
/** The 16×16 picture, full bleed in a rounded square, at `scale` px a cell (corners antialiased). */
export function renderSmall(scale) {
  const f = 16, S = 16 * f, tile = roundRectCoverage(0, 0, S, S, 3.2 * f)
  const img = new Img(S, S)
  img.grid(small(), 0, 0, f, tile)
  return img.shrink(f / scale)
}

export function renderAll() {
  const b = renderBig()
  const png = { 16: renderSmall(1).png(), 32: renderSmall(2).png(), 1024: b.png() }
  for (const s of [64, 128, 256, 512]) png[s] = b.shrink(1024 / s).png()
  const files = {}
  for (const [s, buf] of Object.entries(png)) files[`desktop/icons/icon-${s}.png`] = buf
  files['desktop/icons/icon.icns'] = encodeICNS(png)
  files['web/public/icon-16.png'] = png[16]
  files['web/public/icon-32.png'] = png[32]
  return files
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check')
  let stale = 0
  for (const [rel, buf] of Object.entries(renderAll())) {
    const file = path.join(ROOT, rel)
    if (check) {
      const same = fs.existsSync(file) && fs.readFileSync(file).equals(buf)
      if (!same) { stale++; console.log(`out of date: ${rel}`) }
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, buf)
      console.log(`wrote ${rel} (${buf.length} bytes)`)
    }
  }
  if (check && stale) { console.log('Run node tools/icon/build.mjs to redraw them.'); process.exit(1) }
}
