/**
 * The app icon, drawn in code: a cozy isometric cottage on a floating grass island at dusk, with a
 * crowned agent villager out front saying ♥. Two hand-tuned versions of the same picture:
 *
 *   big()   64×64 cells, drawn at 16 px a cell into a 1024 px macOS tile (and shrunk for 64…512)
 *   small() 16×16 cells for 16 and 32 px (favicon, header mark, the icon's smallest slots)
 *
 * Every shape is a polygon or a char-map sprite on an integer grid, so the output is reproducible.
 */
import { Grid } from './raster.mjs'

export const OUT = '#1f1a2e' // outline: a deep violet rather than black, as in the village art

const SKY = ['#1d2147', '#2a2a5a', '#3e3570', '#5e4479', '#8a527f', '#b8607a']
const ROOF = { hi: '#f2a65e', lit: '#e07a4f', mid: '#c4553e', dk: '#8e3540', deep: '#5e2440' }
const WALL = { L: '#f3e2bd', R: '#d6a77e', beam: '#6b4428', beamD: '#4a2f2a' }
const GLOW = { a: '#ffe08a', b: '#f2a13b' }
const GRASS = { hi: '#9fcf5a', mid: '#78b44a', lo: '#4f8f3e' }
const DIRT = { L: '#9a6a3e', Lk: '#7a4f30', R: '#6b4428', Rk: '#4a2f2a' }
const VILLAGER = { Y: '#f6c445', y: '#c98a2a', W: '#fff1a8', R: '#ff7262', h: '#5a3a2a', k: '#f6c7a0', c: '#ec8f80', o: OUT, S: '#4f7ec9', s: '#36589a', p: '#3a3048', b: '#2a2236', K: '#f6c7a0' }
const MOON = '#ffe9a8', STAR = '#f4efe4', STAR2 = '#c9c2e6'

/** World (x, y, z) → grid point; x runs down-right, y down-left, z up. */
const isoAt = (ox, oy) => (x, y, z = 0) => [ox + (x - y), oy + (x + y) / 2 - z]

function sky(g, stops) {
  for (let y = 0; y < g.h; y++) {
    const n = Math.min(stops.length - 1, Math.floor((y / g.h) * stops.length))
    for (let x = 0; x < g.w; x++) g.set(x, y, stops[n])
  }
}

function shingles(sx, sy, eave) {
  // Rows of 3 cells parallel to the eave, with staggered tabs every 4 cells.
  const v = Math.round(eave(sx) - sy - 0.5)
  const row = Math.floor(v / 3), r = v - row * 3
  const sep = (((sx + (row % 2) * 2) % 4) + 4) % 4 === 0
  if (r === 0) return ROOF.dk
  if (sep) return r === 1 ? ROOF.dk : ROOF.mid
  return r === 2 ? ROOF.hi : ROOF.lit
}

function cottage(iso, { x0, x1, y0, y1, h, rise, ov = 1 }) {
  const g = new Grid(64, 64), ym = (y0 + y1) / 2, zr = h + rise
  const P = (pts) => pts.map((p) => iso(...p))
  const faceY = (y, xa, xb, za, zb, col) => g.poly(P([[xa, y, za], [xb, y, za], [xb, y, zb], [xa, y, zb]]), col)
  const faceX = (x, ya, yb, za, zb, col) => g.poly(P([[x, ya, za], [x, yb, za], [x, yb, zb], [x, ya, zb]]), col)
  // chimney on the far end of the back slope; the roof hides its foot
  const cx = x0 + 2, cy = y0 + 1.5, top = zr + 2.5
  faceY(cy + 2, cx, cx + 2, h, top, '#b05a4a')
  faceX(cx + 2, cy, cy + 2, h, top, '#7a3a40')
  g.poly(P([[cx, cy, top], [cx + 2, cy, top], [cx + 2, cy + 2, top], [cx, cy + 2, top]]), '#3a2a36')
  // back slope: only its edge shows, past the gable
  const drop = (ov * rise) / (ym - y0)
  g.poly(P([[x0 - ov, y0 - ov, h - drop], [x1 + ov, y0 - ov, h - drop], [x1 + ov, ym, zr], [x0 - ov, ym, zr]]), ROOF.deep)
  // walls: the long face (lit) and the gable end (shade)
  faceY(y1, x0, x1, 0, h, WALL.L)
  g.poly(P([[x1, y0, 0], [x1, y1, 0], [x1, y1, h], [x1, ym, zr], [x1, y0, h]]), WALL.R)
  // half-timbering
  faceY(y1, x0, x0 + 1, 0, h, WALL.beam)
  faceY(y1, x1 - 1, x1, 0, h, WALL.beam)
  faceY(y1, x0, x1, h - 1, h, WALL.beam)
  faceX(x1, y1 - 1, y1, 0, h, WALL.beamD)
  faceX(x1, y0, y0 + 1, 0, h, WALL.beamD)
  faceX(x1, y0, y1, h - 1, h, WALL.beamD)
  // stone footing
  faceY(y1, x0, x1, 0, 2, (x, y) => ((x + 2 * y) % 5 === 0 ? '#7d6f74' : '#a39490'))
  faceX(x1, y0, y1, 0, 2, (x, y) => ((x - 2 * y) % 5 === 0 ? '#5d5262' : '#7f7078'))
  // door with a brass knob
  const dx = x0 + 2.5
  faceY(y1, dx - 0.6, dx + 3.6, 1.4, 8.6, '#4a2f2a')
  faceY(y1, dx, dx + 3, 1.6, 8, '#8a5236')
  faceY(y1, dx + 1.4, dx + 1.9, 1.6, 8, '#6e3f2c')
  g.set(...iso(dx + 2.6, y1, 4.4).map(Math.floor), GLOW.a)
  // lit windows with a sill, on the long face and the gable
  faceY(y1, x0 + 8.4, x0 + 13.6, 3.4, 8.6, '#4a2f2a')
  faceY(y1, x0 + 9, x0 + 13, 4, 8, GLOW.b)
  faceY(y1, x0 + 9, x0 + 11, 6, 8, GLOW.a)
  faceY(y1, x0 + 8, x0 + 14, 2.6, 3.4, '#6b4428')
  faceX(x1, ym - 2.6, ym + 2.6, 3.4, 8.6, '#3a2430')
  faceX(x1, ym - 2, ym + 2, 4, 8, GLOW.b)
  faceX(x1, ym - 2, ym, 6, 8, GLOW.a)
  faceX(x1, ym - 0.8, ym + 0.8, h + 1.5, h + 3.3, '#3a2430') // attic vent
  // front slope, shingled, over a dark fascia, with a ridge cap
  const a = iso(x0 - ov, y1 + ov, h - drop), b = iso(x1 + ov, y1 + ov, h - drop)
  const eave = (sx) => a[1] + ((sx - a[0]) * (b[1] - a[1])) / (b[0] - a[0])
  g.poly([[a[0], a[1] + 1], [b[0], b[1] + 1], b, a], ROOF.deep)
  g.poly([a, b, iso(x1 + ov, ym, zr), iso(x0 - ov, ym, zr)], (x, y) => shingles(x, y, eave))
  g.poly([iso(x0 - ov, ym, zr - 0.2), iso(x1 + ov, ym, zr - 0.2), iso(x1 + ov, ym, zr + 0.9), iso(x0 - ov, ym, zr + 0.9)], ROOF.dk)
  return g.outline(OUT)
}

function island(iso, xa, ya, xb, yb, depth) {
  const g = new Grid(64, 64)
  const P = (pts) => pts.map((p) => iso(...p))
  g.poly(P([[xa, yb, 0], [xb, yb, 0], [xb, yb, -depth], [xa, yb, -depth]]), (x, y) => (y % 3 === 0 && x % 4 === 1 ? DIRT.Lk : DIRT.L))
  g.poly(P([[xb, ya, 0], [xb, yb, 0], [xb, yb, -depth], [xb, ya, -depth]]), (x, y) => (y % 3 === 1 && x % 4 === 2 ? DIRT.Rk : DIRT.R))
  g.poly(P([[xa, ya, 0], [xb, ya, 0], [xb, yb, 0], [xa, yb, 0]]), (x, y) => {
    const k = (x * 7 + y * 13) % 11
    return k === 0 ? GRASS.hi : k === 3 ? GRASS.lo : GRASS.mid
  })
  return g
}

function king(x, y) {
  const g = new Grid(64, 64)
  g.sprite(x, y, [
    '..Y.Y.Y..',
    '..YWYWY..',
    '..yyRyy..',
    '.hhhhhhh.',
    'hhkkkkkhh',
    'hkkokokkh',
    '.kckkkck.',
    '..kkkkk..',
    '.sSSSSSs.',
    'KsSSSSSsK',
    '.sSSSSSs.',
    '..ppppp..',
    '..pp.pp..',
    '..bb.bb..',
  ], VILLAGER)
  return g.outline(OUT)
}

function heartBubble(x, y) {
  const g = new Grid(64, 64)
  g.sprite(x, y, [
    '.eeeeeeeee.',
    'eeeeeeeeeee',
    'eeeeeeeeeee',
    'eeeeeeeeeee',
    'eeeeeeeeeee',
    '.eeeeeeeee.',
    '..ee.......',
    '.e.........',
  ], { e: '#f8f3e6' })
  g.sprite(x + 3, y + 1, ['RR.RR', 'RRRRR', '.RRR.', '..R..'], { R: '#ff7262' })
  return g.outline(OUT)
}

/** The 64×64 picture for the 1024 px icon. */
export function big() {
  const g = new Grid(64, 64)
  sky(g, SKY)
  for (const [x, y, c] of [[22, 11, STAR2], [30, 8, STAR], [44, 12, STAR], [53, 28, STAR2], [11, 24, STAR2], [38, 16, STAR2], [16, 17, STAR]]) g.set(x, y, c)
  g.sprite(12, 9, ['.MMM.', 'MMM..', 'MM...', 'MMM..', '.MMM.'], { M: MOON })
  const iso = isoAt(29, 30)
  const ground = island(iso, -3, -4, 22, 17, 4)
  // a stone step at the door, flowers along the wall, a round bush
  ground.poly([iso(2.5, 9), iso(5.5, 9), iso(5.5, 13), iso(2.5, 13)], (x, y) => ((x + y) % 4 === 0 ? '#a89a8e' : '#c4b6a6'))
  for (const [wx, c] of [[7, '#ff8fb1'], [9, '#ffe08a'], [11, '#ff8fb1'], [13, '#c39bff'], [15, '#ffe08a']]) {
    const [px, py] = iso(wx, 11).map(Math.floor)
    ground.set(px, py, c); ground.set(px + 1, py + 1, GRASS.lo)
  }
  ground.outline(OUT)
  g.over(ground)
  g.over(cottage(iso, { x0: 0, x1: 16, y0: 0, y1: 9, h: 12, rise: 6 }))
  const bush = new Grid(64, 64)
  bush.sprite(13, 32, ['.ggg.', 'gHgHg', 'ggggg', '.ggg.'], { g: GRASS.lo, H: GRASS.hi })
  g.over(bush.outline(OUT))
  g.over(king(44, 29))
  g.over(heartBubble(46, 17))
  return g
}

/** The 16×16 picture for 16 and 32 px: the same cottage, crowned villager and night sky, flattened. */
export function small() {
  const g = new Grid(16, 16)
  sky(g, ['#1d2147', '#2a2a5a', '#3e3570', '#5e4479'])
  g.sprite(0, 0, [
    '................',
    '.*.........MM...',
    '...oooo.....MM..',
    '..orrrro...MM...',
    '.orrrrrro......*',
    'orrrrrrrro.YoYoY',
    'oddddddddo.YYYYY',
    '.oLLLLLRo..okkko',
    '.oLwwLDRo..oSSSo',
    '.oLwwLDRo..oSSSo',
    '.oLLLLDRo..opopo',
    'GGooooooooGGoGoG',
    'GgGGgGGGgGGgGGgG',
    'gGGgGGgGGgGGgGGg',
    'GGgGGGgGGGgGGgGG',
    'gggggggggggggggg',
  ], { o: OUT, r: ROOF.lit, d: ROOF.dk, L: WALL.L, R: WALL.R, w: GLOW.a, D: '#8a5236', G: GRASS.mid, g: GRASS.lo, Y: VILLAGER.Y, k: VILLAGER.k, S: VILLAGER.S, p: VILLAGER.p, M: MOON, '*': STAR })
  return g
}
