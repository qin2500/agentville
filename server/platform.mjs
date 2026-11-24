/**
 * Small OS-portability helpers shared by the server. Every function takes an optional
 * `{ platform, env, home }` so tests can simulate Windows on any host.
 */
import os from 'node:os'
import path from 'node:path'

export const isWin = process.platform === 'win32'

/**
 * Extra directories to search for the `claude` / `codex` CLI, after PATH. Never inside an app
 * bundle; a shell function or alias is invisible here by construction.
 */
export function cliDirs(name, { platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    const profile = env.USERPROFILE || home
    const appData = env.APPDATA || path.join(profile, 'AppData', 'Roaming')
    const local = env.LOCALAPPDATA || path.join(profile, 'AppData', 'Local')
    return [
      path.join(profile, '.local', 'bin'),
      path.join(appData, 'npm'),
      ...(name === 'claude' ? [path.join(local, 'Programs', 'claude')] : []),
      path.join(local, 'Microsoft', 'WindowsApps'),
      path.join(profile, '.bun', 'bin'),
    ]
  }
  if (name === 'codex') return [path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
  return [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
}

/** One cmd.exe argument: double quotes doubled, the whole thing quoted (& | < > ^ are literal inside). */
function cmdQuote(arg) {
  const s = String(arg)
  if (/[\r\n\0]/.test(s)) throw new Error('Argument contains a line break')
  return '"' + s.replaceAll('"', '""') + '"'
}

/**
 * `{ file, args, opts }` for execFile / spawn. Node refuses to spawn .cmd/.bat directly
 * (CVE-2024-27980), so on Windows those go through `cmd.exe /d /s /c "<line>"` with verbatim args.
 * cmd expands %VAR% even inside quotes and cannot escape it there, so a line holding a `%...%`
 * pair is refused rather than risk injecting an environment value.
 */
export function execTarget(bin, args = [], { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const line = [bin, ...args].map(cmdQuote).join(' ')
    if ((line.match(/%/g) || []).length > 1) throw new Error('Argument contains a % sequence cmd.exe would expand')
    return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], opts: { windowsVerbatimArguments: true } }
  }
  return { file: bin, args, opts: {} }
}

/** For display-only command lines: POSIX single quotes, or PowerShell single quotes on Windows. */
export function quoteForShell(value, { platform = process.platform } = {}) {
  const s = String(value)
  if (platform === 'win32') return "'" + s.replaceAll("'", "''") + "'"
  return "'" + s.replaceAll("'", "'\"'\"'") + "'"
}
