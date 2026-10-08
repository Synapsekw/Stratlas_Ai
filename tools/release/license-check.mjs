#!/usr/bin/env node
// Licence report for CI (`pnpm license:check`), using pnpm's own licence report. A report only
// since the founder decision of 8 Oct 2026 (ADR 0008, amended): it prints what it finds as
// warnings and never fails CI, a dist or a release.
//   - Policy: tools/release/licence-exceptions.json, read through licence-policy.mjs (the app
//     stays permissive by convention: M10 decision 1, 7 Oct 2026).
//   - Production dependencies of every workspace package (what ships inside the app) must be
//     allowed: an SPDX `OR` needs one allowed option, `AND` needs all. MPL-2.0 counts only for
//     the packages named in licence-exceptions.json (`mpl`), and LGPL only for a named shared
//     library (`lgplShared`); a dual licence with a permissive option needs no entry.
//   - No dependency at all, dev tooling included, may be GPL or AGPL. (LGPL dev tooling such as
//     the libvips binary behind sharp is tolerated because it never ships.)
//   - `-r` covers every workspace, so the Team Server (`apps/team-server`, what its Docker image
//     ships) passes the same allow-list as the app (M9).
// The Python side is python/tests/test_licences.py, native libraries are native-licences.mjs and
// data packs data-licences.mjs (M10 G1); all read the same exceptions file.
import { execSync } from 'node:child_process';
import { judge, loadPolicy } from './licence-policy.mjs';

const DENIED = /^(A?GPL)(-[0-9.]+)?(-only|-or-later|\+)?$/i;

const policy = loadPolicy();

function report(prod) {
  const command = `pnpm licenses list --json -r${prod ? ' --prod' : ''}`;
  const out = execSync(command, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  /** @type {Record<string, { name: string, versions: string[] }[]>} */
  const byLicense = JSON.parse(out);
  return Object.entries(byLicense).flatMap(([license, pkgs]) =>
    pkgs.map((p) => ({ license, name: p.name, id: `${p.name}@${p.versions.join(',')}` })),
  );
}

const ids = (expression) =>
  expression
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND|WITH)\s+|\s+/i)
    .filter(Boolean);

const problems = [];
const pending = new Set();
for (const { license, name, id } of report(true)) {
  const verdict = judge(policy, license, { ecosystem: 'npm', names: [name] });
  if (verdict.status === 'denied') problems.push(`${id}: ${license} (not allowed in shipped code)`);
  for (const p of verdict.pending) pending.add(p);
}
for (const { license, id } of report(false)) {
  if (ids(license).some((l) => DENIED.test(l))) problems.push(`${id}: ${license} (GPL/AGPL)`);
}

for (const p of pending)
  process.stdout.write(`::warning::licence exception "${p}" waits for founder approval\n`);
const notes = [...new Set(problems)];
for (const n of notes) process.stdout.write(`::warning::licence report: ${n}\n`);
process.stdout.write(
  notes.length > 0
    ? `Licence report: ${String(notes.length)} packages outside the permissive policy (report only).\n`
    : 'Licence report: every package is within the permissive policy.\n',
);
