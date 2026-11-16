# Playbook: make and publish an Agentville world (for AI coding agents)

You are an AI coding agent. Your human wants their Agentville village to look different. This file takes you from
"change my village" to a merged pull request without anyone explaining anything. Follow the steps in order. Every
command below was run against this repo; if one fails, see step 8.

Reference docs, only when you need detail: [make-your-own-world.md](../make-your-own-world.md) (hooks, data keys, kit),
[mod-boundary.md](../mod-boundary.md) (lint rules, ownership), [village-mods.md](../village-mods.md) (design background).

## 1. Orient

**What a world mod is.** A folder `mods/<id>/` with an `index.js` that default-exports
`{ id, name, version, apiVersion: 1, extends, rules, hooks, ... }`. The engine owns the grid, walking, drawing, the camera
and the saved layout. The mod decides what the village looks like and how it grows. Every hook is optional; a hook you
leave out is answered by the world you `extends`.

**What you may touch.**
- Everything inside `mods/<id>/`.
- One line at the end of `.github/CODEOWNERS`: `/mods/<id>/ @<github-handle-of-the-human>`.
- Nothing else. Not `web/src/engine/**`, not another mod, not `tools/`, `package.json`, `test/`, `docs/`. `mods/index.js` is
  generated and gitignored; never commit it.

**API v1 rules.**
- `apiVersion: 1` is a literal in your file, never the engine's constant. v1 is frozen. New capabilities arrive only as
  names in `FEATURES` (`layout`, `terrain.classes`, `scatter.at`, `represent.pr`, `represent.project`, `venues`,
  `persist`; `prs.loading` is coming in the next engine update). Before relying on one: `ctx.api.has('<feature>')`.
- Import only from `#agentville/mod` and from files inside your own folder. Never `web/src/engine/**`, never another
  mod. To build on a world, use `extends` and `ctx.parent`.
- Hooks are pure and deterministic. Use `ctx.rng(stream)`, `ctx.hash(string)` and `ctx.time.now` (not available in
  `layout`). Never `Math.random`, `Date.now`, `performance.now`, `new Date(` (lint M5).
- A mod owns no I/O. Forbidden identifiers (lint M7): `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`,
  `sessionStorage`, `indexedDB`, `document`, `window`, `navigator`. No network, no reading real file paths, nothing from
  the human's machine. A mod draws only from the input it is handed.
- Do not write an own `ambient` key (ignored and linted, M6). Leave `persist` out.
- **Draw from the built world only (matters for the community feature, upcoming).** Growth and layout may be any
  algorithm you like. But how your world is drawn must depend only on the built world data (grid layers, lots, objects,
  villager positions and animations) and your world's own assets. It must not depend on local state, the clock beyond
  the provided `ctx.time.now`, unseeded random numbers, or anything about the viewer's machine. Then the same snapshot
  renders identically on every screen.
- Original art only. Nothing copied from games, films or brands. No personal data in a mod: it ships in a public repo.

## 2. Ask the human, once

Ask these in a single message, offer a default for each, then build without more back-and-forth:

1. **Theme**: what should the village be? (for example "autumn forest", "space station", "desert market")
2. **Mood and palette**: cosy, eerie, bright, calm? Two or three colours they like.
3. **Name**: the world's display name, and the id owner part (their GitHub handle, lowercase, digits and `-` allowed after
   the first dot). The id will be `<owner>.<world>`, for example `example.autumn`.
4. **Start from**: the full default village (`agentville.fantasy`) or an empty flat world (`agentville.base`)? Default:
   fantasy if they want to tweak, base if they want a new shape.
5. Their GitHub handle, for the CODEOWNERS line.

Id rules, enforced: lowercase letters and digits, at least one dot, each part after the first dot may contain `-`, at most
64 characters, not ending in `.demo`, and never starting with `agentville.`.

## 3. Scaffold

Prerequisites: Node 22.13 or newer, a clone of the repo (your own fork, see step 6), `npm install` done.

```sh
git checkout -b world/<id>
npm run mod -- new <owner>.<world>                              # empty flat world: extends agentville.base
npm run mod -- new <owner>.<world> --extends agentville.fantasy # or start from the full village
npm run mod -- check <owner>.<world>                            # a fresh copy passes
```

`new` copies `mods/_template/` to `mods/<id>/`, rewrites `id`, `name` and `extends`, regenerates `mods/index.js`, and
prints `?engine=2&world=<id>`. Run `check` after every edit.

### Change data before code

Data keys merge deeply over the world you extend (objects merge, arrays replace): `rules`, `terrain`, `objects`,
`behaviour`, `represent`, `venues`. This is the fastest visible change. In the template the data sits above the hooks:

```js
const rules = {
  layout: { accents: ['#e06666', '#6fa8dc'] },   // your own accent colours
};
```

Pull requests can look different via `represent.pr` (the state names `building` and `merged` are produced today; `loading`, via `features: ['prs.loading']`, is coming in the next engine update and is not available yet):

```js
const represent = { pr: { building: { as: 'lot', model: 'flag' }, merged: { as: 'none' } } };
// add `represent` next to `rules` and `hooks` in the default export
```

### Hooks

All hooks start as a call to the parent. Replace one body at a time. The names, from `MOD1_HOOKS`:
`growth`, `tier`, `capacity`, `lots`, `crowns`, `planSettlement`, `style`, `layout`, and the optional `scatter`.

```js
// A per-project accent from a list; only `accent` is read by the engine.
const ACCENTS = ['#c8641e', '#a8431f', '#d9a441', '#7a4a21'];
style: (projectKey, ctx, preset) => ({
  ...ctx.parent.style(projectKey, ctx, preset),
  accent: ACCENTS[ctx.hash(projectKey) % ACCENTS.length],
}),

// Settlements grow one lot sooner. Wrap the parent, do not rewrite it.
capacity: (tier, need, ctx) => ctx.parent.capacity(tier, need, ctx) + 1,

// Wild decoration on unbuilt tiles whose terrain class has `grows: true`. Ask first.
scatter: (tile, draw, ctx) => ctx.api.has('scatter.at') && draw(1) < 0.1 ? { /* terrain?, model?, variant? */ } : null,
```

`ctx` holds `rng`, `hash`, `time.now`, `parent` and `api` (`{ version, has }`).

### Toolkit (`import { ... } from '#agentville/mod'`)

`API_VERSION`, `MOD_CODE_MAX` (199; codes 200..255 belong to the engine), `FEATURES`, `MOD1_HOOKS`, `hash`, `ROAD`
(`NONE`, `PATH`, `LANE`, `STREET`, `MAIN`), `LAYOUT_GROUND` (`EDGE`, `VENUE`, `HUB`, `ROUTE`), `LOT` (`WILD`, `HUB`,
`VENUE`), `createRaster`, `routeOnRaster`, `noise(x, y, scale)`, `flood4`, `distance4`, `rectsBounds`, `near`, `inRect`,
`checkClasses`, `classByName`. Nothing else is public.

To change the land, write a `layout.js` in your folder and import it from `index.js`. The simplest correct model is
`mods/agentville.base/layout.js`: it receives `{ settlements, square }` and returns
`{ bounds, focus, tiles: { ox, oy, w, h, terrain, ground, road, lot } }`. Cheaper: call `ctx.parent.layout(input, ctx)` and change
one thing in what it returns, for example `focus`. Terrain classes are `{ code, name, water?, wild?, grows?, color? }`
with codes 0..15; class 0 is required and is also "outside the grid". `water` blocks walking.

## 4. Iterate visually

Do not judge a world from code alone. Look at it after every meaningful change.

1. Run in the background: `npm run dev:web` (a Vite dev server, default `http://127.0.0.1:5173/`). Open
   `http://127.0.0.1:5173/?mock&engine=2&debug&world=<id>&fixture=busy`. `mock` uses a fake API with synthetic data, so no
   real agents or sessions are needed. Add `&night=1` for night.
2. Headless screenshots, no visible window: `npm run mod -- shots <id>` writes `out/mod-shots/<id>/overview.png`,
   `focus-z1.png` and `index.json`. Options: `--fixture <name>` (`busy`, `citydemo`, `harbour`, `harbour-3`, `harbour-6`,
   `harbour-10`, `sequence-50`, `stress`), `--zoom 0.25|0.5|1|2|3|4`, `--night`, `--dry-run` (prints the plan and starts
   nothing). Run it in the background; it starts its own hidden dev server on port 5391 (override with `ARTPASS_PORT`).
3. Open the PNGs with your image-reading tool. Compare with the starting copy: take a baseline before your first edit.

What "good" looks like:
- Villagers are always visible: walkable ground, paths and doors are not hidden under props or dark tints.
- Layouts are stable: the same input gives the same world (the engine saves the layout; do not make the land depend on
  anything that changes between runs). Adding a project must not reshuffle the others.
- Readable at overview zoom (0.5) and at 1: you can tell settlements, roads and the square apart.
- Contrast: accent colours stay distinguishable from each other and from the ground, day and night.
- Original art only; consistent palette; no huge lint counts. Check also `stress` and `harbour-3` (many and few projects).

## 5. Verify

```sh
npm run mod -- check <id>        # must print "ok  <id>"
npm run lint:mods                # must print "mod-lint: ok"
node --test test/mod-*.test.mjs test/engine-*.test.mjs test/mods-index.test.mjs test/worlds.test.mjs test/mod-tool.test.mjs
```

`check` verifies: the import boundary and rules M1 to M7, that the mod resolves through its `extends` chain, that every
fixture in `e2e/fixtures/engine/` builds twice to the same world (determinism), that none of your own `terrain.classes`
lint, and that no hook throws. Lint kinds like `nudge` and `covered-forecourt` per fixture are advisory.
The last command is what CI runs, plus `npm run mods` and `node tools/mod.mjs check all`; run those too for a final pass.

## 6. Publish so others see it

Worlds are distributed as **reviewed code through the repo**. They are never sent through the community server. A world
is code that runs on every user's machine, so a maintainer reviews it first. Everyone who updates Agentville then has
your world in the picker (Settings, World).

1. Fork the upstream repo on GitHub (or, if the human has write access, branch). Work on a branch such as `world/<id>`.
2. Commit only `mods/<id>/**` and your CODEOWNERS line. Check with `git status` and `git diff --stat main`: no other
   path. Never `mods/index.js`.
3. Add to the end of `.github/CODEOWNERS`: `/mods/<id>/ @<handle>`.
4. Push the branch and open a pull request to the upstream repo's `main`. Describe the theme, include two screenshots from
   `out/mod-shots/<id>/` (as PR attachments, not committed), and state which fixtures you checked.
5. CI workflow `mods` must pass: `npm run mods`, `npm run lint:mods`, `node tools/mod.mjs check all`, and the mod and
   engine tests. Fix any failure on the same branch.
6. A maintainer reviews and merges. If you need something the API does not offer, open an issue; engine changes are
   reviewed separately and are never part of a world PR.

After the merge, a new release carries your world. When the village community feature ships, other people's apps can
draw your island using your world, because they already have that code.

## 7. Village community (coming soon)

Not available yet; nothing here is an API you can call.

- Planned mechanism: the owner's app runs the world's rules and growth on the owner's machine, then shares the built
  world (plain data: grid layers, lots, objects, plus anonymous villager positions and animations). Viewers install your
  world from the repo only to draw it; they never re-run your growth on their own data. So a cyberpunk world with a
  completely different growth algorithm looks on other screens exactly as it does on yours, provided drawing follows the
  rule in step 1: built world data and the world's own assets only.

- A visitor to someone's village will see only the village name, the island and the villagers walking around, with the
  HUD off.
- The world you select for your village will be how your island looks to visitors. Their app renders it with the world
  code it already has installed, so it must exist in the repo (step 6).
- Nothing in a mod should depend on this. Do not write code for it.

## 8. Troubleshooting

Messages are the ones the tools print.

| You see | Cause | Fix |
|---|---|---|
| `error: "agentville.x": the agentville.* prefix is reserved...` | Id starts with `agentville.` | Use `<owner>.<world>`. |
| `error: invalid mod id "...": must be reverse-DNS ...` | Uppercase, `_`, no dot, over 64 chars or ends in `.demo` | Lowercase, one dot, digits and `-` after it. |
| `error: mods/<id> already exists` | Folder taken | Pick another id or delete the folder. |
| `error: --extends must be a bundled mod: ...` | Unknown parent | Use `agentville.base` or `agentville.fantasy`. |
| `no mod "<id>": there is no mods/<id>/ folder` | Typo, or wrong directory | Run from the repo root; check the id. |
| `boundary M1/M3 ...` (or `M3` in lint) | Import outside your folder or from another mod | Import only `#agentville/mod` and your own files. Use `extends`. |
| `boundary M2 ...` | Bare, `node:` or URL import, or `import()` with a non-literal | Remove it; a mod needs no packages. |
| `boundary M5 ... (Math.random)` | Clock or global randomness | Use `ctx.rng(stream)`, `ctx.hash`, `ctx.time.now`. |
| `boundary M7 ... (fetch)` or `window`, `document`, `localStorage`... | Browser or network global | Delete it. A mod owns no I/O; derive everything from hook inputs. |
| `<fixture>: not deterministic (two identical runs gave different worlds)` | Hook output depends on something outside its inputs | Remove hidden state, module-level counters, iteration over unordered input without sorting. |
| `<fixture>: threw <message>` | A hook threw | Fix the hook; test against that fixture's shape (`e2e/fixtures/engine/<fixture>.json`). |
| `<fixture>: N lint error(s), first: {...}` | World lint of level error, for example a bad venue or terrain class | Read the JSON, fix the data or layout. |
| `threw The requested module ... does not provide an export named ...` | Wrong import in your files | Check the named exports; `index.js` needs a `default` export. |
| `error: --zoom must be one of 0.25 0.5 1 2 3 4` | Bad zoom | Use a listed value. |
| `error: unknown fixture "x" (have: ...)` | Bad fixture | Use a listed name. |
| `dev server did not start` (from `shots`) | Port 5391 busy or Vite failed | Set `ARTPASS_PORT=<free port>`; run `npm install`. |
| World missing from the picker, or `?world=` ignored | Not in `mods/index.js`, or engine v1 | `npm run mods`; add `engine=2` to the URL. Unknown ids fall back to `agentville.fantasy`. |
| `mod-id` / `mod-duplicate` lint, "skipped" | Invalid or duplicate id in a mod | Fix the id; ids are unique. |
| PR touched forbidden paths | Engine, tools, another mod or `mods/index.js` in the diff | Revert those files from the branch. |
