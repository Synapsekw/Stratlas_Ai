#!/usr/bin/env node
// Licence gate for CI (`pnpm license:check`), using pnpm's own licence report.
//   - Policy: permissive only (M10 decision 1, 7 Oct 2026; tools/release/licence-exceptions.json).
//   - Production dependencies of every workspace package (what ships inside the app) must be
//     on the allow-list below; an SPDX `OR` needs one allowed option, `AND` needs all. MPL-2.0
//     counts only for the packages named in licence-exceptions.json (`mpl`), and LGPL only for a
//     named shared library (`lgplShared`); a dual licence with a permissive option needs no entry.
//   - No dependency at all, dev tooling included, may be GPL or AGPL. (LGPL dev tooling such as
//     the libvips binary behind sharp is tolerated because it never ships.)
//   - `-r` covers every workspace, so the Team Server (`apps/team-server`, what its Docker image
//     ships: Fastify and later `pg` and the S3 client) passes the same allow-list as the app (M9).
// The Python side (python/tests/test_licences.py) reads the same exceptions file; the native and
// data gates arrive with M10 stream G1.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Unlicense',
  // M10 decision 1: pako inside CesiumJS (`MIT AND Zlib`), mapMAP's dset; Boost.
  'Zlib',
  'BSL-1.0',
  // Font licence: bundling the fonts in an app is allowed (IBM Plex, the UI typeface).
  'OFL-1.1',
  // PSF licence, permissive (argparse, under js-yaml).
  'Python-2.0',
]);
const DENIED = /^(A?GPL)(-[0-9.]+)?(-only|-or-later|\+)?$/i;

const exceptions = JSON.parse(
  readFileSync(new URL('./licence-exceptions.json', import.meta.url), 'utf8'),
);
const named = (list) =>
  new Set((list ?? []).filter((e) => e.ecosystem === 'npm').map((e) => e.name));
const MPL_BY_NAME = named(exceptions.mpl);
const LGPL_BY_NAME = named(exceptions.lgplShared);

function report(prod) {
  const command = `pnpm licenses list --json -r${prod ? ' --prod' : ''}`;
  const out = execSync(command, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  /** @type {Record<string, { name: string, versions: string[] }[]>} */
  const byLicense = JSON.parse(out);
  return Object.entries(byLicense).flatMap(([license, pkgs]) =>
    pkgs.map((p) => ({ license, name: p.name, id: `${p.name}@${p.versions.join(',')}` })),
  );
}

/** Evaluate a (flat) SPDX expression: `A OR B`, `A AND B`, parentheses ignored. */
function evaluate(expression, ok) {
  const clean = expression.replace(/[()]/g, ' ').trim();
  return clean
    .split(/\s+OR\s+/i)
    .some((alt) => alt.split(/\s+AND\s+/i).every((id) => ok(id.trim())));
}

const ids = (expression) =>
  expression
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND|WITH)\s+|\s+/i)
    .filter(Boolean);

/** Is licence `l` allowed for the shipped package `name`? */
const allowedFor = (name) => (l) =>
  ALLOWED.has(l) ||
  (l === 'MPL-2.0' && MPL_BY_NAME.has(name)) ||
  (/^LGPL-/i.test(l) && LGPL_BY_NAME.has(name));

const problems = [];
for (const { license, name, id } of report(true)) {
  if (!evaluate(license, allowedFor(name)))
    problems.push(`${id}: ${license} (not allowed in shipped code)`);
}
for (const { license, id } of report(false)) {
  if (ids(license).some((l) => DENIED.test(l))) problems.push(`${id}: ${license} (GPL/AGPL)`);
}

if (problems.length > 0) {
  console.error(`Licence check failed:\n  ${[...new Set(problems)].join('\n  ')}`);
  process.exit(1);
}
process.stdout.write('Licence check passed.\n');
