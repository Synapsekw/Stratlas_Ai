import { exportPackage } from '@aio/project/package';
import { PackageHeader, ProjectManifest } from '@aio/schema';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listLibrary } from './library';
import {
  checkExport,
  cloudAllowedFor,
  createPackageJobs,
  createPlanCache,
  exportFormatRefusal,
  packagePathFromArgv,
  packageReports,
  ProjectPolicy,
  stagePackageExport,
} from './packages';
import { openProject, ProjectRegistry, writeProjectIssues } from './project';
import { createAioHandler } from './protocol/handler';
import { sampleIssue, sampleManifest, writeProject } from './testing';

let base: string;
let root: string;
const VIDEO = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-pkgmain-'));
  root = await writeProject(join(base, 'alzour'), sampleManifest(), {
    'issues.json': JSON.stringify({ schema: 'aio.issues/1', issues: [sampleIssue()] }),
    'models/plant.glb': 'glTF',
    'flights/DJI_0789.json': '{"samples":[]}',
    'flights/DJI_0790.json': '{"samples":[]}',
    'video/DJI_0790.mp4': 'mp4',
    'thumbnail.jpg': 'jpg',
    'legacy/Old Review.html': '<!doctype html><html><head></head><body>old</body></html>',
  });
  await mkdir(join(root, 'video'), { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(root, 'video', 'DJI_0789.mp4'), VIDEO);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function makePackage(
  file: string,
  o: { passphrase?: string; header?: Partial<PackageHeader> } = {},
): Promise<string> {
  await exportPackage({
    root,
    out: file,
    manifest: ProjectManifest.parse(sampleManifest()),
    exclude: [],
    header: { readOnly: true, aiPolicy: 'forbid', exports: ['issues-csv'], ...o.header },
    ...(o.passphrase ? { passphrase: o.passphrase } : {}),
  });
  return file;
}

describe('opening a .aio package', () => {
  it('opens in place, registers it as a package and returns its policy', async () => {
    const file = await makePackage(join(base, 'alzour.aio'));
    const reg = new ProjectRegistry();
    const r = await openProject(file, reg);
    if (!r.ok) throw new Error(r.error);
    expect(r.manifest.name).toBe('Al-Zour LNG Terminal');
    expect(r.issues).toHaveLength(1);
    expect(r.package).toMatchObject({
      file,
      encrypted: false,
      header: { readOnly: true, aiPolicy: 'forbid', exports: ['issues-csv'] },
    });
    expect(reg.root(r.id)).toBeUndefined();
    expect(reg.package(r.id)?.file).toBe(file);
  });

  it('asks for the passphrase of an encrypted package, then opens it', async () => {
    const file = await makePackage(join(base, 'locked.aio'), { passphrase: 'correct horse' });
    const reg = new ProjectRegistry();
    const locked = await openProject(file, reg);
    expect(!locked.ok && locked.needsPassphrase).toBe(true);
    const open = await openProject(file, reg, 'correct horse');
    expect(open.ok && open.package?.encrypted).toBe(true);
  });

  it('still refuses a plain file that is not a package', async () => {
    const r = await openProject(join(root, 'thumbnail.jpg'), new ProjectRegistry());
    expect(!r.ok && r.error).toMatch(/project folder|\.aio/);
  });
});

describe('aio:// inside a package', () => {
  async function opened() {
    const file = await makePackage(join(base, 'alzour.aio'));
    const reg = new ProjectRegistry();
    const r = await openProject(file, reg);
    if (!r.ok) throw new Error(r.error);
    const handler = createAioHandler({
      projectRoot: (id) => reg.root(id),
      projectPackage: (id) => reg.package(id)?.archive,
      packsDir: () => join(base, 'packs'),
    });
    return { id: r.id, handler };
  }

  it('streams a byte range of a member with 206', async () => {
    const { id, handler } = await opened();
    const res = await handler(
      new Request(`aio://project/${id}/video/DJI_0789.mp4`, {
        headers: { Range: 'bytes=1000-1099' },
      }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-range')).toBe(`bytes 1000-1099/${String(VIDEO.length)}`);
    expect(Buffer.from(await res.arrayBuffer()).equals(VIDEO.subarray(1000, 1100))).toBe(true);
  });

  it('serves a whole member, a legacy page with its shims, and 404 for anything else', async () => {
    const { id, handler } = await opened();
    const whole = await handler(new Request(`aio://project/${id}/models/plant.glb`));
    expect(whole.status).toBe(200);
    expect(await whole.text()).toBe('glTF');
    const legacy = await handler(new Request(`aio://project/${id}/legacy/Old%20Review.html`));
    expect(legacy.headers.get('content-security-policy')).toBeTruthy();
    expect(await legacy.text()).toContain('old');
    expect((await handler(new Request(`aio://project/${id}/nope.bin`))).status).toBe(404);
    expect((await handler(new Request(`aio://project/${id}/../alzour/x`))).status).toBe(404);
  });
});

describe('player policy', () => {
  it('never writes issues into a package', async () => {
    const file = await makePackage(join(base, 'alzour.aio'));
    const reg = new ProjectRegistry();
    const r = await openProject(file, reg);
    if (!r.ok) throw new Error(r.error);
    const w = await writeProjectIssues(reg, r.id, [sampleIssue()]);
    expect(w.ok).toBe(false);
    expect(w.error).toMatch(/read-only/i);
  });

  it('allows cloud AI only when the setting is on and the package allows it', () => {
    const header = (aiPolicy: 'forbid' | 'allow') =>
      PackageHeader.parse({
        schema: 'aio.package/1',
        projectId: 'p',
        createdAt: '2026-10-04T00:00:00Z',
        aiPolicy,
      });
    expect(cloudAllowedFor(true, undefined)).toBe(true);
    expect(cloudAllowedFor(false, undefined)).toBe(false);
    expect(cloudAllowedFor(true, header('forbid'))).toBe(false);
    expect(cloudAllowedFor(true, header('allow'))).toBe(true);
    expect(cloudAllowedFor(false, header('allow'))).toBe(false);
  });

  it('limits saved files to the export kinds the package lists', () => {
    const header = PackageHeader.parse({
      schema: 'aio.package/1',
      projectId: 'p',
      createdAt: '2026-10-04T00:00:00Z',
      exports: ['issues-csv'],
    });
    expect(checkExport(undefined, 'model.glb')).toBeNull();
    expect(checkExport(header, 'issues.csv')).toBeNull();
    expect(checkExport(header, 'report.pdf')).toMatch(/does not allow/);
  });

  it('limits issue exports to the package list and keeps photo exports to folders', () => {
    const header = PackageHeader.parse({
      schema: 'aio.package/1',
      projectId: 'p',
      createdAt: '2026-10-04T00:00:00Z',
      exports: ['issues-csv', 'kit-json', 'masks'],
    });
    expect(exportFormatRefusal(undefined, 'masks-zip')).toBeNull();
    expect(exportFormatRefusal(header, 'csv')).toBeNull();
    expect(exportFormatRefusal(header, 'kit-json')).toBeNull();
    expect(exportFormatRefusal(header, 'report-pdf')).toMatch(/does not allow saving PDF/);
    expect(exportFormatRefusal(header, 'geojson')).toMatch(/does not allow/);
    expect(exportFormatRefusal(header, 'masks-zip')).toMatch(/project folder/);
  });

  it('lists the reports a package carries and stages its issues for an export', async () => {
    const file = await makePackage(join(base, 'staged.aio'));
    const reg = new ProjectRegistry();
    const opened = await openProject(file, reg);
    if (!opened.ok) throw new Error(opened.error);
    const pkg = reg.package(opened.id);
    if (!pkg) throw new Error('no package');
    expect(packageReports(pkg.archive).every((r) => r.path.startsWith('report/'))).toBe(true);
    const staged = await stagePackageExport(pkg, base);
    const issues = JSON.parse(await readFile(join(staged.root, 'issues.json'), 'utf8')) as {
      issues: unknown[];
    };
    expect(issues.issues).toHaveLength(opened.issues.length);
    expect(existsSync(join(staged.root, 'manifest.json'))).toBe(true);
    await staged.dispose();
    expect(existsSync(staged.root)).toBe(false);
  });

  it('follows the project that was opened last', async () => {
    const file = await makePackage(join(base, 'alzour.aio'), { header: { aiPolicy: 'forbid' } });
    const reg = new ProjectRegistry();
    const policy = new ProjectPolicy(reg);
    const pkg = await openProject(file, reg);
    if (!pkg.ok) throw new Error(pkg.error);
    policy.opened(pkg.id);
    expect(policy.cloudAllowed(true)).toBe(false);
    const folder = await openProject(root, reg);
    if (!folder.ok) throw new Error(folder.error);
    policy.opened(folder.id);
    expect(policy.cloudAllowed(true)).toBe(true);
  });
});

describe('library entries for packages', () => {
  it('lists .aio files in the projects folder and added paths, encrypted ones by file name', async () => {
    const dataRoot = join(base, 'data');
    await mkdir(join(dataRoot, 'projects'), { recursive: true });
    await makePackage(join(dataRoot, 'projects', 'alzour.aio'));
    const locked = await makePackage(join(base, 'Customer copy.aio'), {
      passphrase: 'correct horse',
    });
    const entries = await listLibrary({
      dataRoot,
      extraPaths: [locked],
      registry: new ProjectRegistry(),
    });
    const plain = entries.find((e) => e.path.endsWith('alzour.aio'));
    expect(plain).toMatchObject({
      name: 'Al-Zour LNG Terminal',
      customer: 'KIPIC',
      kind: 'native',
      package: { encrypted: false, readOnly: true },
    });
    expect(plain?.thumbnail).toMatch(/^aio:\/\/project\/.+\/thumbnail\.jpg$/);
    const enc = entries.find((e) => e.path === locked);
    expect(enc).toMatchObject({ name: 'Customer copy', package: { encrypted: true } });
    expect(enc?.sizeBytes).toBeGreaterThan(0);
  });

  it('shows an encrypted package by its project once it was unlocked in this session', async () => {
    const dataRoot = join(base, 'data');
    const locked = await makePackage(join(base, 'Customer copy.aio'), {
      passphrase: 'correct horse',
    });
    const registry = new ProjectRegistry();
    const opened = await openProject(locked, registry, 'correct horse');
    expect(opened.ok).toBe(true);
    const [entry] = await listLibrary({ dataRoot, extraPaths: [locked], registry });
    expect(entry).toMatchObject({
      name: 'Al-Zour LNG Terminal',
      customer: 'KIPIC',
      package: { encrypted: true, readOnly: true },
    });
    expect(entry?.thumbnail).toMatch(/thumbnail\.jpg$/);
  });
});

describe('package plan cache', () => {
  it('reports per-layer and total bytes for the requested exclusions', async () => {
    const cache = createPlanCache();
    const manifest = ProjectManifest.parse(sampleManifest());
    const all = await cache.plan(root, manifest, []);
    const without = await cache.plan(root, manifest, ['dji0789']);
    expect(all.totalBytes - without.totalBytes).toBe(VIDEO.length + 14);
    expect(all.layers.find((l) => l.id === 'dji0789')?.bytes).toBe(VIDEO.length + 14);
  });
});

describe('packagePathFromArgv', () => {
  it('finds the double-clicked package among Electron arguments', () => {
    expect(packagePathFromArgv(['C:/app/Stratlas.exe', 'D:/jobs/HCl.aio'])).toBe('D:/jobs/HCl.aio');
    expect(packagePathFromArgv(['electron', '.', '--flag', 'x.AIO'])).toBe('x.AIO');
    expect(packagePathFromArgv(['electron', 'out/main/index.js'])).toBeNull();
    expect(packagePathFromArgv(['app', '--open=x.aio'])).toBeNull();
    expect(packagePathFromArgv(['app', 'stratlas://open?path=C%3A%5Cx.aio'])).toBeNull();
  });
});

describe('package export jobs', () => {
  const options = (projectId: string) => ({
    projectId,
    exclude: [],
    readOnly: true,
    aiPolicy: 'forbid' as const,
    exports: ['issues-csv' as const],
  });

  async function setup(target: string | null) {
    const registry = new ProjectRegistry();
    const opened = await openProject(root, registry);
    if (!opened.ok) throw new Error(opened.error);
    const events: number[] = [];
    let jobs: ReturnType<typeof createPackageJobs> | null = null;
    jobs = createPackageJobs({
      registry,
      cache: createPlanCache(),
      createdBy: 'test',
      chooseTarget: () => Promise.resolve(target),
      progress: (e) => {
        events.push(e.bytesDone);
        // Cancel as soon as the first progress arrives when asked to.
        if (target?.endsWith('cancel')) jobs?.cancel({ jobId: e.jobId });
      },
    });
    return { jobs, id: opened.id };
  }

  it('writes the package where the person chose, adding the .aio extension', async () => {
    const { jobs, id } = await setup(join(base, 'out', 'delivery'));
    await mkdir(join(base, 'out'));
    const r = await jobs.export({ jobId: 'j1', options: options(id) });
    expect(r).toMatchObject({ ok: true, path: join(base, 'out', 'delivery.aio') });
    expect(existsSync(join(base, 'out', 'delivery.aio'))).toBe(true);
  });

  it('answers a cancelled dialog or a cancelled job with no path and leaves no file', async () => {
    const none = await setup(null);
    expect(await none.jobs.export({ jobId: 'j1', options: options(none.id) })).toEqual({
      ok: true,
      path: null,
    });
    const cancelled = await setup(join(base, 'cancel'));
    const r = await cancelled.jobs.export({ jobId: 'j2', options: options(cancelled.id) });
    expect(r).toEqual({ ok: true, path: null });
    expect(existsSync(join(base, 'cancel.aio'))).toBe(false);
    expect(existsSync(join(base, 'cancel.aio.partial'))).toBe(false);
  });

  it('refuses to export a package from a package', async () => {
    const file = await makePackage(join(base, 'alzour.aio'));
    const registry = new ProjectRegistry();
    const opened = await openProject(file, registry);
    if (!opened.ok) throw new Error(opened.error);
    const jobs = createPackageJobs({
      registry,
      cache: createPlanCache(),
      createdBy: 'test',
      chooseTarget: () => Promise.resolve(join(base, 'x.aio')),
      progress: () => undefined,
    });
    const r = await jobs.export({ jobId: 'j', options: options(opened.id) });
    expect(r.ok).toBe(false);
    const plan = await jobs.plan({ projectId: opened.id, exclude: [] });
    expect(!plan.ok && plan.error).toMatch(/project folder/);
  });
});

describe('extract to edit', () => {
  async function opened(header: Partial<PackageHeader>, passphrase?: string) {
    const file = await makePackage(join(base, 'Al-Zour delivery.aio'), {
      header,
      ...(passphrase ? { passphrase } : {}),
    });
    const registry = new ProjectRegistry();
    const r = await openProject(file, registry, passphrase);
    if (!r.ok) throw new Error(r.error);
    const events: number[] = [];
    const jobs = createPackageJobs({
      registry,
      cache: createPlanCache(),
      createdBy: 'test',
      chooseTarget: () => Promise.resolve(null),
      progress: (e) => events.push(e.filesDone),
      dataRoot: () => join(base, 'data'),
      user: 'surveyor',
    });
    return { jobs, id: r.id, events, registry };
  }

  it('extracts an unlocked package into an editable project that saves issues', async () => {
    const { jobs, id, events } = await opened({ editPolicy: 'allow' }, 'correct horse battery');
    const r = await jobs.extract({ jobId: 'x', projectId: id });
    if (!r.ok || !r.root) throw new Error(r.ok ? 'cancelled' : r.error);
    expect(r.root).toBe(join(base, 'data', 'projects', 'al-zour-delivery-edit'));
    expect(events.length).toBeGreaterThan(0);
    const origin = JSON.parse(await readFile(join(r.root, 'package-origin.json'), 'utf8')) as {
      package: string;
      extractedBy: string;
    };
    expect(origin).toMatchObject({ package: 'Al-Zour delivery.aio', extractedBy: 'surveyor' });

    // The copy is a normal project: it opens as a folder and takes issue edits.
    const registry = new ProjectRegistry();
    const copy = await openProject(r.root, registry);
    if (!copy.ok) throw new Error(copy.error);
    expect(copy.package).toBeUndefined();
    expect(copy.issues).toHaveLength(1);
    const saved = await writeProjectIssues(registry, copy.id, [
      ...copy.issues,
      sampleIssue({ id: 'i2', code: 'F02', title: 'Added after extract' }),
    ]);
    expect(saved).toEqual({ ok: true });
  });

  it('refuses a package that forbids editing and a project that is not a package', async () => {
    const { jobs, id } = await opened({ readOnly: true });
    const r = await jobs.extract({ jobId: 'x', projectId: id });
    expect(!r.ok && r.error).toMatch(/did not allow editing/);
    const folder = await jobs.extract({ jobId: 'y', projectId: 'nope' });
    expect(!folder.ok && folder.error).toMatch(/Open the package first/);
    expect(existsSync(join(base, 'data', 'projects'))).toBe(false);
  });
});
