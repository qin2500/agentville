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
  use: { baseURL: BASE, trace: 'retain-on-failure' },
  webServer: { command: 'node e2e/serve.mjs', url: `${BASE}/api/agents`, reuseExistingServer: false, timeout: 60_000 },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
})
