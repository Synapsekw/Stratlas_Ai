import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // One worker locally: several Electron windows with WebGL compete for the GPU with other work.
  ...(process.env.CI ? {} : { workers: 1 }),
  timeout: 60_000,
  // A test that passes only on a second attempt is a flake to fix at its cause, never to retry
  // away: no retries, and on CI a test reported flaky (e.g. run with --retries) fails the run.
  retries: 0,
  failOnFlakyTests: Boolean(process.env.CI),
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
