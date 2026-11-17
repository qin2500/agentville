// Neutral re-export of the classic builders for the engine's waterside props (engine files carry no world words,
// so they import through this file). Builders take the projection scale last: pass 1.25 for the true 32x16 tile.
// Hull classes are renamed neutrally: dinghy, cutter (the classic sloop), brig (the classic cargo brig).
import './engine-art-env.js';
import { harbourArt, HARBOUR_SHIPS } from './dock-art.js';
const NAME = { dinghy: 'dinghy', cutter: 'sloop', brig: 'cargo' };
export const classicArt = { ...harbourArt, hull: (cls, accent, head, hl, s) => harbourArt.ship(NAME[cls] || 'sloop', accent, head, hl, s) };
export const VESSEL_CLASSES = { dinghy: HARBOUR_SHIPS.dinghy, cutter: HARBOUR_SHIPS.sloop, brig: HARBOUR_SHIPS.cargo };
export const TILE_SCALE = 1.25;
