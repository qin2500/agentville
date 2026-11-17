// Selection marks: the selected-but-indoors ghost at the door, the selected home's outline and the white marker
// above a selected agent. Pure planning (selectionMarks) plus Gfx drawing (drawMarks, 1x world px).
// The sticker rim / white rim of the selected sprite itself is actor-art.js (frame(a, { selected: true })).
import { toScreen } from '../core/coords.js';

const F = { SELECTED: 2, INDOORS: 8 };
const isSel = a => !!(a.selected || ((a.flags | 0) & F.SELECTED));
const isIn = a => !!(a.indoors || ((a.flags | 0) & F.INDOORS));
const inCrowd = (crowd, id) => (crowd instanceof Set || crowd instanceof Map ? crowd.has(id) : Array.isArray(crowd) ? crowd.includes(id) : !!crowd);

const MARKER = ['ooooooo', 'oyyyyyo', '.oyyyo.', '..oyo..', '...o...'];   // classic world.js marker glyph
const MARKER_COL = { o: '#140f1c', y: '#eaf2ff' };
// The "Important" star (classic world.js glyph): a gold star at the left of the head of an agent flagged important.
const STAR = ['...o...', '..oyo..', 'ooyyyoo', '.oyyyo.', 'oyo.oyo', 'oo...oo'];
const STAR_COL = { o: '#140f1c', y: '#ffd23f' };

/**
 * importantStars({ actors }) -> [{ id, x, y }] (tile coords of the feet): every outdoor agent carrying input.important
 * (or a.important). Indoor actors get none (nobody sees them). Order follows `actors`.
 */
// parity: vil.important-star
export function importantStars({ actors } = {}) {
  const out = [];
  for (const a of actors || []) {
    if (a?.kind !== 'agent' || !(a.important || a.input?.important) || isIn(a) || !Number.isFinite(a.x)) continue;
    out.push({ id: a.id, x: a.x, y: a.y });
  }
  return out;
}

/**
 * selectionMarks({ world, actors, selected, crowd }) -> { ghost?, outline?, marker? }
 *   selected: the selected actor id (else the actor carrying the SELECTED flag).
 *   crowd: Set / array of ids folded into a crowd tag, or a boolean for the selected actor.
 *   ghost   { id, actor, home, tx, ty }  selected and indoors: faded at its home's door (drawMarks resolves via entryOf)
 *   outline { id, tx, ty, w, h }         the selected actor's home footprint, when it is indoors or in the crowd
 *   marker  { id, x, y }                 selected and outdoors: the marker above its head (tile coords)
 */
// parity: vil.selected-indoors-ghost-at-door
// parity: bld.selected-home-outline
// parity: vil.selection-marker-rims
export function selectionMarks({ world, actors, selected, crowd } = {}) {
  const a = (actors || []).find(x => (selected != null ? x.id === selected : isSel(x)));
  if (!a) return {};
  // the house it is in: its own home, else the one it went into (a resting sub-agent: its parent's house)
  const hid = a.home ?? a._target?.homeId ?? null;
  const home = hid != null ? world?.objects?.get?.(hid) ?? world?.objects?.get?.(String(hid)) : null;
  const indoors = isIn(a), folded = inCrowd(crowd, a.id);
  const out = {};
  if (indoors) out.ghost = { id: a.id, actor: a, home: home || null, tx: home?.tx, ty: home?.ty };
  if ((indoors || folded) && home && Number.isFinite(home.tx)) out.outline = { id: home.id ?? hid, tx: home.tx, ty: home.ty, w: home.w || 1, h: home.h || 1 };
  if (!indoors && !folded && Number.isFinite(a.x)) out.marker = { id: a.id, x: a.x, y: a.y };
  return out;
}

// A 1 world-px line between two screen points, as a thin parallelogram (Gfx has rect/poly only).
function line(g, p, q, color) { g.poly([[p[0], p[1]], [q[0], q[1]], [q[0], q[1] + 1], [p[0], p[1] + 1]], color); }

/**
 * drawMarks(g, marks, { cam, gview, entryOf, frameOf, now })
 *   entryOf(homeObj) -> { x, y } tile coords of the door; default the front corner of the footprint.
 *   frameOf(actor) -> { img, pivot? } the selected sprite for the ghost (actorArt.frame(a, { selected: true })).
 *   headOf(id) -> px from the feet to the top of the figure (doll frames carry `head`); default 24, the classic sticker height.
 *   Without frameOf the ghost is a faded 16x24 box. now (ms) bobs the marker like classic (3 steps/s).
 */
export function drawMarks(g, marks, { entryOf, frameOf, headOf, now = 0 } = {}) {
  const top = id => { const h = headOf?.(id); return Number.isFinite(h) ? h : 24; };   // px from the feet to the top of the figure
  if (!marks) return;
  const { ghost, outline, marker, stars } = marks;
  for (const st of stars || []) {
    const p = toScreen(st.x, st.y), x0 = Math.round(p.sx) - 9, y0 = Math.round(p.sy) - top(st.id) - 4;
    STAR.forEach((row, y) => [...row].forEach((ch, x) => { if (STAR_COL[ch]) g.rect(x0 + x, y0 + y, 1, 1, STAR_COL[ch]); }));
  }
  if (outline) {
    const { tx, ty, w, h } = outline;
    const P = [toScreen(tx, ty), toScreen(tx + w, ty), toScreen(tx + w, ty + h), toScreen(tx, ty + h)].map(p => [p.sx, p.sy]);
    for (let i = 0; i < 4; i++) line(g, P[i], P[(i + 1) % 4], '#eaf2ff');
  }
  if (ghost) {
    const d = ghost.home ? (entryOf?.(ghost.home) || { x: ghost.home.tx + (ghost.home.w || 1) / 2, y: ghost.home.ty + (ghost.home.h || 1) }) : { x: ghost.actor.x, y: ghost.actor.y };
    const p = toScreen(d.x, d.y), f = frameOf?.(ghost.actor);
    if (f?.img) {
      const w = f.img.width ?? 16, h = f.img.height ?? 24, px = f.pivot?.x ?? w / 2, py = f.pivot?.y ?? h;
      g.image(f.img, 0, 0, w, h, Math.round(p.sx - px), Math.round(p.sy - py), w, h, 0.5);
    } else {
      g.rect(Math.round(p.sx) - 8, Math.round(p.sy) - 24, 16, 24, 'rgba(234,242,255,0.5)');
    }
  }
  if (marker) {
    const p = toScreen(marker.x, marker.y), step = Math.floor(now / 1000 * 3) % 2;
    const x0 = Math.round(p.sx) - 3, y0 = Math.round(p.sy) - top(marker.id) - 9 - step;
    MARKER.forEach((row, y) => [...row].forEach((ch, x) => { if (MARKER_COL[ch]) g.rect(x0 + x, y0 + y, 1, 1, MARKER_COL[ch]); }));
  }
}
