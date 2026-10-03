#!/usr/bin/env node
// Package apps/desktop with electron-builder using the brand-derived config.
// Run from apps/desktop after `electron-vite build`; extra arguments go to electron-builder.
//   node ../../tools/release/dist.mjs --win            NSIS installer + portable exe
//   node ../../tools/release/dist.mjs --win appx       Microsoft Store package
//   node ../../tools/release/dist.mjs --mac            dmg + zip
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appDir, writeEffectiveConfig } from './brand-config.mjs';

const { path } = writeEffectiveConfig();
const cli = createRequire(import.meta.url).resolve('electron-builder/cli.js');
const args = [cli, '--config', path, '--publish', 'never', ...process.argv.slice(2)];
// CI maps absent secrets to empty strings; electron-builder must see them as unset.
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ''));
// Without a certificate, never let electron-builder pick an arbitrary keychain identity.
if (!env.CSC_LINK && !env.CSC_NAME) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

const result = spawnSync(process.execPath, args, { cwd: appDir, stdio: 'inherit', env });
process.exit(result.status ?? 1);
