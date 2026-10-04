import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openProject, ProjectRegistry, slugify, writeIssues } from './project';
import { sampleIssue, sampleManifest, writeProject } from './testing';

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-project-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('slugify', () => {
  it('makes a URL-safe id from a folder name', () => {
    expect(slugify('Al-Zour LNG (2023)')).toBe('al-zour-lng-2023');
    expect(slugify('HCl')).toBe('hcl');
    expect(slugify('???')).toBe('project');
  });
});

describe('ProjectRegistry', () => {
  it('gives each root a stable id and resolves it back', () => {
    const reg = new ProjectRegistry();
    const a = reg.register(join(base, 'alzour'));
    expect(a).toBe('alzour');
    expect(reg.register(join(base, 'alzour'))).toBe('alzour');
    expect(reg.root('alzour')).toBe(join(base, 'alzour'));
    expect(reg.root('nope')).toBeUndefined();
  });

  it('keeps ids unique when two folders share a name', () => {
    const reg = new ProjectRegistry();
    expect(reg.register(join(base, 'a', 'hcl'))).toBe('hcl');
    expect(reg.register(join(base, 'b', 'hcl'))).toBe('hcl-2');
  });
});

describe('openProject', () => {
  it('opens a native project with its issues and registers it', async () => {
    const issues = [sampleIssue()];
    const dir = await writeProject(join(base, 'alzour'), sampleManifest(), {
      'issues.json': JSON.stringify({ schema: 'aio.issues/1', issues }),
    });
    const reg = new ProjectRegistry();
    const r = await openProject(dir, reg);
    if (!r.ok) throw new Error(r.error);
    expect(r.id).toBe('alzour');
    expect(r.root).toBe(dir);
    expect(r.manifest.name).toBe('Al-Zour LNG Terminal');
    expect(r.issues).toEqual(issues);
    expect(reg.root('alzour')).toBe(dir);
  });

  it('answers the package origin of an extracted project, and none for others', async () => {
    const origin = {
      schema: 'aio.origin/1',
      package: 'HCl customer.aio',
      projectId: 'hcl',
      exportedAt: '2026-10-04T08:00:00Z',
      extractedAt: '2026-10-05T09:00:00Z',
      encrypted: false,
    };
    const dir = await writeProject(join(base, 'hcl-edit'), sampleManifest(), {
      'package-origin.json': JSON.stringify(origin),
    });
    const r = await openProject(dir, new ProjectRegistry());
    if (!r.ok) throw new Error(r.error);
    expect(r.origin).toMatchObject({ package: 'HCl customer.aio', projectId: 'hcl' });
    const plain = await openProject(await writeProject(join(base, 'plain')), new ProjectRegistry());
    if (!plain.ok) throw new Error(plain.error);
    expect(plain.origin).toBeUndefined();
    const bad = await writeProject(join(base, 'bad'), sampleManifest(), {
      'package-origin.json': '{"schema":"aio.origin/1"}',
    });
    const b = await openProject(bad, new ProjectRegistry());
    expect(b.ok && b.origin).toBe(undefined);
  });

  it('treats a missing issues.json as no issues', async () => {
    const dir = await writeProject(join(base, 'p'));
    const r = await openProject(dir, new ProjectRegistry());
    expect(r.ok && r.issues).toEqual([]);
  });

  it('names the folder when manifest.json is missing', async () => {
    const r = await openProject(base, new ProjectRegistry());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/manifest\.json/);
    expect(!r.ok && r.error).toContain(base);
  });

  it('explains a manifest that is not JSON', async () => {
    await writeFile(join(base, 'manifest.json'), '{ nope');
    const r = await openProject(base, new ProjectRegistry());
    expect(!r.ok && r.error).toMatch(/manifest\.json is not valid JSON/);
  });

  it('passes on the schema error for an invalid manifest', async () => {
    const dir = await writeProject(join(base, 'p'), { ...sampleManifest(), name: '' });
    const r = await openProject(dir, new ProjectRegistry());
    expect(!r.ok && r.error).toMatch(/manifest\.json.*invalid at name/);
  });

  it('explains an invalid issues.json', async () => {
    const dir = await writeProject(join(base, 'p'), sampleManifest(), {
      'issues.json': JSON.stringify({ schema: 'aio.issues/1', issues: [{ id: 'x' }] }),
    });
    const r = await openProject(dir, new ProjectRegistry());
    expect(!r.ok && r.error).toMatch(/issues\.json/);
  });

  it('refuses a path that is not a folder', async () => {
    const r = await openProject(join(base, 'missing'), new ProjectRegistry());
    expect(!r.ok && r.error).toMatch(/not found|does not exist/i);
  });
});

describe('writeIssues', () => {
  it('writes issues.json atomically and keeps a backup of the previous version', async () => {
    const first = [sampleIssue()];
    const dir = await writeProject(join(base, 'p'), sampleManifest(), {
      'issues.json': JSON.stringify({ schema: 'aio.issues/1', issues: first }),
    });
    const second = [sampleIssue(), sampleIssue({ id: 'i2', code: 'F02', severity: 5 })];
    const r = await writeIssues(dir, second);
    expect(r).toEqual({ ok: true });
    const written = JSON.parse(await readFile(join(dir, 'issues.json'), 'utf8')) as unknown;
    expect(written).toEqual({ schema: 'aio.issues/1', issues: second });
    const bak = JSON.parse(await readFile(join(dir, 'issues.json.bak'), 'utf8')) as unknown;
    expect(bak).toEqual({ schema: 'aio.issues/1', issues: first });
  });

  it('refuses a severity that is not in the named severity model', async () => {
    const dir = await writeProject(join(base, 'p'));
    const r = await writeIssues(dir, [sampleIssue({ severity: 4 })]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/severity 4/);
  });

  it('refuses an unknown severity model', async () => {
    const dir = await writeProject(join(base, 'p'));
    const r = await writeIssues(dir, [sampleIssue({ severityModelId: 'other' })]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/other/);
  });
});
