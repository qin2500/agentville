'use strict'
/**
 * The desktop app, the only way to use Agentville: a thin Electron shell around the local server and its page.
 *
 * It finds the checkout (see shell.cjs resolveSettings), reuses a server already answering on the
 * port or starts `node server/cli.mjs` from the checkout itself, then shows http://127.0.0.1:<port>/
 * in one window. Since the server and page always come from the checkout, pulling new code there
 * (and restarting the server) updates the app without rebuilding it.
 *
 * Only a server this app started is ever stopped (on Quit). Agent sessions are never touched.
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { app, BrowserWindow, Menu, shell, dialog, screen, clipboard, nativeImage } = require('electron')
const S = require('./shell.cjs')

const { BRAND } = S
const env = process.env

// Tests (and anyone who wants a second profile) point the app at another profile folder.
if (env[S.envKey('DESKTOP_USER_DATA')]) app.setPath('userData', path.resolve(env[S.envKey('DESKTOP_USER_DATA')]))
app.setName(BRAND.name)
// Chromium would otherwise keep a cookie-encryption key in the macOS Keychain. The page keeps
// nothing secret in cookies, and an ad-hoc signed app would ask for the Keychain password after
// every rebuild, so use Chromium's in-memory stand-in instead.
app.commandLine.appendSwitch('use-mock-keychain')
// <ENV>_HEADLESS_TEST=1 (set by the test harness): never show a window, take focus or appear in the
// Dock, so test runs don't interrupt whoever is using the machine. The page still renders.
const HEADLESS = env[S.envKey('HEADLESS_TEST')] === '1'
if (HEADLESS && process.platform === 'darwin') try { app.setActivationPolicy('accessory') } catch { /* again once ready */ }

const USER_DATA = app.getPath('userData')
const CONFIG_FILE = path.join(USER_DATA, 'config.json')
const STATE_FILE = path.join(USER_DATA, 'window-state.json')
const LOG_FILE = path.join(USER_DATA, 'server.log')
const BAKED_REPO = app.isPackaged ? path.join(process.resourcesPath, 'repo-path') : null
const DEV_REPO = app.isPackaged ? null : path.resolve(__dirname, '..')

let win = null
let settings = null
let origin = null
/** The server this app started: { child, exited } or null when it reuses one (or none yet). */
let owned = null
let quitting = false
let booting = false

function log(...parts) {
  try { fs.appendFileSync(path.join(USER_DATA, 'app.log'), `${new Date().toISOString()} ${parts.join(' ')}\n`) } catch { /* best effort */ }
}

// ---------- the server ----------

/** Start `node server/cli.mjs` in the checkout. Output goes to server.log in the app's profile. */
function startServer() {
  const node = S.findNode({ env })
  const childEnv = { ...env, PATH: S.augmentedPath(env.PATH || ''), [S.envKey('PORT')]: String(settings.port), [S.envKey('DESKTOP')]: '1' }
  delete childEnv.ELECTRON_RUN_AS_NODE
  let bin = node?.bin
  if (!bin) { // last resort: Electron's own Node (native modules may not load, npm isn't next to it)
    bin = process.execPath
    childEnv.ELECTRON_RUN_AS_NODE = '1'
    log('no system Node >= 22.13 found; using Electron as Node')
  }
  fs.mkdirSync(USER_DATA, { recursive: true })
  const out = fs.openSync(LOG_FILE, 'w')
  const child = spawn(bin, [path.join('server', 'cli.mjs')], { cwd: settings.repo, env: childEnv, stdio: ['ignore', out, out] })
  fs.closeSync(out)
  const me = { child, exited: false, code: null }
  owned = me
  log('started server pid', child.pid, 'with', bin, node ? node.version : '(electron)', 'in', settings.repo)
  child.on('error', (e) => { log('server spawn error', e.message); me.exited = true })
  child.on('exit', (code, signal) => {
    me.exited = true
    me.code = code
    log('server exited', code, signal || '')
    if (owned !== me) return
    owned = null
    if (quitting) return
    if (code === S.RESTART_EXIT) restartAfterUpdate()
    else if (!booting) offerRestart(code, signal)
  })
  return me
}

/** Stop the server this app started (never one it didn't). Resolves when it has exited. */
function stopServer(ms = 8000) {
  const me = owned
  if (!me || me.exited) { owned = null; return Promise.resolve() }
  owned = null
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); resolve() }
    me.child.once('exit', done)
    const t = setTimeout(() => { try { me.child.kill('SIGKILL') } catch {} resolve() }, ms)
    try { me.child.kill('SIGTERM') } catch { done() }
  })
}

/** Reuse a running server or start one; resolves true once the page can load. */
async function ensureServer() {
  let state = await S.probe(settings.port)
  if (state === 'other') { // maybe another start is mid-way; give it a moment
    for (let i = 0; i < 10 && state === 'other'; i++) { await sleep(500); state = await S.probe(settings.port) }
  }
  if (state === 'ours') { log('reusing the server on port', settings.port); return true }
  if (state === 'other') {
    fail(`Port ${settings.port} is in use by another app.`, `Quit that app, or pick another port in ${CONFIG_FILE} ({"port": 5276}).`)
    return false
  }
  const me = startServer()
  // The first run builds the web app, so allow a couple of minutes.
  const ok = await S.waitReady(settings.port, { ms: 180_000, stop: () => me.exited })
  if (!ok) {
    fail(`${BRAND.name}'s server didn't start.`, `${tail(LOG_FILE)}\n\nFull log: ${LOG_FILE}`)
    await stopServer()
    return false
  }
  return true
}

async function restartAfterUpdate() {
  log('server asked to be restarted (update)')
  booting = true
  try {
    if (await ensureServer()) win?.webContents.reloadIgnoringCache()
  } finally { booting = false }
}

async function restartServer() {
  if (!owned) {
    if (HEADLESS) return
    await dialog.showMessageBox(win, {
      type: 'info', message: `${BRAND.name} is using a server it didn't start.`,
      detail: `Restart it where it was started (for example the terminal running npm start). The app never stops a server it didn't start.`,
    })
    return
  }
  booting = true
  try {
    await stopServer()
    if (await ensureServer()) win?.webContents.reloadIgnoringCache()
  } finally { booting = false }
}

async function offerRestart(code, signal) {
  if (HEADLESS) return
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Restart Server', 'Later'], defaultId: 0, cancelId: 1,
    message: `${BRAND.name}'s server stopped.`, detail: `It exited with ${signal || `code ${code}`}. Log: ${LOG_FILE}`,
  })
  if (response === 0 && !owned) {
    booting = true
    try { if (await ensureServer()) win?.webContents.reloadIgnoringCache() } finally { booting = false }
  }
}

function tail(file, lines = 12) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-lines).join('\n') } catch { return '' }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fail(message, detail) {
  log('error:', message)
  if (HEADLESS || env[S.envKey('DESKTOP_TEST')] === '1') return // tests read app.log instead of clicking a dialog
  dialog.showMessageBoxSync({ type: 'warning', message, detail })
}

// ---------- the window ----------

function loadState() { return S.readJSON(STATE_FILE) || {} }
let saveTimer = null
function saveState() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return
    const state = { ...win.getNormalBounds(), maximized: win.isMaximized(), fullscreen: win.isFullScreen() }
    try { fs.mkdirSync(USER_DATA, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state)) } catch { /* best effort */ }
  }, 300)
}

function openExternal(url) {
  if (S.isExternal(url)) shell.openExternal(url).catch((e) => log('openExternal failed', e.message))
}

function createWindow() {
  const saved = loadState()
  const bounds = S.placeWindow(saved, screen.getAllDisplays().map((d) => d.workArea))
  win = new BrowserWindow({
    ...bounds,
    minWidth: 360, minHeight: 320,
    title: BRAND.name,
    backgroundColor: '#0f1115', // the page's --bg, so there is no white flash
    show: false,
    ...(HEADLESS && { paintWhenInitiallyHidden: true, focusable: false, skipTaskbar: true }),
    webPreferences: {
      ...(HEADLESS && { backgroundThrottling: false }),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // No preload: the page gets no Node or Electron access.
    },
  })
  if (saved.maximized && !HEADLESS) win.maximize() // maximize() would also show it
  if (!HEADLESS) win.once('ready-to-show', () => win.show())
  for (const ev of ['resize', 'move']) win.on(ev, saveState)
  // macOS: closing the window hides it, so notifications and chimes carry on. The Dock icon brings
  // it back; Quit really quits.
  win.on('close', (e) => {
    saveState()
    if (process.platform === 'darwin' && !quitting) { e.preventDefault(); if (win.isFullScreen()) win.setFullScreen(false); win.hide() }
  })
  win.on('closed', () => { win = null })

  const wc = win.webContents
  // Links that open a new window (PR links, the README) go to the default browser.
  wc.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' } })
  // The window itself only ever shows the local server.
  const guard = (e, url) => {
    if (origin && S.isLocal(url, origin)) return
    e.preventDefault()
    openExternal(url)
  }
  wc.on('will-navigate', guard)
  wc.on('will-redirect', guard)
  wc.on('will-attach-webview', (e) => e.preventDefault())
  wc.on('context-menu', (_e, p) => contextMenu(p))

  const ses = wc.session
  const allowed = (perm, url) => S.ALLOWED_PERMISSIONS.has(perm) && !!origin && S.isLocal(url || '', origin)
  ses.setPermissionRequestHandler((_wc, perm, cb, details) => cb(allowed(perm, details?.requestingUrl || _wc.getURL())))
  ses.setPermissionCheckHandler((_wc, perm, requestingOrigin) => allowed(perm, requestingOrigin))

  win.loadFile(path.join(__dirname, 'loading.html'))
  return win
}

function showWindow() {
  if (!win) { createWindow(); if (origin && !booting) win.loadURL(`${origin}/`) }
  if (HEADLESS) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Right-click: what Chrome offers for text and links, nothing else. */
function contextMenu(p) {
  const items = []
  if (p.linkURL && S.isExternal(p.linkURL) && !S.isLocal(p.linkURL, origin)) {
    items.push({ label: 'Open Link in Browser', click: () => openExternal(p.linkURL) })
    items.push({ label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) })
  }
  if (p.isEditable) {
    if (items.length) items.push({ type: 'separator' })
    items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy },
      { role: 'paste', enabled: p.editFlags.canPaste }, { role: 'selectAll' })
  } else if (p.selectionText) {
    if (items.length) items.push({ type: 'separator' })
    items.push({ role: 'copy' })
  }
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
}

function buildMenu() {
  const mac = process.platform === 'darwin'
  const template = [
    ...(mac ? [{
      label: BRAND.name,
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { label: 'Restart Server', click: () => restartServer() },
        { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Show Server Log', click: () => shell.showItemInFolder(LOG_FILE) },
        ...(mac ? [] : [{ label: 'Restart Server', click: () => restartServer() }]),
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' },
        // Cmd-= zooms in as in Chrome (the visible item above is Cmd-+).
        { role: 'zoomIn', accelerator: 'CommandOrControl+=', visible: false, acceleratorWorksWhenHidden: true },
        { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------- start-up and quit ----------

async function boot() {
  booting = true
  try {
    settings = S.resolveSettings({ env, configFile: CONFIG_FILE, bakedRepoFile: BAKED_REPO, devRepo: DEV_REPO })
    for (const p of settings.problems) log('ignored:', p)
    origin = `http://127.0.0.1:${settings.port}`
    log('boot: port', settings.port, `(${settings.sources.port})`, 'checkout', settings.repo, `(${settings.sources.repo})`)
    if (!settings.repo) {
      // A server may already be up even without a checkout here (say, started by hand); use it.
      if ((await S.probe(settings.port)) !== 'ours') {
        fail(`${BRAND.name} can't find its checkout.`, `Rebuild the app from the checkout (npm run app:build), or set "repo" in ${CONFIG_FILE}.`)
        app.quit()
        return
      }
    } else if (!(await ensureServer())) {
      app.quit()
      return
    }
    if (!win) createWindow()
    await win.loadURL(`${origin}/`)
  } finally { booting = false }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.on('activate', () => { if (app.isReady()) showWindow() })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('before-quit', (e) => {
    quitting = true
    if (owned && !owned.exited) {
      e.preventDefault()
      log('quit: stopping the server this app started')
      stopServer().finally(() => app.quit())
    }
  })
  app.whenReady().then(() => {
    if (HEADLESS && process.platform === 'darwin') { app.setActivationPolicy('accessory'); app.dock?.hide() }
    if (process.platform === 'darwin' && !app.isPackaged && !HEADLESS) {
      const icon = path.join(__dirname, '.build', 'icon.png')
      if (fs.existsSync(icon)) app.dock?.setIcon(nativeImage.createFromPath(icon))
    }
    buildMenu()
    createWindow()
    return boot()
  }).catch((e) => { log('boot failed', e.stack || e.message); fail(`${BRAND.name} couldn't start.`, e.message); app.quit() })
}
