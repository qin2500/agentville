/**
 * A fake Anthropic OAuth API on 127.0.0.1 for the accounts feature (unit and e2e). Never the real
 * one. Serves `GET /api/oauth/profile`, `GET /api/oauth/usage` and `POST /v1/oauth/token`, with
 * rotating refresh tokens like the real one: a used refresh token stops working.
 *
 *   const api = await fakeAnthropic({ A: { email, five: 12, week: 40, fiveResetsIn?: ms, status?: 401 }, B: { … } })
 *   (mutate those objects to change what the next call returns)
 *   api.env       // AGENTVILLE_ANTHROPIC_API + AGENTVILLE_OAUTH_TOKEN_URL for the server
 *   api.cred('A') // a credential JSON text for A, as Claude Code stores it (fresh tokens)
 *   api.requests  // [{ path, account, refreshToken? }]
 */
import http from 'node:http'

export const UUID = { A: 'aaaaaaaa-1111-4111-8111-111111111111', B: 'bbbbbbbb-2222-4222-8222-222222222222', C: 'cccccccc-3333-4333-8333-333333333333' }
/** Every token this fake hands out starts with this, so tests can grep responses and logs for it. */
export const TOKEN_MARK = 'tok-SECRET-'

export async function fakeAnthropic(accounts) {
  const access = new Map() // token -> key
  const refresh = new Map() // token -> key
  const requests = []
  let n = 0
  const mint = (key) => {
    n++
    const at = `${TOKEN_MARK}at-${key}-${n}`, rt = `${TOKEN_MARK}rt-${key}-${n}`
    access.set(at, key)
    refresh.set(rt, key)
    return { at, rt }
  }
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1]
    const key = bearer && access.get(bearer)
    if (req.url === '/v1/oauth/token' && req.method === 'POST') {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      const k = refresh.get(body.refresh_token)
      requests.push({ path: req.url, account: k || null, refreshToken: body.refresh_token, clientId: body.client_id, grant: body.grant_type })
      if (!k) return json(400, { error: 'invalid_grant' })
      refresh.delete(body.refresh_token) // rotation: the old one is spent
      const t = mint(k)
      return json(200, { access_token: t.at, refresh_token: t.rt, expires_in: 3600, token_type: 'Bearer' })
    }
    requests.push({ path: req.url, account: key || null, beta: req.headers['anthropic-beta'] })
    if (!key) return json(401, { error: { type: 'authentication_error', message: `bad token ${bearer}` } })
    const a = accounts[key]
    if (req.url === '/api/oauth/profile') return json(200, { account: { uuid: UUID[key], email: a.email, full_name: 'Test' }, organization: { uuid: 'org', name: 'Org' } })
    if (req.url === '/api/oauth/usage') {
      if (a.status) return json(a.status, { error: 'nope' })
      return json(200, {
        // `five: null`: an account Anthropic has taken the 5-hour limit off.
        five_hour: a.five === null ? null : { utilization: a.five, resets_at: new Date(Date.now() + (a.fiveResetsIn ?? 2 * 3600e3)).toISOString() },
        seven_day: { utilization: a.week, resets_at: new Date(Date.now() + 3 * 86400e3).toISOString() },
        seven_day_opus: null,
      })
    }
    json(404, { error: 'not found' })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    env: { AGENTVILLE_ANTHROPIC_API: base, AGENTVILLE_OAUTH_TOKEN_URL: `${base}/v1/oauth/token` },
    requests,
    /** A credential text for `key`; `expiresAt` defaults to an hour from now. */
    cred(key, { expiresAt = Date.now() + 3600e3, subscriptionType = 'max' } = {}) {
      const t = mint(key)
      return JSON.stringify({ claudeAiOauth: { accessToken: t.at, refreshToken: t.rt, expiresAt, scopes: ['user:inference', 'user:profile'], subscriptionType, rateLimitTier: 'default' } })
    },
    oauthAccount: (key) => ({ accountUuid: UUID[key], emailAddress: accounts[key].email, organizationUuid: 'org' }),
    close: () => new Promise((r) => server.close(r)),
  }
}
