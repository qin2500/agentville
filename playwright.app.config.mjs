import { defineConfig } from '@playwright/test'

// The desktop app (Electron, desktop/) against throwaway fixture servers: `npm run test:app`.
// Separate from playwright.config.mjs so browser-mode runs never need the Electron binary.
export default defineConfig({
  testDir: 'e2e-app',
  outputDir: 'test-results/app',
  globalSetup: './e2e-app/setup.mjs',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
})
