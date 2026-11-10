// The desktop app (desktop/main.cjs) launched for real with Playwright's Electron driver, against
// fixture servers only: a private HOME, profile folder and fixture agent homes, the fake terminal,
// and shell.openExternal stubbed so no browser ever opens. Every launch is hidden (<ENV>_HEADLESS_TEST):
// no window on screen, no focus taken, no Dock icon. Screenshots come from webContents.capturePage().
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, _electron as electron, chromium } from '@playwright/test'
import { prepareHome, startServer, tmpDir, freePort, SAFE_ENV, ROOT } from '../e2e/helpers.mjs'

const BRAND = 'Agentville'
const ENV = 'AGENTVILLE'
const SHOTS = process.env.APP_SHOTS_DIR || '/tmp/vshots'

/** Env for one app launch: everything private, pointed at this checkout and `port`. */
function appEnv(port, { home = tmpDir('apphome'), extra = {} } = {}) {
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    [`${ENV}_DESKTOP_USER_DATA`]: path.join(home, 'profile'), [`${ENV}_DESKTOP_TEST`]: '1', [`${ENV}_HEADLESS_TEST`]: '1',
    [`${ENV}_DESKTOP_REPO`]: ROOT, [`${ENV}_PORT`]: String(port), ...SAFE_ENV, ...extra,
  }
  delete env.ELECTRON_RUN_AS_NODE
  return { env, home, profile: env[`${ENV}_DESKTOP_USER_DATA`] }
}

async function launch(env) {
  const app = await electron.launch({ args: [path.join(ROOT, 'desktop')], env })
  // Record instead of opening the default browser.
  await app.evaluate(({ shell }) => { globalThis.opened = []; shell.openExternal = async (url) => { globalThis.opened.push(url) } })
  return app
}
/** The app's one window, once it shows the local server (not the "Starting…" page). */
async function mainPage(app, base) {
  // Going from the local "Starting…" file to the server can swap the renderer, so look the page up again.
  let page = null
  await expect.poll(() => (page = app.windows().find((p) => !p.isClosed() && p.url() === `${base}/`)) != null, { timeout: 120_000 }).toBe(true)
  await page.locator('.main').waitFor()
  return page
}
const listening = async (url) => { try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok } catch { return false } }

test.describe('reusing a running server', () => {
  let server, base
  test.beforeAll(async () => {
    const port = freePort()
    server = await startServer({ ...prepareHome(tmpDir('home')), [`${ENV}_DATA_DIR`]: tmpDir('data') }, port)
    base = server.url
  })
  test.afterAll(async () => { await server?.stop() })

  test('loads the page like a browser tab, links go outside, and Quit leaves the server running', async () => {
    const { env } = appEnv(new URL(base).port)
    const app = await launch(env)
    const page = await mainPage(app, base)
    await expect(page).toHaveTitle(new RegExp(`${BRAND}$`)) // "(4) Agentville" when agents wait, as in a tab

    // First run: the expanded Team view, as in the browser.
    await expect(page.locator('.main')).toHaveClass(/\bfull\b/)
    await expect(page.locator('#view-team')).toHaveAttribute('aria-pressed', 'true')
    // The page's own keys reach it (no menu accelerator swallows them): V cycles the views.
    await page.locator('body').press('v')
    await expect(page.locator('#view-tree')).toHaveAttribute('aria-pressed', 'true')
    expect(await page.evaluate(() => localStorage.getItem('va.view'))).toContain('tree')
    await expect(page.locator('.tv .tnode').first()).toBeVisible()

    // A new-window link (PR chips, the README) opens in the default browser, not in the app.
    await page.evaluate(() => window.open('https://github.com/example/repo/pull/7', '_blank', 'noopener'))
    await page.evaluate(() => {
      const a = Object.assign(document.createElement('a'), { href: 'https://github.com/example/repo/pull/8', target: '_blank', rel: 'noopener noreferrer', id: 'ext-test', textContent: 'PR' })
      document.body.append(a)
    })
    await page.locator('#ext-test').click()
    // So does a link that would replace the page; the window stays on the local server.
    await page.evaluate(() => { location.href = 'https://example.com/elsewhere' })
    await expect.poll(() => app.evaluate(() => globalThis.opened)).toEqual([
      'https://github.com/example/repo/pull/7', 'https://github.com/example/repo/pull/8', 'https://example.com/elsewhere',
    ])
    const here = () => page.evaluate(() => location.href)
    expect(await here()).toBe(`${base}/`)
    expect(app.windows()).toHaveLength(1)
    // Other schemes go nowhere.
    await page.evaluate(() => { location.href = 'file:///etc/hosts' })
    await page.waitForTimeout(300)
    expect(await here()).toBe(`${base}/`)
    expect(await app.evaluate(() => globalThis.opened.length)).toBe(3)

    // Browser features the page uses: notifications (opt-in in Settings) and clipboard writes.
    expect(await page.evaluate(() => Notification.permission)).toBe('granted')
    const before = await app.evaluate(({ clipboard }) => clipboard.readText())
    try {
      await page.evaluate(() => navigator.clipboard.writeText('claude --resume e2e-check'))
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('claude --resume e2e-check')
    } finally {
      await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), before)
    }
    // Locked down: no Node in the page.
    expect(await page.evaluate(() => typeof require + typeof process)).toBe('undefinedundefined')
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
      return { contextIsolation: w.contextIsolation, nodeIntegration: w.nodeIntegration, sandbox: w.sandbox, preload: w.preload || null }
    })
    expect(prefs).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true, preload: null })

    // The menu: Reload, zoom, Copy/Paste, DevTools under View; no single-key shortcuts.
    const menu = await app.evaluate(({ Menu }) => {
      const out = []
      const walk = (m, top) => m.items.forEach((i) => { out.push({ top, role: i.role || null, label: i.label, acc: i.accelerator || null }); if (i.submenu) walk(i.submenu, top || i.label) })
      walk(Menu.getApplicationMenu(), null)
      return out
    })
    const roles = menu.map((i) => i.role?.toLowerCase())
    for (const r of ['reload', 'zoomin', 'zoomout', 'resetzoom', 'copy', 'paste', 'quit']) expect(roles).toContain(r)
    expect(menu.find((i) => i.role?.toLowerCase() === 'toggledevtools')?.top).toBe('View')
    expect(menu.filter((i) => i.acc && !/[+]/.test(i.acc))).toEqual([])

    await app.close()
    expect(await listening(`${base}/api/agents`)).toBe(true) // never stops a server it didn't start
  })

  test('remembers the window size and position', async () => {
    const { env } = appEnv(new URL(base).port)
    let app = await launch(env)
    await mainPage(app, base)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 120, y: 140, width: 1000, height: 700 }))
    await new Promise((r) => setTimeout(r, 800))
    await app.close()
    app = await launch(env)
    await mainPage(app, base)
    const b = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
    expect(b).toMatchObject({ x: 120, y: 140, width: 1000, height: 700 })
    await app.close()
  })

  test('looks the same as the browser at the same size (screenshots in /tmp/vshots)', async () => {
    const W = 1440, H = 900
    const { env } = appEnv(new URL(base).port)
    const app = await launch(env)
    const page = await mainPage(app, base)
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [W, H])
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([W, H])
    const dpr = await page.evaluate(() => devicePixelRatio)
    const browser = await chromium.launch()
    const tab = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: dpr })).newPage()
    await tab.goto(`${base}/`)
    await tab.locator('.main').waitFor()
    // Same moment in both: let each settle, then shoot.
    await Promise.all([page.waitForTimeout(2500), tab.waitForTimeout(2500)])
    fs.mkdirSync(SHOTS, { recursive: true })
    const [a, b] = await Promise.all([
      // The window is hidden, so shoot its contents the way Electron does it.
      app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
        .then((b64) => { const buf = Buffer.from(b64, 'base64'); fs.writeFileSync(path.join(SHOTS, 'electron-app.png'), buf); return buf }),
      tab.screenshot({ path: path.join(SHOTS, 'electron-browser.png') }),
    ])
    // Pixel diff in a page (no image library needed). The village canvas animates, so it is
    // reported separately from the panel, which must match.
    const diff = await tab.evaluate(async ([a, b]) => {
      const load = async (s) => createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob())
      const [ia, ib] = await Promise.all([load(a), load(b)])
      if (ia.width !== ib.width || ia.height !== ib.height) return { sizeA: [ia.width, ia.height], sizeB: [ib.width, ib.height] }
      const w = ia.width, h = ia.height
      const px = (img) => { const c = new OffscreenCanvas(w, h).getContext('2d'); c.drawImage(img, 0, 0); return c.getImageData(0, 0, w, h).data }
      const da = px(ia), db = px(ib)
      const out = new OffscreenCanvas(w, h), oc = out.getContext('2d'), od = oc.createImageData(w, h)
      const cv = document.querySelector('#cv')?.getBoundingClientRect()
      const k = w / innerWidth
      let all = 0, outside = 0, outsideTotal = 0
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 24
        const inCanvas = cv && x >= cv.left * k && x < cv.right * k && y >= cv.top * k && y < cv.bottom * k
        if (!inCanvas) outsideTotal++
        if (d) { all++; if (!inCanvas) outside++ }
        od.data[i] = d ? 255 : da[i] / 3; od.data[i + 1] = d ? 0 : da[i + 1] / 3; od.data[i + 2] = d ? 0 : da[i + 2] / 3; od.data[i + 3] = 255
      }
      oc.putImageData(od, 0, 0)
      const png = await out.convertToBlob({ type: 'image/png' })
      const bytes = new Uint8Array(await png.arrayBuffer())
      let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return { w, h, all: all / (w * h), outsideCanvas: outsideTotal ? outside / outsideTotal : 0, png: btoa(bin) }
    }, [a.toString('base64'), b.toString('base64')])
    expect(diff.sizeA, 'same pixel size').toBeUndefined()
    fs.writeFileSync(path.join(SHOTS, 'electron-diff.png'), Buffer.from(diff.png, 'base64'))
    const summary = { size: [W, H], devicePixelRatio: dpr, differingPixels: diff.all, differingOutsideVillageCanvas: diff.outsideCanvas }
    fs.writeFileSync(path.join(SHOTS, 'electron-compare.json'), JSON.stringify(summary, null, 2))
    console.log('screenshot comparison', JSON.stringify(summary))
    expect(diff.outsideCanvas).toBeLessThan(0.03) // text antialiasing differs slightly between a headless tab and a window
    await browser.close()
    await app.close()
  })
})

test('starts its own server when none is running, and Quit stops only that one', async () => {
  const port = freePort()
  const base = `http://127.0.0.1:${port}`
  const fixture = prepareHome(tmpDir('home'))
  const { env, profile } = appEnv(port, { extra: { ...fixture, [`${ENV}_DATA_DIR`]: tmpDir('data') } })
  expect(await listening(`${base}/api/agents`)).toBe(false)
  const app = await launch(env)
  const page = await mainPage(app, base)
  await expect(page.locator('#view-team')).toHaveAttribute('aria-pressed', 'true')
  expect(await listening(`${base}/api/agents`)).toBe(true)
  expect(fs.readFileSync(path.join(profile, 'app.log'), 'utf8')).toMatch(/started server pid \d+/)
  expect(fs.readFileSync(path.join(profile, 'server.log'), 'utf8')).toContain(`running at ${base}/`)
  // Never shown under the test flag, so it can't take focus.
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false)
  // Closing the window keeps the app (macOS) and the server.
  if (process.platform === 'darwin') {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    expect(await listening(`${base}/api/agents`)).toBe(true)
  }
  await app.close()
  await expect.poll(() => listening(`${base}/api/agents`), { timeout: 15_000 }).toBe(false)
  expect(fs.readFileSync(path.join(profile, 'app.log'), 'utf8')).toContain('quit: stopping the server this app started')
})

test('reports a port held by another app instead of starting a second server', async () => {
  const http = await import('node:http')
  const other = await new Promise((r) => { const s = http.createServer((_q, res) => res.end('<title>Not us</title>')).listen(0, '127.0.0.1', () => r(s)) })
  try {
    const { env, profile } = appEnv(other.address().port)
    const app = await electron.launch({ args: [path.join(ROOT, 'desktop')], env })
    await new Promise((r) => app.process().once('exit', r))
    expect(fs.readFileSync(path.join(profile, 'app.log'), 'utf8')).toContain(`Port ${other.address().port} is in use by another app.`)
    expect(fs.readFileSync(path.join(profile, 'app.log'), 'utf8')).not.toContain('started server')
  } finally { other.close() }
})
