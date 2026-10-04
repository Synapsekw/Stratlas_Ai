#!/usr/bin/env node
/* eslint-disable no-console -- release script output */
// Launches the packaged app (dist/win-unpacked) with an isolated, off-screen profile and
// STRATLAS_SMOKE=1: it must load its UI and exit 0 within the time limit. A crash dialog keeps
// the process alive, so a timeout is a failure too. Run from apps/desktop after packaging.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const candidates = [
  'dist/win-unpacked/Stratlas.exe',
  'dist/mac-arm64/Stratlas.app/Contents/MacOS/Stratlas',
  'dist/mac/Stratlas.app/Contents/MacOS/Stratlas',
];
const exe = candidates.find((c) => existsSync(c));
if (!exe) {
  console.log('Smoke check skipped: no unpacked app found (store-only build).');
  process.exit(0);
}
const userData = mkdtempSync(join(tmpdir(), 'stratlas-smoke-'));
const env = {
  ...process.env,
  STRATLAS_SMOKE: '1',
  STRATLAS_USER_DATA: userData,
  STRATLAS_DATA: join(userData, 'data'),
};
const child = spawn(exe, [], { env, stdio: 'ignore' });
const limit = setTimeout(() => {
  console.error(
    `Smoke check failed: ${exe} did not finish loading within 60 s (crash dialog or hang).`,
  );
  child.kill();
  process.exit(1);
}, 60_000);
child.on('exit', (code) => {
  clearTimeout(limit);
  if (code === 0) {
    console.log(`Smoke check passed: ${exe} started and loaded its UI.`);
    process.exit(0);
  }
  console.error(`Smoke check failed: ${exe} exited with code ${code}.`);
  process.exit(1);
});
