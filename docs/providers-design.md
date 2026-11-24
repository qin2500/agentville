# Providers: Claude + Gemini (design)

Status: design, 2026-11-24. Not implemented. Gemini CLI facts are open and marked as `TODO(G…)` slots in the
text below. A separate research pass will fill them in.

Product rules: see the brief. In short: the providers are Claude and Gemini (official `gemini` CLI, no proxy).
`defaultProvider` is a setting. All agents of one provider share one active account. Rotation happens within a
provider first. When a provider is out, its agents are handed off: first to the default provider, then to the next
provider in `providerOrder`. Agents can start agents on the other provider. Codex is display-only.

Terms used here:
- **provider**: the account family (`claude`, `gemini`, `codex`). It is a new agent field.
- **harness**: the CLI (`claude-code`, `gemini-cli`, `codex`). This field already exists and keeps its values.

---

## 1. Provider adapter interface

### 1.1 Layout

```
server/providers/
  contract.mjs     JSDoc typedefs + assertAdapter(adapter) conformance check + PROVIDER_IDS
  index.mjs        registry: getProvider(id), providers(), providerOfHarness(h), providerOfAgent(a)
  claude.mjs       wraps existing Claude modules (nothing moves)
  codex.mjs        display-only wrapper around server/codex.mjs
  gemini.mjs       composes server/gemini/* ; TODO(G*) slots live here and there
server/gemini/
  scan.mjs         session discovery            (TODO G1)
  runner.mjs       start / stop / resume supervisor (TODO G2, G3)
  accounts.mjs     credential store + AccountOps (TODO G4)
  limits.mjs       limit text, usage readings, tuning (TODO G5, G6)
  transcript.mjs   normalizer for handoff notes (TODO G1)
```

### 1.2 Module shape (`contract.mjs`)

Every adapter default-exports one object with this shape.

```js
/** @typedef {'claude'|'gemini'|'codex'} ProviderId */
/** @typedef {{ kind:'start'|'stop'|'resume'|'fork', provider:ProviderId, args:string[], cwd:string,
 *   env?:Record<string,string>, name?:string, project?:string, id?:string, jobId?:string }} Plan */
/** @typedef {{ ok:boolean, ref?:{ jobId?:string, sessionId?:string, runId?:string }, error?:string }} RunResult */
/** @typedef {'busy'|'idle'|'limit'|'dialog'|'gone'} Activity */
/** @typedef {{ role:'user'|'assistant'|'tool', at:number, text?:string,
 *   tool?:{ name:string, files:string[], done:boolean } , todo?:{ text:string, done:boolean }[] }} TxEvent */
/** @typedef {{ fiveHour:{used:number,resetsAt:number|null,none?:boolean}|null,
 *   weekly:{used:number,resetsAt:number|null}|null, error?:string, stale?:boolean, asOf?:number }} Reading */

export default {
  id: 'claude', label: 'Claude', harness: 'claude-code',
  capabilities: { start: true, stop: true, resume: true, fork: true, message: true,
                  accounts: true, usage: 'api' /* 'api'|'errors'|'none' */, handoffTarget: true },

  // environment
  home(),                                  // string: the CLI's data folder
  available(),                             // Promise<{ ok, why }>: CLI found, not blocked (tests, Windows gate)
  bin(),                                   // Promise<string|null>
  sessionEnv: ['CLAUDE_CODE_SESSION_ID'],  // env vars that carry the caller's session id (for tools/agentville)

  // discovery
  scan(now),                               // Promise<Fact[] & { unreadable?, titles? }>; every fact has provider + harness
  configure({ dataDir }),                  // one-off setup (Claude: configureCache)
  activity(agent),                         // Promise<Activity>: turn-boundary check, used by the handoff flow

  // start / resume / stop (each returns a Plan; run() executes one)
  options(),                               // { models, efforts, modes, promptMax, nameMax }
  startPlan(body, projects),               // body: { cwd, prompt, name, model, effort, permissionMode, worktree, env }
  resumePlan(agent, { prompt? }),          // a stopped agent continues (Undo of a handoff)
  stopPlan(agent),
  forkPlan(agent, fork, name),             // optional (capabilities.fork)
  display(plan),                           // the exact command line shown on the confirm step
  run(plan),                               // Promise<RunResult>; never rejects

  // credentials + accounts (AccountOps: the existing createAccounts() return shape, plus provider)
  accounts,                                // { load, list, usage, cachedUsage, activeUsage, capture, addStart, addFinish,
                                           //   addCancel, rename, remove, readLive, identify, activate, restoreLive,
                                           //   checkActive, headroom }
  credentials: { read(), write(text), identify(text, {network}) },   // thin aliases into `accounts`
  switcher,                                // SwitchOps: { profile, status, switchTo, undo, lastChangeAt, isBusy,
                                           //   respawnStale?, settled? } (the existing createAccount() shape)

  // usage + limits
  isLimitText(text),                       // boolean: "this agent stopped on the usage limit"
  limitModel(text),                        // '' or the model a model-specific limit names
  tuning: {},                              // optional overrides of autoswitch.mjs constants (see §3.1)

  // handoff
  readTranscript(agent, { maxBytes }),     // Promise<TxEvent[]>, normalized, newest last, bounded read
}
```

`assertAdapter(a)` checks the keys and function types, and that `capabilities` agrees with what the adapter
provides. For example, `start: false` means `startPlan` throws 409. Each adapter's test calls it.

### 1.3 Claude mapping: wrap, don't move

No Claude file moves and no Claude export changes, so every existing test keeps passing unchanged.
`providers/claude.mjs` is about 120 lines of delegation.

| Adapter field | Existing code | How |
|---|---|---|
| `scan`, `home`, `configure` | `claude-code.mjs` `scan`, `home`, `configureCache` | re-export; the adapter stamps `provider:'claude'` on each fact |
| `activity` | `account.mjs` `jobActivity(home, short)` | wrap: `'stopped'` maps to `'limit'` when `limitStopAt > 0`; a session (no job) is `'idle'`/`'busy'` from `bucket` |
| `options`, `startPlan`, `stopPlan`, `forkPlan`, `display`, `run`, `bin`, `available` | `actions.mjs` `MODELS…`, `startPlan`, `stopPlan`, `forkPlan`, `display`, `run`, `claudeBin`, `actionsBlocked` | re-export; the plan gets `provider:'claude'` |
| `resumePlan` | `restore.mjs`: `claude respawn <short>`, else `claude --bg --resume <sid>` with checked flags | factor `respawnArgs(job)` / `resumeArgs(job)` out of `createRestore` as named exports (pure move inside the file) |
| `accounts`, `credentials` | `createAccount().accounts` (`accounts.mjs`) | the same object; `credentials.read = accounts.readLive` |
| `switcher` | `createAccount()` (`account.mjs`) | the same object |
| `isLimitText`, `limitModel` | `claude-code.mjs` `isHarnessLimit`; `autoswitch.mjs` `limitModel` | re-export |
| `readTranscript` | new `providers/claude-transcript.mjs` (JSONL reader using `fsutil.readTail`) | new |

Files that get a small edit, with behaviour unchanged:
- `accounts.mjs`: `loadMeta`/`saveMeta` delegate to `account-registry.mjs` with `provider:'claude'` (§2.1).
- `autoswitch.mjs`: `createSampler({ …, provider='claude', file='autoswitch.json', tuning })`, and
  `decide({ …, tuning })`, which defaults to today's constants. Log lines gain `provider`.
- `usage-pause.mjs`: `createUsagePause({ …, provider='claude', file='usage-pause.json', text })`, and
  `pauseTargets` filters by `providerOfAgent(a) === provider`.
- `serve.mjs`: the scan loops over `providers()` instead of the hard-coded `[claude.scan, codex.scan]`.
  The `/api/act/*` routes dispatch on `plan.provider`.
- `classify.mjs`: passes `provider` through, plus the `handoff` / `handedOffFrom` / `startedBy` annotations (§2.4).

`sub-limit.mjs` and the pool profile (`account.mjs` pool stash) stay Claude-only, inside the Claude adapter.
The pool is still never chosen automatically.

### 1.4 Gemini adapter (`providers/gemini.mjs`) and its TODO slots

| Slot | Needed for | Placeholder until filled |
|---|---|---|
| `TODO(G1)` session storage: where chats/checkpoints live, file format, project hash, how to tell live from finished | `gemini/scan.mjs`, `gemini/transcript.mjs` | scan returns only the runs Agentville started itself (from `runner.mjs` state), no history |
| `TODO(G2)` headless start: prompt flag, model flag, approval/yolo flag, output format, how to get a session id back | `runner.mjs` `startArgs()`, `options()` | `options()` returns `models:['']`, `modes:['']` |
| `TODO(G3)` resume: flag and id, whether a headless run can take a follow-up turn | `resumePlan`, Undo | `capabilities.resume=false` |
| `TODO(G4)` auth files: OAuth creds file, active-account file, API-key mode, whether a running process re-reads creds | `gemini/accounts.mjs` | `capabilities.accounts=false`, one implicit account `gemini-default` |
| `TODO(G5)` quota errors: the exact 429 / RESOURCE_EXHAUSTED text, and the CLI's automatic Pro→Flash fallback | `limits.mjs` `isLimitText`, `limitModel` | matches `/\b429\b|RESOURCE_EXHAUSTED|quota/i` |
| `TODO(G6)` usage readings: is there a quota endpoint, what the windows are (per-minute / per-day), reset time | `limits.mjs` `usage()`, `tuning` | "errors-only" mode (below) |
| `TODO(G7)` env var that carries the session id inside a Gemini process | `sessionEnv` | `['AGENTVILLE_AGENT_ID']` only (Agentville injects it, §5) |

**Process model.** Gemini has no `--bg` daemon. `gemini/runner.mjs` owns the process:
- spawn it detached (`windowsHide`, no shell, argv only, via `actions.launch`);
- write `<data>/gemini-runs/<runId>/state.json` (0600) with `{ runId, pid, cwd, sessionId?, name, startedAt,
  state, exitCode?, parentAgentId?, handoffId? }`;
- send stdout/stderr to `out.log` there (rotated at 4 MB);
- `stop` = SIGTERM, then SIGKILL after 10 s (`taskkill /T` on Windows).

The agent id is `gemini:<runId>`, or `gemini:<sessionId>` once G1 lets the scan link a run to its session.
Gemini agents get `messageWhy = "Gemini agents can't be messaged from here yet"` (Fleet send stays Claude-only).

**Errors-only usage (until G6).** `activeUsage()` builds a Reading from recent limit hits:
- a limit seen at T: `weekly:{ used:100, resetsAt: TODO(G6) default next 00:00 America/Los_Angeles }`;
- otherwise: `weekly:{ used:0, resetsAt:<same> }`, `fiveHour:{ none:true }`.

This feeds `decide()` unchanged. With no readings for the other accounts, `ok(u)` fails, so only the
`hard`-out fallback path (`canRun`) can pick a target. The synthesized reading must therefore pass `canRun`
when no limit has been seen.

---

## 2. Data model

### 2.1 Accounts (`<data>/accounts.json`, still one file)

```jsonc
[{ "id": "8c1f…", "provider": "claude", "label": "Work", "email": "…", "subscriptionType": "max",
   "addedAt": 0, "quarantine": true, "lowPriority": true, "oauthAccount": {…} },
 { "id": "gemini-3f9a…", "provider": "gemini", "label": "Personal Google", "email": "…", "addedAt": 0,
   "authType": "TODO(G4)" }]
```

- New `server/account-registry.mjs` provides `loadMeta(provider)` and `saveMeta(provider, list)`.
  - `saveMeta` re-reads the file under a lock and replaces only that provider's entries, so the Claude and Gemini
    writers can't drop each other's rows.
  - An entry without `provider` reads as `'claude'`.
  - On the first save after upgrade, the file is rewritten with `provider:'claude'` on those rows. A copy is kept
    as `accounts.json.pre-providers` once.
- Gemini ids carry a `gemini-` prefix, so ids never collide and the provider can be read from an id
  (`ID_RE` already allows it).
- Slots:
  - Claude: `<data>/accounts/<id>.json` (unchanged).
  - Gemini: `<data>/accounts/gemini/<id>.json`. This keeps them out of Claude's `claudeAiOauth` slot migration.
- Downgrade caveat: an older build would list Gemini rows as broken Claude accounts ("Saved login is missing").
  This goes in the release note.

### 2.2 Active account per provider

There is no stored pointer. The truth is each provider's live credential: Claude's Keychain or
`.credentials.json`, and Gemini's creds file `TODO(G4)`. `adapter.accounts.list().active` derives it, as Claude
does today. `GET /api/providers` reports `activeAccount` per provider from that.

### 2.3 Settings (`<data>/providers.json`, server-side; the switcher needs it, so not `localStorage`)

```jsonc
{ "version": 1,
  "defaultProvider": "claude",
  "providerOrder": ["claude", "gemini"],          // invariant: [0] === defaultProvider (normalized on save)
  "handoff": { "mode": "auto",                    // 'auto' | 'ask' | 'off'
               "minWaitMs": 1800000,              // don't hand off if the provider frees up sooner than this
               "maxHops": 2 },                    // per lineage per 6 h
  "agentStarts": { "enabled": true, "perHour": 20, "maxDepth": 3 } }
```

Owner: `server/provider-settings.mjs`, which exposes `createProviderSettings({ dataDir }) → { get(), set(patch),
defaultProvider(), order() }`.

Validation:
- `set` rejects unknown providers and `codex`, which can't be a target.
- `set` dedupes the order and moves `defaultProvider` to the front.

Per-provider autoswitch state:
- `autoswitch.json` stays Claude's; Gemini uses `autoswitch-gemini.json`.
- The same split applies to `usage-pause*.json`.
- `account-log.jsonl` lines gain `provider`; a line without it is Claude.

`minWaitMs` is the one engineering addition to the user's rule. A provider that frees up in 10 minutes still
counts as "usable"; waiting is cheaper than losing context. Setting it to 0 means always hand off.

### 2.4 Agent record (API, from `classify.mjs`)

| Field | Values |
|---|---|
| `provider` | `'claude' \| 'gemini' \| 'codex'`, set by the adapter on the fact |
| `harness` | unchanged; adds `'gemini-cli'` |
| `handoff` | `{ id, state, toProvider, toAgentId?, at } \| null` on the old agent |
| `handedOffFrom` | `{ id, fromProvider, fromAgentId } \| null` on the new agent |
| `startedBy` | `agentId \| null`, from `launches.json` (a cross-provider start or a handoff) |

New ledgers, all 0600 and written atomically:
- `<data>/handoffs.json`: `{ episodes: { [provider]: { id, since, until } }, records: { [hid]: HandoffRecord } }`.
- `<data>/handoffs/<hid>.md`: the full note.
- `<data>/launches.json`: `{ [ref]: { parentAgentId, provider, via: 'api'|'handoff'|'ui', at } }`.
  - `ref` is a jobId, sessionId or runId.
  - Kept 14 days. This is how `parentId` works across providers: the Claude scan only links `claude --bg`
    children through transcript lines.

```js
/** HandoffRecord */
{ id, episode, chain: ['claude','gemini'], parentHid?,
  from: { agentId, provider, jobId?, sid?, cwd, name },
  to:   { provider, agentId?, ref? },
  state: 'planned'|'waiting_idle'|'noted'|'starting'|'started'|'stopping'|'done'|'failed'|'undone'|'cancelled',
  interrupted?: { tool }, error?, attempts, createdAt, updatedAt }
```

---

## 3. Switcher

### 3.1 Within-provider rotation (unchanged logic, one instance per provider)

`serve.mjs` builds one sampler per provider that has `capabilities.accounts`:
`createSampler({ provider, account: adapter.switcher, agents: () => agentsOf(provider), file, tuning: adapter.tuning })`.

- `decide()` stays the same pure function. `tuning` can override `SWITCH_AT`, `OUT_AT`, `SOON_WEEK_MS`,
  `WAIT_RESET_MS` and `TARGET_MIN_ROOM`. For Claude it is `{}`, so decisions are byte-identical. A test pins this
  on the existing autoswitch fixtures.
- `agents()` for a provider returns only that provider's agents. Gemini limit stops then never count against a
  Claude account.
- Quarantine, low priority, the cooldown, backoff, stale-login handling and AUTO_POOL all stay per sampler.

### 3.2 Provider-exhausted detection (`server/provider-switch.mjs`)

`exhausted(provider)` is true when all of these hold:
1. `sampler.info().blocked?.why === 'all accounts low'`. This is today's `stuck` state: really out, and
   `decide()` found no target, not even a fallback.
2. It has held for 2 consecutive ticks and at least `EXHAUST_CONFIRM_MS = 2 min`. This lets an in-flight switch or a
   stale reading settle.
3. `until == null` or `until - now > settings.handoff.minWaitMs`.

A provider without accounts (`capabilities.accounts=false`) is exhausted when ≥1 of its live agents stopped on the
limit in the last 10 minutes, and none has run since.

An episode starts at (1) and gets an id: `<provider>-<since>`. It ends when `blocked` clears.

### 3.3 Fallback target

```js
// pure, exported for tests
export function fallbackTarget(from, { defaultProvider, providerOrder }, state /* id -> { usable, why } */) {
  const order = [defaultProvider, ...providerOrder.filter((p) => p !== defaultProvider)]
  return order.find((p) => p !== from && state[p]?.usable) ?? null
}
```

- `usable` means: an adapter with `capabilities.start && handoffTarget`, `available().ok`, and not `exhausted`.
- A non-default provider out → the default, if usable. The default out → the next in order.
- Codex is never a target.

### 3.4 Handoff flow (`server/handoff.mjs`)

Settings: `handoff.mode='off'` → nothing happens. `'ask'` → records go to `planned`, and the UI shows one prompt
listing the agents (§3.6). `'auto'` → the flow runs.

**Who is handed off.** Agents of the exhausted provider that are all of:
- top-level (`kind` is `job` or `session`, never `subagent`/`teammate`/`thread`);
- live, or stopped on the limit after `episode.since - 5 min`;
- not `hidden`, not `self` (Agentville's own session), not `neverStarted`;
- not already in a non-terminal handoff record;
- their lineage `chain` length is under `maxHops`.

**Order.** Children before parents, where a child has `parentId` and is itself a job/run. A parent's note can then
list its children's new ids. At most 2 run at once, 2 s apart (like `usage-pause` `STAGGER_MS`).

**Steps per agent.** The record is persisted before each side effect.

1. `planned`: the record is created with id `hid = sha256(agentId + episode.id).slice(0, 16)`.
   This is the de-dupe key: the same agent in the same episode always gets the same `hid`, so a second create
   is a no-op.
2. `waiting_idle`: `source.activity(agent)` is polled every 3 s, for up to 10 min (`AGENTVILLE_HANDOFF_IDLE_MAX_MS`).
   - `limit`, `idle` or `gone` → continue.
   - `dialog` → continue; the note records the question.
   - `busy` past the limit (a long Bash or tool call still running) → continue. The record gets
     `interrupted:{ tool }`, and the note says: "a `<tool>` call was still running when you took over; check its
     effect before redoing it".
3. `noted`: `buildNote(events, changes)` from `handoff-note.mjs` writes `<data>/handoffs/<hid>.md`. This is pure
   extraction with no LLM call: the old agent is out of usage and can't write its own note. The note has:
   - **Task**: the first user prompt plus later user prompts (each cut to 600 characters).
   - **Done**: the last TodoWrite list (done items), and the last 3 assistant texts (800 characters each).
   - **Changed files**: `changes.mjs` `readChanges(cwd)` (git status), merged with the files from Edit/Write tool
     calls.
   - **Left**: open todo items; the interrupted tool; open questions; for a lead, its subagents that were still
     running (description only) and its child jobs, with their new ids.
   - **Pointers**: the old transcript path (read-only) and the old agent's name/id.

   The prompt is a fixed preamble plus the note, cut to `PROMPT_MAX - 500`. The full note path is always included.
4. `starting`: `target.startPlan({ cwd: from.cwd /* worktree path if it was in one */, prompt, name:
   "<name> (from Claude)", model: mapModel(from, target), permissionMode: mapMode(from, target),
   env: { AGENTVILLE_AGENT_ID: hid, AGENTVILLE_HANDOFF_ID: hid } })`, then `run`.
   - The ref is written to the record and to `launches.json` (`via:'handoff'`).
   - `mapModel` / `mapMode` default to `''` (the provider's default), except for a small table in the target
     adapter (`TODO(G2)` for Gemini's mode names).
5. `started`: the flow waits until the scan shows the new agent, matched by ref (≤ 2 min), and checks that it isn't
   `neverStarted`. Only then does it stop the old agent.
6. `stopping`: `source.run(source.stopPlan(agent))`.
   - An interactive Claude session can't be stopped from here. The record goes to `done` with
     `note:'close the old terminal'`, and the inspector shows it.
7. `done`.

**Failure modes.**

| Case | Behaviour |
|---|---|
| The target is also out (now, or before step 4) | `fallbackTarget()` is re-checked right before `starting`. If there is no target, the record goes to `cancelled` ("no provider has room"), and that provider's `usage-pause` instance pauses the agent as today. Nothing is stopped. |
| The target runs out later (Gemini out after a Claude→Gemini handoff) | A normal new episode for Gemini. Its target is the default (Claude). If Claude is still out, there is no target, so the agent is paused. Hops are bounded by `maxHops` per lineage per 6 h, so there is no ping-pong. |
| Start fails, or the agent never appears | `failed`, `attempts++`. The old agent is not stopped. One retry after 2 min, then the user sees "Handoff failed: Retry / Dismiss". |
| Stop fails | `done`, with the warning `old agent still running` and a "Stop it" button. No blind retry. |
| Server restarts mid-flow | On load, each non-terminal record resumes from its state. `starting` with no ref: first search the scan for an agent whose launch env or ledger carries `hid`. Start again only if none is found, so there is never a double start. |
| A handoff mid tool call | Step 2 waits for a turn boundary (10 min max), then marks it `interrupted` (above). |
| A lead with subagents | In-process subagents die with the lead; the note lists them so the new lead can re-run them. Child background jobs are handed off as their own records first (same episode). The parent's note maps old child id → new child id, and `launches.json` re-parents the new children under the new lead. |
| A child already handed off by a parent's flow | The `hid` de-dupe makes it a no-op. |
| The user starts a manual handoff during an auto one | Same `hid` key, so it joins the running record. |
| The source recovers mid-flow (before `starting`) | → `cancelled`. After `started`, it carries on (no hand-back, §3.5). |

### 3.5 What the user sees, and undo

- The provider's account group shows a banner: "Claude is out on every account until 14:00 — 3 agents handed to
  Gemini." A toast (once per episode) offers "Show".
- The old agent's inspector says "Handed off to `<name>` (Gemini) · Undo". The village shows it as resting, with
  its usual stopped look. The new agent's inspector says "Continued from `<name>` (Claude) · note".
- **Undo** (`POST /api/handoffs/:id/undo`, only from `started` or `done`):
  1. `target.stop(new)`;
  2. `source.resumePlan(old, { prompt: "While you were stopped, a Gemini agent worked on this task. Its handoff
     note is at <path> and its changes are in the working tree; review them, then continue." })`;
  3. → `undone`. Files are never reverted.

  If the source is still exhausted, the confirm warns: "it will wait on the limit".
- **No automatic hand-back** when the source recovers: each handoff costs context. The new agent's menu offers
  "Hand back to Claude", which is a normal handoff in the other direction with a fresh note.
- `account-log.jsonl` gets one `handoff` line per record transition to `done`, `failed` or `undone`. It holds ids,
  providers and states only, never prompt or note text.

### 3.6 Interplay with existing nudgers

- The `usage-pause` instance per provider only pauses agents that the handoff flow left with no target (it asks
  `handoff.covers(agentId)`).
- `sub-limit` and the stale-login nudges skip agents whose `handoff.state` is non-terminal.

---

## 4. UI

| Surface | File(s) | Change |
|---|---|---|
| New agent | `web/src/launch.js` | A provider segmented control at the top (Claude / Gemini), defaulting to `opts.defaultProvider`. Model, effort and mode lists come from `opts.providers[p]`. An unavailable provider is disabled, with its `why` as helper text. The confirm shows the exact `gemini …` command. The lede becomes "Starts a background agent…". |
| Settings | new `web/src/providers-settings.js`, one hook in `main.js` `fillPop('settings')` | A "Providers" section with: a Default provider select; an order list with ↑/↓ buttons (accessible, no drag), where the default is pinned first; Handoff (Automatic / Ask first / Off); "Wait for a reset under N min". Saves through `PUT /api/providers/settings`. |
| Accounts menu | `web/src/account.js`, `acct-items.js` | One group per provider: a header with the active account, the auto-switch state and the exhausted banner; the rows; and "Add a Gemini account". The right-click menu is the same per row (quarantine and low priority apply per provider). A "Handoffs" list (new `web/src/handoffs.js`) shows rows with state plus Undo / Retry / Dismiss, and the "Ask first" confirm. |
| Village marker | `web/src/engine/snapshot.js` (`AGENT_FIELDS` + `copyAgentFields`: add `provider`), `engine/sim/represent.js` (carry `provider`), `engine/render/actor-art.js` (accessory) | Gemini agents wear a small four-point sparkle accessory above the head, in a violet-blue tint. It is generic and not a logo. It goes in the actor sprite key, and it shows at every zoom (far zoom keeps full detail). Status badges are untouched. |
| Labels, filters | `web/src/ui.js` `HARNESS_NAME['gemini-cli']='Gemini CLI'`; `main.js` filter box; `engine/mod/input.js` `HARNESS['gemini-cli']='gemini'` | Mechanical. |

---

## 5. Agent-to-agent start: API and CLI seam

**Endpoint** `POST /api/agents/start`. It uses the same `isLocalRequest` + JSON content-type + origin header guard
as `/api/notify`. Owner: `server/agent-start.mjs` (`parseAgentStart(body)`, `checkAgentStart(input, ctx)`).

```jsonc
// request
{ "session": "<caller session id or AGENTVILLE_AGENT_ID>", "provider": "gemini" /* default: defaultProvider */,
  "prompt": "…", "name": "…", "cwd": "/abs/path" /* default: caller's cwd */, "model": "", "permissionMode": "" }
// 200
{ "ok": true, "id": "gemini:…" | null, "ref": { "runId": "…" }, "provider": "gemini" }
```

The guards are fixed strings, and each one returns 4xx:
- `agentStarts.enabled`;
- the caller resolves (`resolveSession`) to a live agent that is not a subagent;
- `cwd` is the caller's cwd, inside it, or a known project;
- the target provider is `usable`;
- the caller's start depth (from `launches.json` `startedBy` links) is under `maxDepth`;
- `perHour` per caller, and 60 per hour overall;
- the body goes through the adapter's `startPlan`, so the same allowlists apply.

Every start is logged to the fleet log with ids only, and recorded in `launches.json` (`via:'api'`). There is no
confirm token: the caller is an agent the user already runs, and the setting is the consent.

Agentville injects `AGENTVILLE_AGENT_ID=<ref>` and `AGENTVILLE_PORT` into every agent it starts, for both
providers. A Gemini agent can then call back even before `TODO(G7)` is known.

`GET /api/agents/:id/status` returns `{ id, provider, bucket, live, handoff }`. It is a small read for a parent
that wants to poll the agent it started.

**CLI** `tools/agentville.mjs`, plus `tools/agentville` (sh) and `tools/agentville.cmd`. It has no dependencies,
and its argument parsing and errors work like `tools/notify.mjs`:

```
agentville start [--provider gemini|claude] [--cwd DIR] [--name N] [--model M] [--mode P] "prompt"
agentville status <agent-id>
agentville notify "message" [--title T]      # same as agentville-notify (kept)
```

The session comes from `--session`, or else the first set variable among `CLAUDE_CODE_SESSION_ID`,
`AGENTVILLE_AGENT_ID` and the Gemini var (`TODO(G7)`). On success it prints the new agent id on stdout.
`docs/agents/` gets a snippet for CLAUDE.md / GEMINI.md that tells agents the command exists.

Other endpoints:
- `GET /api/providers` → `{ defaultProvider, providerOrder, handoff, agentStarts, providers: [{ id, label,
  available, why, capabilities, activeAccount, exhausted: { since, until } | null }] }`
- `PUT /api/providers/settings` (body: the patch)
- `GET /api/act/options` → adds `defaultProvider` and `providers: { [id]: { models, efforts, modes, available,
  why } }`. The top-level `models/efforts/modes` stay Claude's for back-compat.
- `POST /api/act/preview` → the body takes `provider`, defaulting to `defaultProvider`.
- `GET /api/accounts` → adds `byProvider: { [id]: <list() result + autoSwitch info> }`; the top level stays Claude's.
- `POST /api/accounts/add/start` → `{ provider }`.
- `GET /api/handoffs`; `POST /api/handoffs/:id/(undo|retry|dismiss|approve)`;
  `POST /api/agents/:id/handoff { to }` (manual).

---

## 6. Work split

The rules: each piece owns its files, and no two pieces edit the same file. The seam names below are frozen by
this doc. Pieces marked **G** have TODO slots that wait on the Gemini research; build them now against the
placeholders.

Seam names: `assertAdapter`, `getProvider`, `providers`, `providerOfHarness`, `providerOfAgent`,
`createProviderSettings`, `loadMeta(provider)` / `saveMeta(provider, list)`, `fallbackTarget`,
`createProviderSwitch`, `createHandoffs`, `buildNote`, `notePrompt`, `createLaunches`, `parseAgentStart`,
`checkAgentStart`, and the endpoints and types in §2 and §5.

| # | Piece | Owns (new unless noted) | Depends on | G | Model |
|---|---|---|---|---|---|
| P0 | Contract + registry | `server/providers/contract.mjs`, `server/providers/index.mjs`, `test/providers-contract.test.mjs` | none (land first, ~1 h) | | sonnet |
| P1 | Provider settings | `server/provider-settings.mjs`, `test/provider-settings.test.mjs` | none | | sonnet |
| P2 | Account registry + migration | `server/account-registry.mjs`, edit `server/accounts.mjs` (loadMeta/saveMeta only), `test/account-registry.test.mjs` | none | | sonnet |
| P3 | Claude adapter + transcript reader | `server/providers/claude.mjs`, `server/providers/claude-transcript.mjs`, edit `server/restore.mjs` (export `respawnArgs`/`resumeArgs`), `test/claude-adapter.test.mjs` | P0 | | sonnet |
| P4 | Codex adapter (display-only) | `server/providers/codex.mjs` | P0 | | haiku |
| P5 | Gemini runner | `server/gemini/runner.mjs`, `test/gemini-runner.test.mjs` (fake bin) | P0 | G2 G3 | sonnet |
| P6 | Gemini scan + transcript | `server/gemini/scan.mjs`, `server/gemini/transcript.mjs` | P0, P5 state format | G1 | sonnet |
| P7 | Gemini accounts/credentials | `server/gemini/accounts.mjs` (AccountOps + SwitchOps), test | P2 | G4 | opus (token rotation hazard) |
| P8 | Gemini limits/usage | `server/gemini/limits.mjs`, test | none | G5 G6 | sonnet |
| P9 | Gemini adapter glue | `server/providers/gemini.mjs` | P0; stubs for P5–P8 | G* | sonnet |
| P10 | Sampler + pause per provider | edit `server/autoswitch.mjs`, `server/usage-pause.mjs`; `test/autoswitch-provider.test.mjs` (Claude decisions byte-identical) | none | | sonnet |
| P11 | Handoff note | `server/handoff-note.mjs` (`buildNote(events, changes, meta)`, `notePrompt(note, max)`), test | TxEvent type (P0) | | sonnet |
| P12 | Handoff engine | `server/handoff.mjs` (`createHandoffs`), `test/handoff.test.mjs` with fake adapters | P0, P11 seam | | **opus** |
| P13 | Provider switch / exhaustion | `server/provider-switch.mjs` (`createProviderSwitch`, `fallbackTarget`), test | P1, P10 `info()` shape | | **opus** |
| P14 | Launch ledger + agent-start guards | `server/launches.mjs`, `server/agent-start.mjs`, tests | P1 | | sonnet |
| P15 | CLI | `tools/agentville.mjs`, `tools/agentville`, `tools/agentville.cmd`, `docs/agents/agentville-cli.md` | §5 contract only | | sonnet |
| P16 | Server integration | edit `server/serve.mjs`, `server/classify.mjs`, `server/actions.mjs` (plan carries provider) | merges after P0–P14 (can stub early) | | sonnet |
| P17 | New agent picker | edit `web/src/launch.js` | §5 options shape | | sonnet |
| P18 | Settings section | `web/src/providers-settings.js`, edit `web/src/main.js` (settings hook + filter box only) | §5 | | sonnet |
| P19 | Accounts menu + handoffs list | edit `web/src/account.js`, `web/src/acct-items.js`; new `web/src/handoffs.js` | §5 | | sonnet |
| P20 | Village marker + labels | edit `web/src/engine/snapshot.js`, `engine/sim/represent.js`, `engine/render/actor-art.js`, `engine/mod/input.js`, `web/src/ui.js` | `provider` field | | sonnet (visual check at far zoom) |
| T1–T4 | Spec tests, written from this doc and not from the code | `test/fallback-target.spec.test.mjs`, `test/handoff-dedupe.spec.test.mjs`, `test/agent-start-guards.spec.test.mjs`, `test/accounts-migration.spec.test.mjs` | this doc | | sonnet |
| R1 | Review of P12+P13 (Keystone gate) | none | P12, P13 | | opus |
| R2 | Security review of P7, P14, P15 (credentials; agents starting agents) | none | P7, P14, P15 | | fable |

Merge order: P0 → (P1, P2, P3, P4, P8, P10, P11, P14, P15 in parallel) → (P5, P6, P7, P9, P12, P13, P17–P20) →
P16 → R1/R2 → one PR.

These can ship before the Gemini research lands:
- Claude behaviour stays identical: P2, P3, P10 and P16 with only the Claude and Codex adapters registered.
- The settings UI, with Gemini shown as "not available: Gemini CLI not found".
