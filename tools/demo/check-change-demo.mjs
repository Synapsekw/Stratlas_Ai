#!/usr/bin/env node
/* eslint-disable no-console -- check script output */
// Checks of the change and modelling demo (M8): its size budget (founder decision 6), a manifest
// with two dates whose layers each name their date, a truth.json that agrees with the files, and
// the client data check. Run by build-change-demo.mjs, ensure-demo.mjs and `pnpm demo:check`.
//
//   node tools/demo/check-change-demo.mjs [<demo folder or the project folder>]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUDGET_MB, CHANGE_ID } from './build-change-demo.mjs';
import { checkFolder } from './check-no-client-data.mjs';
import { envVar } from '../../packages/brand/src/env.ts';

function size(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? size(p) : statSync(p).size;
  }
  return n;
}

/** Findings for the change demo project folder (empty when it passes). */
export function checkChangeDemo(root, { projectsDir } = {}) {
  const findings = [];
  if (!existsSync(join(root, 'manifest.json')))
    return { findings: [`${root} has no manifest.json`], bytes: 0 };
  const bytes = size(root);
  if (bytes > BUDGET_MB * 1e6)
    findings.push(
      `size ${(bytes / 1e6).toFixed(1)} MB is over the ${BUDGET_MB} MB budget of the change demo`,
    );
  const m = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  if (m.id !== CHANGE_ID) findings.push(`manifest id ${m.id}, expected ${CHANGE_ID}`);
  if (!Array.isArray(m.captures) || m.captures.length !== 2)
    findings.push('the manifest does not list 2 captures');
  const dated = (m.layers ?? []).filter((l) => l.kind !== 'raster' || l.role !== 'plan');
  for (const l of dated) if (!l.capture) findings.push(`layer ${l.id} names no capture`);
  for (const l of m.layers ?? []) {
    const src = l.src?.path ?? l.flight?.src?.path;
    if (src && !existsSync(join(root, src))) findings.push(`layer ${l.id}: ${src} is missing`);
    for (const it of l.items ?? [])
      if (!existsSync(join(root, it.src.path)))
        findings.push(`layer ${l.id}: ${it.src.path} is missing`);
  }
  if (!existsSync(join(root, 'truth.json'))) findings.push('truth.json is missing');
  else {
    const t = JSON.parse(readFileSync(join(root, 'truth.json'), 'utf8'));
    if (t.schema !== 'aio.truth/1') findings.push('truth.json: not aio.truth/1');
    const issues = JSON.parse(readFileSync(join(root, 'issues.json'), 'utf8')).issues;
    for (const d of ['d1', 'd2']) {
      const n = issues.filter((i) => i.capture === d).length;
      if (t.counts?.issues?.[d] !== n)
        findings.push(`truth.json: ${d} has ${n} issues, truth says ${t.counts?.issues?.[d]}`);
    }
    for (const f of [
      ...Object.values(t.sources ?? {}),
      t.modelling?.drawing?.file,
      t.detector?.model,
    ])
      if (f && !existsSync(join(root, f))) findings.push(`truth.json names ${f}, which is missing`);
  }
  const c = checkFolder(root, { projectsDir, maxMb: BUDGET_MB });
  findings.push(...c.findings.map((f) => `client data: ${f}`));
  return { findings, bytes };
}

function cli() {
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const arg = resolve(process.argv[2] ?? join(repo, 'apps', 'desktop', 'demo'));
  const root = existsSync(join(arg, 'manifest.json')) ? arg : join(arg, CHANGE_ID);
  const data =
    envVar(process.env, 'DATA') ?? (process.platform === 'win32' ? 'E:\\Stratlas Data' : '');
  const r = checkChangeDemo(root, { projectsDir: data ? join(data, 'projects') : undefined });
  if (r.findings.length) {
    console.error(`Change demo check FAILED for ${root}:`);
    for (const f of r.findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    `Change demo check passed: ${(r.bytes / 1e6).toFixed(1)} MB of ${BUDGET_MB} MB, truth.json agrees.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
