import { aliasLegacyEnv } from '@aio/brand/env';
import { defineConfig } from '@playwright/test';

// The app's variables are QUADRION_* since the rename; STRATLAS_* names still set in a shell count
// as their QUADRION_* twins, here, in every worker and in every app a test starts (main/legacyEnv.ts).
aliasLegacyEnv(process.env);

// Every app an e2e test starts keeps its device key in a TEST-ONLY file of its throwaway userData,
// never in Windows Credential Manager or the macOS Keychain (main/testVault.ts, M9 integration).
process.env.QUADRION_TEST_VAULT = '1';

// Every app an e2e test starts refuses any write under the founder's real client data
// (QUADRION_REAL_DATA_ROOT, default E:\Stratlas Data; main/realDataGuard.ts), also when a spec
// launches it without the fixtures. Real projects are only ever opened as temporary copies
// (e2e/realData.ts), and every test that uses them carries @realdata in its title, so a run
// without the real data is:
//   playwright test --grep-invert @realdata
// With QUADRION_REAL_DATA_ROOT set to an empty folder, the @realdata tests skip.
process.env.QUADRION_E2E = '1';

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
