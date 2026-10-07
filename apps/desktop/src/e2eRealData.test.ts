/**
 * The e2e suite's one gate to the founder's real client data (e2e/realData.ts), checked
 * statically over every e2e file, and the copy helper itself on a fake real data root.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as RealDataGate from '../e2e/realData';

const E2E = join(import.meta.dirname, '..', 'e2e');
const GATE = 'realData.ts';

const files = readdirSync(E2E)
  .filter((n) => /\.(ts|mts|cts|js|mjs|cjs)$/.test(n))
  .map((name) => ({ name, text: readFileSync(join(E2E, name), 'utf8') }));

/** A drive-root `Stratlas Data` path, as written in source (`E:\\Stratlas Data`, `E:/Stratlas Data`). */
const LITERAL_ROOT = /[A-Za-z]:[\\/]+Stratlas Data/;
/**
 * The real data root by environment, or the per-spec variables it replaced, under the current
 * QUADRION_ prefix or the legacy STRATLAS_ one.
 */
const ROOT_ENV =
  /process\.env\.(QUADRION|STRATLAS)_(REAL_DATA_ROOT|DATA|DATA_ROOT|REAL_DATA|(HCL|EBSM|MASAFI|RINGROAD|COMPARE|PROJECTS|A1)_DATA|HCL)\b/;
/** A spec reaching real projects through the gate. */
const USES_REAL_PROJECTS =
  /\b(copyRealProjects|realProject|realDataTest|realProjectDir|hasRealProject|missingRealProject)\b|\b(copyRealData|hasRealData|realDataPath)\(\s*\[?\s*'projects'/;
/** `@realdata` at the start of a test or describe title. */
const TAGGED = /(['`])@realdata\b/;

describe('e2e specs reach the real data only through realData.ts', () => {
  it('finds the e2e files', () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((f) => f.name === GATE)).toBe(true);
  });

  it('names the real data root nowhere but realData.ts', () => {
    const offenders = files
      .filter((f) => f.name !== GATE)
      .flatMap((f) =>
        f.text
          .split('\n')
          .map((line, i) => ({ line, i }))
          .filter(({ line }) => LITERAL_ROOT.test(line) || ROOT_ENV.test(line))
          .map(({ line, i }) => `${f.name}:${String(i + 1)}: ${line.trim()}`),
      );
    expect(offenders, 'use realDataPath / copyRealProjects from realData.ts').toEqual([]);
  });

  it('launches the app with a data root only through launchApp, never with the gate', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f.name === 'fixtures.ts') continue;
      const launches = [...f.text.matchAll(/electron\.launch\(/g)];
      if (launches.length === 0) continue;
      if (f.text.includes("from './realData'"))
        offenders.push(`${f.name}: launches the app itself and uses real data (use realProject)`);
      for (const m of launches) {
        // the launch options: up to the call's closing `});`
        const call = f.text.slice(m.index, f.text.indexOf('});', m.index) + 3);
        if (!/(QUADRION|STRATLAS)_DATA\b/.test(call))
          offenders.push(`${f.name}: electron.launch without its own QUADRION_DATA`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('tags every spec that uses real projects with @realdata', () => {
    const untagged = files
      .filter((f) => f.name !== GATE && f.name !== 'fixtures.ts')
      .filter((f) => USES_REAL_PROJECTS.test(f.text) && !TAGGED.test(f.text))
      .map((f) => f.name);
    expect(untagged).toEqual([]);
  });

  it('has no other copy helper for real projects', () => {
    expect(existsSync(join(E2E, 'agentProjects.ts'))).toBe(false);
  });

  it('catches the patterns it is meant to', () => {
    expect(LITERAL_ROOT.test(`const DATA = 'E:\\\\Stratlas Data';`)).toBe(true);
    expect(LITERAL_ROOT.test(`QUADRION_DATA: 'E:/Stratlas Data',`)).toBe(true);
    expect(LITERAL_ROOT.test(`join(dir, 'Stratlas Data')`)).toBe(false);
    expect(LITERAL_ROOT.test(`'C:\\\\Users\\\\you\\\\Documents\\\\Stratlas Data'`)).toBe(false);
    expect(ROOT_ENV.test('process.env.QUADRION_HCL_DATA ?? x')).toBe(true);
    expect(ROOT_ENV.test('process.env.QUADRION_DATA ?? x')).toBe(true);
    expect(ROOT_ENV.test('process.env.STRATLAS_REAL_DATA_ROOT')).toBe(true);
    expect(ROOT_ENV.test('process.env.QUADRION_SHOTS')).toBe(false);
    expect(USES_REAL_PROJECTS.test(`copyRealData(['projects', 'hcl', d], x)`)).toBe(true);
    expect(USES_REAL_PROJECTS.test(`copyRealData(['packs', f], x)`)).toBe(false);
  });
});

describe('copyRealProjects on a fake real data root', () => {
  let base = '';
  let real = '';
  let gate: typeof RealDataGate;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'aio-realdata-'));
    real = join(base, 'real');
    const p = join(real, 'projects', 'site');
    await mkdir(join(p, 'photos'), { recursive: true });
    await mkdir(join(p, 'edits'), { recursive: true });
    await mkdir(join(real, 'packs'), { recursive: true });
    await writeFile(join(p, 'manifest.json'), JSON.stringify({ id: 'site', name: 'Site' }));
    await writeFile(join(p, 'issues.json'), JSON.stringify({ issues: [] }));
    await writeFile(join(p, 'photos', 'big.jpg'), Buffer.alloc(2 * 1024 * 1024, 7));
    await writeFile(join(p, 'photos', 'small.jpg'), Buffer.alloc(10, 7));
    await writeFile(join(p, 'edits', 'boundaries.json'), '{}');
    await writeFile(join(real, 'packs', 'kuwait.pmtiles'), Buffer.alloc(10, 1));
    await writeFile(join(real, 'packs', 'kuwait.json'), '{}');
    vi.stubEnv('QUADRION_REAL_DATA_ROOT', real);
    vi.stubEnv('QUADRION_E2E_COPY_DIR', base);
    vi.resetModules();
    gate = await import('../e2e/realData');
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(base, { recursive: true, force: true });
  });

  it('reads the root from QUADRION_REAL_DATA_ROOT', () => {
    expect(gate.REAL_DATA_ROOT).toBe(real);
    expect(gate.hasRealProject('site')).toBe(true);
    expect(gate.hasRealProject('other')).toBe(false);
    expect(gate.isUnderRealData(join(real, 'projects'))).toBe(true);
    expect(gate.isUnderRealData(join(base, 'realer'))).toBe(false);
    expect(() => {
      gate.assertNotRealData(real, 'The e2e data root');
    }).toThrow(/inside the real data root/);
  });

  it('copies a project to a temp root, links large read-only files, and deletes the copy', async () => {
    const copy = await gate.copyRealProjects(['site', 'missing'], {
      packs: ['kuwait'],
      include: (rel) => rel !== 'edits',
    });
    try {
      expect(gate.isUnderRealData(copy.root)).toBe(false);
      expect(copy.projectDir).toBe(join(copy.root, 'projects', 'site'));
      expect(readdirSync(join(copy.root, 'projects'))).toEqual(['site']);
      expect(existsSync(join(copy.projectDir, 'edits'))).toBe(false);
      expect(existsSync(join(copy.root, 'packs', 'kuwait.pmtiles'))).toBe(true);
      // the large photo is a hard link (same drive), records are real copies
      expect(statSync(join(copy.projectDir, 'photos', 'big.jpg')).nlink).toBe(2);
      expect(statSync(join(copy.projectDir, 'photos', 'small.jpg')).nlink).toBe(1);
      expect(statSync(join(copy.projectDir, 'issues.json')).nlink).toBe(1);
      expect(copy.stats.linked).toBe(1);
      // writing a record in the copy leaves the real one alone
      await writeFile(join(copy.projectDir, 'issues.json'), '{"issues":["F79"]}');
      expect(await readFile(join(real, 'projects', 'site', 'issues.json'), 'utf8')).toBe(
        '{"issues":[]}',
      );
    } finally {
      await copy.dispose();
    }
    expect(existsSync(copy.base)).toBe(false);
    expect(statSync(join(real, 'projects', 'site', 'photos', 'big.jpg')).size).toBe(
      2 * 1024 * 1024,
    );
  });

  it('renames, filters and rewrites the manifest of a copy', async () => {
    const copy = await gate.copyRealProjects(['site'], {
      rename: { site: 'site-review' },
      include: gate.onlyPaths(['manifest.json', 'photos/small.jpg']),
      manifest: (m) => ({ ...m, id: 'site-review' }),
      link: false,
    });
    try {
      expect(copy.projectId).toBe('site-review');
      expect(readdirSync(copy.projectDir).sort()).toEqual(['manifest.json', 'photos']);
      expect(readdirSync(join(copy.projectDir, 'photos'))).toEqual(['small.jpg']);
      const m = JSON.parse(await readFile(join(copy.projectDir, 'manifest.json'), 'utf8')) as {
        id: string;
      };
      expect(m.id).toBe('site-review');
    } finally {
      await copy.dispose();
    }
  });

  it('refuses to copy into the real data', async () => {
    await expect(
      gate.copyRealData(['projects', 'site', 'issues.json'], join(real, 'x.json')),
    ).rejects.toThrow(/inside the real data root/);
  });
});
