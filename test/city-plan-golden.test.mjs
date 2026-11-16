// GOLDEN HASHES for nested settlement plans. These pin the exact layout planSettlement produces for fixed
// (seed, tiers chain) inputs. Saved towns persist `chain` and rebuild through generate/wrap, so ANY change to
// generate or wrap that alters these plans re-lays-out saved towns. Updating a hash here means saved towns will move:
// only do it on purpose, with the maintainers' agreement. Pure, node only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const { planSettlement } = await import('../web/src/city-plan.js');

// stable serialisation: sorted object keys at every depth (the whole plan: ground, lots, civic, props, squares, roads, chain, nest)
const stable = v => Array.isArray(v) ? `[${v.map(stable)}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`)}}` : JSON.stringify(v);
const hash = p => createHash('sha256').update(stable(p)).digest('hex').slice(0, 16);

// replay a growth chain: each step is [tier, lots]; every re-plan nests the previous one's `chain`
function grow(seed, steps) {
  let p = null;
  for (const [tier, lots] of steps) p = planSettlement({ tier, seed, lots, from: p ? p.chain : null });
  return p;
}
const CASES = [
  { name: 'seed 7, tier 0', seed: 7, steps: [[0, 3]] },
  { name: 'seed 7, 0 -> 1 -> 2', seed: 7, steps: [[0, 3], [1, 9], [2, 20]] },
  { name: 'seed 42, 1 -> 2 -> 3', seed: 42, steps: [[1, 6], [2, 18], [3, 40]] },
  { name: 'seed 12345, 0 -> 3 straight', seed: 12345, steps: [[0, 2], [3, 40]] },
];
const GOLDEN = {
  'seed 7, tier 0': '026591fc4a0f9d1a',
  'seed 7, 0 -> 1 -> 2': '7a82339862f4fa97',
  'seed 42, 1 -> 2 -> 3': 'f4d106c2f86bb1b4',
  'seed 12345, 0 -> 3 straight': 'f9e933b4f6feb128',
};

for (const c of CASES) test(`golden plan hash: ${c.name}`, () => {
  const p = grow(c.seed, c.steps);
  assert.equal(hash(p), GOLDEN[c.name], `${c.name}: plan changed (saved towns would move); see the header comment before updating`);
  assert.equal(hash(grow(c.seed, c.steps)), hash(p), 'deterministic');
});
