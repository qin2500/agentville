#!/usr/bin/env node
/**
 * `npm run app:build`: package the desktop app (Electron) for this checkout.
 *
 *   npm run app:build                      build dist-app/…/Agentville.app (macOS) or the folder app elsewhere
 *   npm run app:build -- --install         …and copy it to ~/Applications (replacing an older copy)
 *   npm run app:build -- --install DIR     …or to DIR
 *   npm run app:build -- --repo DIR        run the checkout at DIR instead of this one
 *
 * The app holds only the shell (desktop/*). It runs the server and page from this checkout, whose
 * path is baked into the app (Resources/repo-path), so pulling new code here updates the app too.
 * macOS: signed ad hoc (codesign -s -); the icon is drawn by tools/macos-launcher/DrawIcon.swift.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const DESKTOP = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(DESKTOP, '..')
const BUILD = path.join(DESKTOP, '.build')
const OUT = path.join(ROOT, 'dist-app')
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'))
const NAME = pkg.productName
const mac = process.platform === 'darwin'

const args = process.argv.slice(2)
const installAt = args.indexOf('--install')
const repoAt = args.indexOf('--repo')
const REPO = repoAt < 0 ? ROOT : path.resolve(args[repoAt + 1] || '')
if (!fs.existsSync(path.join(REPO, 'server', 'cli.mjs'))) { console.error(`${REPO} isn't a checkout (no server/cli.mjs).`); process.exit(1) }
const installDir = installAt < 0 ? null : (args[installAt + 1] && !args[installAt + 1].startsWith('--') ? path.resolve(args[installAt + 1]) : path.join(os.homedir(), 'Applications'))

fs.rmSync(BUILD, { recursive: true, force: true })
fs.mkdirSync(BUILD, { recursive: true })
// The checkout this app runs, read verbatim by main.cjs (a plain file: any character is safe).
fs.writeFileSync(path.join(BUILD, 'repo-path'), REPO)

// Requiring electron downloads its binary on first use (it has no install script).
require('electron')
const electronVersion = JSON.parse(fs.readFileSync(require.resolve('electron/package.json'), 'utf8')).version

let icon = null
if (mac && has('swiftc') && has('iconutil')) {
  const draw = path.join(BUILD, 'draw-icon'), png = path.join(BUILD, 'icon.png'), set = path.join(BUILD, 'icon.iconset')
  execFileSync('swiftc', ['-O', path.join(ROOT, 'tools', 'macos-launcher', 'DrawIcon.swift'), '-o', draw], { stdio: 'inherit' })
  execFileSync(draw, [png], { stdio: 'inherit' })
  fs.mkdirSync(set)
  for (const s of [16, 32, 128, 256, 512]) {
    execFileSync('sips', ['-z', String(s), String(s), png, '--out', path.join(set, `icon_${s}x${s}.png`)], { stdio: 'ignore' })
    execFileSync('sips', ['-z', String(s * 2), String(s * 2), png, '--out', path.join(set, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' })
  }
  icon = path.join(BUILD, 'icon.icns')
  execFileSync('iconutil', ['-c', 'icns', set, '-o', icon])
} else if (mac) {
  console.log('No swiftc/iconutil (xcode-select --install): building with the default Electron icon.')
}

const { build, Platform } = require('electron-builder')
fs.rmSync(OUT, { recursive: true, force: true })
await build({
  projectDir: ROOT,
  targets: (mac ? Platform.MAC : process.platform === 'win32' ? Platform.WINDOWS : Platform.LINUX).createTarget('dir'),
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
      ...(icon && { icon }),
      identity: null, // signed ad hoc below
      category: 'public.app-category.developer-tools',
      extendInfo: { NSHighResolutionCapable: true },
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
  const dest = path.join(installDir, path.basename(found))
  fs.rmSync(dest, { recursive: true, force: true })
  // ditto keeps the bundle's symlinks, modes and signature intact.
  if (mac) execFileSync('ditto', [found, dest])
  else fs.cpSync(found, dest, { recursive: true, verbatimSymlinks: true })
  console.log(`Installed ${dest}`)
}

function has(cmd) { return spawnSync('/usr/bin/which', [cmd], { stdio: 'ignore' }).status === 0 }
function findApp(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const p = path.join(dir, e.name)
    if (mac ? e.name === `${NAME}.app` : e.name.endsWith('-unpacked')) return p
    if (!e.name.endsWith('.app')) { const q = findApp(p); if (q) return q }
  }
  return null
}
