#!/usr/bin/env node
// Licence gate for CI (`pnpm license:check`), using pnpm's own licence report.
//   - Production dependencies of every workspace package (what ships inside the app) must be
//     on the allow-list below; an SPDX `OR` needs one allowed option, `AND` needs all.
//   - No dependency at all, dev tooling included, may be GPL or AGPL. (LGPL dev tooling such as
//     the libvips binary behind sharp is tolerated because it never ships.)
import { execSync } from 'node:child_process';

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'MPL-2.0',
  '0BSD',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Unlicense',
]);
const DENIED = /^(A?GPL)(-[0-9.]+)?(-only|-or-later|\+)?$/i;

function report(prod) {
  const command = `pnpm licenses list --json -r${prod ? ' --prod' : ''}`;
  const out = execSync(command, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  /** @type {Record<string, { name: string, versions: string[] }[]>} */
  const byLicense = JSON.parse(out);
  return Object.entries(byLicense).flatMap(([license, pkgs]) =>
    pkgs.map((p) => ({ license, id: `${p.name}@${p.versions.join(',')}` })),
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

const problems = [];
for (const { license, id } of report(true)) {
  if (!evaluate(license, (l) => ALLOWED.has(l)))
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
