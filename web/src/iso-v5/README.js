// City v5 storybook features: one module per feature, each a pure function of K (no imports, no globals).
// iso.js decides WHETHER and WHERE (whimsy() + the house builders); these modules decide HOW it is drawn.
//
// K, the kit context (built once per building inside iso.js make()):
//   st, it            the building's style (st.sty family id, st.paint/st.trim/st.beam/st.shutter/st.doorC rgb,
//                     st.roof material name, st.R, st.H, st.h/st.g hashes, st.seed) and its item
//   FAM, V            FAMS[st.sty] (iso-fam/<family>.js) and its v5 knobs: read EVERY family difference from these
//   W, D, s           footprint in world px (x east 0..W, y south 0..D), ISO factor; z is height in view px
//   lit, out          windows lit? ; out = { vane, finial, chimney, ... } result points (set out.vane = K.Q(x, y, z))
//   Q(x, y, z)        world -> view px
//   face(pts, dir, mat, extra)  a planar polygon; dir 'S' (texture rows run along x) | 'E' (along y);
//                     extra.col0 = screen x of column 0 ((x0 - Y) * s for an S wall), extra.keep(P, col) masks pixels
//   box(x0,x1,y0,y1,z0,z1, matS, matE, matTop)   cyl(cx,cy,r,z0,z1,mat)   ball(cx,cy,cz,r,mat)
//   prism(name, cx, cy, r0, r1, z0, z1, n, mk, rot)  n-gon frustum/cone; mk(faceName, N, cols, i) -> material
//   wallS(name, x0, x1, Y, z0, z1, o) / wallE(name, X, y0, y1, z0, z1, o)  named kit walls (o: tex, paint, frame,
//                     corner 'post'|'quoin', quoinC, foot, belts, eave, shade); fittings target them by name
//   wm(name, o)       a kit wall material ; fit(...fittings) push fittings ({ face, kind: 'win'|'belfry'|'arch'|
//                     'lancet'|'round'|'board'|..., c0, c1, z0, z1, lead, cross, crown, arch, round, flowers, shutters })
//   finfo[name]       { dir, Y|X, x0|y1, cols } of a named wall ; clearFits(name, a0, a1) drops fittings on that
//                     wall whose world span overlaps a0..a1 (use when a feature hides part of a wall)
//   storeys(o), roof2(o), winRow(name, z0, o), dormer(I, c, dw)   the kit's own builders (see iso.js)
//   roofMat(shade, edge, along, opt), coneMat(base, mat, z0), stoneM(paint, sh, tex), capM(paint),
//   roundWall(r, paint, ops, tex), winOp(a, z0, z1), slitOp(a, z0, z1), flat(c)   materials
//   shOf(N), shade(c, sh), rgb(hex), mix, lt, dk, jit, ramp, byLight(ramp, N, bias), h2(a, b, seed), mm(mat)
//   RB (roof base rgb), TR (trim ramp), and colours LEAF, FLOWERS[], WOOD, DARKWOOD, BEAM, IRON, GOLD, SHADE,
//   STONE, SAND, LEAD, GLASS (ramp), LIT (ramp), FOOT (ramp)
// Bounds: stay inside the footprint plus about 6 world px to the south/east (the extent margin is 8 view px);
// heights are budgeted by whimsy() in iso.js (st.tur, st.top): ask before drawing above them.
export {};
