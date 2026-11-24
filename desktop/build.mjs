#!/usr/bin/env node
/**
 * `npm run app:build`: package the desktop app (Electron) for this checkout.
 *
 *   npm run app:build                      build dist-app/…/Agentville.app (macOS) or the folder app elsewhere
 *   npm run app:build -- --install         …and copy it to ~/Applications (replacing an older copy)
 *   npm run app:build -- --install DIR     …or to DIR
 *   npm run app:build -- --repo DIR        run the checkout at DIR instead of this one
 *
 * Windows: builds dist-app\win-unpacked\Agentville.exe and an NSIS installer (per-user, you choose the
 * folder). --install copies win-unpacked to %LOCALAPPDATA%\Programs\Agentville and adds a Start Menu
 * shortcut (a plain copy, so no installer UI and no admin rights; DIR overrides the folder). The
 * icon is desktop/icons/icon.ico.
 *
 * The app holds only the shell (desktop/*). It runs the server and page from this checkout, whose
 * path is baked into the app (Resources/repo-path), so pulling new code here updates the app too.
 * macOS: signed ad hoc (codesign -s -). The icon is desktop/icons/icon.icns, drawn by tools/icon/build.mjs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const DESKTOP = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(DESKTOP, '..')
const BUILD = path.join(DESKTOP, '.build')
const OUT = path.join(ROOT, 'dist-app')
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'))
const NAME = pkg.productName
const mac = process.platform === 'darwin'
const windows = process.platform === 'win32'

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ ?\* ?/gm, '').trim())
  process.exit(0)
}
const installAt = args.indexOf('--install')
const repoAt = args.indexOf('--repo')
const REPO = repoAt < 0 ? ROOT : path.resolve(args[repoAt + 1] || '')
if (!fs.existsSync(path.join(REPO, 'server', 'cli.mjs'))) { console.error(`${REPO} isn't a checkout (no server/cli.mjs).`); process.exit(1) }
const installDir = installAt < 0 ? null : (args[installAt + 1] && !args[installAt + 1].startsWith('--') ? path.resolve(args[installAt + 1]) : windows ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', NAME) : path.join(os.homedir(), 'Applications'))

// Build the page now, so the app's first start doesn't sit on "Starting…" while the server builds it.
console.log('Building the web app…')
execFileSync(windows ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: REPO, stdio: 'inherit', shell: windows })

fs.rmSync(BUILD, { recursive: true, force: true })
fs.mkdirSync(BUILD, { recursive: true })
// The checkout this app runs, read verbatim by main.cjs (a plain file: any character is safe).
fs.writeFileSync(path.join(BUILD, 'repo-path'), REPO)

// Requiring electron downloads its binary on first use (it has no install script).
require('electron')
const electronVersion = JSON.parse(fs.readFileSync(require.resolve('electron/package.json'), 'utf8')).version

const icon = path.join(DESKTOP, 'icons', 'icon.icns')

const { build, Platform } = require('electron-builder')
fs.rmSync(OUT, { recursive: true, force: true })
await build({
  projectDir: ROOT,
  targets: (mac ? Platform.MAC : process.platform === 'win32' ? Platform.WINDOWS : Platform.LINUX).createTarget(windows ? ['nsis', 'dir'] : 'dir'),
  config: {
    appId: `local.${pkg.name}`,
    productName: NAME,
    directories: { app: DESKTOP, output: OUT },
    // Only the shell: the server's own dependencies stay in the checkout, which is what runs.
    files: ['main.cjs', 'shell.cjs', 'loading.html', 'package.json', '!node_modules{,/**/*}'],
    extraResources: [{ from: path.join(BUILD, 'repo-path'), to: 'repo-path' }],
    electronVersion,
    electronDist: path.join(path.dirname(require.resolve('electron/package.json')), 'dist'),
    npmRebuild: false,
    nodeGypRebuild: false,
    asar: true,
    publish: null,
    mac: {
      icon,
      identity: null, // signed ad hoc below
      category: 'public.app-category.developer-tools',
      extendInfo: { NSHighResolutionCapable: true },
    },
    win: {
      icon: path.join(DESKTOP, 'icons', 'icon.ico'),
      signAndEditExecutable: false, // unsigned: skips the winCodeSign download (README: SmartScreen)
    },
    nsis: {
      oneClick: false,
      perMachine: false, // per user: no admin rights
      allowToChangeInstallationDirectory: true,
      artifactName: '${productName}-Setup-${version}.exe',
    },
  },
})

const found = findApp(OUT)
if (!found) { console.error(`Couldn't find the built app under ${OUT}.`); process.exit(1) }
// Electron's sample app, unused (the shell is app.asar).
for (const res of [path.join(found, 'Contents', 'Resources'), path.join(found, 'resources')]) fs.rmSync(path.join(res, 'default_app.asar'), { force: true })
if (mac) execFileSync('codesign', ['--force', '--deep', '--sign', '-', found], { stdio: 'inherit' })
console.log(`Built ${found} (runs ${REPO})`)

if (installDir) {
  fs.mkdirSync(installDir, { recursive: true })
  // Windows: the folder app itself goes to installDir (not a subfolder named win-unpacked).
  const dest = windows ? installDir : path.join(installDir, path.basename(found))
  fs.rmSync(dest, { recursive: true, force: true })
  // ditto keeps the bundle's symlinks, modes and signature intact.
  if (mac) execFileSync('ditto', [found, dest])
  else fs.cpSync(found, dest, { recursive: true, verbatimSymlinks: true })
  console.log(`Installed ${dest}`)
  if (windows) startMenuShortcut(path.join(dest, `${NAME}.exe`))
}

/** A Start Menu shortcut for the installed exe (PowerShell's WScript.Shell; arguments, not a shell string). */
function startMenuShortcut(exe) {
  const dir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  const lnk = path.join(dir, `${NAME}.lnk`)
  fs.mkdirSync(dir, { recursive: true })
  const q = (v) => `'${v.replace(/'/g, "''")}'`
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${q(lnk)});$s.TargetPath=${q(exe)};$s.WorkingDirectory=${q(path.dirname(exe))};$s.Save()`
  try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' }); console.log(`Start Menu shortcut ${lnk}`) }
  catch (e) { console.warn(`Couldn't create the Start Menu shortcut (${e.message}); run ${exe} directly.`) }
}

function findApp(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const p = path.join(dir, e.name)
    if (mac ? e.name === `${NAME}.app` : e.name.endsWith('-unpacked')) return p
    if (!e.name.endsWith('.app')) { const q = findApp(p); if (q) return q }
  }
  return null
}
