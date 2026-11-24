/**
 * Account metadata registry (`<data>/accounts.json`, one file, rows tagged by `provider`).
 *
 * `loadMeta(provider)` returns that provider's rows (a row with no `provider` is `'claude'`).
 * `saveMeta(provider, list)` re-reads the file under a lock and replaces only that provider's rows, so
 * two providers' writers cannot drop each other's accounts. The first save after an upgrade rewrites
 * legacy rows with `provider:'claude'` and keeps a copy as `accounts.json.pre-providers`, once.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { renameRetry } from './fsutil.mjs'

const ID_RE = /^[A-Za-z0-9-]{8,64}$/
const rowProvider = (a) => (typeof a?.provider === 'string' && a.provider ? a.provider : 'claude')
const chains = new Map() // metaFile -> promise chain: serializes writers inside this process

export function createAccountRegistry({ dataDir }) {
  const metaFile = path.join(dataDir, 'accounts.json')
  const lock = `${metaFile}.lock`

  async function readRaw() {
    try {
      const list = JSON.parse(await fsp.readFile(metaFile, 'utf8'))
      return Array.isArray(list) ? list.filter((a) => a && typeof a === 'object' && ID_RE.test(a.id || '')) : []
    } catch { return [] }
  }

  async function withFileLock(fn) {
    const start = Date.now()
    for (;;) {
      try { await fsp.mkdir(lock); break } catch (e) {
        if (e?.code !== 'EEXIST') throw e
        const st = await fsp.stat(lock).catch(() => null)
        if (!st || Date.now() - st.mtimeMs > 10_000 || Date.now() - start > 5_000) { await fsp.rmdir(lock).catch(() => {}); continue }
        await new Promise((r) => setTimeout(r, 15))
      }
    }
    try { return await fn() } finally { await fsp.rmdir(lock).catch(() => {}) }
  }

  async function loadMeta(provider = 'claude') {
    return (await readRaw()).filter((a) => rowProvider(a) === provider).map((a) => (a.provider ? a : { ...a, provider }))
  }

  async function saveMeta(provider, list) {
    const prev = chains.get(metaFile) || Promise.resolve()
    const run = prev.then(async () => {
      await fsp.mkdir(dataDir, { recursive: true })
      await withFileLock(async () => {
        const raw = await readRaw()
        const legacy = raw.some((a) => !a.provider)
        if (legacy) {
          const bak = `${metaFile}.pre-providers`
          const exists = await fsp.stat(bak).then(() => true, () => false)
          if (!exists) await fsp.copyFile(metaFile, bak).then(() => fsp.chmod(bak, 0o600)).catch(() => {})
        }
        const others = raw.filter((a) => rowProvider(a) !== provider).map((a) => (a.provider ? a : { ...a, provider: 'claude' }))
        const mine = list.map((a) => ({ ...a, provider }))
        const rows = provider === 'claude' ? [...mine, ...others] : [...others, ...mine]
        const tmp = `${metaFile}.agentville-${process.pid}.tmp`
        try {
          await fsp.writeFile(tmp, JSON.stringify(rows, null, 2) + '\n', { mode: 0o600 })
          await fsp.chmod(tmp, 0o600)
          await renameRetry(tmp, metaFile)
        } catch (e) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e }
      })
    })
    chains.set(metaFile, run.catch(() => {}))
    return run
  }

  return { loadMeta, saveMeta }
}
