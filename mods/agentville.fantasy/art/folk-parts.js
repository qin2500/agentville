// agentville.fantasy folk, code-drawn paper-doll parts (M6 P2). 16 x 24 doll, feet on the bottom row, 1 px outline added
// by the engine. Storybook high fantasy: tunics, dresses, robes, aprons, coats, hoods, caps, straw hats, kerchiefs and
// feathers, a hammer, a crate, a lantern and a basket. Every part draws only the drawn facing (0 = SE front, 2 = NW back;
// the engine mirrors them for SW and NE) and reads colours from palette slots (art/looks.js fills them):
//   skin skinShade hair hairShade cloth clothShade trim pants boots apron apronShade hat hatShade hatTrim plume
//   cape capeShade crown wood woodShade metal lamp eye
// Pure: no randomness, no time, no I/O.

/** Anim table (engine anim names). bob[f] moves the bob-able parts (everything but the legs) down by that many px. */
export const FOLK_ANIMS = Object.freeze({
  idle: Object.freeze({ frames: 2, bob: Object.freeze([0, 1]) }),
  walk: Object.freeze({ frames: 4, bob: Object.freeze([0, 1, 0, 1]) }),
  hammer: Object.freeze({ frames: 2, bob: Object.freeze([0, 1]) }),
  carry: Object.freeze({ frames: 4, bob: Object.freeze([0, 1, 0, 1]) }),
  sit: Object.freeze({ frames: 1, bob: Object.freeze([2]) }),
  wave: Object.freeze({ frames: 2, bob: Object.freeze([0, 0]) }),
  cheer: Object.freeze({ frames: 2, bob: Object.freeze([0, -1]) }),
  sleep: Object.freeze({ frames: 1, bob: Object.freeze([3]) }),
  enter: Object.freeze({ frames: 1, bob: Object.freeze([0]) }),
});

const SEATED = a => a === 'sit' || a === 'sleep';
/** Body box: slim is 6 wide, broad 8 wide, both centred on x = 8. */
const geo = b => (b ? { bw: 8, x0: 4 } : { bw: 6, x0: 5 });

/** Arm poses for both sides by anim and frame. */
function poses(anim, f) {
  const both = p => ({ l: p, r: p });
  switch (anim) {
    case 'walk': { const s = [0, 1, 0, -1][f & 3]; return { l: { k: 'down', sw: -s }, r: { k: 'down', sw: s } }; }
    case 'carry': return both({ k: 'fwd' });
    case 'hammer': return { l: { k: 'fwd' }, r: (f & 1) === 0 ? { k: 'up', dx: 0 } : { k: 'down', sw: 1 } };
    case 'wave': return { l: { k: 'down', sw: 0 }, r: { k: 'up', dx: f & 1 } };
    case 'cheer': return { l: { k: 'up', dx: f & 1 }, r: { k: 'up', dx: f & 1 } };
    case 'sit': case 'sleep': return both({ k: 'lap' });
    default: return both({ k: 'down', sw: 0 });
  }
}
/** Sleeve cells and hand point of one arm (side 0 left x = x0 - 1, side 1 right x = x0 + bw). */
function arm(side, p, x0, bw) {
  const x = side ? x0 + bw : x0 - 1, inward = side ? -1 : 1;
  if (p.k === 'up') return { x, y0: 7, y1: 10, hx: x + (side ? p.dx : -p.dx), hy: 6 };
  if (p.k === 'fwd') return { x, y0: 10, y1: 11, hx: x + inward, hy: 12 };
  if (p.k === 'lap') return { x, y0: 10, y1: 12, hx: x + inward, hy: 13 };
  const hy = 14 + (p.sw | 0);
  return { x, y0: 10, y1: hy - 1, hx: x, hy };
}
const handOf = (anim, f, b, side) => { const { bw, x0 } = geo(b); const ps = poses(anim, f); return arm(side, side ? ps.r : ps.l, x0, bw); };

// ---- legs ----
function legs(b) {
  const { bw, x0 } = geo(b), lw = b ? 3 : 2;
  return { layer: 10, bob: false, draw(g, fc, anim, f) {
    const xs = [x0, x0 + bw - lw];
    if (SEATED(anim)) {
      g.rect(x0, 18, bw, 3, 'pants');
      for (const x of xs) g.rect(x, 21, lw + 1, 3, 'boots');
      return;
    }
    const lift = [0, 0];
    if (anim === 'walk' || anim === 'carry') { if (f === 1) lift[0] = 1; if (f === 3) lift[1] = 1; }
    if (anim === 'cheer' && (f & 1)) { lift[0] = 1; lift[1] = 1; }
    xs.forEach((x, i) => {
      const l = lift[i];
      g.rect(x, 17 - l, lw, 5, 'pants');
      g.rect(x, 22 - l, lw, 2, 'boots');
      g.px(x + lw - 1, 17 - l, 'pants');
    });
  } };
}

// ---- garments (torso layer) ----
function neck(g, fc, x0, bw) {
  if (fc === 0) { g.rect(7, 9, 2, 1, 'skin'); g.px(6, 9, 'trim'); g.px(9, 9, 'trim'); g.rect(x0, 9, 1, 1, 'cloth'); g.rect(x0 + bw - 1, 9, 1, 1, 'cloth'); }
  else g.rect(6, 9, 4, 1, 'clothShade');
}
function tunic(b) {
  const { bw, x0 } = geo(b);
  return { layer: 20, draw(g, fc) {
    g.rect(x0, 9, bw, 8, 'cloth');
    g.rect(x0 + bw - 1, 10, 1, 6, 'clothShade');
    g.rect(x0, 16, bw, 1, 'clothShade');
    g.rect(x0, 14, bw, 1, 'trim');
    if (fc === 0) g.px(7, 14, 'metal');
    neck(g, fc, x0, bw);
  } };
}
function dress(b) {
  const { bw, x0 } = geo(b);
  return { layer: 20, draw(g, fc) {
    g.rect(x0, 9, bw, 5, 'cloth');
    g.rect(x0, 14, bw, 1, 'trim');
    g.rect(x0 - 1, 15, bw + 2, 2, 'cloth');
    g.rect(x0 - 2, 17, bw + 4, 3, 'cloth');
    g.rect(x0 - 2, 20, bw + 4, 1, 'trim');
    g.rect(x0 + bw + 1, 17, 1, 3, 'clothShade'); g.rect(x0 + bw - 1, 9, 1, 5, 'clothShade');
    if (fc === 0) { g.rect(7, 16, 1, 4, 'clothShade'); g.px(8, 18, 'clothShade'); }
    neck(g, fc, x0, bw);
  } };
}
function robe(b) {
  const { bw, x0 } = geo(b);
  return { layer: 20, draw(g, fc) {
    g.rect(x0, 9, bw, 13, 'cloth');
    g.rect(x0 - 1, 17, bw + 2, 5, 'cloth');
    g.rect(x0 - 1, 21, bw + 2, 1, 'trim');
    g.rect(x0 + bw, 17, 1, 4, 'clothShade'); g.rect(x0 + bw - 1, 9, 1, 8, 'clothShade');
    g.rect(x0, 14, bw, 1, 'trim');
    if (fc === 0) { g.rect(7, 15, 1, 6, 'clothShade'); g.px(8, 15, 'trim'); g.px(8, 16, 'trim'); }
    neck(g, fc, x0, bw);
  } };
}
function coat(b) {
  const { bw, x0 } = geo(b);
  return { layer: 20, draw(g, fc) {
    g.rect(x0, 9, bw, 10, 'cloth');
    g.rect(x0 + bw - 1, 10, 1, 8, 'clothShade');
    g.rect(x0, 18, bw, 1, 'clothShade');
    g.rect(x0, 14, bw, 1, 'trim');
    if (fc === 0) {
      g.rect(7, 10, 2, 9, 'trim');
      g.px(x0 + 1, 12, 'metal'); g.px(x0 + 1, 16, 'metal'); g.px(x0 + bw - 2, 12, 'metal'); g.px(x0 + bw - 2, 16, 'metal');
    } else g.rect(7, 14, 2, 5, 'clothShade');
    neck(g, fc, x0, bw);
  } };
}
function apron(b) {
  const { bw, x0 } = geo(b);
  return { layer: 25, draw(g, fc) {
    if (fc === 0) {
      g.rect(x0 + 1, 12, bw - 2, 8, 'apron');
      g.px(x0 + 1, 10, 'apron'); g.px(x0 + 1, 11, 'apron'); g.px(x0 + bw - 2, 10, 'apron'); g.px(x0 + bw - 2, 11, 'apron');
      g.rect(x0 + 1, 19, bw - 2, 1, 'apronShade');
      g.rect(x0 + 2, 15, 2, 1, 'apronShade');
    } else { g.px(7, 13, 'apron'); g.px(8, 13, 'apron'); g.px(6, 14, 'apron'); g.px(9, 14, 'apron'); }
  } };
}

// ---- arms (sleeve + hand) ----
function arms(b) {
  const { bw, x0 } = geo(b);
  return { layer: 30, draw(g, fc, anim, f) {
    const ps = poses(anim, f);
    [ps.l, ps.r].forEach((p, side) => {
      const a = arm(side, p, x0, bw);
      g.rect(a.x, a.y0, 1, a.y1 - a.y0 + 1, side ? 'clothShade' : 'cloth');
      g.px(a.hx, a.hy, 'skin');
    });
  } };
}

// ---- head, face, hair ----
const sleepDrop = (g, anim) => { if (anim === 'sleep') g.dy = g.dy + 1; };
const HEAD = { layer: 40, draw(g, fc, anim) {
  sleepDrop(g, anim);
  g.rect(6, 3, 4, 1, 'skin'); g.rect(5, 4, 6, 4, 'skin'); g.rect(6, 8, 4, 1, 'skin');
  g.rect(10, 6, 1, 2, 'skinShade'); g.px(9, 8, 'skinShade');
} };
const FACE = { layer: 45, draw(g, fc, anim, f) {
  if (fc !== 0) return;
  sleepDrop(g, anim);
  if (anim === 'sleep') { g.px(6, 7, 'eye'); g.px(9, 7, 'eye'); return; }
  g.px(6, 6, 'eye'); g.px(9, 6, 'eye');
  g.px(5, 7, 'skinShade'); g.px(10, 7, 'skinShade');
  if (anim === 'cheer' || anim === 'wave') g.rect(7, 8, 2, 1, 'eye');
  else if (anim === 'hammer') g.px(8, 8, 'skinShade');
} };
const crop = g => { g.rect(6, 2, 4, 1, 'hair'); g.rect(5, 3, 6, 1, 'hair'); };
const HAIR = [
  { layer: 50, draw(g, fc, anim) {   // 0 crop
    sleepDrop(g, anim);
    if (fc === 0) { crop(g); g.rect(5, 4, 3, 1, 'hair'); g.px(10, 4, 'hair'); }
    else { g.rect(6, 2, 4, 1, 'hair'); g.rect(5, 3, 6, 5, 'hair'); g.rect(6, 8, 4, 1, 'hairShade'); }
  } },
  { layer: 50, draw(g, fc, anim) {   // 1 bob
    sleepDrop(g, anim);
    if (fc === 0) { crop(g); g.rect(5, 4, 1, 4, 'hair'); g.rect(10, 4, 1, 4, 'hair'); g.rect(6, 4, 3, 1, 'hair'); g.px(5, 7, 'hairShade'); g.px(10, 7, 'hairShade'); }
    else { g.rect(6, 2, 4, 1, 'hair'); g.rect(5, 3, 6, 6, 'hair'); g.rect(5, 8, 6, 1, 'hairShade'); }
  } },
  { layer: 50, draw(g, fc, anim) {   // 2 long
    sleepDrop(g, anim);
    if (fc === 0) { crop(g); g.rect(6, 4, 3, 1, 'hair'); g.rect(5, 4, 1, 9, 'hair'); g.rect(10, 4, 1, 9, 'hair'); g.rect(5, 11, 1, 2, 'hairShade'); g.rect(10, 11, 1, 2, 'hairShade'); }
    else { g.rect(6, 2, 4, 1, 'hair'); g.rect(5, 3, 6, 10, 'hair'); g.rect(5, 11, 6, 2, 'hairShade'); }
  } },
  { layer: 50, draw(g, fc, anim) {   // 3 bun
    sleepDrop(g, anim);
    g.rect(7, 1, 2, 2, 'hair');
    if (fc === 0) { crop(g); g.rect(5, 4, 3, 1, 'hair'); g.px(10, 4, 'hair'); g.px(8, 1, 'hairShade'); }
    else { g.rect(6, 2, 4, 1, 'hair'); g.rect(5, 3, 6, 5, 'hair'); g.rect(6, 8, 4, 1, 'hairShade'); }
  } },
  { layer: 50, draw(g, fc, anim) {   // 4 braid
    sleepDrop(g, anim);
    if (fc === 0) {
      crop(g); g.rect(5, 4, 3, 1, 'hair'); g.rect(10, 4, 1, 3, 'hair');
      for (let i = 0; i < 6; i++) g.px(10, 7 + i, i & 1 ? 'hairShade' : 'hair');
    } else {
      g.rect(6, 2, 4, 1, 'hair'); g.rect(5, 3, 6, 5, 'hair'); g.rect(6, 8, 4, 1, 'hairShade');
      for (let i = 0; i < 6; i++) g.px(8, 8 + i, i & 1 ? 'hairShade' : 'hair');
    }
  } },
  { layer: 50, draw(g, fc, anim) {   // 5 curly
    sleepDrop(g, anim);
    g.rect(5, 1, 6, 1, 'hair'); g.rect(4, 2, 8, 3, 'hair');
    g.px(6, 3, 'hairShade'); g.px(9, 2, 'hairShade'); g.px(11, 4, 'hairShade');
    if (fc === 0) { g.rect(4, 5, 1, 2, 'hair'); g.rect(11, 5, 1, 2, 'hair'); g.rect(5, 4, 1, 1, 'hair'); g.rect(10, 4, 1, 1, 'hair'); }
    else { g.rect(4, 5, 8, 3, 'hair'); g.rect(5, 8, 6, 1, 'hairShade'); }
  } },
];

// ---- headwear (hat layer) ----
const capShape = (g, fc, plume) => {
  g.rect(6, 1, 4, 1, 'hat'); g.rect(5, 2, 6, 1, 'hat'); g.rect(5, 3, 6, 1, 'hatTrim');
  if (fc === 0) g.rect(5, 4, 6, 1, 'hatShade'); else g.rect(5, 4, 6, 1, 'hat');
  if (plume) { g.rect(11, 2, 1, 3, 'plume'); g.rect(12, 1, 1, 2, 'plume'); g.px(11, 4, 'hatShade'); }
};
const HATS = {
  hood: { layer: 70, draw(g, fc, anim) {
    sleepDrop(g, anim);
    g.rect(6, 1, 4, 1, 'hat');
    if (fc === 0) {
      g.rect(5, 2, 6, 2, 'hat'); g.rect(4, 4, 2, 5, 'hat'); g.rect(10, 4, 2, 5, 'hat'); g.rect(4, 9, 8, 1, 'hatShade');
      g.rect(6, 4, 4, 1, 'hatShade'); g.px(4, 8, 'hatShade'); g.px(11, 8, 'hatShade');
    } else { g.rect(4, 2, 8, 8, 'hat'); g.rect(4, 9, 8, 1, 'hatShade'); g.px(8, 10, 'hatShade'); g.rect(11, 3, 1, 6, 'hatShade'); }
  } },
  cap: { layer: 70, draw(g, fc, anim) { sleepDrop(g, anim); capShape(g, fc, false); } },
  feather: { layer: 70, draw(g, fc, anim) { sleepDrop(g, anim); capShape(g, fc, true); } },
  straw: { layer: 70, draw(g, fc, anim) {
    sleepDrop(g, anim);
    g.rect(5, 1, 6, 2, 'hat'); g.rect(5, 2, 6, 1, 'hatTrim'); g.rect(2, 3, 12, 1, 'hat');
    g.rect(3, 4, 10, 1, fc === 0 ? 'hatShade' : 'hat'); g.px(13, 3, 'hatShade'); g.px(2, 3, 'hatShade'); g.px(6, 1, 'hatShade');
  } },
  kerchief: { layer: 70, draw(g, fc, anim) {
    sleepDrop(g, anim);
    if (fc === 0) {
      g.rect(6, 2, 4, 1, 'hat'); g.rect(5, 3, 6, 1, 'hat'); g.rect(5, 4, 1, 1, 'hatShade');
      g.rect(11, 3, 2, 2, 'hat'); g.rect(12, 5, 1, 2, 'hatShade'); g.px(11, 4, 'hatShade');
    } else {
      g.rect(6, 2, 4, 1, 'hat'); g.rect(5, 3, 6, 5, 'hat'); g.rect(7, 8, 2, 2, 'hatShade'); g.px(6, 8, 'hat'); g.px(9, 8, 'hat');
    }
  } },
  crown: { layer: 75, draw(g, fc, anim) {
    sleepDrop(g, anim);
    g.rect(5, 2, 6, 2, 'crown'); g.px(5, 1, 'crown'); g.px(7, 1, 'crown'); g.px(8, 1, 'crown'); g.px(10, 1, 'crown');
    if (fc === 0) { g.px(7, 3, 'plume'); g.px(6, 2, 'wood'); g.px(9, 2, 'wood'); } else g.rect(5, 3, 6, 1, 'woodShade');
  } },
  ninja: { layer: 60, draw(g, fc, anim) {
    sleepDrop(g, anim);
    g.rect(6, 2, 4, 1, 'hat'); g.rect(5, 3, 6, 6, 'hat'); g.rect(5, 3, 6, 1, 'trim');
    if (fc === 0) {
      g.rect(6, 5, 4, 2, 'skin'); g.px(6, 6, 'eye'); g.px(9, 6, 'eye');
      g.rect(5, 7, 6, 1, 'hatShade'); g.rect(6, 8, 4, 1, 'hatShade');
    } else g.rect(5, 8, 6, 1, 'hatShade');
    g.rect(11, 3, 2, 1, 'trim'); g.rect(12, 4, 1, 3, 'trim'); g.px(13, 6, 'trim');
  } },
};

// ---- cape (boss) ----
function cape(b) {
  const { bw, x0 } = geo(b);
  return { layer: 22, draw(g, fc) {
    if (fc === 2) {
      g.rect(x0 - 1, 9, bw + 2, 12, 'cape'); g.rect(8, 10, 1, 10, 'capeShade'); g.rect(x0 - 1, 20, bw + 2, 1, 'capeShade');
      g.rect(x0 + bw, 12, 1, 8, 'capeShade');
    } else {
      g.rect(x0 - 2, 10, 2, 10, 'cape'); g.rect(x0 + bw, 10, 2, 10, 'capeShade'); g.rect(x0 - 2, 19, bw + 4, 1, 'capeShade');
      g.rect(6, 9, 4, 1, 'crown'); g.px(7, 10, 'crown'); g.px(8, 10, 'crown');
    }
  } };
}

// ---- held items ----
const ITEMS = {
  hammer: { layer: 85, draw(g, fc, anim, f) {
    if (anim === 'hammer') {
      const h = handOf(anim, f, false, 1);
      if ((f & 1) === 0) { g.rect(h.hx, 3, 1, 3, 'wood'); g.rect(h.hx - 1, 1, 3, 2, 'metal'); g.px(h.hx - 1, 2, 'woodShade'); }
      else { g.rect(h.hx + 1, 15, 2, 1, 'wood'); g.rect(h.hx + 2, 14, 2, 3, 'metal'); }
    } else if (!SEATED(anim)) { g.px(11, 15, 'wood'); g.px(11, 16, 'metal'); }
  } },
  crate: { layer: 85, draw(g, fc, anim) {
    if (anim !== 'carry') return;
    const bw = 10, x = 3;
    if (fc === 0) {
      g.rect(x, 11, bw, 6, 'wood'); g.rect(x, 11, bw, 1, 'woodShade'); g.rect(x, 16, bw, 1, 'woodShade');
      g.rect(x, 11, 1, 6, 'woodShade'); g.rect(x + bw - 1, 11, 1, 6, 'woodShade'); g.rect(x + 1, 13, bw - 2, 1, 'woodShade');
      g.px(x + 2, 12, 'metal'); g.px(x + bw - 3, 12, 'metal');
    } else { g.rect(x, 11, 2, 6, 'wood'); g.rect(x + bw - 2, 11, 2, 6, 'woodShade'); }
  } },
  basket: { layer: 85, draw(g, fc, anim, f) {
    if (anim === 'carry') {
      if (fc === 0) {
        g.rect(5, 10, 6, 1, 'woodShade'); g.px(5, 11, 'woodShade'); g.px(10, 11, 'woodShade');
        g.rect(4, 12, 8, 4, 'wood'); g.rect(5, 16, 6, 1, 'woodShade'); g.rect(4, 12, 8, 1, 'woodShade');
        for (let i = 0; i < 4; i++) { g.px(5 + i * 2, 14, 'woodShade'); g.px(6 + i * 2, 15, 'woodShade'); }
        g.px(6, 11, 'trim'); g.px(8, 11, 'plume'); g.px(9, 11, 'trim');
      } else { g.rect(4, 12, 1, 4, 'wood'); g.rect(11, 12, 1, 4, 'woodShade'); }
    } else if (anim === 'idle' || anim === 'walk') {
      const h = handOf(anim, f, false, 1);
      g.rect(h.hx, h.hy + 1, 3, 3, 'wood'); g.px(h.hx + 1, h.hy + 2, 'woodShade'); g.px(h.hx + 1, h.hy, 'woodShade'); g.px(h.hx + 2, h.hy, 'woodShade');
    }
  } },
  lantern: { layer: 85, draw(g, fc, anim, f) {
    if (anim !== 'idle' && anim !== 'walk') return;
    const h = handOf(anim, f, false, 1), x = h.hx;
    g.px(x + 1, h.hy, 'metal'); g.rect(x, h.hy + 1, 3, 1, 'metal'); g.rect(x, h.hy + 2, 3, 2, 'lamp'); g.px(x + 1, h.hy + 4, 'metal');
  } },
};

/** All parts, by id: legs.0|1, tunic.0|1, dress.0|1, robe.0|1, coat.0|1, apron.0|1, arms.0|1, cape.0|1, head, face,
 *  hair.0..5, hood, cap, feather, straw, kerchief, crown, ninja, item.hammer, item.crate, item.basket, item.lantern. */
export const FOLK_PARTS = (() => {
  const parts = { head: HEAD, face: FACE, ...HATS };
  [0, 1].forEach(b => {
    parts[`legs.${b}`] = legs(b); parts[`tunic.${b}`] = tunic(b); parts[`dress.${b}`] = dress(b); parts[`robe.${b}`] = robe(b);
    parts[`coat.${b}`] = coat(b); parts[`apron.${b}`] = apron(b); parts[`arms.${b}`] = arms(b); parts[`cape.${b}`] = cape(b);
  });
  HAIR.forEach((p, i) => { parts[`hair.${i}`] = p; });
  for (const [k, p] of Object.entries(ITEMS)) parts[`item.${k}`] = p;
  return Object.freeze(parts);
})();
export const HAIR_STYLES = HAIR.length;
export const GARMENTS = Object.freeze(['tunic', 'dress', 'robe', 'coat']);
export const HEADWEAR_PARTS = Object.freeze(['hood', 'cap', 'straw', 'kerchief', 'feather']);
