// Every spec imports `test` from here. The app's first run opens on the expanded Team view; most
// specs are about the docked village + panel, so they start docked unless a spec opts into a real
// first run with `test.use({ firstRun: true })`. Docked Team shows the top level only, so the
// default fixture's teams (and the resting solos behind Solo's caret) start unfolded, so its rows are
// there to click; `test.use({ openTeams: false })` keeps the app's own folded start. A saved choice
// is never overwritten. Specs that open their own page call `startDocked(page)`.
import { test as base, expect } from '@playwright/test'
import { IDS } from '../test/fixtures/make-home.mjs'

const OPEN = ['__solo', ...Object.values(IDS).flatMap((id) => [`claude-code:${id}`, `codex:${id}`])]

export const test = base.extend({
  firstRun: [false, { option: true }],
  openTeams: [true, { option: true }],
  page: async ({ page, firstRun, openTeams }, use) => {
    if (!firstRun) await startDocked(page, { openTeams })
    await use(page)
  },
})
export { expect }

export function startDocked(page, { openTeams = true } = {}) {
  return page.addInitScript(({ open }) => {
    try {
      if (localStorage.getItem('va.panel') === null) localStorage.setItem('va.panel', '"docked"')
      if (localStorage.getItem('va.view') === null) localStorage.setItem('va.view', '{"docked":"team","full":"team"}')
      if (open && localStorage.getItem('va.teamOpen') === null) localStorage.setItem('va.teamOpen', JSON.stringify(open))
    } catch {}
  }, { open: openTeams ? OPEN : null })
}
