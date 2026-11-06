# Agentville: UX design notes

The design notes the app was built from: who it is for, the layout, views, row anatomy, the village
and its art direction, theme tokens and accessibility. They explain *why* the UI is the way it is.
Where they and the [README](../README.md) disagree about current behaviour, the README and the code
win. [ARCHITECTURE.md](ARCHITECTURE.md) covers the server side.

## 1. The user, the moment, the job

The user glances over while 50–150 sessions run. The one job: **"Does anyone need me, and who
exactly?"** Second job: find any named agent in under 3 seconds. The village is the ambient,
pleasant view; the panel is the instrument. Nothing in the village is load-bearing — every fact it
shows is also in the panel.

## 2. Stack decision

Vanilla JS + Canvas 2D. No Preact: the list is ≤ 150 rows, re-rendered on a poll every 2 s. Keep a
`Map<id, HTMLElement>` and patch rows in place (text, classes, order via `append` in sorted order —
moving an existing node keeps focus). That is ~80 lines and cheaper than a framework.
Data: poll `GET /api/agents` every 2 s while visible, every 15 s when the tab is hidden (the title
badge still updates), stop entirely after 3 failed polls → disconnected state (§9) with backoff.

## 3. Screen layout (desktop first; this is a local desktop tool)

```
┌ top bar 44px ──────────────────────────────────────────────────────────────────┐
│ ▣ Agentville   [! 3 Stalled]  ⌛ 7 Waiting  ⚒ 12 Building      ● live · 2s  ⚙ │
├──────────────────────────────────────────────┬─────────────────────────────────┤
│                                              │ panel 400px                     │
│           village canvas (fills)             │ [/ Search agents…        ] [⤢] │
│                                              │ [Status|Team]  Filters ▾        │
│                                              │ STALLED · 3                     │
│                                              │  rows…                          │
│                                              │ WAITING · 7                     │
│                                              │ BUILDING · 12                   │
│                                              │ ▸ Resting · 41                  │
└──────────────────────────────────────────────┴─────────────────────────────────┘
```

Viewport rules: < 900px wide → panel opens as an overlay over the village (village keeps
rendering behind it, not resized). ≥ 1600px → panel 440px. Full-screen ignores widths.

### Panel modes

| Mode | What shows | Enter |
| --- | --- | --- |
| **Collapsed** | 40px rail on the right edge: three stacked count pips (! 3, ⌛ 7, ⚒ 12) and an expand chevron. Village gets the space. | `\` or rail chevron/`«` button |
| **Docked** (default) | 400px panel as above. | `\` from collapsed; `Esc` from full-screen |
| **Full-screen** | Panel covers the whole area below the top bar. Village canvas stops drawing (not just hidden). | `F`, or the `⤢` button in panel header |

`\` toggles collapsed ↔ docked. `F` toggles docked ↔ full-screen (from collapsed it goes straight
to full-screen). `Esc` leaves full-screen to docked, but first clears an active search/selection if
there is one (one `Esc` = one step back). The mode persists in `localStorage` (`va.panel`). Keyboard
shortcuts are ignored while focus is in a text input, except `Esc`.

## 4. Views: how buckets and hierarchy combine

Two views, one segmented control `[Status | Team]`, key `V` to switch. Each mode remembers its
own view: **docked defaults to Status, full-screen defaults to Team.**

Why: docked is the glance — the attention list must be on top with nothing to scroll past, so
bucket sections win. Full-screen is "see everyone and the structure" — the user expands it to
understand the org, so team grouping wins, and it has the width to put a bucket badge on every
row. Both views show both dimensions; only the primary grouping changes.

### Status view (default docked)

Sections in fixed order: **Stalled → Waiting → Building → Resting (collapsed)**. Section header:
icon + label + count, sticky while its rows scroll. An empty Stalled section stays visible with
"Nobody needs you." so absence is an explicit, reassuring fact.

Hierarchy inside a section: rows are flat (no indentation, because the parent is often in another
section), but every row carries its role glyph and, for subs and leads, a muted "↳ Auth Lead"
parent crumb. A boss sorts first in its section.

**Full-screen Status**: three equal columns Stalled | Waiting | Building, each scrolling on its
own; Resting is a collapsed bar across the bottom ("▸ 41 resting — show"). On < 1100px wide it
falls back to the single stacked list.

### Team view (default full-screen)

A tree: Boss → Leads → subs. Solos (no parent, no children) go in a final "Solo" group.

- **Docked**: indented tree, 16px per level, with a 1px `--line` guide on the left of children.
  Each lead group is collapsible (chevron; `←`/`→` on a focused lead). Boss row is the group
  header for its whole team.
- **Full-screen**: one **card per lead** in a responsive grid (`grid-template-columns:
  repeat(auto-fill, minmax(320px, 1fr))`) under a boss header strip per team. Card = lead row +
  its subs indented. Card left border is 3px in the worst bucket colour among its members, and
  the card header shows a mini tally `! 1 · ⌛ 2 · ⚒ 3`.
- Ordering: teams, then cards within a team, by **worst bucket** (stalled > waiting > building >
  resting), then by most recent `since`. Inside a card, subs sort the same way.
- Resting members inside a team collapse to one "+ 4 resting" line per card.

## 5. Row anatomy

Height 44px (two lines), 12px horizontal padding. At 900px tall the docked panel shows ~16 rows;
full-screen at 1440×900 in Team view shows ~60 rows (4 columns × ~15). A **Compact** toggle in
Filters (`va.density`) switches to one-line 30px rows (line 2 hidden; reason moves to a tooltip
and the detail view).

```
 ┌─────────────────────────────────────────────────────────────┐
 │ ♛ Big Boss                  #6856 #6861        ● 12m        │  line 1
 │   ! Needs your answer · my-app                   │  line 2
 └─────────────────────────────────────────────────────────────┘
```

Line 1, left → right:
1. **Role glyph** 14×14, pixel icon in `--text`: boss = crown, lead = flag, sub = small filled
   square (6×6, visually smaller), solo = hollow square. Shape alone carries the role. Text alternative
   in the row's accessible name ("Boss", "Lead", "Subagent", "Solo"). If `roleSource` is
   `override`, a 4px `--accent` dot sits at the glyph's top-right.
2. **Name**, 13px; boss 600 weight, lead 600, sub/solo 400. Ellipsis truncation, `title` holds full.
3. **PR chips** (max 2 then "+N"), mono 11px, `--surface-3` bg, open `href` in a new tab.
   Clicking a chip never selects the row.
4. **Live dot** 6px: filled `--building` if `live`, hollow `--text-dim` ring if not. Not
   animated.
5. **Time in state**, right-aligned, tabular numerals, from `serverTime - since`:
   `<1m`, `12m`, `3h`, `2d`. For Stalled rows older than 30m the time turns `--stalled`.

Line 2 (muted, 12px): **bucket icon** (! / ⌛ / ⚒ / ☾ — shape, not colour, carries meaning) +
**reason** (or "Building" if empty) + ` · ` + **project**. Subs/leads in Status view append
` · ↳ Auth Lead`. In Team view the project is dropped when equal to the parent's.

Row backgrounds: default transparent. Stalled rows get `--stalled-bg` plus a 3px `--stalled`
left bar — the only rows with a fill. Waiting rows get nothing extra (calm). Resting rows render at
`--text-muted` throughout.

States: hover `--surface-2`; selected `--surface-3` + 3px `--focus` left bar (overrides the
stalled bar; the stalled bg stays); focus-visible 2px `--focus` outline, 2px inset; a row whose
bucket changed in the last poll flashes its bg once (400ms, none under reduced motion).

## 6. Sorting, search, filters

**Sort** (within a section / card): stalled by `since` ascending (longest-waiting first — he owes
those the most); waiting and building by `lastActivityAt` descending; resting by
`lastActivityAt` descending. Boss always first in its group. No user-selectable sort — one
right order beats a dropdown.

**Search** — `/` focuses the search field (also `⌘K`). Placeholder "Search agents, projects, PRs".
Matches name, title, project, PR id, id prefix; case-insensitive substring; also matches
Resting (Resting auto-expands while a query is active). Results keep the current view; in Team
view non-matching rows hide but their ancestors stay as dimmed context. `Enter` selects the first
match and pans the village to it. `Esc` clears; second `Esc` blurs. Empty result:
"No agents match "foo"." + "Clear search" text button.

**Filters** (popover from "Filters ▾", one modal-like layer at a time; closes on outside click /
`Esc`): Project (checkbox list, sorted by agent count), Harness (Claude Code / Codex), Role
(Boss / Lead / Sub / Solo), "Show hidden agents", Compact rows. Active filters show as removable
chips under the search field ("my-app ×") and the button reads "Filters · 2". Counts
in the top bar never change with filters — they are the global truth.

## 7. Selection — village ↔ list

One selection, shared. URL hash `#agent=<id>` so a reload keeps it.

- **Click a row** (or `Enter` on a focused row): row selects; village camera pans to the villager
  (300ms ease-out, instant under reduced motion) and centres it; the villager **freezes in place**
  (no wander, faces camera) and gets a selection marker (§10). It stays frozen while selected.
  If the agent is indoors (resting), its house is highlighted and a ghost villager stands at the
  door. In full-screen there is no village, so the click opens the detail view instead.
- **Click a villager** (or house of a resting agent): same selection; panel switches to docked if
  collapsed, expands the section/card containing the row, scrolls it into view (`block: nearest`)
  and highlights it. Focus does not move into the panel (it stays on the canvas).
- **Double-click / `Enter` on a selected row** opens the detail view.
- Clear: `Esc`, click empty grass, or click the selected row again. On clear, the villager walks
  home and resumes.
- Keyboard in list: `↑/↓` move focus, `Home/End`, `Enter` select, `Space` select without panning,
  `J/K` jump to next/previous Stalled row anywhere (the "triage" keys).

## 8. Detail view (one agent)

Docked: replaces the list inside the panel (slide in, with "← All agents" back button; `Esc` or
`Backspace` returns, list scroll position restored). Full-screen: a 480px right drawer over the
grid. Not a modal; one layer at a time — opening Filters closes detail and vice versa.

Content top → bottom:
1. Header: role glyph, name (18px/600), bucket pill (icon + label), time in state.
2. Reason line in full ("Waiting for CI or checks · since 14:02").
3. Title (first prompt summary), up to 3 lines, then "more".
4. Facts table (12px, label `--text-muted`): Project, Harness, Role (+ "set manually" if
   override), Parent (link → selects parent), Children (links, with their bucket icons), Live,
   Last activity, Working dir (mono, ellipsis-left), Id (mono).
5. PRs as chips.
6. Actions:
   - **Copy resume command** (primary; disabled only when `resume` is null, with helper text
     "No resume command for this session"). On click: "Copied" for 1.5s replaces the label.
   - **Copy id**.
   - **Edit…** reveals inline fields: Name (text), Role (Boss/Lead/Sub/Solo/Auto), Parent
     (searchable select of non-resting agents + "None" + "Auto"). Save → `PATCH
     /api/overrides/:id`. "Auto" sends null. Errors show inline under the field
     ("Couldn't save — server not reachable."); Save shows "Saving…" while busy.
   - **Hide from Agentville** (text button) → PATCH `{hidden:true}`; toast "Auth Lead hidden · Undo"
     for 6s. Hidden agents are excluded from counts, village, and list unless "Show hidden"
     filter is on, where they render at 50% with a "Hidden" tag and an "Unhide" action.

The server never runs commands; nothing in the UI suggests it will. No transcript text anywhere.

## 9. Top bar, attention, and app states

Top bar 44px, `--surface`: brand left; three bucket counters centre-left; connection status +
settings right. The counters are buttons: clicking one filters the panel to that section
(Status view) and opens the panel if collapsed.

- **Stalled counter** is the loudest element on screen: `--stalled` filled pill with dark text
  (`#1a0f0e` on `#ff7262`, 7.0:1), 14px/700, "! 3 Stalled". At 0 it becomes a quiet outline pill
  "✓ 0 Stalled" in `--text-muted` — so zero reads as good, not as missing.
- Waiting and Building counters: plain text with icon, `--waiting` / `--building` icon colour,
  never filled, never animated. Waiting must look as calm as Building.
- `document.title` = "(3) Agentville" when stalled > 0, else "Agentville". Favicon gets a red
  dot when stalled > 0.
- **Sound**: off by default (Settings). When on, a single soft two-note chime when the stalled
  count *increases*, max once per 60s. Never for Waiting.
- Resting count is not in the top bar.

States:

| State | Top bar | Panel | Village |
| --- | --- | --- | --- |
| Loading (first fetch) | counters show "–" | 6 skeleton rows (`--surface-2` bars, static) | grass + plots drawn empty, no villagers |
| Empty (no agents at all) | "✓ 0 Stalled" etc. | "No agents found yet." / "Agentville reads Claude Code sessions from ~/.claude and Codex sessions from ~/.codex …" | an empty, pleasant village: one lamplit town square, a cat |
| All quiet (agents exist, none stalled) | quiet Stalled pill | Stalled section: "Nobody needs you." | normal |
| Disconnected (3 failed polls) | status reads "● Offline" in `--stalled`, counters keep last values at 50% opacity | 32px banner on top of panel: "Can't reach the Agentville server on 127.0.0.1:5275. Showing data from 14:02. Retrying…" + "Retry now" button | dimmed 40%, all villagers frozen |
| Server warnings (`warnings[]` non-empty) | small "⚠ 2" button in status area | opens a popover listing warnings verbatim (server strings are fixed, not transcript) | — |

Connection status when healthy: "● Live" with the dot in `--building`, tooltip "Updated 2s ago".
Retry backoff: 2s, 5s, 10s, then every 30s.

## 10. The village

### World and mapping

- Tile grid 16×16 px, drawn at **integer scale 3×** by default (2×–4× via zoom `+/-` and wheel,
  snapped to integers; `imageSmoothingEnabled = false`). Camera drag-to-pan. `0` recentres.
- **Each project is a plot**: a 14×10-tile fenced lot with a wooden sign showing the project name
  (rendered in the DOM over the canvas, so it's crisp and searchable). Plots tile a grid in
  stable order: first-seen order persisted in `localStorage` (`va.plots`), so a plot never moves
  once placed. New projects append. Paths connect plots; a central plaza sits at the origin.
- **Town hall**: a boss lives in a 5×4-tile hall in its project's plot (one hall per boss).
- **Houses**: each lead gets a 3×3 house; each solo gets a smaller 2×2 hut. House doors face down.
  Leads under a boss get a small **team banner** on the roof in the boss's team colour (from the
  8-colour team list below) — that's how cross-project teams read as one team.
- **Subagents** are smaller villagers (10×12 px sprite vs 12×16) that live in a 3-tile radius
  of their lead's door. Subs never get houses.
- Positions are deterministic: slot index inside a plot = order of first appearance; house slots
  fill left→right, top→bottom on a fixed 3×2 grid per plot (max 6 houses; overflow leads share
  the plot's "inn", a 4×3 building that holds the rest).

### Behaviour by bucket (home-bound, so they stay findable)

| Bucket | Pose / place | Bubble | Motion |
| --- | --- | --- | --- |
| Building | at a workbench/anvil beside their door | none | 2-frame hammer at 4 fps; subs carry a crate back and forth ≤ 3 tiles |
| Stalled | standing **in front of their door**, facing the camera | red **"!"** speech bubble | 1px bob every 1.2s; never wanders |
| Waiting | **sitting on the bench** by their door, hands in lap | **hourglass** bubble, `--waiting` blue, flips every 3s | nothing else; no "zZ" |
| Resting | indoors (not drawn); house window lit with dim warm light if any resident is resting; a tiny number sign "3" on the door if > 1 | — | none |

Idle ambience (pleasant, cheap): 2 slow clouds shadows, a lamp flicker at night, chimney smoke
from a house with a Building resident (4 frames, 2 fps). A day/night tint follows local time
(single `globalCompositeOperation='multiply'` rect; night = `#2b3150` at 45%). Nothing else.

### Labels and selection in the world

- Name tags: hidden by default, shown on hover, for the selected agent, and for **every Stalled
  villager** (DOM label, 11px, `--surface` bg, 1px `--stalled` border). Holding `Alt` shows all.
- Selected villager: 1px white pixel outline around the sprite + a bouncing ▼ marker in `--focus`
  above the bubble (static under reduced motion), and the villager freezes (§7).
- Hover: cursor pointer; tooltip-style name tag.

### Rendering budget

- Render loop at **8 fps** only while something animates and the canvas is visible; render on
  demand (pan, zoom, data change) otherwise. `document.hidden` or full-screen panel → no frames.
- Pre-render each sprite frame per team colour into an offscreen canvas once; draw with
  `drawImage` only. Static world (grass, paths, plots, buildings) cached in one layer canvas,
  redrawn only when plots change.
- Reduced motion (`prefers-reduced-motion: reduce` or Settings toggle): no wandering, no bob, no
  hammer frames, no smoke, no clouds, camera jumps. Poses and bubbles still show state.

## 11. Pixel art direction

16×16 tiles, characters 12×16 (lead/boss/solo) and 10×12 (sub), 1px dark outline, no
anti-aliasing, no gradients. Everything drawn from string pixel maps in code; each char indexes
the palette. Boss wears a crown (2px gold), lead a cap, sub bare-headed — role survives without
colour in the world too.

Palette (dusk; sits under a dark UI without glaring):

| Key | Hex | Use |
| --- | --- | --- |
| `o` | `#1a1c22` | outline |
| `g` / `G` | `#3b5d3a` / `#4f7a4a` | grass dark / light |
| `p` | `#8a7353` | path |
| `w` / `W` | `#6b4428` / `#9a6a3e` | wood dark / light |
| `r` | `#9c3f35` | roof red |
| `b` | `#3f5a8c` | roof blue |
| `s` | `#6b6f7a` | stone |
| `k` | `#e8b48a` | skin |
| `h` | `#4a3426` | hair |
| `y` | `#f2c14e` | gold / lamp / crown |
| `e` | `#f4efe4` | bubble white / window glow |
| `R` | `#ff7262` | stalled "!" (same as UI `--stalled`) |
| `B` | `#8ea6d8` | waiting hourglass (same as UI `--waiting`) |
| `t` | team colour | shirt |

Team colours (shirt + roof banner), assigned per boss in first-seen order: `#c96442`,
`#4f7ec9`, `#c9a24f`, `#8e6fc9`, `#4fa3a0`, `#c96f9a`, `#7fa34f`, `#a37b55`. Agents without a boss
use `#7d8290`.

Example maps (`.` = transparent):

```
// lead, standing, 12×16              // stalled bubble 7×9     // waiting bubble 7×9
....oooo....                           .ooooo.                   .ooooo.
...ottttoo..   (cap = team colour)     oeeeeeo                   oeeeeeo
..ohhhhhhho.                           oeeReeo                   oeBBBeo
..ohkkkkkho.                           oeeReeo                   oeeBeeo
..okokkokko.                           oeeReeo                   oeeBeeo
..okkkkkkko.                           oeeeeeo                   oeBBBeo
...okkkkko..                           oeeReeo                   oeeeeeo
..otttttttto                           .ooeoo.                   .ooeoo.
.ottttttttto                           ...o...                   ...o...
.oktttttttko
.oktttttttko
..otttttttto
..owwwowwwo.
..owwo.owwo.
..ooo...ooo.
............
```

Boss = same body with rows 0–1 replaced by a 3-point crown in `y`. Sub = 10×12 scaled-down body,
no hat. Sitting pose = rows 12–15 replaced by bent legs 2px shorter. Hammer frame 2 = right arm
row shifted up 2px with a 3px `s` hammer head.

## 12. Theme tokens (UI)

Contrast measured with WCAG formula against the surfaces listed (computed, not eyeballed).

```css
:root {
  color-scheme: dark;
  --bg: #0f1115;          /* app background, village letterbox */
  --surface: #161920;     /* top bar, panel */
  --surface-2: #1d212a;   /* hover, skeleton, inputs */
  --surface-3: #262b36;   /* selected row, chips */
  --line: #2a2f3a;        /* 1px dividers */
  --text: #ecebe7;        /* 14.7:1 on surface */
  --text-muted: #a3a7b3;  /* 7.3:1 on surface, 5.9:1 on surface-3 */
  --text-dim: #767b88;    /* 4.15:1 on surface — decoration and large text only */
  --stalled: #f2b84b;     /* amber, needs you: 9.8:1 on surface, 8.5:1 on its row fill */
  --stalled-bg: #2e2410;  /* stalled row fill; text 12.8:1, muted 6.4:1 */
  --error: #ff7262;       /* red, errors only (crashed, failed): 6.6:1 on surface */
  --error-bg: #3a1a18;    /* error row fill; red 5.8:1 on it */
  --waiting: #8ea6d8;     /* 7.2:1 on surface */
  --building: #6cc98a;    /* 8.7:1 on surface */
  --resting: #8a8f9c;     /* 5.4:1 on surface */
  --focus: #eaf2ff;       /* focus ring + selection, blue-white so it never reads as amber: 15.6:1 */
  --accent: #c96442;      /* brand mark + override dot only */
  --radius: 6px;  --radius-pill: 999px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-6: 24px;
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
}
```

Type scale: 11 (chips, tags), 12 (row line 2, facts), 13 (row name, body), 14 (counters, section
headers uppercase 11px/600 letter-spacing .06em), 18 (detail name). Line height 1.35. Tabular
numerals on all counts and times. No pixel font in the UI — the pixel style lives in the
village and the role/bucket icons only.

Bucket identity is always **icon + word**, colour third: Stalled `!`, Waiting hourglass,
Building hammer, Resting crescent. Icons are 12×12 pixel-map SVGs (`shape-rendering:
crispEdges`) so the UI echoes the village.

## 13. Accessibility

- Focus order: top bar (counters → status → settings) → panel header (search → view toggle →
  filters → full-screen) → list rows → canvas. Skip link "Skip to agent list" first in DOM.
- Status view is a plain `<ul>` (no listbox role): each row is a `<button>` inside `<li>`, accessible
  name "Auth Lead, Lead, Stalled 12 minutes, Needs your answer, my-app". Section
  headers are `<h2>` with counts. Team view uses `role="tree"`/`treeitem` with `aria-expanded`
  on leads, `aria-level` for depth.
- Canvas: `role="img"` with `aria-label="Village: 3 stalled, 7 waiting, 12 building"`; it is
  focusable; `Tab` into it then `←/→` cycles villagers in list order, `Enter` selects. The list
  is the accessible path; the canvas just must not trap focus.
- Count changes announced via a polite live region, only when the stalled count changes
  ("Stalled: 4"). Nothing else is announced.
- Focus ring: 2px `--focus`, 2px offset, never removed.
- Reduced motion as §10; also respected for panel transitions (instant).

## 14. Decisions made without asking (flag if wrong)

- No user-selectable sort; Stalled sorts longest-waiting first.
- Docked defaults to Status view, full-screen to Team view; each remembered.
- Hidden agents don't count anywhere unless "Show hidden" is on.
- Full-screen stops the village rendering entirely (saves CPU; you aren't looking at it).

## 15. As built (frontend, 2026-10-21)

Where the build differs from the sections above, and why:

- **Narrow screens (< 900px):** the docked panel covers the village, so tapping a row opens the
  detail view instead of panning a village nobody can see. The detail view has a **Show in
  village** button. It collapses the panel to the rail and pans to the villager; on desktop it
  leaves full-screen. Clicking a villager on a narrow screen does not reopen the panel.
- **Name tags:** they are placed in priority order: selected, keyboard cursor, hover, plot
  signs, stalled (longest-waiting first), crowd counts, then Alt. A tag that would overlap one
  already placed is skipped, and hovering shows it.
- **Crowds:** a home shows at most 10 villagers around its door, stalled ones first, and clamped
  inside the plot. The rest get a "+N more" tag at the door. A selected crowd member appears as a
  ghost at the door, as an indoors agent does.
- **Town hall:** 5×3 tiles, not 5×4, so a yard row still fits inside the 4-tile slot.
- **Team tree:** nested lists with chevron buttons (`aria-expanded`) instead of `role="tree"`,
  because tree items can't contain row buttons. Every tree row reserves the chevron column, so
  siblings line up.
- **Row names:** a row's accessible name is its visible text plus a screen-reader-only tail
  ("Lead, Stalled for 12 minutes, under Big Boss"). WCAG 2.5.3 needs the visible text to be part
  of the accessible name.
- **Fleet actions are copy-only in v1.** §16 describes them as built.
- **Stable ordering** (rows that jump around are hard to track). This replaces the
  sort rules in §4 and §6.
  - Every agent gets a persistent first-seen rank (`localStorage` `va.rank`). The first load seeds it
    by last activity, oldest first. Rank is the tiebreak everywhere.
  - Status sections order by when the agent entered the section, then rank; errors go first in
    Stalled. An existing row never moves, and a newcomer or a bucket change lands at the end.
    "Most recently active first" is gone.
  - Team view: projects by their first agent's rank, cards and members by rank. Urgency shows only
    through colour, edges and counts. A lead folds into "Quiet" only after 10 min with nobody awake.
  - Table: the default is the tree by rank. A column sort stays as chosen. Time columns (In state,
    Last active) are snapshotted when you sort. Re-sort with R or the "Order paused · ↻ re-sort"
    chip, which appears once the data has drifted.
  - **Hold while engaged.** While the pointer is over the list or detail, keyboard focus is in the
    panel, you scrolled in the last 3 s, or the detail view is open, rows keep their place and
    section. Contents still update in place (colour, reason). Your own clicks and keys in the list
    still apply.
  - When engagement ends, held moves slide into place over 150 ms (FLIP), with no slide under
    reduced motion.
  - Mouse focus left on a row doesn't count as engagement, or a single click would freeze the list
    forever. Keyboard focus does.
- **Amber stalled, red errors** : Stalled is amber (`--stalled`) with a "!".
  Red (`--error`) means only an error: a stalled agent with `severity: 'error'` (crashed, hit an
  error). Those show a "×" icon, the word "Error" in the Table and detail views, and a red fill.
  They sort first within Stalled. The top bar shows a red "N errors" pill only when
  `counts.errors > 0`; clicking it filters to errors.
  - The favicon dot is amber, or red when there are errors.
  - The village bubble is an amber "!" for needs-you and a red "×" for errors: different shapes,
    not only different colours.
  - Focus and selection moved from yellow to blue-white (`--focus: #eaf2ff`), so a selected row
    never looks stalled. The offline banner, form errors and "invalid" outlines use `--error`.
- **PR chips:** in rows they are clickable spans, because a link can't sit inside a button. The
  detail view uses real links.
- **World v2** (2026-10-22): `web/src/world.js` does layout and sprites;
  `web/src/village.js` owns the camera, input and labels.
  - Zoom is Map (0.5×) or 1–4×. The camera is clamped to the world (land plus 10 tiles of sea) and
    remembered in `va.cam`. With no saved camera the view opens at 2× on the village with the most
    stalled agents, else the busiest.
  - Village sites and every building's spot persist in `va.world3` (sites as `at`); growth only adds.
  - Roads are routed with A*, not Dijkstra, which keeps 36 villages near 0.5 s of layout.
    Layout reruns only when a home, PR or decor tier is added, removed or changes state.
  - The ground is baked lazily in 48×48-tile chunks, and open sea is never baked, so no single
    canvas outgrows browser limits.
  - At Map zoom each village shows one aggregate badge (needs-you, errors, waiting). The
    procedural fallback draws the same badges.
  - `?debug` exposes `window.villageDebug()` for e2e (`e2e/world.spec.mjs`).
- **World v3** (2026-10-26): one town instead of islands, and quiet projects folded away.
  - The islands are gone. There is one town: a central square with one fenced, accent-tinted block
    per project around it, joined by ring streets. Blocks and buildings persist in `va.world4`, and the
    camera persists in `va.cam2`.
  - **Hide quiet projects** (Settings, on by default) leaves out of the village any project whose
    agents are all resting with nothing for 24 h. A note reads "N quiet projects hidden · Show". The
    list is unchanged.
  - A hidden project keeps its block for 14 days, so it comes back in place.
  - The default view fits the whole town (2×, else 1×, else Map). Stalled tags show from 1×.
  - Flags no longer blink (a negative frame index left of x = 0). Chickens, the cat and crate
    carriers face the way they walk and step only while moving.
