import './support/ensure-mods-index.mjs';
// Mod data crossing the sandbox must be clonable (village-mods.md; COMMON.md: the ObjectTypeTable holds NO functions).
// For every bundled mod: objects, terrain and rules contain no functions anywhere, and survive structuredClone and a JSON round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
const { resolveMod, listMods } = await import('../web/src/engine/mod/registry.js');

// Known failing on 554bbbf: fantasy objects.props.{stall,bench,fence,hedge,railing,bridge} are functions (variants). Fixed by M1b.
const TODO = {};   // m1b landed: fantasy objects are plain data
const KEYS = ['objects', 'terrain', 'rules'];

/** Paths of every non-plain value (function, symbol, bigint, class instance, undefined-valued key) in a deep walk. */
function offenders(v, path = '$', seen = new Set(), out = []) {
  if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') { out.push(`${path} (${typeof v})`); return out; }
  if (!v || typeof v !== 'object') return out;
  if (seen.has(v)) return out;
  seen.add(v);
  for (const [k, c] of Object.entries(v)) offenders(c, `${path}.${k}`, seen, out);
  return out;
}
const hasFunctionDeep = (v, seen = new Set()) => {
  if (typeof v === 'function') return true;
  if (!v || typeof v !== 'object' || seen.has(v)) return false;
  seen.add(v);
  return Reflect.ownKeys(v).some(k => hasFunctionDeep(v[k], seen));
};

for (const { id } of listMods()) {
  const mod = resolveMod(id);
  for (const key of KEYS) {
    const opts = (name) => TODO[`${id}/${key}/${name}`] ? { todo: 'needs m1b' } : {};
    test(`${id}: mod.${key} is present`, () => assert.ok(mod[key] && typeof mod[key] === 'object'));
    test(`${id}: mod.${key} contains no functions`, opts('nofn'), () => {
      assert.equal(hasFunctionDeep(mod[key]), false, `functions at: ${offenders(mod[key]).slice(0, 8).join(', ')}`);
    });
    test(`${id}: mod.${key} survives structuredClone deep-equal`, opts('clone'), () => {
      assert.deepEqual(structuredClone(mod[key]), mod[key]);
    });
    test(`${id}: mod.${key} survives a JSON round trip deep-equal`, opts('json'), () => {
      assert.deepEqual(JSON.parse(JSON.stringify(mod[key])), mod[key]);
    });
  }
}
