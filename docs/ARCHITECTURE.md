# Agentville: architecture

How the pieces fit, for contributors. The [README](../README.md) describes what users see;
[DESIGN.md](DESIGN.md) explains the UI decisions.

## Overview

```
~/.claude (transcripts, jobs, live-session registry)   ~/.codex (state_<n>.sqlite, rollouts)
        │                                                   │
        ▼  server/claude-code.mjs                           ▼  server/codex.mjs
                    adapter "facts", one per agent (read-only, bounded reads)
                                     │
                                     ▼  server/classify.mjs (pure)
                 bucket + reason + role + parent, with overrides applied
                                     │
                                     ▼  server/serve.mjs  (127.0.0.1 only, Origin-checked)
                       GET /api/agents (cached ~2 s)  ·  /api/models  ·  /api/spend  ·  …
                                     │
                                     ▼  web/src (vanilla JS, Canvas 2D, built by Vite)
           village (village.js, world.js, iso.js)  ·  panel (panel.js, table.js, models.js)
```

The page polls `/api/agents` every 2 s while visible and every 15 s when the tab is hidden.

## Server modules

| File | What it does |
| --- | --- |
| `cli.mjs` | `npm start`: checks the Node version, moves the old data folder (`datadir.mjs`), rebuilds `web/dist` when sources changed, listens on `127.0.0.1:$AGENTVILLE_PORT` (5275). |
| `serve.mjs` | HTTP routes, static files, the snapshot cache, and what Open/Terminal may run (`openCommand`, chosen from server data only). |
| `local-request.mjs` | Refuses requests that aren't from loopback with a matching Host/Origin. |
| `claude-code.mjs`, `codex.mjs` | Adapters. Turn files on disk into facts: liveness, lifecycle, waits, prompts, parent links, PRs. Never return tool arguments or outputs. |
| `waiting.mjs` | Explicit wait evidence (foreground subagents, blocking `TaskOutput`, `gh run watch`, scheduler waits). |
| `classify.mjs` | Pure: facts → buckets, reasons and the boss/lead/sub tree. |
| `overrides.mjs`, `projects.mjs` | The user's corrections; per-project history for the village (PR buildings). |
| `spend.mjs`, `research.mjs`, `models.mjs` | Token counts from transcripts, read incrementally; the usage research log; the Models view. |
| `accounts.mjs`, `account.mjs`, `autoswitch.mjs`, `projection.mjs`, `network.mjs` | Saved Claude logins and their usage, switching (with backups, a canary and rollback), auto-switch, the run-out projection, and the work-network rule for quarantine accounts. |
| `fleet.mjs`, `inbox.mjs` | Fleet messages: compose a previewed plan, then deliver to live sessions' local message sockets. |
| `terminal.mjs`, `pty.mjs` | Open in a terminal window (Ghostty, Terminal.app, or a Linux terminal); the built-in terminal over a WebSocket. |
| `term-screen.mjs` | The built-in terminal's screen on the server (a headless xterm): what a page gets when it attaches, and the sizes a PTY may be given. |
| `datadir.mjs` | Where Agentville's own files live, and the one-time move from the pre-rename `village-ai` folder. |
| `update.mjs` | The update check against GitHub's `main`, Update now (pull, install, build) and the self-restart. |

## Updates

`update.mjs` finds the install's own checkout (its `.git`, never a parent folder's) and, 15 s after
start and then every 6 h, calls `GET api.github.com/repos/<owner>/<repo>/compare/<HEAD>...main`
without auth. `ahead_by` and `commits` give the count and titles; a 404 means local commits, so it
compares again from the merge base with `origin/main`. Offline or rate-limited, it keeps the last
answer and retries in 30 min or after the reset. `GET /api/update` reports it; `POST
/api/update/apply` (local, same-origin, like every POST) re-checks the tree, fast-forwards, runs
`npm ci` if `package-lock.json` changed and `npm run build`, responds, then restarts: from a terminal
the old process stays as a thin parent (so Ctrl-C still works), under the desktop app it exits with
code 75 and the app starts it again, and in the background a detached copy takes over the same log. `web/src/update.js` prompts once per latest sha (`va.update.seen`) and
reloads when a server with a new `startedAt` answers.

## How agents are sorted into buckets

The server applies these rules in order and stops at the first match:

1. Quiet for more than 24 h, or done, stopped or closed → **resting**. Resting agents are
   hidden by default but searchable.
2. Needs you → **stalled**. Detected from:
   - the scheduler reporting a background job `blocked` ("Needs your input"), unless its tempo is
     `active` or its process is busy: answering a blocked job starts a turn without clearing `blocked`;
   - Claude's live-session registry (`~/.claude/sessions/*.json`), where Claude reports the
     session's status. A status asking for you gives "Needs your input".

   **Needs a click.** A session sitting in a dialog is easy to miss, so it gets its own purple
   indicator (a cursor bubble in the village, a "Needs a click" counter that filters to them, a purple
   row, the tab title, and an optional desktop notification in Settings). Detected from:
   - the registry's `waitingFor`: `"permission prompt"` → "Needs a click: permission prompt";
     `"dialog open"` (e.g. a choice when resuming a session) → "Needs a click: a dialog is open";
   - a background job's `needs` of the form `approve <Tool>: …` → permission prompt;
   - a session that reports `idle` while a tool call is still pending → permission prompt;
   - a pending `AskUserQuestion` (or Codex `request_user_input`) → "Needs a click: pick an option";
   - a pending `ExitPlanMode` → "Needs a click: approve the plan".
3. Error or failed → **stalled**, shown as an error. This includes API errors (reason "API error (503)"),
   even when Claude's scheduler parks the job as blocked; only the status code is shown.
   If the session is still mid-turn (Claude Code is retrying on its own), the reason reads
   "Retrying — API error (503)": nothing to do in the session, it continues once the API recovers.
4. Explicit wait evidence → **waiting**. Examples: a foreground subagent, a blocking
   `TaskOutput`, `gh run watch`, or the scheduler reporting CI or agent waits. This evidence
   expires after 30 minutes.
5. Actively running → **building**. This needs real liveness: a live session that reports
   itself `busy`, a live session mid-turn and written to in the last 30 minutes, or the
   scheduler reporting the job active. A recently written file alone is not enough. Codex
   records no process, so an open turn counts for 30 minutes after its last write.
6. Turn finished, but its own child agents are still building or waiting → **waiting**
   ("Waiting on N agents").
   An idle teammate waits on its lead ("Waiting on its lead"); parked for over 30 minutes it
   rests ("Idle teammate"), matching the agent count Claude Code itself shows.
7. A live session whose turn finished → **stalled** ("awaiting your reply"). A live session
   stuck mid-turn with no progress for 30 minutes → **stalled** ("No progress for 30 min"). A
   session whose process is gone mid-work, or that errored, in the last 24 h → **stalled**
   ("Stopped unexpectedly" / "Hit an error"). A live process is never reported as stopped
   unexpectedly. A Claude session that has exited
   after a clean finish → **resting** ("Closed"). Codex can't report whether it is still
   running, so its finished turns stay in stalled for 6 h and then rest. Sessions that Codex
   imported from another agent (listed in `~/.codex/external_agent_session_imports.json`) are
   mirrors, not conversations: they rest as "Closed" unless you have continued them in Codex.

## Roles and hierarchy

Every agent is a **boss**, **lead**, **sub** or **solo**. Code: `claude-code.mjs`, `codex.mjs`,
`classify.mjs` (`build`).

Signals used:

| Signal | Where | Gives |
| --- | --- | --- |
| A `Bash` call running `claude … --bg` whose result names a job (`claude attach <8-hex>` or `backgrounded · <8-hex>`) | the launching transcript | parent → child background job. The id must match a real `~/.claude/jobs/<id>/`; a job created more than 60 s before the call was a relaunch, not a spawn. |
| `state.json` `sessionId` / `resumeSessionId` | `~/.claude/jobs/*/state.json` | which transcript a job is writing now (it moves on resume or compaction) |
| The first record's `session_id`, or a first-record `uuid` shared with exactly one job | the head of each transcript | folds older continuations of a job into it |
| `<project>/<sessionId>/subagents/agent-<id>.jsonl` + `.meta.json` (`teamName` ⇒ teammate) | next to the parent transcript | subagents and teammates, parented by folder |
| `fan[]` entries of kind `agent` | job `state.json` | only "this job runs agents of its own" |
| `thread_spawn_edges` | `~/.codex/state_<n>.sqlite` | Codex child threads |

Roles:

1. A subagent, a teammate or a spawned Codex thread → `sub`.
2. Has background-job children → `boss` if any of those has children of its own, else `lead`.
3. Otherwise, if its parent is a `boss` → `lead`; any other parent → `sub`.
4. A top-level session with teammates → `lead`. Anything else → `solo`.

A resting parent never owns a child that isn't resting. Overrides always win, and `parentId: ""`
forces an agent to the top level. Known gaps: jobs launched from a backgrounded Bash call or another
terminal have no spawn edge, so they come out `solo` (fix with an override). The first scan reads
every Claude transcript once to find spawn edges; after that only appended bytes are read.

## The village

`web/src/world.js` lays out the town, `web/src/quiet.js` decides which projects show, and
`web/src/village.js` owns the camera, input and labels.

- One compact town: a central square, with one fenced, accent-tinted block (neighbourhood) per
  project around it, joined by ring streets. Each agent with a home gets a building; subagents stand
  in their lead's yard; PRs become buildings.
- **Nothing moves.** Block and building positions persist in `localStorage` (`va.world4`); new items
  take the first free fit, a vanished building holds its ground for a while, and a hidden project
  keeps its block for 14 days.
- **Quiet projects** (every agent resting, nothing for 24 h) are left out of the village while
  *Settings → Hide quiet projects* is on (the default). The list still shows everything; the selected
  agent's project always shows; the village is never empty.
- Art is the CC0 Ninja Adventure pack (`web/public/assets/ninja-adventure/`). If the sheets fail to
  load, a procedural renderer draws the same layout.
- `?debug` exposes `window.villageDebug()` for the e2e tests.

## Safety rails in tests

Tests never touch real homes, terminals, sockets or the network:

- `test/fixtures/make-home.mjs` writes synthetic `~/.claude` and `~/.codex` trees.
- Under `AGENTVILLE_TEST=1` (or `NODE_ENV=test`) the server refuses to detect a terminal, spawn a
  CLI outside `AGENTVILLE_FAKE_BIN`, call Anthropic unless pointed at `test/fixtures/fake-anthropic.mjs`,
  read the real network, or send fleet messages outside `AGENTVILLE_FLEET_SOCKET_ROOT`. The update
  check stays off unless `AGENTVILLE_UPDATE_API` points at `test/fixtures/fake-github.mjs`, never
  updates Agentville's own checkout (only a temp clone named by `AGENTVILLE_UPDATE_DIR`) and never
  restarts the server.
