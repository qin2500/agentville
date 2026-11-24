// Loads a module that another piece may not have landed yet. Returns the module or null.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function tryLoad(relFromTest) {
  const url = new URL(relFromTest, import.meta.url)
  if (!fs.existsSync(fileURLToPath(url))) return null
  return import(url.href)
}

// Runs fn, normalises "rejected with a 4xx" across return-value and throw styles.
export async function outcome(fn) {
  try {
    const r = await fn()
    if (r && typeof r === 'object') {
      const status = r.status ?? r.code
      if (r.ok === false || (typeof status === 'number' && status >= 400)) return { rejected: true, status, error: r.error ?? r.why ?? r.message, raw: r }
    }
    return { rejected: false, raw: r }
  } catch (e) {
    return { rejected: true, status: e.status ?? e.statusCode ?? e.code, error: e.message, raw: e }
  }
}
