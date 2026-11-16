import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeHome } from '../fixtures/make-home.mjs'
import { createServer } from '../../server/serve.mjs'

/**
 * Run fn({ base, dataDir, port, root }) against a throwaway server on port 0.
 * Fixture homes only; env is restored and the temp root removed afterwards.
 * Pass { dataDir } to reuse a data dir (it must live under a temp dir you own).
 */
export async function withServer(fn, { dataDir, env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'village-ws-'))
  const saved = { ...process.env }
  Object.assign(process.env, makeHome(root), env)
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]
  const dir = dataDir || path.join(root, 'data')
  const server = createServer({ dataDir: dir })
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    return await fn({ base: `http://127.0.0.1:${port}`, dataDir: dir, port, root })
  } finally {
    await new Promise((r) => server.close(r))
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
    fs.rmSync(root, { recursive: true, force: true })
  }
}
