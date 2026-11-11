// Shared e2e plumbing: synthetic homes (never the real ~/.claude or ~/.codex) and throwaway servers.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { makeHome, IDS, EXPECTED } from '../test/fixtures/make-home.mjs'

export { IDS, EXPECTED }
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** A port the OS says is free right now (sync, so config and module scope can use it). */
export const freePort = () => Number(spawnSync(process.execPath, ['-e',
  "const s = require('net').createServer().listen(0, '127.0.0.1', () => { process.stdout.write(String(s.address().port)); s.close() })"]).stdout)
// E2E_PORT pins the shared test server's port. Otherwise the first process to load this (the
// Playwright runner) picks a free one and exports it, so its workers and webServer agree on it
// and parallel runs on one machine never collide.
process.env.E2E_PORT ||= process.env.AGENTVILLE_E2E_PORT || String(freePort())
export const PORT = Number(process.env.E2E_PORT)
export const nextPort = freePort
export const BASE = `http://127.0.0.1:${PORT}`
export const HOME = path.join(os.tmpdir(), `agentville-e2e-home-${PORT}`)
export const SHOTS = path.join(ROOT, 'e2e', 'screenshots')
/** The middle of a villager's sprite on the page (needs ?debug), or null when it isn't drawn. */
export async function villagerPoint(page, id) {
  const at = () => page.evaluate((id) => {
    const d = window.villageDebug(), h = d.hits.find((x) => x.id === id), v = d.view, s = v.k * v.px
    return h && { x: (h.x + h.w / 2 - v.vx) * s, y: (h.y + h.h - 8 - v.vy) * s }
  }, id)
  let p = await at()
  for (let i = 0; i < 20; i++) { // wait out a camera pan
    await page.waitForTimeout(100)
    const q = await at()
    if (JSON.stringify(q) === JSON.stringify(p)) break
    p = q
  }
  if (!p) return null
  const cv = await page.locator('#cv').boundingBox()
  return { x: cv.x + p.x, y: cv.y + p.y }
}
// Looks like a credential; must never reach the API or the DOM.
export const SECRET = 'sk-ant-api03-E2EFAKESECRETdoNotLeak0123456789'
/**
 * Applied last to every server the suite starts, so no test can reach a real terminal: "Open" goes
 * to a fake recorder, and the server refuses to auto-detect under AGENTVILLE_TEST. Opting out would
 * mean passing `{ realTerminal: true }` to spawnServer; no test should.
 */
export const FAKE_TERMINAL = fileURLToPath(new URL('../test/fixtures/bin/kitty', import.meta.url))
// Fake claude/codex CLIs come first on PATH, so even the command inside the fake window is a fake.
// AGENTVILLE_FAKE_BIN: the built-in terminal may only ever spawn a CLI from this folder under test.
export const SAFE_ENV = { AGENTVILLE_TEST: '1', AGENTVILLE_TERMINAL: FAKE_TERMINAL, AGENTVILLE_FAKE_BIN: path.dirname(FAKE_TERMINAL), PATH: `${path.dirname(FAKE_TERMINAL)}${path.delimiter}${process.env.PATH}` }

/** Fixture home + a leaked-looking secret in tool I/O + garbage files the scan must survive. */
export function prepareHome(dir = HOME) {
  fs.rmSync(dir, { recursive: true, force: true })
  const env = makeHome(dir)
  const project = path.join(env.AGENTVILLE_CLAUDE_HOME, 'projects', '-work-demo-app')
  const t = new Date().toISOString()
  fs.appendFileSync(path.join(project, `${IDS.leadBuilding}.jsonl`), [
    { type: 'assistant', timestamp: t, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'sec', name: 'Bash', input: { command: `export ANTHROPIC_API_KEY=${SECRET}` } }] } },
    { type: 'user', timestamp: t, message: { content: [{ type: 'tool_result', tool_use_id: 'sec', content: `token=${SECRET}` }] } },
    { type: 'assistant', timestamp: t, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: 'x' } }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')
  // Garbage: binary, truncated JSON, wrong shapes, a directory named like a transcript, bad job state.
  fs.writeFileSync(path.join(project, 'bbbbbbbb-0000-4000-8000-000000000000.jsonl'), Buffer.from([0, 255, 254, 10, 123, 34]))
  fs.writeFileSync(path.join(project, 'cccccccc-0000-4000-8000-000000000000.jsonl'), '{"type":"user","message":{"content":"half\n[1,2,3]\nnull\n"str"\n')
  fs.writeFileSync(path.join(project, 'empty.jsonl'), '')
  fs.mkdirSync(path.join(project, 'dddddddd-0000-4000-8000-000000000000.jsonl'), { recursive: true })
  fs.mkdirSync(path.join(env.AGENTVILLE_CLAUDE_HOME, 'jobs', 'deadbeef'), { recursive: true })
  fs.writeFileSync(path.join(env.AGENTVILLE_CLAUDE_HOME, 'jobs', 'deadbeef', 'state.json'), '{not json')
  fs.writeFileSync(path.join(env.AGENTVILLE_CLAUDE_HOME, 'jobs', 'notes.txt'), 'x')
  const codexDay = path.join(env.AGENTVILLE_CODEX_HOME, 'sessions', '2026', '10', '21')
  fs.writeFileSync(path.join(codexDay, 'rollout-garbage.jsonl'), 'not json at all\n\u0000\u0001')
  fs.writeFileSync(path.join(env.AGENTVILLE_CODEX_HOME, 'state_5.sqlite'), 'this is not a sqlite database')
  return { ...env, AGENTVILLE_DATA_DIR: path.join(dir, 'data') }
}

/** A big home: the base fixture plus `n` extra solos spread over projects and buckets. */
export function prepareBigHome(dir, n = 160) {
  const env = prepareHome(dir)
  const now = Date.now()
  for (let i = 0; i < n; i++) {
    const sid = `e${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`
    const proj = `proj-${i % 12}`
    const folder = path.join(env.AGENTVILLE_CLAUDE_HOME, 'projects', `-work-${proj}`)
    fs.mkdirSync(folder, { recursive: true })
    const ago = (i % 3) * 20_000 + 2_000
    const ts = new Date(now - ago).toISOString()
    const recs = [{ type: 'user', sessionId: sid, cwd: `/work/${proj}`, uuid: `${sid}-u`, timestamp: ts, message: { role: 'user', content: `Task number ${i} for ${proj}` } }]
    recs.push(i % 3 === 0
      ? { type: 'assistant', timestamp: ts, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'c', name: 'Read', input: {} }] } }
      : { type: 'assistant', timestamp: ts, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } })
    const file = path.join(folder, `${sid}.jsonl`)
    fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n')
    fs.utimesSync(file, new Date(now - ago), new Date(now - ago))
    fs.writeFileSync(path.join(env.AGENTVILLE_CLAUDE_HOME, 'sessions', `${sid.slice(0, 8)}.json`), JSON.stringify({ pid: 1, sessionId: sid, kind: 'interactive' }))
  }
  return env
}

// ---------- teardown: nothing a run creates may outlive it ----------
const dirs = new Set()
const children = new Set()
/** A temp dir that is deleted when this process exits. */
export function tmpDir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `agentville-e2e-${name}-`))
  dirs.add(d)
  return d
}
export function cleanupTemp() {
  for (const c of children) try { c.kill('SIGKILL') } catch {}
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs.clear()
}
process.once('exit', cleanupTemp)
// A signal skips 'exit': clean up, then re-raise so the process still dies the default way.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { cleanupTemp(); process.kill(process.pid, sig) })
/** Leftovers from runs that were SIGKILLed (no exit hook): anything ours older than 6 h. */
export function sweepStaleTemp(maxAgeMs = 6 * 3600e3) {
  for (const n of fs.readdirSync(os.tmpdir())) {
    if (!n.startsWith('agentville-e2e-')) continue
    const p = path.join(os.tmpdir(), n)
    try { if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { recursive: true, force: true }) } catch {}
  }
}

// Runs the real entry point, but exits when our stdin pipe closes, i.e. when the test process dies
// for any reason (including SIGKILL), so no server is ever orphaned.
const WATCHDOG = `process.stdin.on('end', () => process.exit(0)); process.stdin.on('error', () => process.exit(0)); process.stdin.resume(); await import(${JSON.stringify(new URL('../server/cli.mjs', import.meta.url).href)})`

/** Spawn the server with a private HOME and XDG_CONFIG_HOME so nothing touches the real ones. */
export function spawnServer(env, { realTerminal = false } = {}) {
  const home = tmpDir('userhome')
  const child = spawn(process.execPath, ['--input-type=module', '-e', WATCHDOG], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), ...env, ...(realTerminal ? {} : SAFE_ENV) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}

/** Start the server on `port` and wait until it is listening. */
export async function startServer(env, port) {
  const child = spawnServer({ ...env, AGENTVILLE_PORT: String(port) })
  let out = ''
  child.stdout.on('data', (c) => (out += c))
  child.stderr.on('data', (c) => (out += c))
  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    if (out.includes('running at')) break
    if (child.exitCode != null) throw new Error(`server exited: ${out}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  return { url, child, output: () => out, stop: () => new Promise((r) => { if (child.exitCode != null) return r(); child.once('exit', r); child.kill() }) }
}

/** Clear every override the server knows about (PATCH needs a same-origin Origin header). */
export async function clearOverrides(request, base = BASE) {
  const { agents } = await (await request.get(`${base}/api/agents`)).json()
  for (const a of agents) if (a.overrides && Object.keys(a.overrides).length) {
    await request.patch(`${base}/api/overrides/${encodeURIComponent(a.id)}`, {
      headers: { origin: base, 'content-type': 'application/json' }, data: { role: null, parentId: null, name: null, hidden: null },
    })
  }
}

export const row = (page, id) => page.locator(`#list .row[data-id="${id}"]`)
/** Right-click an agent's row: its menu (ctxmenu.js, which replaced the inspector). Returns the menu. */
export async function openMenu(page, id) {
  const m = page.locator('#ctxmenu')
  if (await m.isVisible()) await page.keyboard.press('Escape')
  await row(page, id).scrollIntoViewIfNeeded()
  await row(page, id).click({ button: 'right' })
  await m.locator('.cm-name').waitFor()
  return m
}
/** A menu action by its data-cm key (term, open, showvillage, copy, fork, stop, important, edit, hide, unhide). */
export const menuItem = (page, act) => page.locator(`#ctxmenu .cm-item[data-cm="${act}"]`)
/** Where an agent's villager stands on screen (world px -> canvas CSS px), or null when it isn't drawn. */
export function villagerAt(page, id) {
  return page.evaluate((id) => {
    const d = window.villageDebug(), h = d.hits.find((x) => x.id === id), v = d.view, cv = document.getElementById('cv').getBoundingClientRect()
    return h ? { x: cv.left + (h.x + h.w / 2 - v.vx) * v.k * v.px, y: cv.top + (h.y + h.h / 2 - v.vy) * v.k * v.px } : null
  }, id)
}
export const claudeId = (k) => `claude-code:${IDS[k]}`

/** Edge-case names a stranger's sessions will have: long, unbroken, RTL, CJK/emoji, duplicate; plus an unreadable file. */
export const EDGE = {
  long: 'Refactor the authentication middleware so that every request handler validates the session token, refreshes it when it is close to expiry, logs the outcome to the audit trail, and returns a structured error',
  unbroken: 'Supercalifragilisticexpialidocious_and_a_very_long_unbroken_identifier_name_without_any_spaces_whatsoever_1234567890',
  rtl: 'مرحبا بالعالم: إصلاح خطأ في الواجهة',
  cjk: '修复登录页面的布局问题 🚀 émoji ünïcödé',
  dup: 'Explain the build', // same first prompt as the fixture's soloTurn
}
export function prepareEdgeHome(dir) {
  const env = prepareHome(dir)
  const proj = path.join(env.AGENTVILLE_CLAUDE_HOME, 'projects', '-work-demo-app')
  const ts = new Date(Date.now() - 30_000).toISOString()
  const ids = {}
  Object.entries({ ...EDGE, denied: 'Permission denied transcript' }).forEach(([k, text], i) => {
    const sid = `f000000${i}-0000-4000-8000-000000000000`
    ids[k] = `claude-code:${sid}`
    const f = path.join(proj, `${sid}.jsonl`)
    fs.writeFileSync(f, [{ type: 'user', sessionId: sid, cwd: '/work/demo-app', uuid: `${sid}u`, timestamp: ts, message: { role: 'user', content: text } },
      { type: 'assistant', timestamp: ts, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } }].map((r) => JSON.stringify(r)).join('\n') + '\n')
    fs.writeFileSync(path.join(env.AGENTVILLE_CLAUDE_HOME, 'sessions', `${sid.slice(0, 8)}.json`), JSON.stringify({ pid: 1, sessionId: sid, kind: 'interactive' }))
    if (k === 'denied') fs.chmodSync(f, 0o000)
  })
  // A 3-day-old session that shares its name with the live soloError ("Fix lint"): history, not a twin.
  const oldSid = 'f00000aa-0000-4000-8000-000000000000'
  const oldFile = path.join(proj, `${oldSid}.jsonl`)
  const oldTs = new Date(Date.now() - 3 * 86_400_000).toISOString()
  fs.writeFileSync(oldFile, [{ type: 'user', sessionId: oldSid, cwd: '/work/demo-app', uuid: `${oldSid}u`, timestamp: oldTs, message: { role: 'user', content: 'Fix lint' } },
    { type: 'assistant', timestamp: oldTs, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } }].map((r) => JSON.stringify(r)).join('\n') + '\n')
  fs.utimesSync(oldFile, new Date(Date.now() - 3 * 86_400_000), new Date(Date.now() - 3 * 86_400_000))
  ids.restingTwin = `claude-code:${oldSid}`
  // A real Codex state DB: a huge thread title and a spawn edge (codexRunning -> codexTurn).
  const dbFile = path.join(env.AGENTVILLE_CODEX_HOME, 'state_5.sqlite')
  fs.rmSync(dbFile, { force: true })
  const db = new DatabaseSync(dbFile)
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT)')
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(IDS.codexTurn, '/work/codex-app', 'Huge codex title '.repeat(400))
  db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?)').run(IDS.codexRunning, IDS.codexTurn)
  db.close()
  return { env, ids }
}
/** The docked Team view with every team unfolded (bosses start folded), so leads and subagents have rows. */
export async function teamView(page) {
  await page.locator('#view-team').click()
  await page.locator('#list [data-act="expandall"]').click()
}
