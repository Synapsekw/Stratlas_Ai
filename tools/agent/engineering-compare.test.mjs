import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  compareInventories,
  evidenceReport,
  insideRepo,
  inventory,
  readGlbJson,
} from './engineering-compare.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'engineering-compare.mjs');
const dir = mkdtempSync(join(tmpdir(), 'eng-compare-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The test runner may keep TEMP inside its worktree. Give the standalone CLI a synthetic
// repository boundary so its report can sit outside that boundary but remain in private TEMP.
const cliRepo = join(dir, 'repo');
const cliScript = join(cliRepo, 'tools', 'agent', 'engineering-compare.mjs');
mkdirSync(dirname(cliScript), { recursive: true });
copyFileSync(script, cliScript);
const cliEnv = { ...process.env, GIT_CEILING_DIRECTORIES: dir };

/** A minimal GLB (JSON chunk only) with these nodes. */
function glb(nodes) {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, nodes }), 'utf8');
  const pad = (4 - (json.length % 4)) % 4;
  const chunk = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const head = Buffer.alloc(12);
  head.write('glTF', 0, 'latin1');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + chunk.length, 8);
  const ch = Buffer.alloc(8);
  ch.writeUInt32LE(chunk.length, 0);
  ch.write('JSON', 4, 'latin1');
  return Buffer.concat([head, ch, chunk]);
}

const node = (id, category) => ({ name: id, extras: { component: id, category, tag: id } });

const candidate = join(dir, 'candidate.glb');
const reference = join(dir, 'reference.glb');
writeFileSync(
  candidate,
  glb([
    node('shaft-1', 'Shaft'),
    node('flue-1', 'Flues'),
    node('flue-2', 'Flues'),
    node('flue-3', 'Flues'),
    node('ladder-1', 'Access'),
    { name: 'root' },
  ]),
);
writeFileSync(
  reference,
  glb([
    node('shaft-1', 'Shaft'),
    node('flue-1', 'Flues'),
    node('flue-2', 'Flues'),
    node('light-l1-1', 'Lighting'),
    node('light-l1-2', 'Lighting'),
  ]),
);

describe('inventory', () => {
  it('reads node names and categories from a GLB', () => {
    const inv = inventory(readGlbJson(readFileSync(candidate)));
    expect(inv.categories).toEqual({ Shaft: 1, Flues: 3, Access: 1, Uncategorised: 1 });
    expect(inv.roles).toMatchObject({ shaft: 1, flue: 3, ladder: 1 });
  });

  it('lists the missing and extra categories and the count differences', () => {
    const diff = compareInventories(
      inventory(readGlbJson(readFileSync(candidate))),
      inventory(readGlbJson(readFileSync(reference))),
    );
    expect(diff.missingCategories).toEqual(['Lighting']);
    expect(diff.extraCategories).toEqual(['Access', 'Uncategorised']);
    expect(diff.categoryCounts).toContainEqual({ category: 'Flues', candidate: 3, reference: 2 });
    expect(diff.roleCounts).toContainEqual({ role: 'light-l1', candidate: 0, reference: 2 });
    expect(diff.roleCounts).toContainEqual({ role: 'flue', candidate: 3, reference: 2 });
  });

  it('refuses a file that is not a GLB', () => {
    expect(() => readGlbJson(Buffer.from('not a glb at all'))).toThrow(/not a GLB/);
  });
});

describe('evidence', () => {
  it('reports residuals and coverage per measured group', () => {
    const r = evidenceReport({
      schema: 'aio.evidence/1',
      slices: [
        { y: 1, centre: [0, 0], r: 2, residualM: 0.02, support: 100, coverage: 0.8 },
        { y: 2, centre: [0, 0], r: 2, residualM: 0.04, support: 100, coverage: 0.6 },
      ],
      taper: { profile: [], residualM: 0.03 },
      members: [
        {
          kind: 'flue',
          items: [
            { centre: [0, 9, 0], size: 1, support: 40, residualM: 0.01, coverage: 0.5 },
            { centre: [1, 9, 0], size: 1, support: 30 },
          ],
          metrics: { residualM: 0.012 },
        },
      ],
    });
    expect(r.slices).toEqual({ count: 2, meanResidualM: 0.03, meanCoverage: 0.7 });
    expect(r.taperResidualM).toBe(0.03);
    expect(r.members).toEqual([
      { kind: 'flue', items: 2, residualM: 0.012, meanCoverage: 0.5, withCoverage: 1 },
    ]);
  });
});

describe('command line', () => {
  it('refuses an output folder inside the repository', () => {
    expect(insideRepo(join(here, 'out'))).toBe(true);
    const r = spawnSync(
      process.execPath,
      [cliScript, candidate, reference, '--out', join(cliRepo, 'out')],
      {
        encoding: 'utf8',
        env: cliEnv,
      },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/inside the repository/);
  });

  it('writes the report outside the repository without the reference path', () => {
    const out = join(dir, 'report');
    const r = spawnSync(process.execPath, [cliScript, candidate, reference, '--out', out], {
      encoding: 'utf8',
      env: cliEnv,
    });
    expect(r.status).toBe(0);
    const report = JSON.parse(readFileSync(join(out, 'compare.json'), 'utf8'));
    expect(report.diff.missingCategories).toEqual(['Lighting']);
    const text = readFileSync(join(out, 'compare.json'), 'utf8');
    expect(text).not.toContain(dir);
    expect(text).not.toContain('reference.glb');
    expect(readFileSync(join(out, 'compare.md'), 'utf8')).toContain('| Flues | 3 | 2 |');
  });
});
