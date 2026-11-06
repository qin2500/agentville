# Agentville

**Every Claude Code and Codex session on your machine, as a little pixel-art village.** See at a
glance who's building, who's waiting on something, and who needs you.

![Agentville: the village of agents beside the agent list](docs/screenshot-village.png)

Agentville is a small local web app. It reads the session files Claude Code and Codex already write
to your disk and shows each agent as a villager, with a dark-mode list beside the village. There's
nothing to sign up for, and nothing leaves your machine except the usage checks described under
[Privacy & safety](#privacy--safety).

## What it does

**Three buckets.** Every agent that isn't resting is in exactly one:

| Bucket | Means | Examples |
| --- | --- | --- |
| **Stalled** (amber; red for errors) | It needs *you*. | Waiting for your reply; a permission prompt or a question to answer ("Needs a click", purple); an API error; a process that died mid-work; no progress for 30 minutes. |
| **Waiting** | It's blocked on something other than you. | CI or checks, a foreground subagent, a background job, its own child agents still working. |
| **Building** | It's actively working right now. | A live session mid-turn, a background job the scheduler reports active. |

Agents quiet for 24 hours, or that finished cleanly, are **resting**: tucked away by default but
searchable. The tab title shows how many are stalled, and Settings can turn on desktop
notifications. The exact rules are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#how-agents-are-sorted-into-buckets).

**Hierarchy.** If you run orchestrators, Agentville shows the structure: a **boss** with its
**leads**, and each lead with its **subagents** and teammates. It works this out from `claude --bg`
launches in transcripts, background-job records, subagent files and Codex spawn edges. You can
correct any agent's role, parent or name from its detail view.

**The village.** Each project is a neighbourhood. Agents live in homes, subagents gather in their
lead's yard, and pull requests become buildings. Stalled villagers show a "!" bubble. There's day
and night, an isometric (2.5D) and a top-down view (**I** toggles), and buildings never move around
between visits. Click a villager to select its row, and the other way round.

**Views.** The panel groups agents four ways (**V** cycles):

- **Status**: Stalled, Waiting, Building and Resting sections, longest-waiting first.
- **Team**: the boss → lead → sub tree.
- **Table**: everything in sortable columns.
- **Models**: which model each agent is *really* using (from its latest reply) next to what it was
  told to use, its route, context use and tokens, with flags for mismatches.

The first time you open Agentville, the panel fills the window in Team view. **⤡ Dock** (or **F**)
puts it beside the village; Agentville remembers your choice.

![The first-run view: the panel expanded, in Team view](docs/screenshot-team.png)

![The Models view, expanded](docs/screenshot-models.png)

**Token spend.** The top bar shows tokens per minute and the last hour's total. Click it for a chart
of the past hour, 24-hour and 7-day totals, a breakdown by kind (input, output, cache writes, cache
reads; Codex in its own rows) and, while you're on a saved Claude account, a projection of when your
5-hour and weekly limits run out.

![The token spend popover](docs/screenshot-spend.png)

**Accounts and auto-switch** (optional, Claude Code only). Save more than one Claude login in the
**Account** menu, see each one's 5-hour and weekly usage, and move every running background job to
another account in one go. Every switch makes a backup first, tries the change on one job before the
rest, and rolls everything back if that fails; **Undo** restores the last backup. **Auto-switch** (on
by default; toggle it in the token-spend popover) moves you to an account with room when the current
one runs out. If you use a shared gateway or token pool (configured via `ANTHROPIC_BASE_URL` and
friends in `~/.claude/settings.json` → `env`), it appears as one more choice, the "pool". You can
also mark accounts **quarantine** so they're never used on your work Wi-Fi.
[Details](#accounts-in-detail).

**Fleet actions** (experimental). Message many agents at once: *Prep for laptop reboot*, *Prep for
internet loss* (each agent commits locally, writes a resume note and stops), *Resume*, and *Continue
errored agents*. You always confirm a preview that lists every recipient first.
[Details](#fleet-actions-experimental).

**Open in a terminal.** **Open** resumes an agent in a new terminal window: Ghostty if it's installed,
else Terminal.app on macOS; `$TERMINAL`, `gnome-terminal` or `x-terminal-emulator` on Linux.
**Terminal** runs the same command in a terminal inside the page. The server picks the command itself
(`claude attach <job>`, `claude --resume <id>` or `codex resume <id>`); the page can't choose it. A
session that's already running somewhere else is never resumed a second time.

## Quick start

```sh
git clone https://github.com/qin2500/agentville.git
cd agentville
./setup.sh      # checks Node, installs dependencies, builds the app; on macOS offers a Desktop launcher
npm start       # then open http://127.0.0.1:5275/
```

`./setup.sh` is safe to re-run. `--no-launcher` skips the launcher and `--launcher` makes it without
asking; `npm run setup` does the same. Stop the server with Ctrl-C.

## Requirements

- **Node.js 22.13 or newer** (`node --version`). Install it from [nodejs.org](https://nodejs.org),
  with `brew install node`, or with `nvm install 22`.
- **Claude Code and/or Codex**, used on this machine. Either one is enough. With neither, Agentville
  still starts and tells you where it looked.
- **macOS** gets everything. **Linux** runs the server, the village and every view. The Desktop
  launcher, Keychain-backed accounts and the work-Wi-Fi rule are macOS-only. On Linux, Claude's login
  is read from `~/.claude/.credentials.json`.
- Optional: the Xcode command line tools (`xcode-select --install`) to build the Desktop launcher, and
  [Ghostty](https://ghostty.org) 1.3+ if you'd rather **Open** used it than Terminal.app.

## How it works

The server (`server/`, plain Node, no framework) scans `~/.claude` and `~/.codex` every couple of
seconds while the page is open, reading only bounded pieces of each file. It turns what it finds into
one record per agent, sorts them into buckets and a hierarchy, and serves that to the web app (`web/`,
vanilla JS and Canvas, built with Vite) on `127.0.0.1:5275`. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
has the details.

## Privacy & safety

**What it reads:** Claude Code's folder (`~/.claude`: transcripts, background jobs, the live-session
registry, `settings.json`) and Codex's (`~/.codex`: its state database and rollouts). The UI shows
titles, first-prompt summaries, statuses and counts, never tool arguments, commands or outputs.
Token counts come from local transcripts only.

**What it sends, and to whom:** only these calls, all to Anthropic, about your own Claude logins:

- While Claude Code is signed in to a Claude account (not a shared gateway), the server asks
  `api.anthropic.com` once a minute for that login's 5-hour and weekly usage and, when its tokens
  change, whose login it is. This drives the projection and auto-switch.
- When you open the Account menu, press Refresh, or switch accounts, it asks for your saved accounts'
  usage, and `platform.claude.com` renews an inactive saved account's login.

For these calls it reads Claude Code's login from the macOS Keychain (or
`~/.claude/.credentials.json`) and sends the token only to Anthropic. It also runs
`claude auth status` to see which kind of login is active. Nothing else goes anywhere: no analytics,
no telemetry, no GitHub polling.

**The server is local-only.** It listens on `127.0.0.1` and refuses requests that don't come from
this machine, or that come from another web page.

**What it writes:** only its own folder, `~/.config/agentville/` (or `$XDG_CONFIG_HOME/agentville`):
your overrides, token-spend counts, settings, logs of what it did (ids and results, never message
text or tokens) and, if you use the Account menu, your saved logins. Saved logins and their backups
are readable only by you (files `0600`, folders `0700`). Claude Code's own login stays where Claude
Code keeps it: the macOS Keychain (read and written with `security`, never on a command line) or
`~/.claude/.credentials.json` on Linux. Tokens never reach the page, an API response or a log.

**When it acts on your agents.** All but the last only happen when you click:

- **Open** and **Terminal** run the resume command the server chose for that agent.
- **Fleet** sends messages only after you confirm a preview listing every recipient.
- **Switch account** changes Claude Code's login (and, from the pool, its settings) and restarts
  running background jobs, with backups and automatic rollback.
- **Auto-switch** does that same switch by itself when an account runs out, and tells you, with
  Undo. Turn it off in the token-spend popover.

Agentville used to be called Village AI. On first start it moves `~/.config/village-ai` to
`~/.config/agentville` (or, if it can't move it, copies it and leaves the old folder alone). Old
`VILLAGE_*` environment variables still work.

## Configuration

All optional.

| Variable | Default | What it does |
| --- | --- | --- |
| `AGENTVILLE_PORT` | `5275` | Port to serve on (1–65535). |
| `AGENTVILLE_DATA_DIR` | `$XDG_CONFIG_HOME/agentville`, else `~/.config/agentville` | Agentville's own files. |
| `AGENTVILLE_CLAUDE_HOME` | `$CLAUDE_CONFIG_DIR`, else `~/.claude` | Where to read Claude Code sessions. |
| `AGENTVILLE_CODEX_HOME` | `$CODEX_HOME`, else `~/.codex` | Where to read Codex sessions. |
| `AGENTVILLE_TERMINAL` | auto | Terminal for **Open** (a name or absolute path), with no fallback. |
| `AGENTVILLE_CREDENTIALS` | Keychain on macOS | `file` keeps Claude's login in `~/.claude/.credentials.json` instead. |
| `AGENTVILLE_FLEET_DRY_RUN` | off | `1`: fleet actions open no socket at all. |

The tests use a few more (`AGENTVILLE_TEST`, `AGENTVILLE_FAKE_BIN` and others); see `e2e/helpers.mjs`.

## Troubleshooting

- **"Port 5275 is in use."** Something else, maybe another Agentville, is on that port. Stop it, or
  run `AGENTVILLE_PORT=5300 npm start`.
- **"Agentville needs Node.js 22.13 or newer."** Install a current Node (see Requirements), open a new
  terminal and run `./setup.sh` again. With nvm, run `nvm use 22` first.
- **No agents showing.** The list says which folders it looked in and whether they exist. Start a
  Claude Code or Codex session and it appears within a few seconds. If your Claude folder is somewhere
  else, set `CLAUDE_CONFIG_DIR` (or `AGENTVILLE_CLAUDE_HOME`). Resting agents are tucked away: search
  for them, or open the Resting section.
- **macOS won't open the launcher.** It's built and signed on your own Mac, so Gatekeeper rarely
  objects. If it does, right-click **Agentville.app** → **Open** → **Open**, or allow it under System
  Settings → Privacy & Security. Startup errors appear in a dialog, with details in
  `~/.config/agentville/launcher.log`. The app remembers where this folder is, so run
  `./setup.sh --launcher` again if you move it.
- **Open does nothing, or says it was "denied Automation access".** The first time, macOS asks whether
  your terminal (or node) may control Ghostty or Terminal. Allow it under System Settings → Privacy &
  Security → Automation.
- **"Build failed; serving the API only."** Run `npm ci && npm run build` to see the error.

## Accounts in detail

- **Saving accounts.** The login Claude Code has now shows as "Claude login"; **Save** keeps it.
  **Add account…** saves the current login, then opens a terminal running `claude auth login`. Sign in
  with the other account, choose **I've logged in**, and Agentville saves the new login and puts the
  previous one back, so adding an account never changes what's running.
- **Switching.** The current login is saved first, then the chosen one is written to Claude Code's
  login store. From the pool, the gateway settings move out of `settings.json` into
  `pool-profile.json` (put back exactly when you switch back), and jobs lose the gateway-only `cc/`
  model prefix. Each running background job is restarted with `claude respawn <id>`, one at a time.
  It keeps its conversation, but running subagents and background shells in the old process end.
  Sessions you started in a terminal are never restarted: Agentville lists them so you can restart
  them yourself.
- **Safety.** Backups go to `account-backups/` first. The first job is a test: if it doesn't come back
  running on the new settings, or its first reply is an API error, everything is put back. One change
  at a time, at most three a minute.
- **Auto-switch.** An account is out when its 5-hour or weekly window reaches 99 %, or when a running
  agent reports a usage limit. Agentville then switches to the saved account with room (both windows
  under 95 %) whose 5-hour window resets soonest, else to the pool. At most once every 15 minutes, and
  never from the pool back to an account.
- **Quarantine accounts and your work Wi-Fi.** Some accounts shouldn't be used on a work network. Mark
  them **Quarantine**, and while you're on your work Wi-Fi choose **This is the work Wi-Fi** once.
  Networks are recognised by the router's hardware address, a local lookup that needs no permission.
  On that network quarantine accounts are never used, and Agentville moves off one straight away.
  Anywhere else they're preferred when they have room. Being offline never counts as leaving.

## Fleet actions (experimental)

The **Fleet** menu is the only part of Agentville that writes to an agent, and only after you confirm
a preview of every recipient and message.

- **Prep for internet loss** and **Prep for laptop reboot** go to each live top-level Claude session.
  Each one is asked to commit its work locally (no push), write a resume note inside its own workspace
  (`.git/agentville-note.md` in a git checkout, so it's never committed, else `.agentville-note.md`)
  and stop. A boss gets one copy and is asked to pass it on to its leads and their subagents.
  Recipients then show as **waiting** ("Paused for reboot prep") instead of stalled.
- **Resume** asks the paused agents to read their notes and carry on. **Continue errored agents**
  sends the word `continue` to every agent showing an error.
- Each recipient is reported as Delivered, Sent (unconfirmed) or Failed. Codex threads, sessions that
  aren't running and subagents can't be messaged; they're listed with a command to reach them yourself.

How it works: each running Claude Code session has a local message socket (the channel Claude's own
agents use to message each other), and Agentville writes one message to each. This is an internal
Claude Code mechanism, so an update can break it; Agentville then reports agents as unreachable
rather than guessing. It only uses sockets owned by you, and it never starts, stops or resumes an
agent this way.

## Development

```sh
npm test                                     # unit tests (node --test), synthetic fixtures only
npx playwright install chromium              # once
npx playwright test                          # end-to-end tests against a fixture home
node test/fixtures/make-home.mjs /tmp/demo   # write a fake boss/leads/subs + Codex home; prints the env to use
npm run dev:web                              # Vite dev server (proxies /api to :5275); add ?mock for fake data
```

Tests never read your real `~/.claude` or `~/.codex`, never open a real terminal and never call
Anthropic. The UX notes are in [docs/DESIGN.md](docs/DESIGN.md).

## Credits & licence

MIT licensed; see [LICENSE](LICENSE). Parts are ported from
[Bot Crossing](https://github.com/jarrenrocks/bot-crossing) (MIT, Jarren Rocks); see [NOTICE](NOTICE).
Pixel art: the [Ninja Adventure Asset Pack](https://pixel-boy.itch.io/ninja-adventure-asset-pack) by
Pixel-boy and AAA, released under CC0 1.0. Built with [node-pty](https://github.com/microsoft/node-pty)
and [xterm.js](https://xtermjs.org/).
