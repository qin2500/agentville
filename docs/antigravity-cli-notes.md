# Antigravity CLI (`agy`): facts for an Agentville adapter

Researched 2026-11-24 from Google's published docs and third-party sources. Nothing was installed and no
Google login or network call to the service was made. This is a docs-only pass, so there are no "RAN" claims.
Everything below should be re-checked against a real install before an adapter relies on it.

Marks:
- **VERIFIED** = stated on a Google-owned page (URL given).
- **THIRD-PARTY** = from a blog, tutorial, forum post or GitHub issue (URL given). Treat as a lead.
- **UNCERTAIN** = inference, conflicting sources, or not documented.

Source key (all Google-owned unless noted):
- `REF` = https://antigravity.google/docs/cli/reference
- `HL` = https://antigravity.google/docs/cli/headless
- `INST` = https://antigravity.google/docs/install.md (authentication page; `/docs/cli/install` redirects to `/docs/install?tab=cli`)
- `SET` = https://antigravity.google/docs/settings?tab=cli (old `/docs/cli/settings` redirects here)
- `HOOKS` = https://antigravity.google/docs/hooks.md
- `RESUME` = https://antigravity.google/docs/cli/commands/resume
- `MIG` = https://antigravity.google/docs/cli/gcli-migration.md
- `TROUBLE` = https://antigravity.google/docs/cli/troubleshooting
- `USING` = https://antigravity.google/docs/cli/using
- `README` = https://raw.githubusercontent.com/google-antigravity/antigravity-cli/main/README.md

The project ships fast and the on-disk shapes are undocumented. Parse defensively.

---

## 1. Install and binary

- Binary name `agy`. VERIFIED (`REF`, `HL`).
- macOS/Linux install: `curl -fsSL https://antigravity.google/cli/install.sh | bash`. VERIFIED (`README`; same
  command quoted in search results from Google's docs).
- Windows PowerShell: `irm https://antigravity.google/cli/install.ps1 | iex`. VERIFIED (`README`).
- Windows CMD: downloads `install.cmd`, runs it, deletes it; third-party quotes
  `curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd`.
  THIRD-PARTY (https://docs.flutter.dev/ai/antigravity-cli.md; the same page also shows
  `winget install Google.AntigravityCLI`, which no Google page confirms. UNCERTAIN).
- Installer flags: `--skip-aliases` (do not purge legacy `agy`/`antigravity` shell aliases) and `--skip-path`
  (do not append to the shell profile PATH). VERIFIED (`INST`). A runner should pass `--skip-path` and manage
  PATH itself.
- Install location: `~/.local/bin/agy` on Unix and `%LOCALAPPDATA%\agy\bin` on Windows. VERIFIED (`TROUBLE`
  says the self-updater needs write permission in "`~/.local/bin/` on Unix, `%LOCALAPPDATA%\agy\bin` on
  Windows"). Other guides disagree on the Windows path (`%LOCALAPPDATA%\Antigravity\`). UNCERTAIN; resolve via
  `where agy` / `command -v agy`.
- `agy --version` is the check used by guides. THIRD-PARTY (search results quoting several tutorials, for
  example https://realpython.com/antigravity-cli/). No Google page seen shows it. UNCERTAIN.
- Self-updates in the background; disable with `AGY_CLI_DISABLE_AUTO_UPDATE=true`. Updater lock file
  `~/.gemini/antigravity-cli/updater/update.lock`. VERIFIED (`TROUBLE`). A runner should set the env var to
  keep a pinned version stable during a run.
- Not an npm package. No Node runtime needed per the docs (UNCERTAIN: not stated; it is a native installer).
- `agy models` lists model slugs; `agy agents` lists agents; `agy plugin import gemini` converts Gemini
  extensions. VERIFIED (`HL`, `MIG`).

## 2. Sessions and transcripts

Google documents very little here. Most of this section is THIRD-PARTY.

### 2.1 Location

- Everything lives under `~/.gemini/antigravity-cli/` (shared `~/.gemini/` parent with Gemini CLI). VERIFIED
  (`USING`, `SET`: settings and keybindings; `RESUME`: cache file). On Windows this is the user profile
  equivalent, `%USERPROFILE%\.gemini\antigravity-cli\`. UNCERTAIN (docs only show the `~` form).
- Documented files:
  - `settings.json`, `keybindings.json`. VERIFIED (`USING`).
  - `cache/last_conversations.json`: "A JSON map associating absolute workspace directory paths with their
    most recently active conversation ID". VERIFIED (`RESUME`). This is the only documented cwd-to-session map.
  - `updater/update.lock`. VERIFIED (`TROUBLE`).
- Other global config (not under `antigravity-cli/`): `~/.gemini/config/hooks.json`,
  `~/.gemini/config/mcp_config.json`, `~/.gemini/config/config.json`; workspace `.agents/hooks.json`,
  `.agents/mcp_config.json`, `.agents/skills/`. VERIFIED (`HOOKS`, `MIG`, `INST`).
- Per-conversation data: `~/.gemini/antigravity-cli/brain/<conversation-id>/`. THIRD-PARTY
  (https://dev.to/iromin/antigravity-cli-tutorial-series-part-2-conversations-conversations-and-conversations-j39,
  https://discuss.ai.google.dev/t/feature-request-configurable-path-for-gemini-antigravity-cli-brain/147404).
  Inside: `.system_generated/logs/transcript.jsonl` (shorter, large outputs truncated) and
  `transcript_full.jsonl` (untruncated), plus artifacts such as `implementation_plan.md`, `task.md`,
  `walkthrough.md`, and `scratch/`. The author says these descriptions are assumptions. UNCERTAIN.
- `~/.gemini/antigravity-cli/history.jsonl` in the root, "seems to be an index of all conversations".
  THIRD-PARTY, UNCERTAIN.
- `conversations/` with protobuf `.pb` files exists in the older Antigravity desktop/2.0 app
  (`~/.gemini/antigravity/conversations/`, later `~/.gemini/antigravity-ide/`). THIRD-PARTY
  (forum threads). Whether the CLI still writes `.pb` is UNCERTAIN. One guide also claims a per-conversation
  SQLite DB (https://www.codeagentswarm.com/en/guides/antigravity-cli-conversation-history; page not
  retrievable at research time). UNCERTAIN.
- Hooks hand the script the transcript location: every hook payload carries `transcriptPath`,
  `artifactDirectoryPath`, `workspacePaths`, `conversationId`. VERIFIED (`HOOKS`). **This is the only
  official way to learn the transcript path**: an adapter can install a `SessionStart` hook that writes the
  payload to a file, or read the path from a probe run on a real install.
- Disk growth warning: a Windows user reported ~52 GB under `~/.gemini` after long headless use
  (https://github.com/google-antigravity/antigravity-cli/issues/155, THIRD-PARTY).

### 2.2 Format

- Transcript rows are JSON Lines, one object per agent step, with fields such as `step_index`, `source`,
  `type`, `status`, `content`. THIRD-PARTY (dev.to link above). Schema is otherwise UNCERTAIN.
- The `stream-json` step events (section 3.3) are the documented, stable-ish representation of the same
  steps; prefer them over scanning files when you own the process.

### 2.3 Session id

- Called `conversation_id`. UUID-shaped (example `a1b2c3d4-e5f6-7890-abcd-ef1234567890`), but the docs do not
  promise UUIDs. VERIFIED example, format guarantee UNCERTAIN (`RESUME`).
- The CLI prints the resume command on exit, for example `Resume: agy --conversation=<id> (or -c)`.
  VERIFIED that it prints one (`USING`); exact text THIRD-PARTY (dev.to).
- **Setting the id up front: not documented.** No flag takes a new id. The id is minted by the CLI and
  reported in the `init` event (stream-json) or `conversation_id` (json). UNCERTAIN (absence of evidence).
  Adapter consequence: start the process, read the first `init` event, then record the id.

### 2.4 Mapping to cwd/project

- `init.cwd` in stream-json gives the working directory. VERIFIED (`HL`).
- `cache/last_conversations.json` maps absolute workspace path to latest conversation id. VERIFIED (`RESUME`).
  It stores only the latest per workspace, so it cannot enumerate history.
- Hook payload `workspacePaths` (array) is the per-conversation workspace. VERIFIED (`HOOKS`).
- The `brain/<id>/` directory name has no cwd in it. A scanner needs either the cache file, a hook capture,
  or a field inside the transcript rows (not confirmed). UNCERTAIN.
- Subagents have their own `conversation_id`, `log_uri` and `workspace_uris` in `subagent_info`. VERIFIED
  (`HL`). A scanner must not treat subagent conversations as top-level sessions.
- Conversations started in the Antigravity desktop app appear on the `/resume` "Other" tab and can be
  imported (cloned). VERIFIED (`RESUME`).
- Conversations can be deleted from the `/resume` picker (F4); `--continue` checks the conversation "still
  exists" on the backend. VERIFIED (`RESUME`). **Conversation history may be partly server-side**, which means
  a missing local file does not prove the conversation is gone. UNCERTAIN.

## 3. Starting headless with a prompt

### 3.1 Command

```
agy -p "<prompt>" --output-format stream-json [--model <slug>] [--mode <m>] [--conversation <id> | -c]
```

VERIFIED flags (`REF`, `HL`):

| Flag | Notes |
|---|---|
| `-p`, `--print`, `--prompt <text>` | one prompt, print, exit |
| `--output-format text\|json\|stream-json` | default `text` |
| `--input-format text\|stream-json` | stream-json reads prompts from stdin; needs stream-json output too |
| `--json-schema <string\|path\|primitive>` | adds `structured_output` |
| `--model <slug>` | slugs from `agy models`, for example `gemini-3.8-flash-medium` |
| `--effort low\|medium\|high\|xhigh\|max` | model dependent |
| `--agent <name>` | from `agy agents` |
| `-c`, `--continue` | most recent conversation for the cwd workspace (`RESUME`) |
| `--conversation <id>` | resume by id |
| `--mode accept-edits\|auto\|plan` | listed in `REF`; `HL` mentions it but omits it from its table |
| `--dangerously-skip-permissions` | approve everything |
| `--sandbox` | terminal sandbox |
| `--print-timeout <dur>` | default `0s` (none), for example `15m` |
| `--add-dir <path>` | repeatable |
| `--disable-slash-commands` | |
| `--project <id-or-name>`, `--new-project` | project selection |
| `--log-file <path>` | CLI log file |
| `-i`, `--prompt-interactive <prompt>` | run prompt then stay interactive |
| `--remote-control`, `--remote-agent` | not relevant |

- Diagnostics go to stderr, the response to stdout. Headless uses cached credentials; unauthenticated runs
  exit with an `authentication required` error. VERIFIED (`HL`).
- An unknown `--model` does not fall back; it exits 1 with `status: "ERROR"`. VERIFIED (`HL`).
- stdout must be read while the process runs; with stdin streaming the session stays open until stdin closes.
  VERIFIED (`HL`).

### 3.2 Modes (the auto/yolo equivalent)

VERIFIED (`REF`, `HL`):

- `default` (the empty `agentMode`): shell commands ask. In headless, an unobtainable approval is
  **soft-denied**: the run continues, exits 0, prints a stderr notice naming the tool.
- `accept-edits`: auto-approves workspace file edits only.
- `auto`: needs the terminal sandbox; runs sandboxed or safe reversible commands automatically, still asks for
  risky ones. macOS and Linux from v1.3.5, Windows from v1.4.4. Not for business/enterprise accounts. Since
  v1.5.7, if `agentMode` is unset, `agy -p` runs in `auto` where available.
- `plan`: research and outline only.
- Yolo-equivalent: `--dangerously-skip-permissions` (`permission_mode` becomes `always-proceed`). There is no
  `--mode yolo`. `auto` is **not** equivalent because risky actions still need approval, and in headless those
  are soft-denied, so a runner wanting unattended edits plus commands needs either
  `--dangerously-skip-permissions` or `permissions.allow` rules in `settings.json`
  (for example `command(git)`, `write_file(src/)`).
- `toolPermission` setting values: `request-review`, `proceed-in-sandbox`, `always-proceed`, `strict`.
  VERIFIED (`REF`).

### 3.3 Folder trust

- No `--skip-trust` style flag is documented. `trustedWorkspaces` (string array, "managed by the CLI") is in
  `settings.json`. VERIFIED (`REF`). Headless has no interactive prompts (`HL`), so whether an untrusted
  folder blocks a headless run is UNCERTAIN. Test on a real install; pre-seeding `trustedWorkspaces` is the
  likely lever but is UNCERTAIN.
- `allowNonWorkspaceAccess` (default false) gates file access outside the workspace. VERIFIED (`REF`).

### 3.4 stream-json schema

NDJSON, one object per line, each with an `event` field. VERIFIED (`HL`). Three event types:

1. `init` (once, first):
   ```json
   {"event":"init","conversation_id":"c3b6...","init":{"cwd":"/home/user/project","tools":["run_command","..."],"permission_mode":"request-review"}}
   ```
   `init` payload: `cwd`, `tools` (string[]), `permission_mode` (`request-review` default,
   `always-proceed` under `--dangerously-skip-permissions`), plus `model` (only if `--model`), `agent` (only if
   `--agent`), `json_schema` (only if `--json-schema`). Top-level `conversation_id` is where the session id
   appears.

2. `step_update` (many):
   ```json
   {"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"..."}}
   ```
   Fields in `step_update`: `conversation_id`, `step_index` (0-based), `state` (`ACTIVE` | `DONE`),
   `step_type`, `tool_name`, `text_delta`, `duration_seconds`, `usage`, `tool_info`, `subagent_info`.
   Observed `step_type` values: `user_input`, `agent_response`, `tool`, `checkpoint`. Long answers arrive as
   several `ACTIVE` deltas then one `DONE`; join `text_delta` fragments (the docs use `jq -j`).
   Tool step: `tool_info` = `{name, parameters, output, error?}`, where `error` is `{type, message}`:
   ```json
   {"step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hello"},"output":"hello\r\n"}}
   ```
   `subagent_info.subagents[]`: `type_name`, `role`, `conversation_id`, `log_uri`, `workspace_uris`.
   Tool names seen: `run_command` (parameter `CommandLine`); the full list is in `init.tools`.
   UNCERTAIN: whether text deltas on `ACTIVE` are cumulative or incremental (the docs say "delta" and
   "join", so incremental; the final `DONE` may repeat the full text, so do not double count: verify on a
   real run). The shape of per-step `usage` is not documented (UNCERTAIN; probably the same keys as the
   result usage). Whether a tool step emits one `ACTIVE` then one `DONE` (so tool calls appear twice by
   `step_index`) is UNCERTAIN. De-duplicate by `(conversation_id, step_index)`, keeping the latest state.

3. `result` (once per turn, last):
   Same shape as the `--output-format json` envelope, nested under `result`:
   `conversation_id`, `status`, `response`, `error` (failures only), `duration_seconds`, `num_turns`,
   `structured_output` and `json_schema` (only with `--json-schema`), `usage`
   `{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}`.
   `status` values: `SUCCESS`, `ERROR`, `CANCELED`, `INTERRUPTED` (SIGINT), `INVALID`, `WAITING` (ended
   awaiting input), `RUNNING` (no terminal state). In stdin-streaming mode `response` is per turn, while
   `num_turns`, `usage`, `duration_seconds` are cumulative.
   Whether the `conversation_id` sits inside `result` or beside it in the stream form is UNCERTAIN (the doc
   example for init shows it at top level; read both locations).

There is **no dedicated error event and no dedicated usage event**: errors appear as `result.status = "ERROR"`
plus `result.error`, or as `tool_info.error` on a tool step; usage appears on `step_update.usage` and
`result.usage`. VERIFIED (`HL`) by absence from the documented event list.

Stdin streaming (`--input-format stream-json --output-format stream-json`): one JSON object per line, for
example `{"event":"user","message":{"content":"..."}}`; content is a string or list of `{"type":"text","text":...}`
blocks only. VERIFIED (`HL`). Misuse results:

| Input | Result | Exit |
|---|---|---|
| unknown `event` | skipped, stderr warning | not stated |
| `control_request` / `control_response` | `ERROR` result, session ends | 2 |
| CLI-handled slash command (`/model`, `/usage`) | `ERROR` result, session ends | 2 |
| missing `event`, invalid JSON, non-text block | `ERROR` result, session ends | 1 |

This mode is how to keep a process alive across turns. `-p` plus stream input drops the `-p` prompt.

### 3.5 Exit codes

- 0 success; also 0 for a soft-denied tool and for a clean stdin-streamed session. VERIFIED (`HL`).
- 1 for failure to produce a response (unknown model, bad stream input), 2 for control requests and slash
  commands over stream input. VERIFIED (`HL`).
- No complete table. Auth failure, quota failure and timeout exit codes are not documented. UNCERTAIN.
  Parse `result.status`, do not rely on exit code alone.

### 3.6 Resume

- `agy -p "..." --conversation <id>` resumes by id; `-c` resumes the latest conversation **for the cwd's
  workspace** (looked up in `last_conversations.json`, verified to still exist, else a fresh session).
  VERIFIED (`RESUME`, `HL`). A runner should always use `--conversation <id>`; `-c` is racy across concurrent
  runs in one folder.
- Each call is a new process; multi-turn in one process needs stdin streaming. VERIFIED (`HL`).
- `/fork` branches a conversation (interactive only). VERIFIED (`REF`).

## 4. Auth and accounts

### 4.1 How sign-in works

VERIFIED (`INST`):
- First `agy` launch: checks the OS keyring (Apple Keychain, Linux Secret Service over D-Bus, Windows
  Credential Manager). A valid profile signs in with no browser; otherwise the default browser opens for
  Google Sign-In.
- Remote/SSH: prints an authorization URL; the user signs in elsewhere and pastes the code back.
- `/logout` (slash command inside the TUI) clears credentials and removes saved profiles from the keyring.
- **There is no documented `agy login` / `agy logout` subcommand.** Sign-in is implicit on first interactive
  launch. UNCERTAIN whether an undocumented subcommand exists. Headless runs cannot sign in (they exit
  `authentication required`).
- Sign-in with a Google Cloud project (enterprise) stores a `gcp` object `{project, location}` in
  `settings.json`; location `global`, `us` or `eu`. VERIFIED (`SET`).
- Alternative credentials, all VERIFIED (`INST`):
  - **Gemini API key**: needs `"modelProvider": "gemini"` in `settings.json` **and** `GEMINI_API_KEY`;
    "only setting a `GEMINI_API_KEY` environment variable on its own has no effect". `GOOGLE_GEMINI_BASE_URL`
    for a custom endpoint. `GOOGLE_API_KEY` and `.env` files are not read. `/logout` does nothing in this mode.
    This bypasses subscription quota (it is pay-per-key), so it is **not** a way to use a Pro/Ultra account.
  - **ADC**: `gcloud auth application-default login --project <p>`, then `AGY_ADC_AUTH=true`
    (optional `GOOGLE_CLOUD_QUOTA_PROJECT`, `GOOGLE_CLOUD_LOCATION`). Enterprise/Cloud billing, not consumer
    Pro/Ultra.

### 4.2 Where credentials live

- OS keyring only. macOS Keychain, Windows Credential Manager, Linux Secret Service. VERIFIED (`INST`).
- Entry naming is inconsistent between sources:
  - Google troubleshooting says to look for an `Antigravity CLI` item in Keychain Access and make sure `agy`
    is in its Access Control list. VERIFIED (`TROUBLE`).
  - A third-party article says macOS service `gemini`, account `antigravity`; Windows target
    `gemini:antigravity`. THIRD-PARTY (https://agentsroom.dev/blog/multiple-accounts-antigravity-cli).
  - Treat both as UNCERTAIN. Inspect on a real machine (`security find-generic-password` without `-w`, to
    list attributes and not secrets) before coding against either.
- Locked-keyring error: `Error: failed to retrieve token: secret keyring is locked`. VERIFIED (`TROUBLE`).
  Headless macOS over SSH needs `security unlock-keychain ~/Library/Keychains/login.keychain-db`.
- **No documented file-based credential store and no flag or env var to force file storage.** Not covered on
  any Google page seen. UNCERTAIN (absence), but the third-party article states the store "cannot be
  relocated" and that there are no `--profile`, `--auth-store`, or `--data-dir` flags.
- `MIG` says first launch can migrate Gemini CLI session tokens into the keyring. VERIFIED.

### 4.3 Multiple Google accounts side by side (critical)

**Answer: not supported by the CLI as documented. Plan on one subscription account per OS user, not per
process.**

- **Home/config relocation env var: none documented.** There is no `GEMINI_CLI_HOME`, `AGY_HOME` or
  `CLAUDE_CONFIG_DIR` equivalent. A feature request for one (modelled on `GEMINI_CLI_HOME`, `CODEX_HOME`,
  `CLAUDE_CONFIG_DIR`) is open with about 20 thumbs-up and no maintainer reply:
  https://github.com/google-antigravity/antigravity-cli/issues/155 (THIRD-PARTY). A second request for a
  configurable `brain/` path is also unanswered:
  https://discuss.ai.google.dev/t/feature-request-configurable-path-for-gemini-antigravity-cli-brain/147404.
  `SET` states home-directory overrides are "not covered" and shows only fixed `~/.gemini/` paths. Note that
  `GEMINI_CLI_HOME` from Gemini CLI should **not** be assumed to work; UNCERTAIN, test it, since both tools
  share `~/.gemini/` and `agy` may happen to honour it (nothing in the docs says so).
- **Credentials are a single machine-wide keyring entry**, so two processes on one OS user share one account.
  THIRD-PARTY (agentsroom link above) and consistent with `INST`.
- Account switchers work by saving a copy of each login and rewriting the one keyring entry; the switch is
  global to every running session, and a token refresh during a switch can overwrite it, so quit all `agy`
  processes first. THIRD-PARTY (agentsroom). UNCERTAIN whether that is safe; unverified by us.
- What might still work (all UNCERTAIN, test before building):
  1. **Separate OS users** (macOS user accounts or Windows users): each has its own `~` and its own keychain.
     Heavy but certainly isolated.
  2. **Override `HOME` / `USERPROFILE` per process.** `~/.gemini/...` follows `HOME` on Unix, so a different
     `HOME` isolates settings, brain, cache and hooks. But the macOS login keychain is located through the
     user database, not `$HOME`, and Windows Credential Manager is per Windows user, so the keyring entry
     would probably still be shared. A fresh `HOME` would also lack the default keychain unless one is
     created. Needs a real test.
  3. **Serialised switching**: keep per-account keyring snapshots and swap the single entry between runs, with
     a lock so no `agy` process is alive during a swap. This is the approach existing switchers use. Quota is
     per account so serial use is fine; concurrency across accounts is not possible.
  4. **Separate machines/containers** per account (the issue #155 commenters run `agy` in throwaway
     containers). In a Linux container the Secret Service is usually absent, so credentials cannot persist;
     UNCERTAIN.
- API-key mode permits per-process credentials (`GEMINI_API_KEY`), but it needs a global
  `modelProvider: "gemini"` setting in the shared `settings.json`, uses API billing, and ignores the
  Pro/Ultra subscription. Not a substitute.
- Family-plan seats reportedly share one quota pool. THIRD-PARTY anecdote (agentsroom), UNCERTAIN.

### 4.4 Reading the signed-in email

- **No documented `agy whoami`, `agy auth status` or similar command**, and no email in `stream-json` `init`.
  UNCERTAIN (absence).
- Ideas to verify on a real install: the interactive `/usage` (`/quota`), `/credits` and `/config` panels may
  show the account (they are TUI-only; in headless, `agy -p /usage` is mentioned as a way to run CLI-handled
  slash commands as separate invocations, per `HL`, which suggests `agy -p /usage` returns text). Whether it
  includes the email is UNCERTAIN.
- The keyring item's secret is an OAuth profile; decoding it to read an ID token claim is possible in theory
  but fragile and touches secrets. Not recommended without testing.
- Workaround for a switcher: tag each saved keyring snapshot with the email entered during Agentville's own
  sign-in flow, instead of reading it back from `agy`.

## 5. Quota and limits

### 5.1 What Google documents

- Official Google pages seen contain **no quota numbers, reset cadence or quota error text** for the CLI.
  `REF` lists `/usage` (`/quota`) and `/credits` slash commands and a `useG1Credits` setting (default false,
  "not for business accounts"). VERIFIED those exist. Behaviour UNCERTAIN.
- Reported cadence, all THIRD-PARTY (Google AI Developers Forum users and a Google staff reply summarised in
  search results; none is official policy):
  - A **5-hour refresh** window for AI Pro/Ultra regular use, plus a separate **weekly baseline quota**.
    Many Pro and Ultra users report multi-day lockouts instead of 5-hour resets.
    Example threads: https://discuss.ai.google.dev/t/unexpected-weekly-quota-exhaustion-on-pro-plan/169788,
    https://discuss.ai.google.dev/t/google-ai-pro-in-antigravity-is-showing-a-baseline-quota-refresh-several-days-away-instead-of-the-expected-5-hour-refresh/168580
  - **AI credits** can be spent instead of plan quota after enabling the credits setting;
    https://discuss.ai.google.dev/t/incorrect-ai-credit-refresh-date-possible-quota-bug/173189.
  - Reset time is per model family (reports of long waits for Claude and GPT-OSS models on Pro while Gemini
    models are available). UNCERTAIN.
- Treat the cadence as unknown; read the reset time from the error or the `/usage` panel, never hard-code it.

### 5.2 Error shape

No official documentation. Reported strings (THIRD-PARTY, forum posts):
- `Model quota reached` with a countdown.
- `You have exhausted your capacity on this model` with a reset time in hours.
- Log lines `RESOURCE_EXHAUSTED` / HTTP 429, `Individual quota reached`, "contact an administrator to enable
  overages", reset in about 53 hours
  (https://discuss.ai.google.dev/t/antigravity-is-returning-http-429-resource-exhausted-errors-even-though-users-still-appear-to-have-quota-available/182413,
  https://discuss.ai.google.dev/t/antigravity-hit-quota-limit-for-no-reason/172247).
- A CLI user reported "usage hit its quota" while Gemini usage looked free
  (https://discuss.ai.google.dev/t/antigravity-cli-stuck-on-starter-quota/176544).
- Exit code and stream event for a quota stop: **UNCERTAIN, not documented.** Best inference from `HL`: the
  run ends with `result.status = "ERROR"` and the text in `result.error`, exit 1. It could also show as a
  `tool_info.error` or as agent text with `status: SUCCESS` if the CLI renders the message as a response. A
  quota detector should scan all of `result.error`, `result.response`, `tool_info.error.message`, and stderr
  for: `quota`, `RESOURCE_EXHAUSTED`, `429`, `exhausted your capacity`, `AI credits`, case-insensitively.
  Capture a real exhausted run and pin the match.

### 5.3 Fallback

- Interactive UI falls back for an unknown model; **headless `--model` never falls back** (it errors).
  VERIFIED (`HL`). No documented auto-downgrade on quota exhaustion in the CLI. UNCERTAIN.
- The `/model` slash command and `--model <slug>` choose models; models come in effort-suffixed slugs
  (`gemini-3.8-flash-medium`). Other families (Claude, GPT-OSS) are reportedly offered by the same
  subscription on separate quota. THIRD-PARTY / UNCERTAIN.

### 5.4 Usage surfaces

- `result.usage` (`input_tokens`, `output_tokens`, `thinking_tokens`, `cache_read_tokens`, `total_tokens`)
  per run; cumulative in stdin-streaming sessions. VERIFIED (`HL`).
- `/usage` (alias `/quota`) shows model quota bars; it is TUI-only and the panel does not auto-refresh
  (feature request: https://discuss.ai.google.dev/t/feature-request-cli-auto-refresh-model-quota-bars-in-the-usage-quota-panel/189759.md).
  Whether `agy -p /usage` prints parseable text is UNCERTAIN.

## 6. Hooks and notifications

Hooks, VERIFIED (`HOOKS`, `SET`):
- Config: `~/.gemini/config/hooks.json` (global), `<workspace>/.agents/hooks.json`, or inside a plugin.
  `hooks` inside `settings.json` is never loaded. `/hooks` lists active hooks. For the CLI `<app_data_dir>` is
  `~/.gemini/antigravity-cli`.
- Events: `SessionStart`, `PreToolUse`, `PostToolUse` (matcher = tool-name regex, `""`/`"*"` all), `PreInvocation`,
  `PostInvocation`, `Stop`.
- Shape:
  ```json
  {"my-hook":{"enabled":true,"PreToolUse":[{"matcher":"run_command","hooks":[{"type":"command","command":"./script.sh","timeout":30}]}],"Stop":[{"type":"command","command":"./done.sh"}]}}
  ```
  `type` is only `command`; `timeout` seconds, default 30.
- Stdin JSON common fields: `conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`,
  `modelName`, `lastUserInput`. Extras: `toolCall{name,args}` and `stepIdx` (tool events), optional `error`
  (PostToolUse, Stop), `invocationNum`, `initialNumSteps`, and for `Stop`: `executionNum`,
  `terminationReason`, `error`, `fullyIdle` (boolean).
- Stdout JSON: `PreToolUse` `{decision: allow|auto_approve|deny|ask|force_ask|deny_unless_prior_grant, reason,
  overwrite, permissionOverrides}`; `Stop` `{decision:"continue"|other, reason}`; Pre/PostInvocation
  `terminationBehavior`; `injectSteps`. Exit-code semantics are **not documented**.
- Use for Agentville: a `Stop` hook with `fullyIdle` and `terminationReason` is a clean "agent finished"
  signal, and `SessionStart` gives the transcript path. A `Stop`/`PostToolUse` `error` field may carry quota
  errors (UNCERTAIN). Because global hooks are one shared file (`~/.gemini/config/hooks.json`), an adapter
  that edits it affects all the user's `agy` runs; prefer a per-workspace `.agents/hooks.json` or clearly
  named entry (`enabled` toggle) and remove it afterwards.
- Hooks reportedly run in the CLI but not in the Antigravity IDE (THIRD-PARTY forum post
  https://discuss.ai.google.dev/t/do-antigravity-ide-2-0-actually-execute-plugin-hooks-pretooluse-posttooluse-or-is-that-cli-only-right-now/176814).

Notifications, VERIFIED (`SET`): setting `notifications` (default false) rings the terminal bell and shows a
desktop notification when the agent needs approval/an answer or finishes. Not useful headless.
`/statusline` and `statusLine` exist (`REF`) but their payload is not documented here.

Telemetry: opt-in per account, stored with the account and not in `settings.json`; always off for business
accounts. VERIFIED (`SET`).

## 7. Windows specifics

- Install via PowerShell `irm .../install.ps1 | iex` or the CMD script; binary in `%LOCALAPPDATA%\agy\bin`
  (VERIFIED `TROUBLE`; see section 1 for the conflicting claim). Winget claim is UNCERTAIN.
- Credentials in Windows Credential Manager, per Windows user. VERIFIED (`INST`). The reported target name is
  `gemini:antigravity` (THIRD-PARTY).
- `auto` mode (terminal sandbox) arrived on Windows in v1.4.4. VERIFIED (`REF`).
- Tool output uses CRLF (`"hello_headless_demo\r\n"` in the doc example), so split on `\r?\n`. VERIFIED (`HL`).
- Config under the user profile `.gemini\` directory; Windows long-run headless sessions have filled the
  system drive (~52 GB). THIRD-PARTY (issue #155). Moving the data folder required a directory junction with
  all `agy` processes stopped (same issue).
- Process management: `--print-timeout` is the only built-in timeout; kill the process tree yourself.
- Shell command tool is `run_command`; whether it uses PowerShell or cmd on Windows is UNCERTAIN.

## 8. Differences from Gemini CLI that matter

| Area | Gemini CLI (see `gemini-cli-notes.md`) | Antigravity CLI |
|---|---|---|
| Binary / install | `gemini`, npm, needs Node | `agy`, native installer script, self-updates (`AGY_CLI_DISABLE_AUTO_UPDATE`) |
| Home relocation | `GEMINI_CLI_HOME` works | **none** (issue #155 open) |
| Credentials | files under `~/.gemini/`, swappable | **OS keyring only**, one entry per machine, no file mode documented |
| Account switch | swap files or set home per process | serialise a keyring swap, or separate OS users |
| Headless events | `init`, `message`, `tool_use`, `tool_result`, `error`, `result` | `init`, `step_update` (types `user_input`, `agent_response`, `tool`, `checkpoint`), `result`; no error or usage event |
| Session id | `session_id`; `--session-id` can set it up front | `conversation_id`; no documented way to choose it up front |
| Yolo | `--approval-mode default\|auto_edit\|yolo\|plan` | `--dangerously-skip-permissions`; `--mode accept-edits\|auto\|plan` |
| Transcripts | `~/.gemini/tmp/<slug>/chats/session-*.jsonl`, slug from the project basename | `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/*.jsonl` (third-party), cwd map in `cache/last_conversations.json`, not a per-project directory tree |
| Resume | `-r/--resume <uuid>` | `--conversation <id>`, `-c` (latest per workspace) |
| Context files | `GEMINI.md` | same `GEMINI.md`/`AGENTS.md` rules; skills in `.agents/skills/`, MCP in `~/.gemini/config/mcp_config.json` and `.agents/mcp_config.json`, key `serverUrl` |
| Hooks | settings-based | separate `hooks.json`, 6 events, JSON stdin/stdout |
| Subscription | Google AI Pro/Ultra no longer served (June 2026) | the supported path for Pro/Ultra |

Per consumer:
- **Runner**: spawn `agy -p <prompt> --output-format stream-json --conversation <id>` (or without for new),
  read `init.conversation_id`, join `step_update.text_delta`, finish on `result`. Use stdin streaming for a
  long-lived multi-turn process. Always set `--print-timeout`, `AGY_CLI_DISABLE_AUTO_UPDATE=true`, and an
  explicit permission strategy. Handle soft-denied tools (exit 0 with a stderr notice).
- **Transcript scanner**: the layout is undocumented and shared with the desktop app. Prefer capturing
  `transcriptPath` via a hook or probe run; use `cache/last_conversations.json` for cwd mapping; skip subagent
  conversations; tolerate `.pb` and truncated vs full transcripts.
- **Multi-account switcher**: cannot be done by env var. Serialise keyring swaps with all `agy` stopped, or use
  separate OS users. Record the email at sign-in time yourself.
- **Quota detector**: match text, not codes (section 5.2). Watch `result.status == "ERROR"`, `result.error`,
  `tool_info.error` and stderr. Read reset time from the message, since weekly vs 5-hour windows are in flux.

## 9. Open questions to settle on a real install (cheap, in order)

1. `agy --version`, `command -v agy`, `where agy`.
2. Does `HOME=<tmp>` or `GEMINI_CLI_HOME=<tmp>` relocate `~/.gemini/antigravity-cli`? Does the keyring entry
   follow (macOS)?
3. Exact Keychain item attributes (`Antigravity CLI` vs service `gemini` / account `antigravity`).
4. Real `stream-json` capture: tool step lifecycle, `usage` shape, text-delta semantics, where `conversation_id`
   lives in `result`.
5. Transcript path and row schema via a `SessionStart` hook probe; does it include cwd?
6. Output and exit code of a quota-exhausted run, and `agy -p /usage` output (does it show the email?).
7. Untrusted-folder behaviour headless; effect of pre-seeding `trustedWorkspaces`.
