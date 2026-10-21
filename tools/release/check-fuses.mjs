#!/usr/bin/env node
// Read the Electron fuses of the packaged app and check them against `electronFuses` in
// apps/desktop/electron-builder.yml (SPEC section 8): RunAsNode off, NODE_OPTIONS and --inspect
// off, the app only from app.asar with its integrity checked, cookies encrypted. electron-builder
// flips them at package time; this proves the flip happened on the binary that ships.
// A post-build step of dist.mjs (brand-config.mjs `postBuildSteps`), after the bundle check.
//
// Usage (from apps/desktop, after packaging): node ../../tools/release/check-fuses.mjs [exe]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findPackagedApp } from './onnx-probe.mjs';

/** `electronFuses` of electron-builder.yml as { RunAsNode: false, ... } (FuseV1Options names). */
export function expectedFuses(yml) {
  const block = /^electronFuses:\s*\n((?:[ \t]+.*\n?)+)/m.exec(yml)?.[1] ?? '';
  const out = {};
  for (const m of block.matchAll(/^[ \t]+([A-Za-z]+):\s*(true|false)\s*$/gm)) {
    const key = m[1] ?? '';
    out[key.charAt(0).toUpperCase() + key.slice(1)] = m[2] === 'true';
  }
  return out;
}

/** FuseState byte values of @electron/fuses: '0' off, '1' on, 'r' removed. */
const ENABLE = 49;
const DISABLE = 48;

/**
 * What differs between the binary's fuse wire and the expected values; empty when they agree.
 * `wire` maps FuseV1Options numbers to FuseState (`getCurrentFuseWire`), `options` the names to
 * numbers (`FuseV1Options`).
 */
export function fuseProblems(wire, expected, options) {
  const problems = [];
  if (Object.keys(expected).length === 0) problems.push('electron-builder.yml names no fuses');
  for (const [name, want] of Object.entries(expected)) {
    const id = options[name];
    if (typeof id !== 'number') {
      problems.push(`${name}: not a fuse this Electron knows`);
      continue;
    }
    const state = wire[id];
    const got = state === ENABLE ? true : state === DISABLE ? false : null;
    if (got !== want)
      problems.push(
        `${name}: ${got === null ? `state ${String(state)}` : got ? 'on' : 'off'}, expected ${want ? 'on' : 'off'}`,
      );
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const appDir = process.cwd();
  const exe = process.argv[2] ?? findPackagedApp()?.exe;
  if (!exe) {
    process.stdout.write('Fuse check skipped: no unpacked app found (store-only build).\n');
    process.exit(0);
  }
  // @electron/fuses comes with electron-builder (app-builder-lib flips the fuses with it)
  const fromApp = createRequire(join(appDir, 'package.json'));
  const fromBuilder = createRequire(
    createRequire(fromApp.resolve('electron-builder/package.json')).resolve(
      'app-builder-lib/package.json',
    ),
  );
  const fuses = fromBuilder('@electron/fuses');
  const yml = readFileSync(join(appDir, 'electron-builder.yml'), 'utf8');
  const expected = expectedFuses(yml);
  const wire = await fuses.getCurrentFuseWire(exe);
  const problems = fuseProblems(wire, expected, fuses.FuseV1Options);
  if (problems.length) {
    console.error(`Fuse check failed for ${exe}:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  process.stdout.write(`Fuses as configured on ${exe}: ${Object.keys(expected).join(', ')}.\n`);
}
