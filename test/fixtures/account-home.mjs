/**
 * A fake Claude home on the "pool", with jobs, transcripts and a fake `claude`, for the account
 * switch (unit tests and e2e). Never the real ~/.claude.
 *
 *   const { env, log, files, TOKEN } = makeAccountHome(root)
 *   // start the server with { ...env, AGENTVILLE_DATA_DIR }; set FAKE_* in the server's env to steer the fake.
 *
 * The fake `claude` records each argv as a JSON line in `log`, and obeys (from its environment):
 *   FAKE_AUTH         personal (default) | gateway | none   -> `auth status --json` answer
 *   FAKE_RESPAWN_FAIL N        the Nth `respawn` call exits 7
 *   FAKE_RESPAWN_MS   ms       each respawn takes this long
 *   FAKE_NO_LIVE      1        a respawned job never comes back (no registry entry)
 *   FAKE_CLOBBER      1        a respawned job's state.json gets `--model cc/…` written back
 *   FAKE_REPLY        ok | synthetic   a respawned job replies (synthetic = API error message)
 */
import fs from 'node:fs'
import path from 'node:path'

export const TOKEN = 'dummy-pool-token-DO-NOT-LEAK-123'
export const SETTINGS = {
  permissions: { allow: ['Bash(ls:*)'] },
  model: 'opus',
  env: {
    KEEP_ME: 'yes',
    ANTHROPIC_BASE_URL: 'https://gateway.example',
    ANTHROPIC_AUTH_TOKEN: TOKEN,
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'cc/claude-opus-5-5',
    CLAUDE_CODE_SUBAGENT_MODEL: 'cc/claude-sonnet-5-5',
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    ALSO_KEEP: 'x',
  },
  hooks: {},
}
export const JOBS = {
  aaaa0001: { state: 'working', tempo: 'active', respawnFlags: ['--name', 'API Lead', '--model', 'cc/claude-opus-5-5'], providerEnv: { CLAUDE_CODE_SUBAGENT_MODEL: 'cc/claude-sonnet-5-5', OTHER: '1' } },
  aaaa0002: { state: 'blocked', tempo: 'blocked', respawnFlags: ['--model=cc/claude-sonnet-5-5'], providerEnv: {} },
  aaaa0003: { state: 'done', tempo: 'idle', respawnFlags: ['--model', 'cc/claude-opus-5-5'], providerEnv: { CLAUDE_CODE_SUBAGENT_MODEL: 'cc/x' } },
  // Not finished, but its process isn't running: its settings are switched, but it is never restarted.
  aaaa0004: { state: 'blocked', tempo: 'blocked', respawnFlags: ['--model', 'cc/claude-opus-5-5'], providerEnv: {} },
}
/** Jobs whose process is running when a test starts (the rest are finished or dormant). */
export const LIVE_JOBS = ['aaaa0001', 'aaaa0002']

export function makeAccountHome(root) {
  const home = path.join(root, 'claude')
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
  const files = { settings: path.join(home, 'settings.json') }
  fs.writeFileSync(files.settings, JSON.stringify(SETTINGS, null, 2) + '\n')
  fs.mkdirSync(path.join(home, 'projects', '-w'), { recursive: true })
  for (const [short, st] of Object.entries(JOBS)) {
    fs.mkdirSync(path.join(home, 'jobs', short), { recursive: true })
    files[short] = path.join(home, 'jobs', short, 'state.json')
    fs.writeFileSync(files[short], JSON.stringify({ sessionId: `${short}-0000-4000-8000-000000000000`, name: short, cwd: root, ...st, updatedAt: new Date().toISOString() }))
    fs.writeFileSync(path.join(home, 'projects', '-w', `${short}-0000-4000-8000-000000000000.jsonl`), JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - 60_000).toISOString(), message: { content: 'hi' } }) + '\n')
    // pid: this test process, so it counts as alive.
    if (LIVE_JOBS.includes(short)) fs.writeFileSync(path.join(home, 'sessions', `${short}.json`), JSON.stringify({ pid: process.pid, sessionId: `${short}-0000-4000-8000-000000000000`, jobId: short, status: 'idle' }))
  }
  const log = path.join(root, 'claude.log')
  const bin = path.join(root, 'claude-fake')
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n')
if (a[0] === 'auth') {
  const mode = process.env.FAKE_AUTH || 'personal' // personal | gateway | none
  process.stdout.write(JSON.stringify({ loggedIn: mode !== 'none', authMethod: mode === 'personal' ? 'claude.ai' : mode === 'gateway' ? 'api_key' : 'none', email: 'someone@example.com' }))
  process.exit(mode === 'none' ? 1 : 0)
}
if (a[0] === 'respawn') {
  const n = fs.readFileSync(${JSON.stringify(log)}, 'utf8').split('\\n').filter((l) => l.includes('respawn')).length
  const wait = Number(process.env.FAKE_RESPAWN_MS || 0); const t = Date.now(); while (Date.now() - t < wait) {}
  if (process.env.FAKE_RESPAWN_FAIL === String(n)) process.exit(7)
  // Like the daemon: the job comes back (a fresh registry entry), may reply, may rewrite its state.
  const home = process.env.AGENTVILLE_CLAUDE_HOME, short = a[1]
  const stateFile = home + '/jobs/' + short + '/state.json'
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  if (process.env.FAKE_CLOBBER === '1') fs.writeFileSync(stateFile, JSON.stringify({ ...state, respawnFlags: ['--model', 'cc/claude-opus-5-5'] }))
  if (process.env.FAKE_NO_LIVE !== '1') fs.writeFileSync(home + '/sessions/' + short + '.json', JSON.stringify({ pid: 1, sessionId: state.sessionId, jobId: short, status: 'idle' }))
  const reply = process.env.FAKE_REPLY // ok | synthetic | (none)
  if (reply) fs.appendFileSync(home + '/projects/-w/' + state.sessionId + '.jsonl', JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(),
    ...(reply === 'synthetic' && { isApiErrorMessage: true }), message: { model: reply === 'synthetic' ? '<synthetic>' : 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }] } }) + '\\n')
  process.exit(0)
}
`)
  fs.chmodSync(bin, 0o755)
  return {
    env: {
      AGENTVILLE_TEST: '1', AGENTVILLE_CLAUDE_HOME: home, AGENTVILLE_CLAUDE_BIN: bin, AGENTVILLE_CODEX_HOME: path.join(root, 'no-codex'),
      AGENTVILLE_ACCOUNT_VERIFY_MS: '1500', AGENTVILLE_ACCOUNT_REPLY_MS: '600',
    },
    home, log, bin, files, TOKEN,
  }
}
