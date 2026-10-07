#!/usr/bin/env node
/* eslint-disable no-console -- CI output */
// The `team-server` CI job: no GPL or AGPL in what the server image ships (its production
// dependencies, from `pnpm licenses list --prod --json --filter @aio/team-server`). LGPL is not
// matched. The repository-wide allow-list (`pnpm license:check`) runs in the `licenses` job.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: licences.mjs <pnpm licenses json>');
  process.exit(2);
}
/** @type {Record<string, { name: string }[]>} */
const byLicence = JSON.parse(readFileSync(file, 'utf8'));
const denied = Object.entries(byLicence).filter(([licence]) => /\bA?GPL/i.test(licence));
if (denied.length > 0) {
  for (const [licence, pkgs] of denied)
    console.error(`${licence}: ${pkgs.map((p) => p.name).join(', ')}`);
  console.error('GPL or AGPL code would ship in the Team Server image.');
  process.exit(1);
}
console.log(`Server licences: ${Object.keys(byLicence).sort().join(', ')}`);
