// Building raster identity (M7 pan/zoom): the faster face fill in classic iso.js (row crossings instead of a point-in-
// polygon test per pixel) must draw exactly what the old fill drew. The golden fingerprints in
// test/fixtures/iso-raster-golden.json were taken from iso.js BEFORE the change (m7-int 028232e): pixels, the 2D call
// log, offsets, anchors and box of every sheet look, building sites and the busy / six-styles fixture buildings,
// at the classic and engine projections, by day and by night.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadIso, fingerprint, goldenCases } from './support/iso-raster-fixture.mjs';

const GOLDEN = JSON.parse(fs.readFileSync(new URL('./fixtures/iso-raster-golden.json', import.meta.url), 'utf8'));
const iso = await loadIso();

test('isoBuilding: every golden case is byte-identical to the pre-change raster', async () => {
  const cases = await goldenCases();
  assert.deepEqual(cases.map(c => c.name).sort(), Object.keys(GOLDEN).sort(), 'the golden case list is unchanged');
  const looks = new Set(cases.map(c => c.it.look));
  assert.ok(looks.size >= 20, `covers the looks (${looks.size})`);
  const bad = [];
  for (const c of cases) {
    const fp = fingerprint(iso.isoBuilding(c.it, 16, c.lit, c.S));
    if (fp !== GOLDEN[c.name]) bad.push(`${c.name}: ${fp} != ${GOLDEN[c.name]}`);
  }
  assert.deepEqual(bad, []);
});

test('polyCuts: the even-odd crossings give exactly inPoly at every pixel centre', () => {
  let st = 12345;
  const rnd = () => { st = (Math.imul(st, 1103515245) + 12345) >>> 0; return st / 4294967296; };
  const polys = [
    [[0, 0], [10, 5], [0, 10], [-10, 5]],                        // an iso diamond
    [[0, 0], [8, 0], [8, 6], [0, 6]],                            // horizontal edges on pixel rows
    [[0.5, 0.5], [6.5, 0.5], [6.5, 4.5], [0.5, 4.5]],            // edges through pixel centres
    [[0, 0], [12, 0], [12, 10], [6, 3], [0, 10]],                // concave
    [[0, 0], [5, 0], [5, 0], [5, 7], [0, 7]],                    // a repeated vertex
    [[0, 0], [10, 0], [0, 10], [10, 10]],                        // self-crossing (bow tie)
    [[-3.25, 1.75], [4.5, -2.5], [9.125, 6.375]],                // a thin triangle off the grid
  ];
  for (let n = 0; n < 60; n++) {
    const k = 3 + Math.floor(rnd() * 6);
    polys.push(Array.from({ length: k }, () => [Math.round((rnd() * 40 - 20) * 8) / 8, Math.round((rnd() * 30 - 15) * 4) / 4]));
  }
  for (const p of polys) {
    const cuts = iso.polyCuts(p);
    for (let py = -22; py < 22; py++) {
      const Y = py + 0.5, m = cuts(Y);
      for (let px = -25, k = 0; px < 25; px++) {
        const X = px + 0.5;
        while (k < m && cuts.xs[k] <= X) k++;
        assert.equal(((m - k) & 1) === 1, iso.inPoly(X, Y, p), `poly ${JSON.stringify(p)} at ${X},${Y}`);
      }
    }
  }
});
