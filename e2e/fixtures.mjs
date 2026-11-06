// Every spec imports `test` from here. The app's first run opens on the expanded Team view; most
// specs are about the docked village + panel, so they start docked unless a spec opts into a real
// first run with `test.use({ firstRun: true })`. They also expand to Table, the specs' long-standing
// expectation (the app's own first-run default is Team). A saved choice is never overwritten.
// Specs that open their own page call `startDocked(page)`.
import { test as base, expect } from '@playwright/test'

export const test = base.extend({
  firstRun: [false, { option: true }],
  page: async ({ page, firstRun }, use) => {
    if (!firstRun) await startDocked(page)
    await use(page)
  },
})
export { expect }

export function startDocked(page) {
  return page.addInitScript(() => {
    try {
      if (localStorage.getItem('va.panel') === null) localStorage.setItem('va.panel', '"docked"')
      if (localStorage.getItem('va.view') === null) localStorage.setItem('va.view', '{"docked":"status","full":"table"}')
    } catch {}
  })
}
