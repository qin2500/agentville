// Ambient life ("something going on"): townsfolk strolling the streets, vendors at their stalls, a cart,
// chickens, pigeons, fountain sparkle, windmill sails, smithy glow and a V of birds now and then.
// Everything is a pure function of f.t (like world.js stroll): routes are precomputed in prepare(), and
// frame()/draw() reuse their drawable objects, so a busy frame allocates (almost) nothing.
//
// Seam (docs: va-city-spec.md): createAmbient({ IMG, actor }) -> { prepare, frame, draw, overlay, sky }.
//   actor(ctx, look, dir, row, x, y): draws the 16x16 frame (dir 0 down 1 up 2 left 3 right; row 0..3 walk
//   frames) of sheet IMG[look] with its top-left at view px (x, y), so the feet are at y + 16.
// World constants are copied here (not imported) so the module also runs in node tests.
const T = 16, ISO = 0.8;
const LOOKS = ['Villager2', 'Woman', 'OldMan', 'Villager4', 'Hunter', 'Princess', 'Villager3', 'Boy', 'Monk2', 'Villager5', 'OldMan3'];
const WALK = new Set([2, 3, 4, 5, 6, 13]); // STREET LANE PLAZA MARKET YARD BRIDGE
const YARD = 6, PASTURE = 11, STREET = 2;
const COUNT = [2, 5, 10, 18];
const CART = ['element', 0, 48, 32, 32]; // R.cart

// ---- small deterministic helpers ----
const fnv = s => { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const rng = seed => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const rnd = s => fnv(s) / 4294967296;
const isoX = (x, y) => (x - y) * ISO, isoY = (x, y) => (x + y) * ISO / 2;
const blockOf = v => { const b = v.block; return Array.isArray(b) ? [b[0], b[1]] : [b?.x ?? 0, b?.y ?? 0]; };
// Cumulative-length lookup: largest i with cum[i] <= u (cum ascending, cum[0] = 0).
function seg(cum, u) { let lo = 0, hi = cum.length - 2; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cum[m] <= u) lo = m; else hi = m - 1; } return lo; }
// Shared out-parameter for positions (no allocation per call).
const P = { x: 0, y: 0, dx: 0, dy: 0 };

// ---- townsfolk outfits (style.folk): palette-swapped clothing + hats --------------------------------------------
// Each actor sheet's body pixels (frame rows 11..15) are clustered into colour families (shade variants of one
// hue). The biggest family becomes the "shirt", the next the "trousers", the rest the "accent"; skin, hair and the
// ink outline are left alone (KEEP lists the skin/hair colours seen in each sheet). A recoloured pixel keeps its
// shading: the palette colour is scaled by pixel luminance / family luminance.
const BODY_Y = 11;
const KEEP = {
  Villager2: ['d14b34', '3b3643'], Woman: ['ef914f', 'd78b4a', 'f1c471'], OldMan: ['ef914f', 'f2ad7d', '4e484a'],
  Villager4: ['f1c471', 'ef914f', 'd78b4a'], Hunter: ['ef914f'], Princess: ['a3754e', 'd78b4a', '3b3643', '4e484a'],
  Villager3: ['a3754e', '965340', '3b3643', '4e484a'], Boy: ['ef914f', '965340'], Monk2: ['ef914f'],
  Villager5: ['c8966b', 'fce2ca'], OldMan3: ['ef914f', 'e3f1f5', '9ba7aa', 'f1c471', '4e484a'],
};
const INK = '#141b1b';
const hex3 = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const lum = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
function hue(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < 28) return -1; // neutral
  const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}
const shade = (c, k) => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v * k))).toString(16).padStart(2, '0')).join('');
// Hat pixel maps, 16 wide, from the top of the 16x16 frame. o ink, m main, s shade, h highlight, a accent, f feather.
// Facing 0 (down) and 1 (up) use F/B; facing 2 (left) uses S, facing 3 mirrors it.
const HATS = {
  cap: {
    F: ['.....oooooo.....', '....ommmmmmo....', '...ommmhmmmmo...', '..ommmmmmmmmmo..', '..osssssssssso..'],
    B: ['.....oooooo.....', '....ommmmmmo....', '...ommmhmmmmo...', '..ommmmmmmmmmo..', '..ommmmmmmmmmo..'],
    S: ['.....oooooo.....', '....ommmmmmo....', '...ommmhmmmmo...', '..ommmmmmmmmmo..', 'oosssssssso.....']
  },
  straw: {
    F: ['......oooo......', '.....ommhmo.....', '....ommmmmmo....', '..ooobbbbbbooo..', '.ommmmmmmmmmmmo.', '..oooooooooooo..'],
    S: ['......oooo......', '.....ommhmo.....', '....ommmmmmo....', '..ooobbbbbbooo..', '.ommmmmmmmmmmmo.', '..oooooooooooo..']
  },
  hood: {
    F: ['....oooooooo....', '...ommmmmmmmo...', '..ommmhmmmmmmo..', '..ommmmmmmmmmo..', '..omm......mmo..', '..omm......mmo..'],
    B: ['....oooooooo....', '...ommmmmmmmo...', '..ommmhmmmmmmo..', '..ommmmmmmmmmo..', '..ommmmmmmmmmo..', '..ommmmmmmmmmo..'],
    S: ['....oooooooo....', '...ommmmmmmmo...', '..ommmhmmmmmmo..', '..ommmmmmmmmmo..', '..o...mmmmmmo...', '......mmmmmo....']
  },
  feather: {
    F: ['..........fff...', '.....oooooofff..', '....ommmmmmofff.', '...ommmhmmmmo...', '..ommmmmmmmmmo..'],
    B: ['..........fff...', '.....oooooofff..', '....ommmmmmofff.', '...ommmhmmmmo...', '..ommmmmmmmmmo..'],
    S: ['..........fff...', '.....oooooofff..', '....ommmmmmofff.', '...ommmhmmmmo...', '..ommmmmmmmmmo..']
  },
  kerchief: {
    F: ['....oooooooo....', '...oaaaaaaaao...', '..oaaahaaaaaao..', '..oaaaaaahaaao..', '..oaaaaaaaaaao..'],
    B: ['....oooooooo....', '...oaaaaaaaao...', '..oaaahaaaaaao..', '..oaaaaaahaaao..', '..oaaaaaaaaaao..', '.....oaaao......'],
    S: ['....oooooooo....', '...oaaaaaaaao...', '..oaaahaaaaaao..', '..oaaaaaaaaaaoo.', '..oaaaaaaaaaaao.', '.......ooaaao...']
  },
};
const mirror = rows => rows.map(r => [...r].reverse().join(''));
function hatRows(hat, dir) {
  const H = HATS[hat]; if (!H) return null;
  if (dir === 2) return H.S;
  if (dir === 3) return mirror(H.S);
  return dir === 1 ? (H.B || H.F) : H.F;
}
const mk = (w, h) => {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null;
};

export function createAmbient({ IMG, actor }) {
  let vills = [];
  const looks = () => LOOKS.filter(l => IMG[l]);


  // ---- folk dressing: per-sheet clothing analysis (once), recoloured + hatted + rimmed frames (cached) ----
  const sheets = new Map(), dressed = new Map();
  function analyse(look) {
    if (sheets.has(look)) return sheets.get(look);
    let out = null;
    const im = IMG[look], c = im && mk(im.width, im.height);
    if (c) {
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
      const data = g.getImageData(0, 0, c.width, c.height).data, keep = new Set(KEEP[look] || []);
      const cnt = new Map(), W = c.width;
      for (let y = 0; y < c.height; y++) {
        if (y % 16 < BODY_Y || ((y / 16) | 0) > 3) continue;
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4; if (data[i + 3] < 200) continue;
          const r = data[i], gg = data[i + 1], b = data[i + 2], hx = ((r << 16) | (gg << 8) | b).toString(16).padStart(6, '0');
          if (keep.has(hx) || lum(r, gg, b) < 0.17) continue;
          cnt.set(hx, (cnt.get(hx) || 0) + 1);
        }
      }
      // families: same hue (within 25 degrees) or both neutral
      const fams = [];
      for (const [hx, n] of [...cnt].sort((a, b) => b[1] - a[1])) {
        const rgb = [parseInt(hx.slice(0, 2), 16), parseInt(hx.slice(2, 4), 16), parseInt(hx.slice(4, 6), 16)], h = hue(...rgb), L = lum(...rgb);
        let f = fams.find(f => (h < 0 && f.h < 0) || (h >= 0 && f.h >= 0 && Math.min(Math.abs(h - f.h), 360 - Math.abs(h - f.h)) < 25));
        if (!f) fams.push(f = { h, n: 0, lsum: 0, cols: [] });
        f.n += n; f.lsum += L * n; f.cols.push([hx, L]);
      }
      fams.sort((a, b) => b.n - a.n);
      out = new Map();
      fams.forEach((f, i) => { const ref = f.lsum / f.n, role = Math.min(i, 2); for (const [hx, L] of f.cols) out.set(hx, { role, k: Math.max(0.55, Math.min(1.4, L / (ref || 1))) }); });
    }
    sheets.set(look, out);
    return out;
  }
  // The 20x20 "sticker" for one dressed frame: ink outline + light rim like world.js rimmed(), around the
  // recoloured, hatted 16x16 frame.
  function dress(look, folk, dir, row) {
    const key = `${look}|${folk.id}|${dir}|${row}`;
    if (dressed.has(key)) return dressed.get(key);
    const an = analyse(look), im = IMG[look], f = mk(16, 16);
    let out = null;
    if (an && im && f) {
      const g = f.getContext('2d', { willReadFrequently: true });
      g.drawImage(im, dir * 16, row * 16, 16, 16, 0, 0, 16, 16);
      const id = g.getImageData(0, 0, 16, 16), d = id.data, pal = folk.rgb;
      for (let y = BODY_Y; y < 16; y++) for (let x = 0; x < 16; x++) {
        const i = (y * 16 + x) * 4; if (d[i + 3] < 200) continue;
        const e = an.get(((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]).toString(16).padStart(6, '0')); if (!e) continue;
        const p = pal[e.role];
        d[i] = Math.min(255, Math.round(p[0] * e.k)); d[i + 1] = Math.min(255, Math.round(p[1] * e.k)); d[i + 2] = Math.min(255, Math.round(p[2] * e.k));
      }
      g.putImageData(id, 0, 0);
      const rows = folk.hat !== 'none' && hatRows(folk.hat, dir);
      if (rows) {
        const m = pal[0], A = pal[2], hc = { o: INK, m: folk.hat === 'hood' ? shade(pal[0], 1) : folk.hat === 'straw' ? '#e0bd6c' : folk.hat === 'feather' ? shade(pal[1], 1) : shade(pal[2], 1), s: null, h: null, a: shade(pal[2], 1), b: shade(pal[2], 1), f: shade(pal[2], 1.15) };
        const base = hat => hat === 'hood' ? m : hat === 'straw' ? [224, 189, 108] : hat === 'feather' ? pal[1] : A;
        const bc = base(folk.hat); hc.s = shade(bc, 0.78); hc.h = shade(bc, 1.22);
        if (folk.hat === 'straw') hc.b = shade(pal[1], 1);
        if (folk.hat === 'feather') hc.f = shade(pal[2], 1.1);
        rows.forEach((r, y) => { for (let x = 0; x < 16; x++) { const ch = r[x]; if (ch === '.') continue; g.fillStyle = hc[ch] || INK; g.fillRect(x, y, 1, 1); } });
      }
      out = mk(20, 20);
      const o = out.getContext('2d'), sil = (color, pad) => {
        const c = mk(16 + pad * 2, 16 + pad * 2), cg = c.getContext('2d');
        for (let dy = -pad; dy <= pad; dy++) for (let dx = -pad; dx <= pad; dx++) if (Math.abs(dx) + Math.abs(dy) <= pad + (pad > 1 ? 1 : 0)) cg.drawImage(f, pad + dx, pad + dy);
        cg.globalCompositeOperation = 'source-in'; cg.fillStyle = color; cg.fillRect(0, 0, c.width, c.height); return c;
      };
      o.globalAlpha = 0.55; o.drawImage(sil('#fff4dc', 2), 0, 0); o.globalAlpha = 1;
      o.drawImage(sil('#140f1c', 1), 1, 1);
      o.drawImage(f, 2, 2);
    }
    dressed.set(key, out);
    return out;
  }
  // Pick a walker's outfit from a village style (undefined without v.style or without folk).
  function folkOf(v, h) {
    const fk = v?.style?.folk;
    if (!fk || !Array.isArray(fk.palettes) || !fk.palettes.length) return null;
    const pal = fk.palettes[h % fk.palettes.length];
    return { pal, hat: fk.hat || 'none', rgb: pal.map(hex3), id: `${pal.join('')}|${fk.hat || 'none'}` };
  }

  // ---- routes ----
  function makeRoute(plan, bx, by, r, steps, walkOK) {
    const { w, h } = plan, g = plan.ground;
    const ok = (x, y) => x >= 0 && y >= 0 && x < w && y < h && walkOK(g[y * w + x]);
    const tiles = [];
    for (let i = 0; i < w * h; i++) if (walkOK(g[i])) tiles.push(i);
    if (!tiles.length) return null;
    let cur = tiles[Math.floor(r() * tiles.length)], px = -1, py = -1, cx = cur % w, cy = (cur / w) | 0;
    const path = [[cx, cy]], D = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let s = 0; s < steps; s++) {
      const opts = [], wts = [];
      let tot = 0;
      for (const [dx, dy] of D) {
        const nx = cx + dx, ny = cy + dy;
        if (!ok(nx, ny) || (nx === px && ny === py)) continue;
        const code = g[ny * w + nx];
        const wt = (code === YARD ? 0.4 : 1) * (px >= 0 && nx - cx === cx - px && ny - cy === cy - py ? 3 : 1);
        opts.push([nx, ny]); wts.push(wt); tot += wt;
      }
      if (!opts.length) break; // dead end: the loop turns back here
      let k = r() * tot, i = 0;
      while (i < opts.length - 1 && k >= wts[i]) { k -= wts[i]; i++; }
      px = cx; py = cy; [cx, cy] = opts[i];
      path.push([cx, cy]);
    }
    // Out and back: a closed loop (the way home retraces the tiles).
    const loop = path.concat(path.slice(1, -1).reverse());
    if (loop.length < 2) return null;
    const n = loop.length + 1, xs = new Float32Array(n), ys = new Float32Array(n), cum = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const [tx, ty] = loop[i % loop.length];
      xs[i] = (bx + tx + 0.5) * T; ys[i] = (by + ty + 0.5) * T;
      if (i) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    }
    return { xs, ys, cum, total: cum[n - 1] };
  }
  // Position (and unit heading) along a route at distance u (wraps).
  function along(rt, u) {
    u = ((u % rt.total) + rt.total) % rt.total;
    const i = seg(rt.cum, u), l = rt.cum[i + 1] - rt.cum[i] || 1, k = (u - rt.cum[i]) / l;
    P.x = rt.xs[i] + (rt.xs[i + 1] - rt.xs[i]) * k; P.y = rt.ys[i] + (rt.ys[i + 1] - rt.ys[i]) * k;
    P.dx = (rt.xs[i + 1] - rt.xs[i]) / l; P.dy = (rt.ys[i + 1] - rt.ys[i]) / l;
  }
  const dirOf = (dx, dy) => Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 3 : 2) : (dy > 0 ? 0 : 1); // +x runs down-right on screen, +y down-left

  // ---- prepare ----
  function prepare(W) {
    vills = [];
    const LK = looks();
    (W?.villages || []).forEach((v, vi) => {
      const plan = v.plan;
      if (!plan || !plan.ground) return;
      const [bx, by] = blockOf(v), { w, h, ground: g } = plan, tier = Math.max(0, Math.min(3, v.tier ?? plan.tier ?? 0));
      const r = rng(fnv(`${v.name ?? vi}|${bx}|${by}|${tier}`));
      let nWalk = 0;
      for (let i = 0; i < g.length; i++) if (WALK.has(g[i])) nWalk++;
      // view-space bounding box of the plot (for culling)
      const xs = [isoX(bx * T, by * T), isoX((bx + w) * T, by * T), isoX(bx * T, (by + h) * T), isoX((bx + w) * T, (by + h) * T)];
      const ys = [isoY(bx * T, by * T), isoY((bx + w) * T, by * T), isoY(bx * T, (by + h) * T), isoY((bx + w) * T, (by + h) * T)];
      const V = { v, bx, by, tier, x0: Math.min(...xs) - 40, x1: Math.max(...xs) + 40, y0: Math.min(...ys) - 80, y1: Math.max(...ys) + 40,
        walkers: [], vendors: [], chickens: [], pigeons: [], fountains: [], cart: null, accent: v.accent };
      // Townsfolk
      const n = LK.length ? Math.min(COUNT[tier], Math.max(nWalk ? 1 : 0, Math.floor(nWalk / 6))) : 0;
      for (let i = 0; i < n; i++) {
        const rt = makeRoute(plan, bx, by, r, 20 + Math.floor(r() * 40), c => WALK.has(c));
        if (!rt) break;
        V.walkers.push({ rt, speed: 14 + r() * 6, phase: r() * rt.total, look: LK[Math.floor(r() * LK.length)], folk: folkOf(v, Math.floor(r() * 4096)), ox: (r() - 0.5) * 5, oy: (r() - 0.5) * 5, night: i < Math.max(1, Math.ceil(n * 0.2)), d: { amb: 1, kind: 'walker', x: 0, y: 0, dir: 0, row: 0, look: '', folk: null, lantern: false, i } });
      }
      // Vendors at stalls, fountains, pigeon spots
      for (const p of plan.props || []) {
        if (p.kind === 'stall' && LK.length) {
          const wx = (bx + p.x) * T, wy = (by + p.y) * T - 5, h0 = fnv(`${vi}|s${p.x}|${p.y}`);
          V.vendors.push({ wx, wy, look: LK[h0 % LK.length], folk: folkOf(v, (h0 >>> 7) % 4096), seed: h0 % 97, d: { amb: 1, kind: 'vendor', x: 0, y: 0, dir: 0, row: 0, look: '', folk: null } });
        } else if (p.kind === 'fountain') V.fountains.push({ wx: (bx + p.x) * T, wy: (by + p.y) * T, s: fnv(`${vi}|f${p.x}|${p.y}`) });
      }
      // Cart: the longest east-west street run, town and city.
      if (tier >= 2) {
        let best = null;
        for (let y = 0; y < h; y++) {
          let x = 0;
          while (x < w) {
            if (g[y * w + x] !== STREET) { x++; continue; }
            let e = x; while (e + 1 < w && g[y * w + e + 1] === STREET) e++;
            if (!best || e - x > best.e - best.x) best = { y, x, e };
            x = e + 1;
          }
        }
        if (best && best.e - best.x >= 3) V.cart = { x0: (bx + best.x + 1) * T, x1: (bx + best.e) * T, wy: (by + best.y + 0.62) * T, speed: 18, phase: r() * 100, d: { amb: 1, kind: 'cart', x: 0, y: 0, flip: false } };
      }
      // Chickens in hamlet / village yards and pastures
      if (tier <= 1 && IMG.chicken) {
        const yt = [];
        for (let i = 0; i < g.length; i++) if (g[i] === YARD || g[i] === PASTURE) yt.push(i);
        const nc = yt.length ? Math.min(tier === 0 ? 3 : 4, 1 + Math.floor(yt.length / 12)) : 0;
        for (let i = 0; i < nc; i++) {
          const t0 = yt[Math.floor(r() * yt.length)];
          V.chickens.push({ seed: `${vi}|c${i}`, rx: (bx + (t0 % w) - 0.5) * T, ry: (by + ((t0 / w) | 0) - 0.5) * T, d: { amb: 1, kind: 'chicken', x: 0, y: 0, flip: false, fr: 0 } });
        }
      }
      // Pigeons on squares (village and up)
      if (tier >= 1) {
        const sq = (plan.squares || []).filter(s => s.w >= 2 && s.h >= 2);
        const np = sq.length ? 1 + tier : 0;
        for (let i = 0; i < np; i++) {
          const s = sq[i % sq.length];
          V.pigeons.push({ wx: (bx + s.x + 0.5 + r() * (s.w - 1)) * T, wy: (by + s.y + 0.5 + r() * (s.h - 1)) * T, ph: r() * 9, d: { amb: 1, kind: 'pigeon', x: 0, y: 0, hop: 0 } });
        }
      }
      if (V.walkers.length || V.vendors.length || V.cart || V.chickens.length || V.pigeons.length || V.fountains.length) vills.push(V);
    });
  }

  // ---- frame: push the visible movers into the depth sort ----
  function frame(f, W, push, inView) {
    if (f.zoom < 1) return;
    const tt = f.still ? 0 : f.t, night = f.night || 0, vx = f.vx, vy = f.vy, vr = vx + f.bw, vb = vy + f.bh;
    for (const V of vills) {
      if (V.x1 < vx || V.x0 > vr || V.y1 < vy || V.y0 > vb) continue;
      for (const k of V.walkers) {
        if (night > 0.4 && !k.night) continue;
        along(k.rt, tt * k.speed + k.phase);
        const wx = P.x + k.ox, wy = P.y + k.oy, d = k.d, X = Math.round(isoX(wx, wy)), Y = Math.round(isoY(wx, wy));
        if (!inView(X - 14, Y - 24, 28, 30)) continue;
        d.x = X - 8; d.y = Y - 16; d.look = k.look; d.folk = k.folk; d.dir = dirOf(P.dx, P.dy); d.row = f.still ? 0 : Math.floor(tt * 8) % 4;
        d.lantern = night > 0.4;
        push(d, wx, wy, X - 10, Y - 20, X + 10, Y + 3);
      }
      if (night < 0.6) for (const k of V.vendors) {
        const wx = k.wx, wy = k.wy, X = Math.round(isoX(wx, wy)), Y = Math.round(isoY(wx, wy)), d = k.d;
        if (!inView(X - 10, Y - 20, 20, 24)) continue;
        // facing south, with a turn to one side now and then
        const c = Math.floor((tt + k.seed) / 7), s = (tt + k.seed) - c * 7;
        d.dir = !f.still && s > 5.4 ? (c & 1 ? 2 : 3) : 0;
        d.x = X - 8; d.y = Y - 16; d.look = k.look; d.folk = k.folk; d.row = 0;
        push(d, wx, wy, X - 10, Y - 20, X + 10, Y + 3);
      }
      if (V.cart && night < 0.6) {
        const c = V.cart, span = c.x1 - c.x0, u = ((tt * c.speed + c.phase) % (span * 2 + 80)), rest = 40;
        let wx, back;
        if (u < rest) { wx = c.x0; back = false; } else if (u < rest + span) { wx = c.x0 + (u - rest); back = false; } else if (u < rest * 2 + span) { wx = c.x1; back = true; } else { wx = c.x1 - (u - rest * 2 - span); back = true; }
        if (u >= span + rest * 2) back = true;
        const wy = c.wy, X = Math.round(isoX(wx, wy)), Y = Math.round(isoY(wx, wy)), d = c.d;
        if (inView(X - 18, Y - 30, 36, 34)) { d.x = X - 16; d.y = Y - 28; d.flip = back; push(d, wx, wy, X - 16, Y - 30, X + 16, Y + 4); }
      }
      if (night < 0.5) for (const k of V.chickens) {
        const s = stroll(k.seed, k.rx, k.ry, 2 * T, 2 * T, tt), X = Math.round(isoX(s.x, s.y)) - 8, Y = Math.round(isoY(s.x, s.y)) - 14, d = k.d;
        if (!inView(X, Y, 16, 16)) continue;
        d.x = X; d.y = Y; d.flip = !s.right;
        d.fr = f.still ? 0 : s.moving ? Math.floor(tt * 6) % 2 : Math.floor(tt * 2.5 + k.d.x) % 2; // pecks while paused
        push(d, s.x, s.y, X, Y, X + 16, Y + 16);
      }
      if (night < 0.6) for (const k of V.pigeons) {
        const q = f.still ? 0 : (tt + k.ph) % 3.2, hop = q < 0.35 ? Math.sin(q / 0.35 * Math.PI) * 4 : 0;
        const wx = k.wx + (f.still ? 0 : Math.floor((tt + k.ph) / 3.2) % 2 * 3), wy = k.wy, X = Math.round(isoX(wx, wy)), Y = Math.round(isoY(wx, wy)), d = k.d;
        if (!inView(X - 5, Y - 9, 10, 12)) continue;
        d.x = X; d.y = Y; d.hop = hop;
        push(d, wx, wy, X - 5, Y - 9, X + 5, Y + 2);
      }
    }
  }
  // A chicken's wander: hashed points in a rect, 3.2 s legs (same shape as world.js stroll).
  function stroll(seed, rx, ry, rw, rh, t) {
    const LEG = 3.2, u = t + rnd(seed) * LEG * 5, leg = Math.floor(u / LEG), s = u - leg * LEG;
    const ax = rx + rnd(`${seed}:x${leg}`) * rw, ay = ry + rnd(`${seed}:y${leg}`) * rh, bx = rx + rnd(`${seed}:x${leg + 1}`) * rw, by = ry + rnd(`${seed}:y${leg + 1}`) * rh;
    const dx = bx - ax, dy = by - ay, dur = Math.min(LEG - 1, Math.max(0.6, Math.hypot(dx, dy) / 14)), k = Math.min(1, s / dur);
    return { x: ax + dx * k, y: ay + dy * k, moving: s < dur && Math.abs(dx) + Math.abs(dy) > 1, right: dx - dy >= 0 };
  }

  // ---- draw one pushed drawable ----
  function draw(ctx, d, f) {
    switch (d.kind) {
      case 'walker': case 'vendor':
        ctx.fillStyle = 'rgba(16, 10, 24, 0.45)'; ctx.beginPath(); ctx.ellipse(d.x + 8, d.y + 15, 6, 2.5, 0, 0, 7); ctx.fill();
        { const sp = d.folk && dress(d.look, d.folk, d.dir, d.row); if (sp) ctx.drawImage(sp, Math.round(d.x) - 2, Math.round(d.y) - 2); else actor(ctx, d.look, d.dir, d.row, d.x, d.y); }
        if (d.lantern) glow(ctx, d.x + 14, d.y + 11, 0.5);
        return;
      case 'cart': {
        const [sh, sx, sy, w, h] = CART;
        if (!IMG[sh]) return;
        ctx.fillStyle = 'rgba(16, 10, 24, 0.4)'; ctx.beginPath(); ctx.ellipse(d.x + 16, d.y + 28, 12, 3.5, 0, 0, 7); ctx.fill();
        if (d.flip) { ctx.save(); ctx.translate(d.x + w, d.y); ctx.scale(-1, 1); ctx.drawImage(IMG[sh], sx, sy, w, h, 0, 0, w, h); ctx.restore(); } else ctx.drawImage(IMG[sh], sx, sy, w, h, d.x, d.y, w, h);
        return;
      }
      case 'chicken':
        if (d.flip) { ctx.save(); ctx.translate(d.x + 16, d.y); ctx.scale(-1, 1); ctx.drawImage(IMG.chicken, d.fr * 16, 0, 16, 16, 0, 0, 16, 16); ctx.restore(); } else ctx.drawImage(IMG.chicken, d.fr * 16, 0, 16, 16, d.x, d.y, 16, 16);
        return;
      case 'pigeon': {
        const x = d.x, y = Math.round(d.y - d.hop);
        ctx.fillStyle = 'rgba(16, 10, 24, 0.35)'; ctx.fillRect(x - 2, d.y, 5, 1);
        ctx.fillStyle = '#140f1c'; ctx.fillRect(x - 3, y - 5, 6, 4); ctx.fillRect(x + 1, y - 7, 3, 3);
        ctx.fillStyle = '#9aa3b2'; ctx.fillRect(x - 2, y - 4, 4, 2); ctx.fillStyle = '#c9d0dc'; ctx.fillRect(x + 1, y - 6, 2, 2);
        ctx.fillStyle = '#e0a458'; ctx.fillRect(x + 3, y - 5, 1, 1);
        return;
      }
    }
  }
  // A tiny warm glow (lantern / forge): two stacked translucent discs.
  function glow(ctx, x, y, a) {
    ctx.fillStyle = `rgba(255, 190, 90, ${0.16 * a})`; ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill();
    ctx.fillStyle = `rgba(255, 220, 140, ${0.5 * a})`; ctx.fillRect(x - 1, y - 1, 2, 2);
  }

  // ---- overlay: windmill sails, smithy glow ----
  function overlay(ctx, it, b, f) {
    if (!it || !b) return;
    if (it.look === 'windmill' && b.hub) {
      const hx = b.ox + b.hub[0], hy = b.oy + b.hub[1], a0 = f.still ? 0.5 : (f.t || 0) * 0.45, L = 26, ink = '#140f1c';
      // a point at (u along the south face's x axis, w up) from the hub, in view px
      const X = (u, w) => hx + u * 0.8, Y = (u, w) => hy + u * 0.4 - w;
      for (let i = 0; i < 4; i++) {
        const a = a0 + i * Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a), na = -sa, nb = ca; // arm dir and its normal
        const pt = (r, o) => [X(ca * r + na * o, sa * r + nb * o), Y(ca * r + na * o, sa * r + nb * o)];
        // spar
        let p0 = pt(2, 0), p1 = pt(L, 0);
        ctx.strokeStyle = ink; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
        ctx.strokeStyle = '#7a5230'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
        // lattice blade on the trailing side
        const q = [pt(7, 1), pt(L, 1), pt(L, 7), pt(7, 7)];
        ctx.fillStyle = 'rgba(236, 222, 186, 0.9)'; ctx.beginPath(); ctx.moveTo(q[0][0], q[0][1]); for (let j = 1; j < 4; j++) ctx.lineTo(q[j][0], q[j][1]); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = ink; ctx.lineWidth = 1; ctx.stroke();
        ctx.strokeStyle = 'rgba(122, 82, 48, 0.9)'; ctx.beginPath();
        for (let r = 11; r < L; r += 5) { const m0 = pt(r, 1), m1 = pt(r, 7); ctx.moveTo(m0[0], m0[1]); ctx.lineTo(m1[0], m1[1]); }
        const c0 = pt(7, 4), c1 = pt(L, 4); ctx.moveTo(c0[0], c0[1]); ctx.lineTo(c1[0], c1[1]);
        ctx.stroke();
      }
      ctx.fillStyle = ink; ctx.fillRect(Math.round(hx) - 2, Math.round(hy) - 2, 5, 5);
      ctx.fillStyle = '#c98a4a'; ctx.fillRect(Math.round(hx) - 1, Math.round(hy) - 1, 3, 3);
    } else if (it.look === 'smithy' && b.door) {
      const dx = b.ox + b.door[0], dy = b.oy + b.door[1], t = f.t || 0;
      const fl = f.still ? 0.8 : 0.65 + 0.35 * Math.sin(t * 13) * Math.sin(t * 7.3 + 1);
      const gx = Math.round(dx), gy = Math.round(dy) - 5;
      ctx.fillStyle = `rgba(255, 120, 30, ${0.18 * fl})`; ctx.beginPath(); ctx.ellipse(gx, gy + 3, 11, 8, 0, 0, 7); ctx.fill();
      ctx.fillStyle = `rgba(255, 170, 60, ${0.5 * fl})`; ctx.fillRect(gx - 3, gy - 2, 6, 7);
      ctx.fillStyle = `rgba(255, 235, 150, ${0.75 * fl})`; ctx.fillRect(gx - 1, gy, 2, 4);
    }
  }

  // ---- sky: fountain sparkle and birds (view-space transform, after everything) ----
  function sky(ctx, f, W) {
    if (f.zoom < 1) return;
    const tt = f.t || 0, vx = f.vx, vy = f.vy, vr = vx + f.bw, vb = vy + f.bh;
    for (const V of vills) {
      if (V.x1 < vx || V.x0 > vr || V.y1 < vy || V.y0 > vb || !V.fountains.length) continue;
      for (const k of V.fountains) {
        const X = Math.round(isoX(k.wx, k.wy)), Y = Math.round(isoY(k.wx, k.wy));
        if (X < vx - 20 || X > vr + 20 || Y < vy - 40 || Y > vb + 20) continue;
        for (let i = 0; i < 5; i++) {
          const on = f.still ? (i & 1) : Math.floor(tt * 4 + i * 1.7 + (k.s & 7)) % 3 === 0;
          if (!on) continue;
          const h = fnv(`${k.s}|${i}|${f.still ? 0 : Math.floor(tt * 2 + i)}`);
          ctx.fillStyle = h & 1 ? '#ffffff' : '#bfe9ff';
          ctx.fillRect(X + (h % 13) - 6, Y - 6 - ((h >> 4) % 12), 1, 1);
        }
      }
    }
    // Birds: a V of 3-5 crosses the view for 18 s out of every 40 s; none at night or when still.
    if (f.still || (f.night || 0) > 0.6) return;
    const PER = 40, DUR = 18, c = Math.floor(tt / PER), s = tt - c * PER;
    if (s < DUR) {
      const r = rng(fnv(`birds${c}`)), n = 3 + Math.floor(r() * 3), dir = r() < 0.5 ? 1 : -1, y0 = vy + f.bh * (0.12 + r() * 0.3), k = s / DUR;
      const x0 = dir > 0 ? vx - 40 : vr + 40, x = x0 + dir * k * (f.bw + 80), y = y0 + Math.sin(k * 6) * 4;
      for (let i = 0; i < n; i++) {
        const rank = (i + 1) >> 1, side = i & 1 ? 1 : -1, bx = Math.round(x - dir * rank * 7), by = Math.round(y + (i ? rank * 5 * side : 0));
        const up = Math.floor(tt * 6 + i) % 2;
        ctx.fillStyle = '#140f1c';
        if (up) { ctx.fillRect(bx - 3, by - 2, 2, 1); ctx.fillRect(bx - 1, by - 1, 3, 1); ctx.fillRect(bx + 2, by - 2, 2, 1); } else { ctx.fillRect(bx - 3, by, 2, 1); ctx.fillRect(bx - 1, by - 1, 3, 1); ctx.fillRect(bx + 2, by, 2, 1); }
      }
    }
  }

  return { prepare, frame, draw, overlay, sky };
}
