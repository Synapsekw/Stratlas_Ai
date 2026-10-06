#!/usr/bin/env node
/* eslint-disable no-console -- release step output */
// Release step (tools/release/dist.mjs): make sure apps/desktop/demo holds a full demo build by
// this generator, then check it for client data. Builds it when it is missing, was built with
// --quick, or was made by another version of tools/demo. Fails the release on any finding.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatorStamp } from './stamp.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = join(here, '..', '..', 'apps', 'desktop', 'demo');

let info = null;
try {
  info = JSON.parse(readFileSync(join(out, 'demo.json'), 'utf8'));
} catch {
  // not built yet
}
const stamp = generatorStamp();
const why = !info
  ? 'not built yet'
  : info.quick
    ? 'built with --quick'
    : info.generator !== stamp
      ? 'built by another version of tools/demo'
      : !existsSync(join(out, 'demo-change-site', 'manifest.json'))
        ? 'the change demo is missing'
        : null;
const run = (script, args = []) =>
  spawnSync(process.execPath, [join(here, script), ...args], { stdio: 'inherit' }).status ?? 1;

if (why) {
  console.log(`Demo project: building (${why}).`);
  if (run('build-demo.mjs', ['--out', out]) !== 0) process.exit(1);
} else console.log(`Demo project: up to date (build ${String(info.build).slice(0, 12)}).`);
if (run('check-no-client-data.mjs', [out]) !== 0) process.exit(1);
process.exit(run('check-change-demo.mjs', [out]));
