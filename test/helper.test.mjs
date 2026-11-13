/** Helper: fake spawn only. Never runs claude, never touches the real ~/.claude or network. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createHelper } from '../server/helper.mjs'

function setup({ reply = 'Hello', hang = false, settings } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'village-helper-'))
  const dir = path.join(root, 'data')
  const home = path.join(root, 'claude-home')
  fs.mkdirSync(home)
  if (settings) fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings))
  const calls = []
  const spawnImpl = (bin, args, opts) => {
    const c = new EventEmitter()
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter()
    c.killed = false
    c.kill = () => { c.killed = true }
    let input = ''
    c.stdin = { on() {}, end(d) { input = d; if (!hang) setImmediate(() => { c.stdout.emit('data', JSON.stringify({ type: 'result', is_error: false, result: reply })); c.emit('close', 0) }) } }
    calls.push({ bin, args, opts, child: c, get input() { return input } })
    return c
  }
  const helper = createHelper({ dir, spawnImpl, claudeHome: () => home })
  return { helper, calls, dir }
}

test('off by default, rejects, enabling persists', async () => {
  const { helper, dir, calls } = setup()
  assert.equal((await helper.status()).enabled, false)
  await assert.rejects(helper.run('x'), { code: 'disabled' })
  assert.equal(calls.length, 0)
  await helper.setEnabled(true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'helper.json'), 'utf8')).enabled, true)
  const again = createHelper({ dir })
  assert.equal((await again.status()).enabled, true)
})

test('args, stdin, cwd and result', async () => {
  const { helper, calls } = setup({ reply: 'Fix login' })
  await helper.setEnabled(true)
  assert.equal(await helper.run('name this', { system: 'be short' }), 'Fix login')
  const [c] = calls
  assert.deepEqual(c.args, ['-p', '--model', 'haiku', '--no-session-persistence', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--system-prompt', 'be short'])
  assert.equal(c.input, 'name this')
  assert.ok(c.opts.cwd.endsWith('helper-cwd'))
  const s = await helper.status()
  assert.equal(s.callsToday, 1)
  assert.equal(s.lastError, null)
})

test('env: session vars and stale ANTHROPIC_* dropped, pool keys copied from settings.json', async () => {
  const saved = { ...process.env }
  Object.assign(process.env, { CLAUDE_CODE_SESSION_ID: 's', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ANTHROPIC_API_KEY: 'stale', ANTHROPIC_FOO: 'stale', ANTHROPIC_BASE_URL: 'stale-url', KEEP_ME: 'yes' })
  try {
    const { helper, calls } = setup({ settings: { env: { ANTHROPIC_BASE_URL: 'https://gw.test', ANTHROPIC_AUTH_TOKEN: 'tok', NOT_POOL: 'x' } } })
    await helper.setEnabled(true)
    await helper.run('p')
    const env = calls[0].opts.env
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://gw.test')
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tok')
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
    assert.equal(env.ANTHROPIC_FOO, undefined)
    assert.equal(env.NOT_POOL, undefined)
    assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined)
    assert.equal(env.CLAUDECODE, undefined)
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined)
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined)
    assert.equal(env.KEEP_ME, 'yes')
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
})

test('personal mode: no settings env means no ANTHROPIC_* at all', async () => {
  process.env.ANTHROPIC_API_KEY = 'stale'
  try {
    const { helper, calls } = setup({ settings: { theme: 'dark' } })
    await helper.setEnabled(true)
    await helper.run('p')
    assert.equal(Object.keys(calls[0].opts.env).some((k) => k.startsWith('ANTHROPIC_')), false)
  } finally { delete process.env.ANTHROPIC_API_KEY }
})

test('timeout kills the child and rejects', async () => {
  const { helper, calls } = setup({ hang: true })
  await helper.setEnabled(true)
  await assert.rejects(helper.run('p', { timeoutMs: 30 }), { code: 'timeout' })
  assert.equal(calls[0].child.killed, true)
  assert.equal((await helper.status()).lastError, 'timed out')
})

test('daily cap of 300', async () => {
  const { helper } = setup()
  await helper.setEnabled(true)
  for (let i = 0; i < 300; i++) await helper.run('p')
  await assert.rejects(helper.run('p'), { code: 'cap' })
})
