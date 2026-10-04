import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // One worker locally: several Electron windows with WebGL compete for the GPU with other work.
  workers: process.env.CI ? undefined : 1,
  timeout: 60_000,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
