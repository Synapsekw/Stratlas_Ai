#!/usr/bin/env node
// The PDF user guide, from the same Markdown as the in-app help (docs/guide). The built app's
// guide page (apps/desktop/out/renderer/guide.html) is printed in a hidden Electron window with
// printToPDF, like the house report. Output: apps/desktop/dist/<Executable>-<version>-user-guide.pdf
// (QuadrionAI-<version>-user-guide.pdf: no spaces, like the installers).
//
//   pnpm -F @aio/desktop build        (once, or after the guide changed)
//   node tools/guide/build-pdf.mjs    [--out <file.pdf>]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const desktop = join(root, 'apps/desktop');
const page = join(desktop, 'out/renderer/guide.html');
const brand = JSON.parse(readFileSync(join(root, 'packages/brand/brand.json'), 'utf8'));
const { version } = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const out = resolve(
  outArg >= 0 && args[outArg + 1]
    ? args[outArg + 1]
    : join(desktop, 'dist', `${brand.executableName}-${version}-user-guide.pdf`),
);

if (!existsSync(page)) {
  console.error(`No built guide page at ${page}. Build the app first: pnpm -F @aio/desktop build`);
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });

// the electron package resolves its binary (and honours ELECTRON_OVERRIDE_DIST_PATH)
const electron = createRequire(join(desktop, 'package.json'))('electron');
const profile = mkdtempSync(join(tmpdir(), 'guide-pdf-'));
const r = spawnSync(
  electron,
  [
    join(import.meta.dirname, 'print-main.mjs'),
    page,
    out,
    `${brand.productName} user guide`,
    profile,
  ],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 180_000 },
);
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
const line = (r.stdout ?? '').trim().split('\n').pop() ?? '';
if (r.status !== 0 || !line.startsWith('{')) {
  console.error(`Printing the guide failed (exit ${String(r.status)}). ${r.stdout ?? ''}`);
  process.exit(1);
}
const result = JSON.parse(line);
const mb = (statSync(out).size / 1e6).toFixed(2);
process.stdout.write(
  `Wrote ${out} (${mb} MB, ${String(result.chapters)} chapters, ${String(result.images)} images)\n`,
);
