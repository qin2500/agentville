// Ported from Bot Crossing server/local-request.mjs (MIT, Jarren Rocks); see NOTICE.
/** Local-only API guard. Do not trust forwarded headers or equate different ports. */
export function isLocalRequest(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || !/^(localhost|127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?$/.test(host)) return false
  const protocol = req.socket?.encrypted ? 'https:' : 'http:'
  let expected
  try {
    expected = new URL(`${protocol}//${host}`)
  } catch { return false }
  const port = Number(expected.port || (protocol === 'https:' ? 443 : 80))
  if (port !== req.socket?.localPort) return false
  const origin = req.headers.origin
  if (origin !== undefined) {
    // Serialized origins have no credentials, paths, queries, fragments or whitespace.
    // Comparing the literal serialization also rejects null and malformed origins.
    return typeof origin === 'string' && origin === expected.origin
  }
  if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin' && req.headers['sec-fetch-site'] !== 'none') return false
  return req.method === 'GET' || req.method === 'HEAD'
}
