#!/usr/bin/env node
// Package apps/desktop with electron-builder using the brand-derived config.
// Run from apps/desktop after `electron-vite build`; extra arguments go to electron-builder.
//   node ../../tools/release/dist.mjs --win            NSIS installer + portable exe
//   node ../../tools/release/dist.mjs --win appx       Microsoft Store package
//   node ../../tools/release/dist.mjs --mac            dmg + zip
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { appDir, writeEffectiveConfig } from './brand-config.mjs';

const { path } = writeEffectiveConfig();
const cli = createRequire(import.meta.url).resolve('electron-builder/cli.js');
const args = [cli, '--config', path, '--publish', 'never', ...process.argv.slice(2)];
// CI maps absent secrets to empty strings; electron-builder must see them as unset.
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ''));
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
