import { defineConfig } from '@playwright/test';

// Every app an e2e test starts keeps its device key in a TEST-ONLY file of its throwaway userData,
// never in Windows Credential Manager or the macOS Keychain (main/testVault.ts, M9 integration).
process.env.STRATLAS_TEST_VAULT = '1';

export default defineConfig({
  testDir: './e2e',
  // One worker, locally and on CI: several Electron windows with WebGL compete for the GPU. On the
  // CI runners the GPU is SwiftShader on the CPU, so a second worker's app shares the cores with
  // the first: beside the software GPU fly-through of perf.spec.ts a Map view click stalled the
  // whole Windows runner for 45 s (CI run 37535253175), and the frame times it measures are only
  // meaningful with the machine to themselves. macOS runners already get one worker.
  workers: 1,
  timeout: 60_000,
  // A test that passes only on a second attempt is a flake to fix at its cause, never to retry
  // away: no retries, and on CI a test reported flaky (e.g. run with --retries) fails the run.
  retries: 0,
  failOnFlakyTests: Boolean(process.env.CI),
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
