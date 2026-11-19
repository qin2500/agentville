// Status badges (classic web/src/world.js badge art, village.js layout). Pure layout + a small sprite cache; the
// only drawing is drawBadges(ctx2d, ...) in screen (device) space, so badges stay crisp at max(2, zoom) css px per
// badge pixel whatever the camera zoom.
//
//   badgeKind(agent) -> 'note'|'need'|'error'|'click'|'build'|'wait'|null
//   layoutBadges(hits, byId, { zoom, bubbles, keep:Set, frame }) -> [{ id, kind, l, t, r, b, f }]   css px
//   drawBadges(ctx, badges, { dpr, zoom, createCanvas })
//   badgeSprite(kind, frame, createCanvas) -> canvas   (cached per factory)

export const BADGE_W = 19, BADGE_H = 23;   // sprite px: 17x17 disc + 2 for the shadow, tail down to 23

const SPECS = {
  note: { fill: '#3fe0d6', ink: '#0a2a2d', frames: [
    ['#######', '##...##', '#.#.#.#', '#..#..#', '#.....#', '#######'],
    ['.......', '#######', '##...##', '#.#.#.#', '#..#..#', '#######']] },
  need: { fill: '#f5a623', ink: '#140f1c', frames: [['...##..', '...##..', '...##..', '...##..', '...##..', '.......', '...##..', '...##..']] },
  error: { fill: '#e5383b', ink: '#ffffff', frames: [['.......', '##...##', '.##.##.', '..###..', '.##.##.', '##...##']] },
  click: { fill: '#9b5de5', ink: '#ffffff', frames: [['#......', '##.....', '###....', '####...', '#####..', '######.', '###....', '#.##...', '...##..']] },
  build: { fill: '#2f9e5b', ink: '#ffffff', frames: [
    ['######.', '#######', '######.', '..##...', '..##...', '..##...', '..##...'],
    ['.......', '######.', '#######', '######.', '..##...', '..##...', '..##...']] },
  wait: { fill: '#3d7be0', ink: '#ffffff', frames: [
    ['#######', '.#####.', '..#.#..', '...#...', '..#.#..', '.#...#.', '#######'],
    ['#######', '.#...#.', '..#.#..', '...#...', '..#.#..', '.#####.', '#######']] },
};

const val = (a, k) => a?.[k] ?? a?.status?.[k] ?? a?.input?.[k];

/** Which badge an agent wears (classic world.js drawVill): stalled -> error / click / need, waiting, building. */
// parity: vil.status-badges
export function badgeKind(agent) {
  if (!agent) return null;
  if (val(agent, 'notice')) return 'note';   // a notice the agent pushed trumps every status badge
  const bucket = val(agent, 'bucket') ?? (val(agent, 'state') === 'stalled' ? 'stalled' : null);
  if (bucket === 'stalled') return val(agent, 'severity') === 'error' ? 'error' : val(agent, 'prompt') ? 'click' : 'need';
  if (bucket === 'waiting') return 'wait';
  if (bucket === 'building') return 'build';
  return null;
}

/**
 * One badge per agent hit (kind 'agent'), centred over the sprite's head, bottom 2 css px above the hit's top,
 * sized (BADGE_W x BADGE_H) * max(2, zoom). byId: Map or plain object, hit id -> agent data.
 * bubbles === false hides every badge except those of ids in keep (hover, selected, cursor).
 * Rects are css px, the same space as the hits. f = animation frame (opts.frame, default 0).
 */
// parity: vil.badges-hidden-bubbles-off
export function layoutBadges(hits, byId, { zoom = 1, bubbles = true, keep, frame = 0 } = {}) {
  const out = [], seen = new Set(), s = Math.max(2, zoom);
  const get = id => (byId instanceof Map ? byId.get(id) : byId?.[id]);
  const w = BADGE_W * s, h = BADGE_H * s;
  for (const hit of hits || []) {
    if (!hit || hit.kind !== 'agent' || seen.has(hit.id)) continue;
    seen.add(hit.id);
    const kind = badgeKind(get(hit.id));
    if (!kind) continue;
    if (bubbles === false && !(keep && keep.has(hit.id))) continue;
    const cx = (hit.rect[0] + hit.rect[2]) / 2, b = hit.rect[1] - 2;
    out.push({ id: hit.id, kind, l: cx - w / 2, t: b - h, r: cx + w / 2, b, f: frame });
  }
  return out;
}

function defaultCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

const cache = new WeakMap();   // createCanvas factory -> Map(key -> canvas)

// Classic disc: 17x17, 1px ink, 2px white ring, coloured fill, glyph, tail and a soft shadow.
function paint(spec, frameMap, createCanvas) {
  const N = 17, c = createCanvas(BADGE_W, BADGE_H), g = c.getContext('2d');
  const inset = y => (y === 0 || y === N - 1 ? 3 : y === 1 || y === N - 2 ? 1 : 0);
  const shape = (pad, col, dx = 0, dy = 0) => {
    g.fillStyle = col;
    for (let y = pad; y < N - pad; y++) { const i = Math.max(inset(y), pad + (y === pad || y === N - 1 - pad ? 1 : 0)); g.fillRect(dx + i, dy + y, N - 2 * i, 1); }
    for (let t = 0; t < 5 - pad; t++) { const w = 7 - 2 * t - 2 * pad; if (w > 0) g.fillRect(dx + 5 + t + pad, dy + N - 1 + t, w, 1); }
  };
  shape(0, 'rgba(10, 6, 16, 0.5)', 2, 2); shape(0, '#140f1c'); shape(1, '#ffffff'); shape(2, '#ffffff'); shape(3, spec.fill);
  g.fillStyle = spec.ink;
  frameMap.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') g.fillRect(5 + x, 4 + y, 1, 1); }));
  return c;
}

export function badgeSprite(kind, frame = 0, createCanvas = defaultCanvas) {
  const spec = SPECS[kind]; if (!spec) return null;
  const f = (frame | 0) % spec.frames.length;
  let m = cache.get(createCanvas); if (!m) cache.set(createCanvas, m = new Map());
  const key = `${kind}|${f}`;
  let c = m.get(key); if (!c) m.set(key, c = paint(spec, spec.frames[f], createCanvas));
  return c;
}

/** Draw badges onto a 2D context in device px: ctx's transform is reset by the caller (identity). */
// parity: vil.status-badges
export function drawBadges(ctx, badges, { dpr = 1, zoom = 1, createCanvas } = {}) {
  if (!badges?.length) return;
  const s = Math.max(2, zoom) * dpr;
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  for (const b of badges) {
    const img = badgeSprite(b.kind, b.f ?? 0, createCanvas);
    if (!img) continue;
    ctx.drawImage(img, Math.round(b.l * dpr), Math.round(b.t * dpr), Math.round(BADGE_W * s), Math.round(BADGE_H * s));
  }
  ctx.imageSmoothingEnabled = prev;
}
