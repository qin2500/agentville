// P3 contract: tools/engine/make-nested-history.mjs (stress.json, f=[0.06,0.2,0.5,1.0], seed 7, NOW+i*day).
// The tool is run with `--out <file>` into a temp dir (spec ambiguity: if --out is unsupported the tests fail loudly).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tool = path.join(root, 'tools/engine/make-nested-history.mjs')
const skip = fs.existsSync(tool) ? false : 'tools/engine/make-nested-history.mjs is absent (activates on P3 merge)'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-'))
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
const gen = (name) => { const out = path.join(tmp, name); execFileSync('node', [tool, '--out', out], { cwd: root, stdio: 'pipe' }); return out }
const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const walk = (o, fn) => { if (Array.isArray(o)) o.forEach((x) => walk(x, fn)); else if (o && typeof o === 'object') { fn(o); Object.values(o).forEach((x) => walk(x, fn)) } }

test('byte-identical on rerun', { skip }, () => {
  assert.ok(fs.readFileSync(gen('a.json')).equals(fs.readFileSync(gen('b.json'))))
})

test('>= 25 projects with chain depth >= 3', { skip }, () => {
  const j = load(gen('a.json'))
  const projects = j.projects || j.layout?.projects || j
  const list = Array.isArray(projects) ? projects : Object.values(projects)
  assert.ok(list.length >= 25, `projects: ${list.length}`)
  const depth = (p) => (p.chain || p.chains || p.tiers || p.history || []).length
  assert.ok(list.filter((p) => depth(p) >= 3).length >= 25, 'every counted project has chain depth >= 3')
})

test('every city project chain starts at tier 0', { skip }, () => {
  const j = load(gen('a.json'))
  let seen = 0
  walk(j, (o) => {
    const chain = o.chain || o.tiers
    if (Array.isArray(chain) && chain.length && (o.kind === 'city' || o.city || o.tier >= 3)) {
      seen++
      const first = chain[0]
      assert.equal(typeof first === 'object' ? (first.tier ?? first.t) : first, 0, JSON.stringify(o.id ?? o.name))
    }
  })
  assert.ok(seen > 0, 'found city chains')
})

test('final tiers equal fresh stress', { skip }, async () => {
  const { makeHistory } = await import('../tools/engine/make-nested-history.mjs')
  const nested = load(gen('a.json'))
  const fx = load(path.join(root, 'e2e/fixtures/engine/stress.json'))
  const fresh = makeHistory(fx, { fractions: [1] })
  const f = Object.fromEntries(fresh.projects.map((p) => [p.name, p.tier]))
  assert.ok(Object.keys(f).length > 0)
  const n = {}
  walk(nested, (o) => { if (o.name != null && o.tier != null && !o.chain && o.name in f) n[o.name] = o.tier })
  assert.equal(Object.keys(n).length, Object.keys(f).length, "every fresh project is found in the nested fixture")
  for (const [name, t] of Object.entries(f)) if (name in n) assert.equal(n[name], t, name)
})
