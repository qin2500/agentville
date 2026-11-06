/**
 * Which network this Mac is on, and whether it is the work Wi-Fi (where quarantine accounts
 * must not be used).
 *
 * macOS hides the Wi-Fi name (SSID) from apps without Location permission, so a network is
 * fingerprinted by its default gateway's hardware address instead: `route -n get default`, then
 * `arp -n <gateway>`. Both are local lookups (no traffic leaves the Mac) and need no permission. The
 * user marks the current network as the work Wi-Fi once, while there; `<data>/networks.json`
 * keeps the marked fingerprints. No gateway (offline) or an unreadable one is "unknown", never work.
 *
 * Tests set AGENTVILLE_NETWORK_ID (a fingerprint, or "none"); under test without it there is no network,
 * so a test never reads the real one.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { writeAtomic } from './accounts.mjs'

const CACHE_MS = 5e3
const run = (cmd, args) => new Promise((ok) => execFile(cmd, args, { timeout: 2000 }, (e, out) => ok(e ? '' : String(out))))
const fail = (status, message) => Object.assign(new Error(message), { status })

/** The current network: `{ id: 'gw:<mac>', gateway, iface }`, or `{ id: null }` when there is none. */
export async function readNetwork() {
  const env = process.env.AGENTVILLE_NETWORK_ID || (process.env.AGENTVILLE_TEST === '1' || process.env.NODE_ENV === 'test' ? 'none' : '')
  if (env) return env === 'none' ? { id: null } : { id: env, gateway: '', iface: '' }
  const route = await run('/sbin/route', ['-n', 'get', 'default'])
  const gateway = /gateway:\s*(\S+)/.exec(route)?.[1], iface = /interface:\s*(\S+)/.exec(route)?.[1] || ''
  if (!gateway || !/^[\d.]+$/.test(gateway)) return { id: null }
  const mac = /\bat\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\b/i.exec(await run('/usr/sbin/arp', ['-n', gateway]))?.[1]
  if (!mac) return { id: null, gateway, iface }
  const norm = mac.toLowerCase().split(':').map((p) => p.padStart(2, '0')).join(':')
  return { id: `gw:${norm}`, gateway, iface }
}

export function createNetwork({ dataDir, read = readNetwork, now = Date.now }) {
  const file = path.join(dataDir, 'networks.json')
  let cache = null, cachedAt = 0
  async function load() {
    try { const j = JSON.parse(await fsp.readFile(file, 'utf8')); return { work: Array.isArray(j?.work) ? j.work.filter((w) => typeof w?.id === 'string') : [] } } catch { return { work: [] } }
  }
  async function current({ fresh = false } = {}) {
    if (fresh || !cache || now() - cachedAt > CACHE_MS) { cache = await read(); cachedAt = now() }
    return cache
  }
  /** `{ id, gateway, work }` for the current network, plus the marked work networks. */
  async function status(opts) {
    const [cur, saved] = await Promise.all([current(opts), load()])
    return { current: { id: cur.id, gateway: cur.gateway || '', work: Boolean(cur.id && saved.work.some((w) => w.id === cur.id)) }, work: saved.work }
  }
  const onWork = async () => (await status()).current.work
  /** Mark (or unmark) the network this Mac is on now as the work Wi-Fi. */
  async function mark(body) {
    if (typeof body?.work !== 'boolean') throw fail(400, 'work must be true or false')
    const cur = await current({ fresh: true })
    if (!cur.id) throw fail(409, "Can't tell which network this is (no router found). Connect to the Wi-Fi first.")
    const saved = await load()
    saved.work = saved.work.filter((w) => w.id !== cur.id)
    if (body.work) saved.work.push({ id: cur.id, label: 'Work Wi-Fi', markedAt: now() })
    await fsp.mkdir(dataDir, { recursive: true })
    await writeAtomic(file, JSON.stringify(saved, null, 2) + '\n', 0o600)
    return status()
  }
  return { status, onWork, mark, current }
}
