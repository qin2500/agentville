/**
 * Where Agentville keeps its own files, and the one-time move from the folder it used before it was
 * renamed (`village-ai`). Per user, so it survives reinstalls:
 *   AGENTVILLE_DATA_DIR > $XDG_CONFIG_HOME/agentville > ~/.config/agentville
 *
 * The old folder can hold saved Claude logins and their backups, so the move never deletes anything
 * it hasn't copied, never overwrites, and never prints a file name. Run as a script
 * (`node server/datadir.mjs`), it does just the move; the macOS launcher calls it before it writes
 * its log into the new folder.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const configHome = (env = process.env) => env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')

export const defaultDataDir = (env = process.env) => env.AGENTVILLE_DATA_DIR || path.join(configHome(env), 'agentville')
export const legacyDataDir = (env = process.env) => path.join(configHome(env), 'village-ai')

/**
 * Move `from` to `to` when `to` doesn't exist and `from` is a folder. A rename first (instant, same
 * disk); if that fails (another disk, say), a full copy into a temporary sibling that is renamed into
 * place only once complete, so `to` never exists half-copied. After a copy the old folder is kept.
 * Returns { moved: 'renamed' | 'copied' | false, dir, error? } where `dir` is the folder to use:
 * `from` itself if nothing could be moved, so no saved data ever seems to vanish.
 */
export function migrateDataDir({ from, to, rename = fs.renameSync, copy = (a, b) => fs.cpSync(a, b, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false }) }) {
  if (fs.existsSync(to)) return { moved: false, dir: to }
  if (!fs.statSync(from, { throwIfNoEntry: false })?.isDirectory()) return { moved: false, dir: to }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    rename(from, to)
    return { moved: 'renamed', dir: to }
  } catch { /* fall through to a copy */ }
  const tmp = `${to}.migrating-${process.pid}`
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
    copy(from, tmp)
    // cpSync keeps file modes but not folder modes: put back each folder's own (0700 for logins).
    for (const rel of ['', ...fs.readdirSync(from, { recursive: true })]) {
      const st = fs.lstatSync(path.join(from, rel))
      if (st.isDirectory()) fs.chmodSync(path.join(tmp, rel), st.mode & 0o777)
    }
    fs.renameSync(tmp, to)
    return { moved: 'copied', dir: to }
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* leave it; the old folder is untouched */ }
    return { moved: false, dir: from, error: e.code || e.message }
  }
}

/** Settings from before the rename (VILLAGE_PORT and friends) still work when the new name isn't set. */
export function adoptLegacyEnv(env = process.env) {
  for (const k of Object.keys(env)) {
    if (!k.startsWith('VILLAGE_')) continue
    const next = `AGENTVILLE_${k.slice('VILLAGE_'.length)}`
    if (env[next] === undefined) env[next] = env[k]
  }
  return env
}

/** The data dir to use at startup: an explicit AGENTVILLE_DATA_DIR as is, else the default after the move. */
export function resolveDataDir(env = process.env, log = console.log) {
  if (env.AGENTVILLE_DATA_DIR) return env.AGENTVILLE_DATA_DIR
  const to = defaultDataDir(env)
  const r = migrateDataDir({ from: legacyDataDir(env), to })
  if (r.moved === 'renamed') log(`Moved Agentville's data from ${legacyDataDir(env)} to ${to}.`)
  if (r.moved === 'copied') log(`Copied Agentville's data from ${legacyDataDir(env)} to ${to}. The old folder is untouched; delete it once you're happy.`)
  if (r.error) log(`Couldn't move ${legacyDataDir(env)} to ${to} (${r.error}); still using the old folder.`)
  return r.dir
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) resolveDataDir(adoptLegacyEnv())
