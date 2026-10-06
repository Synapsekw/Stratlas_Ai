#!/usr/bin/env node
// Package apps/desktop with electron-builder using the brand-derived config.
// Run from apps/desktop after `electron-vite build`; extra arguments go to electron-builder.
//   node ../../tools/release/dist.mjs --win            NSIS installer + portable exe
//   node ../../tools/release/dist.mjs --win appx       Microsoft Store package
//   node ../../tools/release/dist.mjs --mac            universal (arm64 + x64) dmg + zip
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDir, isStoreBuild, storeBuildEnv, writeEffectiveConfig } from './brand-config.mjs';
import { MAC_NATIVE_HINT, missingMacNativePackages } from './mac-native.mjs';

const builderArgs = process.argv.slice(2);

// The demo project ships in every installer and the Store build (electron-builder extraResources):
// rebuilt when missing, built with --quick or by another generator, then checked for client data.
const demo = spawnSync(
  process.execPath,
  [fileURLToPath(new URL('../demo/ensure-demo.mjs', import.meta.url))],
  {
    stdio: 'inherit',
  },
);
if (demo.status !== 0) process.exit(demo.status ?? 1);

// CI maps absent secrets to empty strings; electron-builder must see them as unset.
const presentEnv = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ''));
// Microsoft signs Store packages; our certificate never touches the MSIX.
const env = isStoreBuild(builderArgs) ? storeBuildEnv(presentEnv) : presentEnv;
if (builderArgs.some((a) => a === '--mac' || a === '-m')) {
  // The universal app must carry the keyring addon for both architectures.
  const fromApp = createRequire(join(appDir, 'package.json'));
  const missing = missingMacNativePackages((id) => fromApp.resolve(id));
  if (missing.length) {
    process.stderr.write(`dist: missing ${missing.join(', ')}.\n${MAC_NATIVE_HINT}\n`);
    process.exit(1);
  }
}
const { path } = writeEffectiveConfig(env);
const cli = createRequire(import.meta.url).resolve('electron-builder/cli.js');
const args = [cli, '--config', path, '--publish', 'never', ...builderArgs];
// Without a certificate, never let electron-builder pick an arbitrary keychain identity.
if (!env.CSC_LINK && !env.CSC_NAME) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

const result = spawnSync(process.execPath, args, { cwd: appDir, stdio: 'inherit', env });
if (result.status !== 0) process.exit(result.status ?? 1);

// Never hand over a package that cannot start: check the bundle, then launch the packaged app.
// Last, the update feed (stratlas-update.json) for the installers in dist (ADR 0003).
for (const step of ['check-bundle.mjs', 'smoke-packaged.mjs', 'feed.mjs']) {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL(step, import.meta.url))], {
    cwd: appDir,
    stdio: 'inherit',
    env,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
