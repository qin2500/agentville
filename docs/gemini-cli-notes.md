# Gemini CLI: facts for an Agentville adapter

Researched 2026-11-24 against `@google/gemini-cli@0.71.1` (npm `latest`, node >=20), installed into a
throwaway prefix. No Google login, no Google network calls. Where a claim says "RAN", I executed the real
CLI offline (`GEMINI_API_KEY=fake`, `GOOGLE_GEMINI_BASE_URL` pointed at 127.0.0.1, hidden
`--fake-responses-non-strict` generator, `GEMINI_CLI_HOME` in a temp dir, `privacy.usageStatisticsEnabled:false`).

Marks: **VERIFIED** = read in source or observed in an offline run. **UNVERIFIED** = from docs or inference only.

Code refs: the npm package ships a single minified-ish bundle under
`node_modules/@google/gemini-cli/bundle/`. Hashed chunk names appear in several identical copies; refs below
use the copies that `bundle/gemini.js` actually imports.
- `CORE` = `bundle/chunk-4UW3VJTT.js` (the core package: storage, auth, chat recording, errors)
- `CLI` = `bundle/gemini-7FHLRHNN.js` (argument parsing, headless runner, ACP)
- `SEL` = `bundle/chunk-V3MODYYD.js` (session selector, settings loader)
- docs = `bundle/docs/**` (the repo's `docs/` tree is bundled; same content as google-gemini/gemini-cli)

Line numbers will drift every release. Re-grep by symbol name.

Stability note up front: the project ships very fast (0.71.x in Nov 2026; nightly, preview, latest tags).
The session file format already changed once (single `.json` to append-only `.jsonl`; legacy `.json` is still
read and upgraded in place). Treat every on-disk shape below as unstable and parse defensively.

---

## 1. Install and binary

- Package `@google/gemini-cli`, version `0.71.1`, license Apache-2.0, `"type": "module"`. VERIFIED
  (`package.json`; `npm view` dist-tags: latest 0.71.1, preview 0.72.0-preview.0, nightly 0.71.0-nightly.20261124).
- `"bin": { "gemini": "bundle/gemini.js" }`. Shebang `#!/usr/bin/env node`. VERIFIED (`package.json`,
  `.bin/gemini` is a symlink on macOS).
- Install: `npm i -g @google/gemini-cli`. Node `>=20`. VERIFIED (`engines`).
- Windows shim: npm generates `gemini.cmd`, `gemini.ps1` and a bare `gemini` sh script in the global npm
  prefix (`%APPDATA%\npm`). UNVERIFIED here (standard npm cmd-shim behaviour; not run on Windows). Spawn it as
  `gemini.cmd` (needs `shell:true` in Node, or `cmd /c`), or resolve `bundle/gemini.js` and run
  `node bundle/gemini.js` directly, which avoids the shim.
- Native deps are all optional: `@lydell/node-pty` (+ per-platform `darwin-arm64/darwin-x64/linux-x64/win32-arm64/win32-x64`),
  `node-pty`, `@github/keytar`. The CLI works without them (keychain falls back to a file; interactive shell
  tool needs node-pty). VERIFIED (`package.json`, `CORE:290401`).
- Process shape: `gemini` re-spawns itself as a child `node` with `--max-old-space-size=<50% RAM>` and an `ipc`
  channel (`bundle/gemini.js:53-100`). So there are two node processes per agent; the parent PID is the
  wrapper. Set `GEMINI_CLI_NO_RELAUNCH=true` to run in a single process (`bundle/gemini.js:53`,
  `CLI:19263`). VERIFIED. Useful for clean PID tracking.
- Update: `gemini update` exists; auto-update can be disabled in settings
  (`general.enableAutoUpdate`, `general.enableAutoUpdateNotification`). VERIFIED (docs + I set them off).

## 2. Sessions and transcripts

### 2.1 Location (macOS and Windows)

Base dir ("global gemini dir") = `<home>/.gemini`, where `<home>` is `$GEMINI_CLI_HOME` if set, else
`os.homedir()`. VERIFIED (`CORE:261774` `homedir()`, `CORE:263263` `getGlobalGeminiDir`).
- macOS/Linux: `~/.gemini`
- Windows: `%USERPROFILE%\.gemini` (os.homedir()), e.g. `C:\Users\<you>\.gemini`. Path join uses `path` so it
  is backslash-native. No `%APPDATA%` use. VERIFIED by code path; not run on Windows.

Per-project data lives under `<base>/tmp/<project-slug>/`:
```
~/.gemini/tmp/<slug>/.project_root          # text: absolute project path (ownership marker)
~/.gemini/tmp/<slug>/chats/session-<YYYY-MM-DDTHH-mm>-<first8ofSessionId>.jsonl
~/.gemini/tmp/<slug>/chats/<parentSessionId>/<agentId>.jsonl     # subagent transcripts
~/.gemini/tmp/<slug>/logs/ , tool-outputs/session-<id>/ , memory/ , shell_history
~/.gemini/history/<slug>/.project_root
~/.gemini/projects.json                     # { "projects": { "<abs path>": "<slug>" } }
```
VERIFIED (`CORE:263290-263540`, `CORE:297701-297740`, `CORE:298833-298860`; RAN, listing above reproduced exactly).
Docs still say `tmp/<project_hash>/chats/`; that is outdated. The directory is a **slug** (basename of the project,
`[a-z0-9-]`, with `-1`, `-2` suffix on collisions), not a hash. Legacy sha256-hash dirs are migrated to slugs.
(`CORE:263124 claimNewSlug`, `CORE:263290 performMigration`).

Sandbox variant: with `SANDBOX=sandbox-exec` the runtime dir moves to `<home>/.cache/.gemini` (`CORE:263299`).

### 2.2 Format: append-only JSONL

First line is a metadata header; later lines are messages, `$set` metadata patches, `$patch` message patches,
and `$rewindTo` markers. Messages are upserted by `id` (the same `id` appears multiple times as tool calls
progress; the last record wins). Real output from a RAN session:

```jsonl
{"sessionId":"11111111-2222-3333-4444-555555555555","projectHash":"090bb441...e9123","startTime":"2026-11-24T16:50:31.203Z","lastUpdated":"2026-11-24T16:50:31.203Z","kind":"main"}
{"id":"d04923d3...","timestamp":"...","type":"user","content":[{"text":"<session_context>\nThis is the Gemini CLI... Workspace Directories: ... </session_context>"}]}
{"$set":{"lastUpdated":"2026-11-24T16:50:31.204Z"}}
{"id":"bc2e0b06-...","timestamp":"...","type":"user","content":[{"text":"say hi"}]}
{"id":"1d948026-...","timestamp":"...","type":"gemini","content":"Hello from the fake model.","thoughts":[],"tokens":{"input":10,"output":5,"cached":0,"thoughts":0,"tool":0,"total":15},"model":"gemini-2.5-flash"}
{"$set":{"lastUpdated":"..."}}
```
A tool turn (same `id` written three times; status progresses `scheduled` then a terminal status):
```jsonl
{"id":"e72d74d0-...","type":"gemini","content":"","tokens":{...},"model":"gemini-2.5-flash","toolCalls":[{"id":"run_shell_command__..._0","name":"run_shell_command","args":{"command":"echo hi"},"status":"scheduled","timestamp":"...","displayName":"run_shell_command","description":"","renderOutputAsMarkdown":false}]}
{"id":"e72d74d0-...","type":"gemini", ... ,"toolCalls":[{... "status":"success"|"error"|"cancelled", "result":[{"functionResponse":{"id":"...","name":"...","response":{...}}}],"resultDisplay":"..."}]}
{"id":"208f3e2a-...","type":"user","content":[{"functionResponse":{...}}]}      # tool result fed back, type "user"
```
Record types: header (has `sessionId` + `projectHash`; also `kind` `main|subagent`, optional `directories`,
`summary`), message (`id` + `type` in `user|gemini|info|error|warning`), `{"$set":{...}}` (e.g. `lastUpdated`,
`sessionId`, `memoryScratchpad`), `{"$patch":{"updates":[{id,content}]}}`, `{"$rewindTo":"<messageId>"}`.
VERIFIED (`CORE:298300-298330` type guards, `CORE:298780-299200` writer; RAN). Content of `user` messages is
an array of Gemini `Part`s; `gemini` content is a plain string. Per-message `tokens` and `model` are present, so
token usage can be summed from the file (this is what `/stats heatmap` does, `CORE:408845`).
Message cap in memory is 50 but the file is complete (`MAX_HISTORY_MESSAGES`, `CORE:297703`).

Legacy: single JSON object file `session-*.json` (`messages` array) is still readable and gets converted to
`.jsonl` on resume (`CORE:298790-298820`). VERIFIED. A parser should accept both.

Gotchas: first `user` message of every session is a synthetic `<session_context>` blob (skip it; the CLI itself
skips messages starting `<session_context>`/`<hook_context>`, `SEL:31770-31800`). Tool-result `user` messages have
only `functionResponse` parts. Output of shell tools is wrapped in `<untrusted_context>...`. Rewound/aborted turns
leave only their `user` record followed by `$rewindTo`.

### 2.3 Session id

`randomUUID()` v4 (`CORE:328449 createSessionId`). Can be chosen by the caller: `--session-id <uuid>` starts a
new session with a given id (regex `^[a-zA-Z0-9-_]+$`; fails if it already exists; mutually exclusive with
`--resume` and `--session-file`) (`CLI:8649-8653`, `CLI:8792-8805`, `CLI:19446-19455`). RAN: the file was
named `session-2026-11-24T16-50-11111111.jsonl` for id `11111111-2222-...`. So an adapter can mint the UUID up
front and know the file name pattern (`*-<first8>.jsonl`, minute-resolution timestamp, `-N-` collision index).
Caveat: when a quota fallback fires with "retry_always", the CLI calls `config.rotateSessionId(newUUID)`
(`CORE:329208`), so a long run can switch id mid-process. Interactive path only in practice (see 6.3).

### 2.4 How project/cwd is recorded

- Header has `projectHash` = sha256 of the project root string exactly as given (`CORE:262008 getProjectHash`).
  Not reversible; not useful for display.
- The readable cwd is in: `~/.gemini/projects.json` (abs path to slug; on Windows the key is lower-cased,
  `CORE:262975 normalizePath`), `tmp/<slug>/.project_root` (abs path), and inside the first synthetic `user`
  message ("Workspace Directories: ..."). Subagent headers carry `directories`.
- Project root = `process.cwd()` at launch (`new Storage(process.cwd())`, `CLI:19389`). Not git-root based in
  the code I read. So `cd` matters: sessions are per exact cwd; `--resume` only sees sessions of the cwd's slug.
- To map file to project: read `tmp/<slug>/.project_root`. VERIFIED (RAN).

### 2.5 Status from files alone

There is **no pid file, lock, or status field** in the transcript. VERIFIED (nothing in the writer). Inference only:

| State | Signal | Reliability |
|---|---|---|
| Running / working | file mtime or `lastUpdated` recent, last record is user msg, `gemini` msg with `toolCalls[].status=="scheduled"`, or a tool-result `user` msg | heuristic; combine with live PID check |
| Finished turn | last message is `type:"gemini"` with non-empty `content` and no unresolved `toolCalls` | good, but idle-interactive and finished-headless look identical |
| Asking permission | **not recorded.** `awaiting_approval` is a runtime status that is never written (`recordToolCalls` is only called with `scheduled` at `CORE:352199` and final statuses at `CORE:352236`). A `scheduled` toolCall with no result and an idle file = either executing or waiting for approval | ambiguous; use the Notification hook (section 7) |
| Errored | API errors are **not written**. The failed turn leaves `user` record then `{"$rewindTo":"<that id>"}` (RAN). `type:"error"/"warning"/"info"` records are written only by the interactive UI (`SEL`/`chunk-MTVMJTRD.js:16859-16873`), never in headless | weak from file; use exit code / stdout |
| Tool error | `toolCalls[].status:"error"` with `result[].functionResponse.response.error` | VERIFIED (RAN) |

Recommendation: for liveness, track the OS process (we spawn it) and use hooks (`SessionStart`, `AfterAgent`,
`SessionEnd`, `Notification`) as push signals; use the jsonl only for history and token counts. Hook payloads
include `transcript_path` pointing at the real jsonl (RAN; docs wrongly call it "JSON").

## 3. Starting headless with a prompt

Flags (yargs, `CLI:8680-8860`; docs `docs/cli/cli-reference.md`). VERIFIED:
- `-p, --prompt <text>`: non-interactive; appended to stdin if stdin is piped. Headless is also chosen
  automatically when stdin or stdout is not a TTY, or `CI=true` (`CORE:291085 isHeadlessMode`). A bare positional
  query is interactive on a TTY and headless otherwise.
- `-i, --prompt-interactive`: run the prompt then stay interactive (needs a TTY; errors if stdin piped).
- `-m, --model <name>`: aliases `auto` (default), `pro`, `flash`, `flash-lite`, or concrete ids
  (`gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-3-pro-preview`, ...). Env `GEMINI_MODEL` sets default.
- `--approval-mode default|auto_edit|yolo|plan`; `-y/--yolo` is deprecated and conflicts with `--approval-mode`.
- `-o, --output-format text|json|stream-json`.
- `--session-id`, `-r/--resume`, `--session-file` (mutually exclusive), `--list-sessions`, `--delete-session`.
- `--include-directories`, `--skip-trust`, `-s/--sandbox`, `-e/--extensions`, `--allowed-mcp-server-names`,
  `--policy`, `--admin-policy`, `--acp`, `-w/--worktree` (needs `experimental.worktrees`), `--list-models`.
- `--allowed-tools` is deprecated (policy engine replaces it).

**Trusted-folder gate (gotcha, RAN):** in headless mode in an untrusted dir, the CLI prints
"Gemini CLI is not running in a trusted directory. To proceed, either use `--skip-trust`, set the
`GEMINI_CLI_TRUST_WORKSPACE=true` environment variable, or trust this directory in interactive mode" and exits
without doing anything. Always pass `--skip-trust` or the env var for orchestrated runs.

**Tools in headless (RAN):** in `default` approval mode, `run_shell_command` is not available: a model call to
it returned status `error`, `type:"tool_not_registered"`. Policy engine converts every `ASK_USER` to `DENY` when
non-interactive (`CORE:382307`, `CORE:382723`, docs `reference/policy-engine.md:152`). With
`--approval-mode yolo` the shell ran (`"output":"hi"`). `auto_edit` auto-approves edit tools only. So a
headless agent that must run shell/`claude` needs `yolo` or a policy file that `allow`s the specific tools.

Output formats:
- `text`: final answer on stdout; warnings as `[WARNING] ...` on stderr; fatal `[ERROR] ...` for invalid streams.
- `json`: one object `{response, stats, error?}` at the end (docs `docs/cli/headless.md`). On error (RAN) stdout
  is empty and `{"session_id":..., "error":{"type","message","code"}}` goes to **stderr**.
- `stream-json` (JSONL on stdout; best for supervision). Event types `init`, `message`, `tool_use`,
  `tool_result`, `error`, `result` (`CORE:380358`). RAN sample:
  ```
  {"type":"init","timestamp":"...","session_id":"1111...","model":"gemini-2.5-flash"}
  {"type":"message","role":"user","content":"say hi"}
  {"type":"message","role":"assistant","content":"Hello...","delta":true}
  {"type":"tool_use","tool_name":"run_shell_command","tool_id":"...","parameters":{"command":"echo hi"}}
  {"type":"tool_result","tool_id":"...","status":"success","output":"hi"}        # or status:"error", error:{type,message}
  {"type":"result","status":"success","stats":{"total_tokens":15,"input_tokens":10,"output_tokens":5,"cached":0,"duration_ms":5,"tool_calls":0,"models":{...}}}
  ```
  `error` events carry `severity: "warning"|"error"` (`RESOURCE_EXHAUSTED` status maps to `error`, `CLI:14083`).
  Final failure is `{"type":"result","status":"error","error":{"type","message"},"stats":...}`.
- Stray non-JSON lines appear on **stderr** ("Ripgrep is not available...", "[STARTUP] Phase ..."); stdout stays clean.
  (RAN) Do not merge stderr into the JSON stream.

Exit codes (`CORE:404965`, docs): 0 ok; 41 auth fatal; 42 input error; 52 config error; 53 turn limit
(`FatalTurnLimitedError`); 130 cancelled; 1 generic. **Quota/API errors exit with the HTTP status as the code:
429 gives exit 173 on POSIX (429 mod 256)**, 1 in text mode (RAN: text=1, json=173, stream-json=173). On Windows
exit codes are 32-bit so it would probably be 429 (UNVERIFIED). Don't rely on the number; parse the message.

Background / daemon mode: **none.** No `--bg`, `--daemon`, or detach flag (grepped `CLI`). VERIFIED absence.
Closest things:
1. **Long-lived headless:** run `gemini -p` per turn and chain turns with `--resume <uuid>`. State is the
   session file, so each turn is a fresh process (cheap, robust, easy to supervise). Recommended.
2. **ACP server:** `gemini --acp` (alias `--experimental-acp`) is a long-lived JSON-RPC 2.0 over stdio agent
   (Agent Client Protocol) with `session/new`, `session/load` (`loadSession:true`, `CLI:18752`,
   `CLI:18503`), prompt, cancel, and `session/request_permission` callbacks to the client. This is the only
   official way to keep one process alive and to answer permission prompts programmatically. Docs
   mark it experimental (`docs/cli/acp-mode.md`). Spawn it detached with stdio pipes ourselves.
3. **Interactive in a terminal multiplexer:** run `gemini` under tmux/Ghostty/pty (as Agentville does for
   Claude/Codex). Attach later by terminal, not by gemini.
4. The shell tool's `is_background` param is for child processes, unrelated.

## 4. Resume non-interactively

- `gemini -r latest -p "next prompt"` or `gemini -r <full-uuid> -p "..."` or `-r <index>` (1-based, ordered by
  start time ascending, per `--list-sessions`). VERIFIED (`SEL:31557-31700 SessionSelector`, docs). RAN: resume
  by UUID and `latest` both worked headless.
- Resume **appends to the same file** with the same session id and writes `{"$set":{"sessionId":...}}` plus a
  `$patch` (RAN). So one conversation = one file; a tailer can keep following it.
- Scope is per cwd: you must launch from the same directory (`new Storage(process.cwd())`). From a different
  cwd the id is "not found". VERIFIED.
- Empty `-r` (no value) means latest. If there are no sessions and arg is `latest`, it warns and starts a new one.
- Sessions with no resumable content (e.g. only a rewound prompt) may not appear in `--list-sessions` / index /
  `latest`; ACP load bypasses that filter (`allowEmpty`). UNVERIFIED for the CLI list filter details.
- `--session-file <path>` imports a JSON/JSONL transcript as a **new** session id (copies messages).
- Interactive `/resume` (alias `/chat`) opens the session browser; `/resume save|list|resume <tag>` are manual
  checkpoints (docs `docs/cli/session-management.md`). Not usable headless.
- Retention: sessions older than 30 days are deleted by default at startup (`general.sessionRetention`, docs).
  Agentville must copy what it needs or raise `maxAge`.

## 5. Auth and accounts

### 5.1 Files (all under `<home>/.gemini/`, `<home>` = `$GEMINI_CLI_HOME` or OS home)

| File | Content | Source |
|---|---|---|
| `oauth_creds.json` | Google OAuth tokens from "Login with Google": `access_token`, `refresh_token`, `scope`, `token_type`, `id_token`, `expiry_date`. Mode 0600 (`384` octal-decimal = 0o600), written atomically (temp + rename). **Default storage.** | `CORE:263238`, `CORE:291646-291690` VERIFIED |
| `google_accounts.json` | `{"active":"user@gmail.com"|null,"old":["..."]}` display-only cache of the signed-in email | `CORE:284870-284960` VERIFIED |
| `settings.json` | `security.auth.selectedType`: `oauth-personal` (Login with Google), `gemini-api-key`, `vertex-ai`, `compute-default-credentials`, plus gateway type | `CORE:333644-333646`, docs `configuration.md:2008` VERIFIED |
| `gemini-credentials.json` | AES-256-GCM encrypted token store (the FileKeychain fallback). Key = scrypt of fixed string + `hostname-username`, so it is **not portable across machines/users** | `CORE:290199-290230` VERIFIED |
| `.env` | env vars incl. `GEMINI_API_KEY`; loaded from cwd upward, then `<home>/.gemini/.env`, then `~/.env` | `SEL:38118-38132`, docs `configuration.md:2650` VERIFIED |
| `installation_id`, `trustedFolders.json`, `policy_integrity.json`, `projects.json` | misc state | `CORE:263318-263350` |

The top-level `selectedAuthType` key from older versions does not exist in the 0.71 schema (only the nested
`security.auth.selectedType` is read). UNVERIFIED whether a migration still maps the old key.

Env override of the type: `GEMINI_CLI_AUTH_OVERRIDE=<type>` (`SEL:38925`); or auto-detect from env when no
type is set (`getAuthTypeFromEnv`, `CORE:333651`): `GOOGLE_GENAI_USE_GCA=true` (login with Google),
`GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_GEMINI_BASE_URL` (gateway), `GEMINI_API_KEY`, `CLOUD_SHELL`/
`GEMINI_CLI_USE_COMPUTE_ADC`. Headless with `oauth-personal` and no cached creds fails with exit 41 and
"Please set an Auth method ..." / consent error (`CLI:18883-18915`, `CORE:291107`).

**Keychain caveat (VERIFIED):** the OS keychain (service `gemini-cli-oauth`, account `main-account`) is used only
when `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true` (`CORE:290761`, `CORE:291573`). Then creds are NOT in
`oauth_creds.json` and the keychain entry is **not per `GEMINI_CLI_HOME`**. Default install: file. Adjacent flag
`GEMINI_FORCE_FILE_STORAGE=true` forces the encrypted-file backend instead of the native keychain
(`CORE:290316`). If we ever enable keychain mode we lose folder isolation unless that second flag is also set.

Other credential inputs: `GOOGLE_APPLICATION_CREDENTIALS` (ADC/service-account JSON, checked after
`oauth_creds.json`), `GOOGLE_CLOUD_ACCESS_TOKEN` + `GOOGLE_GENAI_USE_GCA` (a raw bearer token), `GOOGLE_CLOUD_PROJECT`
(needed for Workspace/paid Code Assist accounts) (`CORE:291139-291175`, docs).
Hardcoded OAuth client id/secret are embedded in the CLI (`CORE:291150`); that is Google's public "installed app"
client. **Do not reuse or proxy it outside the official CLI** (per brief).

### 5.2 Does swapping files switch the account? Do running processes cache?

- New processes: yes. `initOauthClient` reads `oauth_creds.json` fresh at startup (`CORE:291160-291185`
  `fetchCachedCredentialsList`) and `google_accounts.json` is read on demand. VERIFIED.
- Running processes: they keep the credentials **in memory** (google-auth-library `OAuth2Client`), refreshing via
  the refresh token when the access token is within the eager-refresh window, and they do not re-read the file.
  VERIFIED by structure. A running process stays on its original account.
- **Danger when swapping under a live process:** on every token refresh the client emits `tokens` and
  `cacheCredentials` writes `{...existingFileContents, ...newTokens}` (merge, `CORE:291646-291668`). A live
  process of account A that refreshes after you swapped in account B's file will merge A's fresh
  `access_token`/`expiry_date` into B's file (mixed identity, B's refresh token with A's access token) and
  `triggerPostAuthCallbacks` may rewrite `google_accounts.json`. Inference from the code; not RAN against Google.
  Do not hot-swap files while any gemini process of the old account is alive.
- Safer design: **one `GEMINI_CLI_HOME` per account** (e.g. `~/.agentville/gemini/<account>/` so config lands at
  `<that>/.gemini/oauth_creds.json`), pass it in the env of each spawned agent. Everything (creds, sessions,
  settings, projects.json, `.env`) is isolated. RAN: all state landed under the custom home.
  Trade-off: session history is also split per account, so `--resume` only finds sessions of the same home. Either
  keep one home per account and always route a conversation to its home, or symlink `tmp/` and `projects.json`
  across homes (UNVERIFIED, not tested).
- `GEMINI_CLI_HOME` is the **parent** of `.gemini` (docs: "The CLI will create a `.gemini` folder inside"), and
  the core honours that (`CORE:261774`). One spot disagrees: `bundle/gemini.js:30` reads
  `$GEMINI_CLI_HOME/settings.json` (no `.gemini`) when sizing node memory (`advanced.autoConfigureMemory`).
  Harmless inconsistency; looks like an upstream bug.
- Login itself is interactive (browser OAuth or `NO_BROWSER=true` user-code flow); there is no non-interactive
  login. For accounts to be usable headless, a human must do the first login per home by running `gemini`
  with that `GEMINI_CLI_HOME` (RAN attempt not made, by instruction).
- Account identity for UI: `google_accounts.json` `active` field (email). For API-key / Vertex auth there is no
  email; identity is the key/project.

## 6. Usage and limits

### 6.1 Documented quotas (docs `docs/resources/quota-and-pricing.md`; UNVERIFIED against live service)
Max requests per user per day: Code Assist Individual (free Google login) 1,000; Google AI Pro 1,500; Google AI
Ultra 2,000; Gemini API key free 250 (Flash only); Workspace Code Assist Standard 1,500, Enterprise 2,000;
Workspace AI Ultra 2,000. Also per-minute limits "subject to availability". Google AI Plus is not supported.
Reset timing: "per day" but the CLI never states a clock time; the real reset comes from the quota API (6.4).

### 6.2 Error classification (VERIFIED, `CORE:328600-328900 classifyGoogleError`)
- `TerminalQuotaError` (no retry): daily quota (`QuotaFailure.quotaId` contains `PerDay`/`Daily`): message
  `You have exhausted your daily quota on this model.`; `ErrorInfo.reason` in `QUOTA_EXHAUSTED`,
  `MODEL_CAPACITY_EXHAUSTED`/`MODEL_CAPACITY_EXCEEDED`, `INSUFFICIENT_G1_CREDITS_BALANCE`,
  `RATE_LIMIT_EXCEEDED` with no or >300 s retry delay; message matching `limit: 0`; spending-cap text
  (`/\b(spending|spend)\s+cap\b/i`, status 400/429/499); text `exhausted your capacity|capacity exceeded`.
  Carries `retryDelayMs` when `RetryInfo.retryDelay` is present.
- `RetryableQuotaError` (auto retry with backoff, max 300 s delay): per-minute quota, `RetryInfo` delay <= 300 s,
  "Please retry in Ns" text, generic 429/499/503.
- `ValidationRequiredError`: 403 with `ErrorInfo.reason=VALIDATION_REQUIRED` on the cloudcode domain
  (account verification link). `ModelNotFoundError`: 404.
- HTTP statuses treated as retryable: 429, 499, 5xx (`CORE:329425-329450`).
- Wire shape the code expects: Google RPC `{"error":{"code":429,"message":"...","status":"RESOURCE_EXHAUSTED",
  "details":[QuotaFailure|ErrorInfo|RetryInfo|Help]}}`. Code Assist (login-with-Google) errors use domain
  `cloudcode-pa.googleapis.com`.
- Final user text: `[API Error: <message> (Status: RESOURCE_EXHAUSTED)]` then, by auth type
  (`CORE:408472-408484`): API key: "Please wait and try again later. To increase your limits, request a quota
  increase through AI Studio, or switch to another /auth method"; Vertex: same with "through Vertex"; Google
  login: "Possible quota limitations in place or slow response times detected. Switching to the <flash model>
  model for the rest of this session." For Google-login users without `GOOGLE_CLOUD_PROJECT` a "Tip: The shared
  Google Cloud project is experiencing high traffic..." paragraph is appended (`CORE:329452 enrichQuotaError`).

**RAN (localhost mock returning a daily-quota 429 with API-key auth):**
- text mode: exit 1, stdout empty, stderr `Error when talking to Gemini API Full report available at: <tmpdir>/gemini-client-error-Turn.run-sendMessageStream-<ts>.json TerminalQuotaError: You have exhausted your daily quota on this model.` + stack trace.
- stream-json: stdout `{"type":"result","status":"error","error":{"type":"Error","message":"[API Error: You have exhausted your daily quota on this model.]\nPlease wait and try again later. To increase your limits, request a quota increase through AI Studio, or switch to another /auth method"},"stats":{...}}`, exit 173.
- json: stdout empty; stderr ends with `{"session_id":"...","error":{"type":"Error","message":"You have exhausted your daily quota on this model.","code":429}}`, exit 173.
- It made 3 HTTP attempts for a TerminalQuotaError before giving up. Crash reports are dropped in `os.tmpdir()`
  as `gemini-client-error-*.json`.
Detection recipe for an adapter: in `stream-json`, `result.status=="error"` and message contains
`exhausted your daily quota` / `RESOURCE_EXHAUSTED` / `Switching to the` / `[API Error:` + `429`; in text mode
match stderr for `TerminalQuotaError|RetryableQuotaError|exhausted your`. The reset time is not in the message
unless `RetryInfo` was supplied (then `retryDelayMs` is only on the thrown object, not printed).

### 6.3 Fallback to Flash
- Chain: with preview models enabled, `gemini-3-pro-preview` then `gemini-3-flash-preview` (last resort, 10
  attempts); otherwise `gemini-2.5-pro` then `gemini-2.5-flash` (`CORE:328960 getModelPolicyChain`). In `auto`
  model mode "transient" capacity errors fall back silently with up to 3 attempts.
- Terminal (daily) quota normally prompts the user (interactive `fallbackModelHandler`); when that handler is
  absent (headless) `handleFallback` returns null and the error is thrown (RAN: no fallback, hard failure).
  `generateContent` utility path is explicitly disabled when not interactive (`CORE:329821`). So **headless
  `gemini -p` does not auto-downgrade to Flash on a daily quota error**; it fails. An orchestrator that wants
  Flash must retry itself with `-m gemini-2.5-flash` (note Flash has its own separate buckets).
- On accepted fallback the session id is rotated (see 2.3).

### 6.4 Usage and stats surfaces
- `/stats` (alias group: `session` default, `model`, `tools`, `heatmap [today|yesterday|YYYY-MM-DD]`) is
  **interactive only** (docs `reference/commands.md:438`). `/stats model` shows token counts and quota with reset
  times. There is no `gemini stats` shell subcommand (subcommands: mcp, extensions, skills, hooks, gemma, models,
  update). `--list-models` lists models.
- The quota data comes from the Code Assist endpoint `retrieveUserQuota` (`CORE:332495`, `CORE:399915`
  `refreshUserQuota`): request `{project}`, response `buckets[]` with `modelId`, `remainingFraction`,
  optional `remainingAmount`, `resetTime`. Only available for Google-login/Code Assist auth with a resolved
  project id; calls need the user's OAuth bearer. VERIFIED in source. **We must not call it ourselves with
  borrowed tokens** (that would be exactly the out-of-CLI OAuth reuse the brief prohibits). UNVERIFIED whether
  the interactive CLI exposes it via any file.
- Local approximation without Google: sum per-message `tokens` from the jsonl; count `gemini`-type messages per
  day for a rough "requests today" figure vs the 1,000/1,500/2,000 limits. (Each model API call is not exactly one
  message; treat as an estimate.) Tier name for Google login is shown in the interactive UI only
  (`chunk-MTVMJTRD.js:58494` `tier`), not on disk (UNVERIFIED).
- Telemetry (`GEMINI_TELEMETRY_*`, OTLP, `telemetry.outfile`) can write local usage events to a file with
  `GEMINI_TELEMETRY_ENABLED=true GEMINI_TELEMETRY_TARGET=local GEMINI_TELEMETRY_OUTFILE=...` (docs
  `reference/configuration.md`). Not tested; a possible structured source.

### 6.5 How a transcript shows a limit hit
It mostly does not. Headless: user message followed by `$rewindTo` (RAN) and nothing else. Interactive: an
`type:"error"` message with the API error text may be recorded (UI path). So the limit signal must come from the
process output/exit code or hooks, not from the jsonl.

## 7. Extensibility an orchestrator can use

- **Hooks (best signal channel).** `settings.json` `hooks.<Event>` arrays of `{matcher?, hooks:[{type:"command",
  command, timeout?}]}`. Events: `BeforeTool`, `AfterTool`, `BeforeAgent`, `AfterAgent`, `BeforeModel`,
  `BeforeToolSelection`, `AfterModel`, `SessionStart`, `SessionEnd`, `Notification` (type `ToolPermission`
  only), `PreCompress` (docs `hooks/reference.md`). stdin gets JSON `{session_id, transcript_path, cwd,
  hook_event_name, timestamp, ...}`; stdout must be JSON (`{}` is fine); exit 2 blocks. RAN (headless):
  `SessionStart` (`source:"startup"`), `AfterAgent` (adds `prompt`, `prompt_response`, `stop_hook_active`),
  `SessionEnd` (`reason:"exit"`) all fired with the real jsonl path. Env passed to hooks:
  `GEMINI_PROJECT_DIR`, `GEMINI_CWD`, `GEMINI_SESSION_ID` and, for Claude-hook compatibility,
  `CLAUDE_PROJECT_DIR` (`CORE:383358-383362`). Use: `Notification` = "waiting for tool approval" (interactive
  only since headless denies instead of asking), `AfterAgent` = turn finished, `SessionEnd` = exit. Configure per
  account home (`<home>/.gemini/settings.json`) so we never touch the user's real settings. Project-level
  `.gemini/settings.json` hooks need a trusted folder. Hook commands run through the platform shell
  (PowerShell on Windows, see 8).
- **Desktop notification setting:** `general.enableNotifications` emits OSC 9 or BEL to the terminal (docs
  `cli/notifications.md`); terminal-level, not machine readable.
- **MCP:** `gemini mcp add|remove|list`, `mcpServers` in settings (stdio, SSE, streamable HTTP), OAuth for remote
  MCP, `--allowed-mcp-server-names`. Tool names appear as `mcp_<server>_<tool>`. Agentville can expose its own
  MCP server (e.g. "send message to agent X") to every Gemini agent this way.
- **GEMINI.md:** context hierarchy: `~/.gemini/GEMINI.md` (under `GEMINI_CLI_HOME`), workspace/parents, and
  JIT-discovered per directory; `@file` imports; filename configurable via `context.fileName` (e.g.
  `["AGENTS.md","GEMINI.md"]`) (docs `cli/gemini-md.md`). Default name `GEMINI.md` (`CORE:263579`). Good place
  for orchestration instructions, shared with `AGENTS.md` via the setting.
- **Subagents:** built-ins like `codebase_investigator`; user agents as Markdown with YAML frontmatter in
  `.gemini/agents/*.md` or `~/.gemini/agents/*.md`; invoked as tools or `@name`. Remote A2A agents with
  `kind: remote` + `agent_card_url` (docs `core/subagents.md`, `core/remote-agents.md`). These run inside the same
  session (kind `subagent` transcripts under `chats/<parentId>/`), not as separate top-level agents.
- **Gemini starting another agent:** (a) shell tool: `run_shell_command` (PowerShell on Windows) can run
  `gemini -p ...` or `claude -p ...` — needs `--approval-mode yolo` or a policy `allow` rule in headless, else the
  tool is unavailable (RAN). Nested **interactive** `gemini` inside a gemini shell is blocked
  (`GEMINI_CLI_IN_SHELL=1` set for shell children, `CORE:342068`, error `CORE:264334`); nested `gemini -p` is
  allowed (`CLI:8898`). (b) MCP: register `claude mcp serve` (Claude Code's own MCP server mode) as an MCP server
  in Gemini settings. UNVERIFIED (Claude side not examined here). (c) A2A remote subagent pointing at an agent
  card. (d) Custom slash commands (`.gemini/commands/*.toml`) and skills/extensions
  (`gemini extensions`, `gemini skills`) for packaging.
- **Policy engine:** `--policy <file>` / `~/.gemini/policies/*.toml` give fine-grained allow/deny/ask per tool,
  with `interactive: false` scoping (docs `reference/policy-engine.md:137`). Preferred over `--yolo` for
  unattended agents.
- **ACP (`--acp`):** the structured, bidirectional control channel (permissions, cancel, load session).

## 8. Windows gotchas

- Shell tool uses PowerShell: `pwsh.exe` if on PATH or `ComSpec` points at powershell, else
  `powershell.exe -NoProfile -NonInteractive -Command` (`CORE:264943 getShellConfiguration`, docs
  `tools/shell.md:9`). Prompts or hooks written for bash will fail. VERIFIED by code.
- Shim: use `gemini.cmd` or call `node ...\bundle\gemini.js`. `child_process.spawn('gemini')` without
  `shell:true` fails on Windows for `.cmd` shims. UNVERIFIED here, standard Node behaviour.
- Project registry lower-cases paths on win32 (`CORE:262975`) so `C:\Foo` and `c:\foo` map to one slug; but
  `projectHash` in the header is sha256 of the **unnormalised** path string (`CORE:262008`), so two casings of the
  same dir give different hashes. Match by `.project_root`/slug, not the hash. VERIFIED by code.
- Registry writes retry on `EBUSY`/`EPERM` during rename (`CORE:262990`), a sign of real-world lock contention;
  expect transient failures when several agents start at once. The registry uses `proper-lockfile` with a 10 s
  budget (`CORE:263040`).
- File modes (0600) are not enforced on NTFS; credentials rely on per-user profile ACLs only.
- Exit codes are 32-bit on Windows, so `429` is likely returned unmasked (UNVERIFIED).
- System settings dir on Windows is `C:\ProgramData\gemini-cli\settings.json` (macOS:
  `/Library/Application Support/GeminiCli`); an admin file there overrides user settings
  (`CORE:263275`, env `GEMINI_CLI_SYSTEM_SETTINGS_PATH`). VERIFIED.
- Windows 10 builds <22000 are flagged for reduced terminal capability (`CORE:isWindows10`); only matters
  interactive.
- WSL: native keychain is skipped; file fallback used (`CORE:290440`). Only relevant if keychain mode is enabled.
- Optional native `node-pty` for win32 x64/arm64 is prebuilt via `@lydell/node-pty-win32-*`; if it fails to load,
  interactive shell degrades but headless is unaffected. UNVERIFIED on Windows.
- Process kill: the CLI forwards signals to its child node (`setupSignalForwarding`); on Windows `taskkill /T`
  is the safe way to end both processes. UNVERIFIED.
- Line endings: transcripts are written with `\n` on all platforms (`JSON.stringify(...)+"\n"`); readers should
  split on `\n` and tolerate a trailing partial line while the file is being written. VERIFIED (`CORE:298880`).

## 9. Instabilities and watch list

- Transcript schema drift (json to jsonl; new `$patch`, `$rewindTo`, `kind`, `directories` fields); docs lag the
  code (docs still say hash dirs and "transcript JSON").
- Duplicate message ids and in-place upserts: dedupe by `id`, last wins; apply `$rewindTo` (drop that id and
  everything after it? the exact semantics are in `CORE:298464`; I only observed it directly after a lone user
  message. UNVERIFIED for mid-conversation rewinds).
- Fast release cadence; flags marked deprecated (`--yolo`, `--allowed-tools`, `--experimental-acp`) will vanish.
- `--fake-responses*` and `--record-responses` are hidden test flags; useful for our own offline tests of the
  adapter (RAN) but not a supported API. File format: one JSON per line `{"method":"generateContentStream",
  "response":[<GenerateContentResponse>...]}`.
- Quota semantics (per-model buckets, shared Google Cloud project congestion, credit balances
  `INSUFFICIENT_G1_CREDITS_BALANCE`, spending caps) are evolving; match on several signals.
- The core and the memory-sizing shim disagree about what `GEMINI_CLI_HOME` points at (see 5.2).

## 10. Suggested adapter shape (for engineers)

1. Spawn: `gemini -p "<prompt>" -o stream-json --skip-trust --approval-mode <default|auto_edit|yolo> -m <model>
   --session-id <uuid>` with env `GEMINI_CLI_HOME=<per-account dir>`, `GEMINI_CLI_NO_RELAUNCH=true`, cwd = project.
   Follow-up turns: same but `-r <uuid>` instead of `--session-id`.
2. Supervise via the stdout `stream-json` events (init gives the session id; `result` ends the turn) and the exit
   code; use the jsonl for history/tokens and `projects.json`/`.project_root` for project mapping.
3. Push signals: install hooks in the per-account `settings.json` that POST to the Agentville server
   (`AfterAgent`, `SessionEnd`, `Notification`).
4. Quota: classify from `result.error.message` as in 6.2; mark the account "limited" until the next day boundary
   (unknown exact reset) or a configured cool-down; do not call Google endpoints directly.
5. Accounts: per-account `GEMINI_CLI_HOME`; do not hot-swap `oauth_creds.json`; require a one-time interactive
   login per home.
