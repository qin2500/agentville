// Day and night lighting (design §3.3 layer 5, §3.7). Pure except for the injected canvas factory.
// A quarter-resolution lightmap: a night-tint veil with light pools erased (destination-out), multiplied onto the
// scene, then warm `lighter` pools on top. Positions are 1x world pixels (the renderer's gfx applies the camera).
import { toScreen } from '../core/coords.js';

export const MAX_POOLS = 160;
export const LIGHTMAP_SCALE = 4;
export const GLOW_FROM = 0.35;
export const POOL_LIFT = 0.62;   // how much of the night veil a light pool removes at its centre
const DEFAULT_LAMPS = { lamp: { r: 70, warm: 1, flicker: 0.15, dy: 30 }, lamppost: { r: 80, warm: 1, flicker: 0.15, dy: 36 },
  forge: { r: 90, warm: 1, flicker: 0.5, dy: 10 }, lighthouse: { r: 160, warm: 0.6, flicker: 0, dy: 60 } };

const clamp01 = v => Math.max(0, Math.min(1, v));
const lerp = (a, b, k) => a + (b - a) * k;
const smooth = (a, b, x) => { const k = clamp01((x - a) / (b - a)); return k * k * (3 - 2 * k); };

/** Night amount 0..1 from a day phase 0..1 (0 = midnight): dusk ramps 18:00-20:00, dawn 05:00-07:00. */
export function nightOf(t) {
  const h = (((t % 1) + 1) % 1) * 24;
  if (h >= 20 || h < 5) return 1;
  if (h >= 18) return smooth(18, 20, h);
  if (h >= 5 && h < 7) return 1 - smooth(5, 7, h);
  return 0;
}
/** Dusk warmth 0..1: peaks while the evening ramp is under way (18:00-20:00) and at dawn. */
export function duskOf(t) {
  const h = (((t % 1) + 1) % 1) * 24;
  if (h >= 18 && h < 20) return Math.sin(((h - 18) / 2) * Math.PI);
  if (h >= 5 && h < 7) return Math.sin(((h - 5) / 2) * Math.PI) * 0.6;
  return 0;
}
/** Veil colour (multiply): white by day, orange-ish at dusk, deep blue at night. */
export function veilColor(night, dusk = 0) {
  const base = [255, 255, 255], deep = [52, 62, 112], warm = [255, 170, 110];
  const c = base.map((v, i) => lerp(v, deep[i], night));
  const w = clamp01(dusk) * (1 - Math.abs(night - 0.5) * 0.6);
  return `rgb(${c.map((v, i) => Math.round(lerp(v, warm[i] * (v / 255 * 0.6 + 0.4), w))).join(',')})`;
}

function defaultCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

/**
 * @param {{ world: object, createCanvas?: (w:number,h:number)=>any,
 *   lightsFor?: (obj:object)=>object|object[]|null,       // extra light data per object (mod field `light`)
 *   statusOf?: (agentId:string)=>string|undefined,        // home agent status; 'resting' lights the windows
 *   lampModels?: Record<string, {r,warm,flicker,dy}>, maxPools?: number }} opts
 */
export function createLighting({ world, createCanvas = defaultCanvas, lightsFor, statusOf, lampModels = DEFAULT_LAMPS, maxPools = MAX_POOLS } = {}) {
  let night = 0, dusk = 0, frame = 0, lastSig = null, lastKey = '';
  let map = null, glow = null, mctx = null, gctx = null;

  function lightFromSpec(o, spec, x, y, kind) {
    return { id: o.id, kind, x: x + (spec.dx || 0), y: y - (spec.dy || 0), r: spec.r ?? 60, warm: spec.warm ?? 1, flicker: spec.flicker ?? 0 };
  }
  function objectLights(o, out, windowsOf) {
    const cx = o.tx + (o.w || 1) / 2, cy = o.ty + (o.h || 1) / 2;
    const p = toScreen(cx, cy, 0);
    const own = lightsFor?.(o);
    if (own) for (const s of Array.isArray(own) ? own : [own]) out.push(lightFromSpec(o, s, p.sx, p.sy, 'object'));
    else if (lampModels[o.model]) out.push(lightFromSpec(o, lampModels[o.model], p.sx, p.sy, 'lamp'));
    if (o.kind === 'building') {
      if (statusOf?.(o.id) === 'resting') {
        // anchors are offsets from the footprint's north corner (the drawn sprite's pivot); else two guesses at the centre
        const ws = windowsOf?.(o), has = Array.isArray(ws) && ws.length;
        const pts = has ? ws : [{ x: -8, y: -(o.z || 24) / 2 }, { x: 8, y: -(o.z || 24) / 2 }];
        const b = has ? toScreen(o.tx, o.ty, 0) : p;
        pts.forEach((w, i) => out.push({ id: `${o.id}#w${i}`, kind: 'window', x: b.sx + (w.x || 0), y: b.sy + (w.y || 0), r: 26, warm: 1, flicker: 0.05 }));
      }
    }
  }

  const api = {
    /** Day phase 0..1 (0 = midnight, 0.5 = noon). */
    setTime(t) { night = nightOf(t); dusk = duskOf(t); },
    /** Override the night amount directly (?night=). */
    setNight(n) { night = clamp01(n); },
    night: () => night,
    /** All lights from world objects (+ lanterns carried by actors at night). */
    lights(objects, actors, windowsOf) {
      const out = [];
      for (const o of objects ?? world?.objects?.values?.() ?? []) objectLights(o, out, windowsOf);
      if (night > 0.4 && actors) for (const a of actors.values ? actors.values() : actors) {
        if (a.lantern || a.carry === 'lantern') {
          const p = toScreen(a.x, a.y, 0);
          out.push({ id: a.id, kind: 'lantern', x: p.sx, y: p.sy - 10, r: 34, warm: 1, flicker: 0.3 });
        }
      }
      return out;
    },
    /** Draw the veil and pools. view = { cssW, cssH, dpr }. Returns the number of pools drawn. */
    draw(gfx, cam, view, lightList) {
      if (night < 0.02) return 0;
      frame++;
      const z = cam.z || 1, cs = toScreen(cam.x, cam.y);
      const wx0 = cs.sx - view.cssW / 2 / z, wy0 = cs.sy - view.cssH / 2 / z, ww = view.cssW / z, wh = view.cssH / z;
      const lw = Math.max(1, Math.ceil(view.cssW / LIGHTMAP_SCALE)), lh = Math.max(1, Math.ceil(view.cssH / LIGHTMAP_SCALE));
      if (!map || map.width !== lw || map.height !== lh) {
        map = createCanvas(lw, lh); glow = createCanvas(lw, lh); mctx = map.getContext('2d'); gctx = glow.getContext('2d'); lastSig = null;
      }
      const all = lightList ?? api.lights();
      // pools: only those whose reach touches the view, nearest to the view centre first
      const vcx = wx0 + ww / 2, vcy = wy0 + wh / 2;
      const vis = [];
      for (const l of all) {
        if (l.x + l.r < wx0 || l.x - l.r > wx0 + ww || l.y + l.r < wy0 || l.y - l.r > wy0 + wh) continue;
        vis.push({ l, d: (l.x - vcx) ** 2 + (l.y - vcy) ** 2 });
      }
      vis.sort((a, b) => a.d - b.d || (a.l.id < b.l.id ? -1 : 1));
      const pools = vis.slice(0, maxPools).map(v => v.l);
      const sig = `${pools.map(l => `${l.id}@${l.x | 0},${l.y | 0}`).join('|')}#${cam.x},${cam.y},${z}#${view.cssW}x${view.cssH}#${night.toFixed(2)}`;
      if (sig !== lastSig || frame % 4 === 0) { rebuild(pools, wx0, wy0, z, lw, lh, view); lastSig = sig; }
      gfx.setComposite('multiply');
      gfx.image(map, 0, 0, lw, lh, wx0, wy0, ww, wh);
      if (night > GLOW_FROM) { gfx.setComposite('lighter'); gfx.image(glow, 0, 0, lw, lh, wx0, wy0, ww, wh, clamp01((night - GLOW_FROM) / (1 - GLOW_FROM))); }
      gfx.setComposite('source-over');
      return pools.length;
    },
  };

  function rebuild(pools, wx0, wy0, z, lw, lh, view) {
    const k = z / LIGHTMAP_SCALE, flick = frame / 4;
    mctx.globalCompositeOperation = 'source-over';
    mctx.clearRect?.(0, 0, lw, lh);
    mctx.fillStyle = veilColor(night, dusk);
    mctx.fillRect(0, 0, lw, lh);
    gctx.globalCompositeOperation = 'source-over';
    gctx.clearRect?.(0, 0, lw, lh);
    for (const l of pools) {
      const f = l.flicker ? 1 - l.flicker * (0.5 + 0.5 * Math.sin(flick * 1.7 + (hashId(l.id) % 97))) : 1;
      const x = (l.x - wx0) * k, y = (l.y - wy0) * k, r = l.r * k * (0.92 + 0.08 * f);
      mctx.globalCompositeOperation = 'destination-out';
      const g = mctx.createRadialGradient(x, y, 0, x, y, r);
      // a pool lifts the veil part way (classic: warm glows in a dark town); full erasure made rows of lamps merge
      // into daylight bands along the streets
      g.addColorStop(0, `rgba(0,0,0,${clamp01(POOL_LIFT * f)})`); g.addColorStop(0.45, `rgba(0,0,0,${POOL_LIFT * 0.45})`); g.addColorStop(1, 'rgba(0,0,0,0)');
      mctx.fillStyle = g; mctx.fillRect(x - r, y - r, r * 2, r * 2);
      gctx.globalCompositeOperation = 'lighter';
      const w = gctx.createRadialGradient(x, y, 0, x, y, r * 0.8);
      const a = 0.35 * f * (l.warm ?? 1);
      w.addColorStop(0, `rgba(255,190,110,${a})`); w.addColorStop(1, 'rgba(255,150,60,0)');
      gctx.fillStyle = w; gctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    mctx.globalCompositeOperation = 'source-over'; gctx.globalCompositeOperation = 'source-over';
  }
  return api;
}

function hashId(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
