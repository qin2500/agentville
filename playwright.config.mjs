import { defineConfig, devices } from '@playwright/test'
import { BASE, PORT } from './e2e/helpers.mjs'

// One server on a shared fixture home; tests mutate it (overrides, live files), so run serially.
export default defineConfig({
  testDir: 'e2e',
  // Per-port artifacts: Playwright empties outputDir at start, so a shared one would eat a parallel run's traces.
  outputDir: `test-results/${PORT}`,
  globalTeardown: './e2e/teardown.mjs',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  // Since M7 the new engine is the default. The classic specs were written for the classic village, so every page starts
  // with va.engine = 1 (classic). Engine specs opt in per page with ?engine=2, which beats the stored setting, and a spec
  // that tests the default itself clears this with test.use({ storageState: { cookies: [], origins: [] } }).
  use: { baseURL: BASE, trace: 'retain-on-failure', storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: 'va.engine', value: '1' }] }] } },
  webServer: { command: 'node e2e/serve.mjs', url: `${BASE}/api/agents`, reuseExistingServer: false, timeout: 60_000 },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
})
