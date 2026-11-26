// POST /api/term/upload: images pasted or dropped onto the built-in terminal. Fixture servers only.
process.env.AGENTVILLE_TEST = '1'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { withServer } from './support/with-server.mjs'
import { sniff, createTermUploads, MAX_BYTES } from '../server/term-upload.mjs'
import { imageFiles, hasFiles, pathsToInput, isAltV } from '../web/src/term-paste.js'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)])
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32, 3)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)])

const up = (base, body, { type = 'image/png', origin = base, ui = true, headers = {} } = {}) => {
  const h = { 'content-type': type, ...headers }
  if (origin !== null) h.origin = origin
  if (ui) h['x-agentville-ui'] = '1'
  return fetch(`${base}/api/term/upload`, { method: 'POST', headers: h, body })
}

test('sniff knows the four types by magic bytes and nothing else', () => {
  assert.equal(sniff(PNG).ext, 'png')
  assert.equal(sniff(JPG).ext, 'jpg')
  assert.equal(sniff(GIF).ext, 'gif')
  assert.equal(sniff(WEBP).ext, 'webp')
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null)
  assert.equal(sniff(Buffer.from('just some text, not an image')), null)
  assert.equal(sniff(Buffer.alloc(3)), null)
})

test('upload saves the image and returns its absolute path (file 0600, folder 0700 off Windows)', () => withServer(async ({ base, dataDir }) => {
  const r = await up(base, PNG)
  assert.equal(r.status, 200)
  const j = await r.json()
  assert.equal(j.ok, true)
  assert.ok(path.isAbsolute(j.path))
  assert.equal(path.dirname(j.path), path.join(dataDir, 'term-uploads'))
  assert.match(path.basename(j.path), /^[0-9a-f]{24}\.png$/)
  assert.deepEqual(fs.readFileSync(j.path), PNG)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(j.path).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(j.path)).mode & 0o777, 0o700)
  }
  const jpg = await (await up(base, JPG, { type: 'image/jpeg' })).json()
  assert.match(jpg.path, /\.jpg$/)
  assert.notEqual(jpg.path, j.path)
}))

test('the extension follows the bytes, not the header; a lie is refused', () => withServer(async ({ base }) => {
  const ok = await (await up(base, GIF, { type: 'image/png' })).json()
  assert.match(ok.path, /\.gif$/)
  const bad = await up(base, Buffer.from('<svg onload=alert(1)></svg> not an image at all'), { type: 'image/png' })
  assert.equal(bad.status, 415)
}))

test('other content types are refused', () => withServer(async ({ base }) => {
  assert.equal((await up(base, PNG, { type: 'image/svg+xml' })).status, 415)
  assert.equal((await up(base, PNG, { type: 'application/json' })).status, 415)
  assert.equal((await up(base, PNG, { type: 'text/plain' })).status, 415)
}))

test('over 20 MB is refused with 413 and nothing is saved', () => withServer(async ({ base, dataDir }) => {
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_BYTES)])
  let status
  try { status = (await up(base, big)).status } catch { status = 413 } // the server may close the socket mid-upload
  assert.equal(status, 413)
  const dir = path.join(dataDir, 'term-uploads')
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [])
}))

test('local only: a foreign origin, no origin, a foreign host or a missing UI header is refused', () => withServer(async ({ base, dataDir }) => {
  assert.equal((await up(base, PNG, { origin: 'http://evil.example' })).status, 403)
  assert.equal((await up(base, PNG, { origin: null })).status, 403)
  assert.equal((await up(base, PNG, { ui: false })).status, 403)
  const status = await new Promise((resolve, reject) => {
    const u = new URL(base)
    const rq = http.request({ host: u.hostname, port: u.port, path: '/api/term/upload', method: 'POST', headers: { host: 'evil.example', origin: base, 'x-agentville-ui': '1', 'content-type': 'image/png' } }, (r) => { r.resume(); resolve(r.statusCode) })
    rq.on('error', reject); rq.end(PNG)
  })
  assert.equal(status, 403)
  assert.equal(fs.existsSync(path.join(dataDir, 'term-uploads')), false)
}))

test('GET is not allowed', () => withServer(async ({ base }) => {
  const r = await fetch(`${base}/api/term/upload`, { headers: { origin: base } })
  assert.equal(r.status, 405)
}))

test('saving prunes files older than 7 days and keeps newer ones', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agv-up-'))
  try {
    const u = createTermUploads({ dataDir })
    const fresh = (await u.save(PNG)).path
    const old = (await u.save(JPG)).path
    const aged = new Date(Date.now() - 8 * 24 * 3600 * 1000)
    fs.utimesSync(old, aged, aged)
    const mid = new Date(Date.now() - 6 * 24 * 3600 * 1000)
    const keep = (await u.save(GIF)).path
    fs.utimesSync(keep, mid, mid)
    await u.save(WEBP) // prunes first
    assert.equal(fs.existsSync(old), false)
    assert.equal(fs.existsSync(fresh), true)
    assert.equal(fs.existsSync(keep), true)
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }) }
})

// ---- the page's pure helpers ----
test('imageFiles takes image files only; a text paste gives none', () => {
  const png = { type: 'image/png', name: 'a.png' }, pdf = { type: 'application/pdf' }
  assert.deepEqual(imageFiles({ files: [png, pdf] }), [png])
  assert.deepEqual(imageFiles({ files: [], items: [{ kind: 'file', type: 'image/webp', getAsFile: () => png }] }), [png])
  assert.deepEqual(imageFiles({ files: [], items: [{ kind: 'string', type: 'text/plain' }] }), [])
  assert.deepEqual(imageFiles({ files: [{ type: 'image/svg+xml' }] }), [])
  assert.deepEqual(imageFiles(null), [])
})

test('hasFiles spots a file drag; pathsToInput quotes spaces and ends with a space', () => {
  assert.equal(hasFiles({ types: ['text/plain', 'Files'] }), true)
  assert.equal(hasFiles({ types: ['text/plain'] }), false)
  assert.equal(pathsToInput(['/a/b.png']), '/a/b.png ')
  assert.equal(pathsToInput(['C:\\Users\\Jo Smith\\x.png', '/b.png']), '"C:\\Users\\Jo Smith\\x.png" /b.png ')
})

test('isAltV matches Alt+V only', () => {
  assert.equal(isAltV({ altKey: true, ctrlKey: false, metaKey: false, code: 'KeyV', key: 'v' }), true)
  assert.equal(isAltV({ altKey: true, ctrlKey: false, metaKey: false, code: 'KeyV', key: '√' }), true)
  assert.equal(isAltV({ altKey: true, ctrlKey: true, metaKey: false, code: 'KeyV', key: 'v' }), false)
  assert.equal(isAltV({ altKey: false, ctrlKey: false, metaKey: false, code: 'KeyV', key: 'v' }), false)
})
