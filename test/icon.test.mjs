// The app icon is drawn in code (tools/icon): the committed files must be exactly what it draws.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderAll } from '../tools/icon/build.mjs'
import { ICNS_SLOTS } from '../tools/icon/raster.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = renderAll()

test('committed icon files match a fresh render (run node tools/icon/build.mjs after changing the art)', () => {
  for (const [rel, buf] of Object.entries(files)) {
    assert.ok(fs.readFileSync(path.join(ROOT, rel)).equals(buf), `${rel} is out of date`)
  }
})

test('every PNG is the size its name says, and the icns holds each slot', () => {
  for (const [rel, buf] of Object.entries(files)) {
    if (!rel.endsWith('.png')) continue
    const size = Number(rel.match(/-(\d+)\.png$/)[1])
    assert.equal(buf.toString('ascii', 1, 4), 'PNG')
    assert.deepEqual([buf.readUInt32BE(16), buf.readUInt32BE(20)], [size, size], rel)
  }
  const icns = files['desktop/icons/icon.icns']
  assert.equal(icns.toString('ascii', 0, 4), 'icns')
  assert.equal(icns.readUInt32BE(4), icns.length)
  const seen = []
  for (let p = 8; p < icns.length; p += icns.readUInt32BE(p + 4)) {
    const type = icns.toString('ascii', p, p + 4), png = icns.subarray(p + 8, p + icns.readUInt32BE(p + 4))
    const size = ICNS_SLOTS.find(([t]) => t === type)[1]
    assert.equal(png.readUInt32BE(16), size, type)
    seen.push(type)
  }
  assert.deepEqual(seen, ICNS_SLOTS.map(([t]) => t))
})

test('the page uses the icon for its favicon and the mark beside the name', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8')
  assert.match(html, /<link rel="icon" id="favicon" type="image\/png" sizes="32x32" href="\/icon-32.png">/)
  assert.match(html, /<h1 class="brand"><img class="mark" src="\/icon-16.png" srcset="\/icon-16.png 1x, \/icon-32.png 2x"/)
})
