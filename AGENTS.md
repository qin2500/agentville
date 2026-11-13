# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex) working in this repo. Humans: see [README.md](README.md).

## What this is

Agentville is a local dashboard of your Claude Code and Codex agents, shown as an isometric pixel-art
village with a side panel (Team / Tree / Models views) and built-in terminals. Three parts:

- a local Node server (`server/`, 127.0.0.1 only) that reads session files from disk,
- a Vite-built web page (`web/`, vanilla JS + Canvas 2D),
- an optional Electron desktop shell (`desktop/`).

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (data flow, bucket rules) and
[docs/DESIGN.md](docs/DESIGN.md) (UI and village decisions) before large changes.

## Layout

| Path | What lives there |
| --- | --- |
| `server/cli.mjs` | `npm start` entry point. |
| `server/serve.mjs` | HTTP routes, snapshot cache (`GET /api/agents`), what Open/Terminal may run. |
| `server/claude-code.mjs`, `server/codex.mjs` | Harness adapters: files on disk become per-agent facts. |
| `server/classify.mjs` | Pure: facts to buckets, reasons, boss/lead/sub tree. |
| `server/accounts.mjs`, `account.mjs`, `autoswitch.mjs` | Claude account switcher. |
| `server/permmode.mjs` | Switches one Claude Code background job to bypass-permissions mode on an explicit click (backs up and rewrites its respawn flags). |
| `server/prpoll.mjs` | Live PR state (open, merged, checks) from one batched `gh` GraphQL query per interval; overrides the PR cache. |
| `server/tasks.mjs`, `loops.mjs` | `tasks.json` (follow-up Tasks list) and `loops.json` (seen, done and snooze times per agent for the "For you" strip). |
| `server/helper.mjs`, `task-names.mjs` | The Haiku helper (off by default; see Data handling) and the task naming job that uses it. |
| `server/terminal.mjs`, `pty.mjs`, `term-screen.mjs` | External and built-in terminals. |
| `server/dock.mjs`, `projects.mjs`, `prstatus.mjs` | Village data: PR buildings, ships, per-project history. |
| `server/fleet.mjs`, `restore.mjs`, `update.mjs`, `models.mjs`, `spend.mjs` | Fleet messages, restore after crash, self-update, Models view, token spend. |
| `web/src/main.js` | Page entry. |
| `web/src/village.js`, `world.js`, `iso.js` | Village rendering, world layout and persisted plan, isometric projection. |
| `web/src/city-plan.js`, `styles-pool.js` | Pure planner that grows a project into a hamlet, village, town or city on a tile plot, and the curated pool of per-project architecture, street and folk styles. |
| `web/src/ground-art.js`, `props-art.js`, `ambient.js` | Code-drawn ground tiles, procedural props, and ambient life (strollers, vendors, birds, sails). |
| `web/src/city-demo.js` | `?citydemo=1`: a showcase town of made-up projects, one per growth tier. |
| `web/src/dock.js`, `dock-art.js`, `dock-walk.js`, `agentsheet.js` | Dock scene, code-drawn art, villagers walking crates to the pier, sprites. |
| `web/src/bubbles.js` | Button that shows or hides the labels and status bubbles on the village canvas. |
| `web/src/tasks-model.js`, `loops-model.js` | Pure display models for the Team view Tasks list and the "For you" strip. |
| `web/src/panel.js`, `tree.js`, `models.js`, `ctxmenu.js`, `term.js`, `mux-model.js` | Side panel, Tree view, Models view, agent menu, terminal and splits. |
| `web/src/dev/mock.js` | Dev-only fake API, loaded with `?mock` (`?mock=big`, `empty`, `down`). |
| `web/src/dev/art-sheet.js` | Dev-only sprite sheet (`?artsheet`, with `?mock`): every building look and prop drawn in isolation. |
| `desktop/` | Electron shell (`main.cjs`, `build.mjs`). |
| `test/` | Unit tests (`*.test.mjs`) and `test/fixtures/`. |
| `e2e/`, `e2e-app/` | Playwright specs for the page and for the desktop app. |
| `tools/icon/` | Pixel-art app icon drawn in code. |
| `tools/artpass/` | Art-audit capture harness: headless close-up screenshots of the village (mock data only). |
| `docs/` | Architecture and design notes; `docs/art-audit.md` is the village art audit. |

## Commands

Node 22.13+ is required.

```sh
./setup.sh                       # check Node, npm ci, build the web app (safe to re-run; also `npm run setup`)
npm start                        # run the server on 127.0.0.1:5275 (AGENTVILLE_PORT overrides)
npm run dev:web                  # Vite dev server for web/ (add ?mock to the URL for fake data)
npm run build                    # vite build web
npm run app                      # run the Electron app from the checkout
npm run app:build -- --install   # build Agentville.app and install it to ~/Applications (macOS)
npm run fixtures -- <dir>        # write a synthetic Claude/Codex home and print the env vars for it
npm test                         # all unit tests
node --test test/classify.test.mjs   # one unit test file
npm run test:e2e                 # Playwright page specs (builds, starts a fixture server itself)
npm run test:app                 # Playwright specs for the Electron app
npm run icon                     # redraw the app icon
```

## Working rules

### Git

- Every change goes through a branch and a pull request. Never push to `main`. Never force-push.
- Squash-merge. One feature or fix per PR.
- A visual change needs before/after screenshots in the PR description.
- Ask before any destructive git operation (reset --hard, clean, branch deletion, history rewrites,
  discarding someone else's uncommitted work).
- Commit messages: one short summary line, no prefix, PR number added on squash, for example
  `Dock: ships load while PRs are open and sail off when they merge (#7)`. Explain the why in the body
  when it is not obvious.

### Privacy (this repo is public)

Never commit personal data: real names, emails, usernames, absolute home-directory paths, employer or client
names, real agent or project names from your own machine, tokens, account details, or conversation text.
Use neutral examples (`my-app`, `payments-service`, `example/demo-app`). This applies to code, tests,
fixtures, docs, screenshots and commit messages.

Before opening a PR, scrub your diff. Replace the last alternatives with your own name, username and
company:

```sh
git diff origin/main | grep -nEi '/[U]sers/|/home/[a-z]|@[a-z0-9.-]+\.(com|org|io)|your-name|your-company'
```

Screenshots must show only fixture or mock data (`?mock`, `npm run fixtures`).

### Tests and dev runs stay sandboxed

Tests and dev runs must never read or write the real `~/.claude`, `~/.codex`, `~/.config`, the macOS
Keychain, the network, or real agent sessions. Use what is already there:

- `test/fixtures/make-home.mjs`: synthetic Claude and Codex homes (`AGENTVILLE_CLAUDE_HOME`,
  `AGENTVILLE_CODEX_HOME`, `AGENTVILLE_DATA_DIR`).
- `test/fixtures/account-home.mjs`, `fake-anthropic.mjs`, `fake-github.mjs`: fake accounts, usage API
  and GitHub (temp git repos for the update check).
- `test/fixtures/bin/` (fake `claude`, `codex`, terminal): reached through `AGENTVILLE_FAKE_BIN`,
  `AGENTVILLE_CLAUDE_BIN`, `AGENTVILLE_TERMINAL`.
- `e2e/helpers.mjs` (`SAFE_ENV`, `prepareHome`): sets `AGENTVILLE_TEST=1` and fixture paths for servers.
- `web/src/dev/mock.js` for UI work without a server.

If you add a feature that touches the filesystem, network or an external binary, add an env override
and a fake first, then test against it.

### Headless, no focus stealing

Browser and Electron tests run headless and must not open visible windows or take focus. Playwright
runs headless by default; keep it that way. Desktop tests set `AGENTVILLE_HEADLESS_TEST=1` (see
`e2e-app/app.spec.mjs`). Never launch a visible window from a test or an agent run.

### Data handling

- The app never displays conversation text. Show names, titles and short status strings only.
- Never log tokens or secrets, and never put them in API responses (tests check this; see `ENV_SECRET`
  in `test/fixtures/make-home.mjs`).
- Server routes accept loopback requests with a matching Host/Origin only (`server/local-request.mjs`).
  The page never chooses what command runs; the server does.
- Personal or opt-in features default to off in code. The Haiku helper (`server/helper.mjs`) is the example:
  it is off unless `helper.json` in the data directory says `{"enabled": true}`. Turn such features on only
  through an explicit setting.

## The village is a game

- Fun over utility. A tidy table is the panel's job; the village should feel alive.
- Keep villagers visible: no hiding, overlap that buries them, or off-screen parking.
- Layouts must be stable across polls and visits. Positions are planned once and persisted
  (`web/src/world.js` stores its plan under a versioned `localStorage` key, the `va.worldN` key in that
  file). When the plan format changes, bump the key so old saved plans are not misread.
- Original art only. Sprites and buildings are drawn in code (`agentsheet.js`, `dock-art.js`,
  `tools/icon/`). Do not copy or trace assets from existing games.
- Rendering has a budget (see DESIGN.md, "Rendering budget"): keep hundreds of agents smooth.

## Worlds and mods (coming soon, not built yet)

Planned, nothing below exists in the repo today:

- A new village engine with a mod system, previewed behind `?engine=2`.
- Each world is a mod in `mods/<world-id>/`, owned by its author.
- The shared engine (`web/src/engine/**`) is reviewed by both owners.
- Mods may use only the public mod API: no reaching into engine internals or into another mod.

Do not invent APIs or create these directories ahead of the engine. Until it lands, coordinate with the
other owner before large changes to the current village files (`web/src/world.js`, `iso.js`, `village.js`,
`city-plan.js`, `styles-pool.js`, `dock.js`, `dock-art.js`, `dock-walk.js`, `agentsheet.js`) and to the
account, bypass and autoswitch server modules (`server/account.mjs`, `accounts.mjs`, `autoswitch.mjs`, `permmode.mjs`). Once the engine lands, its documentation
will be under `docs/`.
