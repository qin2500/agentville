/** The data folder and the one-time move from the pre-rename folder, in temp dirs only. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { adoptLegacyEnv, defaultDataDir, legacyDataDir, migrateDataDir, resolveDataDir } from '../server/datadir.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentville-datadir-'))
/** An old folder shaped like a real one: saved logins (0600, in a 0700 folder), backups, plain files. */
function oldFolder(root) {
  const from = path.join(root, 'village-ai')
  fs.mkdirSync(path.join(from, 'accounts'), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(from, 'account-backups', '2026-11-01'), { recursive: true, mode: 0o700 })
  fs.chmodSync(from, 0o700)
  fs.writeFileSync(path.join(from, 'accounts', 'a1.json'), '{"secret":"x"}', { mode: 0o600 })
  fs.writeFileSync(path.join(from, 'account-backups', '2026-11-01', 'credentials.json'), '{"b":1}', { mode: 0o600 })
  fs.writeFileSync(path.join(from, 'overrides.json'), '{}')
  return from
}
const tree = (dir) => fs.readdirSync(dir, { recursive: true }).sort().map((f) => {
  const st = fs.statSync(path.join(dir, f))
  return [f, st.mode & 0o777, st.isFile() ? fs.readFileSync(path.join(dir, f), 'utf8') : null]
})

test('paths: AGENTVILLE_DATA_DIR wins, then XDG_CONFIG_HOME, then ~/.config', () => {
  assert.equal(defaultDataDir({ AGENTVILLE_DATA_DIR: '/x/data', XDG_CONFIG_HOME: '/xdg' }), '/x/data')
  assert.equal(defaultDataDir({ XDG_CONFIG_HOME: '/xdg' }), path.join('/xdg', 'agentville'))
  assert.equal(legacyDataDir({ XDG_CONFIG_HOME: '/xdg' }), path.join('/xdg', 'village-ai'))
  assert.equal(defaultDataDir({}), path.join(os.homedir(), '.config', 'agentville'))
})

test('migrate: renames the old folder when the new one is missing, keeping every file and mode', () => {
  const root = tmp()
  const from = oldFolder(root), to = path.join(root, 'agentville')
  const before = tree(from)
  assert.deepEqual(migrateDataDir({ from, to }), { moved: 'renamed', dir: to })
  assert.equal(fs.existsSync(from), false)
  assert.deepEqual(tree(to), before)
  assert.equal(fs.statSync(to).mode & 0o777, 0o700)
})

test('migrate: if the rename fails it copies, completely, and leaves the old folder alone', () => {
  const root = tmp()
  const from = oldFolder(root), to = path.join(root, 'agentville')
  const before = tree(from)
  const r = migrateDataDir({ from, to, rename: () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }) } })
  assert.deepEqual(r, { moved: 'copied', dir: to })
  assert.deepEqual(tree(from), before, 'old folder untouched')
  assert.deepEqual(tree(to), before, 'every file copied with its mode')
  assert.equal(fs.statSync(to).mode & 0o777, 0o700)
  assert.deepEqual(fs.readdirSync(root).sort(), ['agentville', 'village-ai'], 'no temp folder left behind')
})

test('migrate: if the copy fails too, nothing half-copied is left and the old folder stays in use', () => {
  const root = tmp()
  const from = oldFolder(root), to = path.join(root, 'agentville')
  const before = tree(from)
  const r = migrateDataDir({
    from, to,
    rename: () => { throw new Error('nope') },
    copy: (a, b) => { fs.mkdirSync(b); fs.writeFileSync(path.join(b, 'partial'), ''); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) },
  })
  assert.deepEqual(r, { moved: false, dir: from, error: 'ENOSPC' })
  assert.deepEqual(tree(from), before)
  assert.deepEqual(fs.readdirSync(root), ['village-ai'])
})

test('migrate: never touches an existing new folder, and does nothing without an old one', () => {
  const root = tmp()
  const from = oldFolder(root), to = path.join(root, 'agentville')
  fs.mkdirSync(to); fs.writeFileSync(path.join(to, 'overrides.json'), '{"new":1}')
  assert.deepEqual(migrateDataDir({ from, to }), { moved: false, dir: to })
  assert.equal(fs.readFileSync(path.join(to, 'overrides.json'), 'utf8'), '{"new":1}')
  assert.ok(fs.existsSync(path.join(from, 'accounts', 'a1.json')))
  const fresh = tmp()
  assert.deepEqual(migrateDataDir({ from: path.join(fresh, 'village-ai'), to: path.join(fresh, 'agentville') }), { moved: false, dir: path.join(fresh, 'agentville') })
  assert.deepEqual(fs.readdirSync(fresh), [])
})

test('resolveDataDir: moves under XDG_CONFIG_HOME, logs folders only (never file names), and an explicit dir is used as is', () => {
  const root = tmp()
  oldFolder(root)
  const lines = []
  assert.equal(resolveDataDir({ XDG_CONFIG_HOME: root }, (l) => lines.push(l)), path.join(root, 'agentville'))
  assert.equal(lines.length, 1)
  assert.doesNotMatch(lines[0], /a1\.json|credentials|overrides/)
  assert.equal(resolveDataDir({ AGENTVILLE_DATA_DIR: '/x/y', XDG_CONFIG_HOME: root }, () => assert.fail('no log')), '/x/y')
})

test('adoptLegacyEnv: VILLAGE_* fills in AGENTVILLE_* only where it is unset', () => {
  const env = adoptLegacyEnv({ VILLAGE_PORT: '5300', VILLAGE_DATA_DIR: '/old', AGENTVILLE_DATA_DIR: '/new' })
  assert.equal(env.AGENTVILLE_PORT, '5300')
  assert.equal(env.AGENTVILLE_DATA_DIR, '/new')
})
