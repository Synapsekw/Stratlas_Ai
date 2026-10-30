import { defineConfig } from 'vitest/config';

/**
 * Most tests here build a project on disk and save it file by file (manifest, backups, trash,
 * packages). Each takes well under a second alone, but many times longer while a full check and
 * other work load the computer, and the 5 s default then fails them at random. A test that times
 * out also keeps running while the next one starts. So the disk gets a load-safe allowance.
 */
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
