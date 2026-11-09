// The desktop app's plain-Node helpers (desktop/shell.cjs): settings, Node lookup, port probe,
// link policy and window placement. The Electron side is covered by e2e-app/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const S = require('../desktop/shell.cjs')
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const K = (k) => `${S.BRAND.env}_${k}`

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-desktop-')) }
function checkout(dir) { fs.mkdirSync(path.join(dir, 'server'), { recursive: true }); fs.writeFileSync(path.join(dir, 'server', 'cli.mjs'), ''); return dir }

test('settings: env beats config beats the baked path beats the dev checkout', (t) => {
  const d = tmp(); t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  const a = checkout(path.join(d, 'a')), b = checkout(path.join(d, 'b')), c = checkout(path.join(d, 'c'))
  const configFile = path.join(d, 'config.json'), bakedRepoFile = path.join(d, 'repo-path')
  fs.writeFileSync(bakedRepoFile, `${c}\n`)
  let s = S.resolveSettings({ env: {}, configFile, bakedRepoFile, devRepo: ROOT })
  assert.equal(s.repo, c); assert.equal(s.sources.repo, 'baked')
  assert.equal(s.port, S.BRAND.defaultPort); assert.equal(s.sources.port, 'default')
  fs.writeFileSync(configFile, JSON.stringify({ repo: b, port: 6001 }))
  s = S.resolveSettings({ env: {}, configFile, bakedRepoFile })
  assert.deepEqual([s.repo, s.port], [b, 6001])
  s = S.resolveSettings({ env: { [K('DESKTOP_REPO')]: a, [K('PORT')]: ' 6002 ' }, configFile, bakedRepoFile })
  assert.deepEqual([s.repo, s.port, s.sources.repo, s.sources.port], [a, 6002, 'env', 'env'])
})

test('settings: a folder without server/cli.mjs or a bad port is skipped and reported', (t) => {
  const d = tmp(); t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  const good = checkout(path.join(d, 'good'))
  const configFile = path.join(d, 'config.json')
  fs.writeFileSync(configFile, JSON.stringify({ repo: path.join(d, 'gone'), port: 70000 }))
  const s = S.resolveSettings({ env: { [K('PORT')]: 'abc' }, configFile, devRepo: good })
  assert.equal(s.repo, good)
  assert.equal(s.port, S.BRAND.defaultPort)
  assert.equal(s.problems.length, 3)
  assert.equal(S.resolveSettings({ env: {}, configFile: path.join(d, 'none.json') }).repo, null)
  fs.writeFileSync(configFile, '{not json')
  assert.equal(S.resolveSettings({ env: {}, configFile, devRepo: good }).repo, good) // a broken config is ignored
})

test('parsePort and compareVersions', () => {
  assert.equal(S.parsePort('5275'), 5275)
  for (const bad of ['', '0', '65536', '12a', '-1', '1.5', null, 3.5]) assert.equal(S.parsePort(bad), null, String(bad))
  assert.ok(S.compareVersions('22.13.0', '22.13') === 0)
  assert.ok(S.compareVersions('22.12.9', '22.13.0') < 0)
  assert.ok(S.compareVersions('24.0.0', '22.13.0') > 0)
})

test('findNode: first new-enough node on the augmented PATH; a pinned one wins', (t) => {
  const d = tmp(); t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  const old = path.join(d, 'old'), fresh = path.join(d, 'fresh')
  for (const dir of [old, fresh]) { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'node'), ''); fs.chmodSync(path.join(dir, 'node'), 0o755) }
  const versions = { [path.join(old, 'node')]: '20.11.0', [path.join(fresh, 'node')]: '24.1.0' }
  const version = (bin) => versions[bin] ?? null
  const home = path.join(d, 'home')
  assert.deepEqual(S.findNode({ env: { PATH: `${old}:${fresh}` }, home, version }), { bin: path.join(fresh, 'node'), version: '24.1.0' })
  assert.equal(S.findNode({ env: { PATH: old }, home, version }), null)
  assert.equal(S.findNode({ env: { PATH: fresh, [K('DESKTOP_NODE')]: path.join(old, 'node') }, home, version }), null)
})

test('augmentedPath puts the usual install folders first, once each', () => {
  const p = S.augmentedPath('/usr/bin:/opt/homebrew/bin:/bin', '/h').split(':')
  assert.equal(p[0], '/h/.local/bin')
  assert.equal(p.filter((x) => x === '/opt/homebrew/bin').length, 1)
  assert.deepEqual(p.slice(-2), ['/usr/bin', '/bin'])
})

test('probe tells our server, another app and a free port apart', async (t) => {
  const serve = (body) => new Promise((r) => { const s = http.createServer((_q, res) => res.end(body)).listen(0, '127.0.0.1', () => r(s)) })
  const ours = await serve(`<!doctype html><title>${S.BRAND.name}</title>`)
  const other = await serve('<title>Something else</title>')
  t.after(() => { ours.close(); other.close() })
  assert.equal(await S.probe(ours.address().port), 'ours')
  assert.equal(await S.probe(other.address().port), 'other')
  const port = other.address().port
  await new Promise((r) => other.close(r))
  assert.equal(await S.probe(port), 'free')
  assert.equal(await S.waitReady(ours.address().port, { ms: 2000 }), true)
  assert.equal(await S.waitReady(port, { ms: 5000, stop: () => true }), false)
})

test('links: only the local origin stays in the window; http(s) and mailto go outside', () => {
  const origin = 'http://127.0.0.1:5275'
  assert.ok(S.isLocal('http://127.0.0.1:5275/?debug', origin))
  assert.ok(!S.isLocal('http://127.0.0.1:5276/', origin))
  assert.ok(!S.isLocal('http://localhost:5275/', origin))
  assert.ok(!S.isLocal('https://github.com/o/r/pull/1', origin))
  assert.ok(!S.isLocal('not a url', origin))
  assert.ok(S.isExternal('https://github.com/o/r/pull/1'))
  assert.ok(S.isExternal('mailto:x@example.com'))
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'vscode://x', '']) assert.ok(!S.isExternal(u), u)
  assert.deepEqual([...S.ALLOWED_PERMISSIONS].sort(), ['clipboard-sanitized-write', 'fullscreen', 'notifications'])
})

test('placeWindow keeps saved bounds on a display that exists, else only the size', () => {
  const displays = [{ x: 0, y: 25, width: 1512, height: 920 }]
  assert.deepEqual(S.placeWindow(null, displays), { width: 1440, height: 900 })
  assert.deepEqual(S.placeWindow({ x: 10, y: 40, width: 1200, height: 800 }, displays), { x: 10, y: 40, width: 1200, height: 800 })
  assert.deepEqual(S.placeWindow({ x: 4000, y: 40, width: 1200, height: 800 }, displays), { width: 1200, height: 800 }) // display gone
  assert.deepEqual(S.placeWindow({ x: 0, y: 0, width: 50, height: 50 }, displays), { x: 0, y: 0, width: 480, height: 360 })
})
