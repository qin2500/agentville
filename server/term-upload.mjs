// Images pasted or dropped onto the built-in terminal: saved under <dataDir>/term-uploads and the
// absolute path handed back, which the page types into the terminal (Claude Code reads a path to an
// image as an attachment). Does not depend on the OS clipboard key, so it works the same on Windows.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export const MAX_BYTES = 20 * 1024 * 1024
export const MAX_AGE_MS = 7 * 24 * 3600 * 1000
export const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/** The image type a buffer really is, from its magic bytes; null when it is none of the four. */
export function sniff(buf) {
  if (!buf || buf.length < 12) return null
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', ext: 'png' }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' }
  const head = buf.subarray(0, 6).toString('latin1')
  if (head === 'GIF87a' || head === 'GIF89a') return { type: 'image/gif', ext: 'gif' }
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { type: 'image/webp', ext: 'webp' }
  return null
}

export function createTermUploads({ dataDir, now = () => Date.now() }) {
  const dir = path.join(dataDir, 'term-uploads')
  async function prune() {
    let names
    try { names = await fsp.readdir(dir) } catch { return 0 }
    let n = 0
    for (const name of names) {
      const f = path.join(dir, name)
      try {
        const st = await fsp.stat(f)
        if (st.isFile() && now() - st.mtimeMs > MAX_AGE_MS) { await fsp.unlink(f); n++ }
      } catch { /* gone already */ }
    }
    return n
  }
  async function save(buf) {
    const kind = sniff(buf)
    if (!kind) throw Object.assign(new Error('Not a PNG, JPEG, GIF or WebP image'), { status: 415 })
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    try { await fsp.chmod(dir, 0o700) } catch { /* Windows */ }
    await prune()
    const file = path.join(dir, `${crypto.randomBytes(12).toString('hex')}.${kind.ext}`)
    await fsp.writeFile(file, buf, { mode: 0o600, flag: 'wx' })
    return { path: file, type: kind.type, bytes: buf.length }
  }
  return { dir, save, prune }
}

/**
 * POST /api/term/upload: the raw image as the body. The caller has already checked isLocalRequest.
 * Needs the page's own header and an Origin, an image content type, <= 20 MB, and the right magic bytes.
 * Returns true when the request was one of ours.
 */
export async function termUploadRoute(req, res, url, uploads, send) {
  if (url.pathname !== '/api/term/upload') return false
  if (req.method !== 'POST') { send(res, 405, { error: 'Method not allowed' }); return true }
  if (req.headers['x-agentville-ui'] !== '1' || typeof req.headers.origin !== 'string') { send(res, 403, { ok: false, error: 'Only the Agentville page may upload' }); return true }
  const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  if (!TYPES[ctype]) { send(res, 415, { ok: false, error: 'Expected image/png, image/jpeg, image/gif or image/webp' }); return true }
  const declared = Number(req.headers['content-length'])
  if (declared > MAX_BYTES) { send(res, 413, { ok: false, error: 'Image is over 20 MB' }); return true }
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > MAX_BYTES) { send(res, 413, { ok: false, error: 'Image is over 20 MB' }); req.destroy?.(); return true }
    chunks.push(c)
  }
  try {
    const r = await uploads.save(Buffer.concat(chunks))
    send(res, 200, { ok: true, ...r })
  } catch (e) { send(res, e.status || 500, { ok: false, error: e.status ? e.message : 'Could not save the image' }) }
  return true
}
