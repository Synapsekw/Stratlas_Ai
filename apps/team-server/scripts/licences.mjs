#!/usr/bin/env node
/* eslint-disable no-console -- CI output */
// The `team-server` CI job: a report of GPL or AGPL in what the server image ships (its
// production dependencies, from `pnpm licenses list --prod --json --filter @aio/team-server`).
// LGPL is not matched. A report only since the founder decision of 8 Oct 2026 (ADR 0008,
// amended): it warns and never fails CI. The repository-wide report (`pnpm license:check`) runs
// in the `licenses` job.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: licences.mjs <pnpm licenses json>');
  process.exit(2);
}
/** @type {Record<string, { name: string }[]>} */
const byLicence = JSON.parse(readFileSync(file, 'utf8'));
const denied = Object.entries(byLicence).filter(([licence]) => /\bA?GPL/i.test(licence));
for (const [licence, pkgs] of denied)
  console.log(
    `::warning::Team Server licence report: ${licence}: ${pkgs.map((p) => p.name).join(', ')}`,
  );
console.log(`Server licences: ${Object.keys(byLicence).sort().join(', ')}`);
