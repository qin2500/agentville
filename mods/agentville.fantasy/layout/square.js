// The central square as a VenueSite (api.js): rect = the square, anchor = the tile just south of its centre (the big
// tree stands on the centre tile and blocks it; resolvePlace('venue:square') and nav go to the anchor). The mod's 'square' venue
// (venues.js) dresses it with the big tree and the four corner lanterns. parity: world.central-square
export function squareVenue(sq) {
  return { kind: 'square', rect: { x: sq.x, y: sq.y, w: sq.w, h: sq.h }, anchor: { tx: sq.x + (sq.w >> 1), ty: sq.y + (sq.h >> 1) + 1 } };
}
