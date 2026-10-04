import { ProjectManifest, type MapPackInfo } from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPackageJobs, createPlanCache } from '../packages';
import { openProject, ProjectRegistry } from '../project';
import { createAioHandler } from '../protocol/handler';
import {
  noise,
  pmtilesArchive,
  sampleIssue,
  sampleManifest,
  tilesOver,
  writeProject,
} from '../testing';
import { choosePack, embeddedPacks, findEmbedded, listWithEmbedded, projectBbox } from './embed';
import { readHeader } from './header';

const KUWAIT: [number, number, number, number] = [46.5, 28.5, 48.5, 30.1];
const kuwait: MapPackInfo = {
  id: 'kuwait',
  label: 'Kuwait streets',
  bbox: KUWAIT,
  maxZoom: 12,
  sizeBytes: 1,
  builtAt: '2026-10-03T20:52:00.000Z',
  build: '20261003',
};
const world: MapPackInfo = {
  id: 'world',
  label: 'World overview',
  bbox: [-180, -85, 180, 85],
  maxZoom: 6,
  sizeBytes: 1,
};

/** The HCl tank's origin (EPSG 32639), in Kuwait. */
const hcl = () =>
  ProjectManifest.parse(
    sampleManifest({
      id: 'hcl',
      name: 'HCl Tank',
      crs: { epsg: 32639 },
      origin: [216108, 3220019, 0],
      layers: [],
    }),
  );

let base: string;
let packsDir: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-embed-'));
  packsDir = join(base, 'packs');
  await mkdir(packsDir, { recursive: true });
  await writeFile(
    join(packsDir, 'kuwait.pmtiles'),
    pmtilesArchive({
      tiles: tilesOver(KUWAIT, 0, 12, (z, x, y) =>
        noise(`${String(z)}/${String(x)}/${String(y)}`, 200),
      ),
      bbox: KUWAIT,
      leafSize: 50,
    }),
  );
  await writeFile(join(packsDir, 'kuwait.json'), JSON.stringify(kuwait));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('projectBbox and choosePack', () => {
  it('puts the HCl site in Kuwait with the margin on every side', () => {
    const b = projectBbox(hcl(), 2);
    expect(b).not.toBeNull();
    const [w, s, e, n] = b ?? [0, 0, 0, 0];
    expect((w + e) / 2).toBeCloseTo(48.1, 0);
    expect((s + n) / 2).toBeCloseTo(29.08, 1);
    expect(n - s).toBeCloseTo(4 / 111.32, 3);
    expect(projectBbox(ProjectManifest.parse(sampleManifest({ crs: { wkt: 'LOCAL' } })), 2)).toBe(
      null,
    );
  });

  it('takes the most detailed covering pack, then the smallest', () => {
    const b = projectBbox(hcl(), 2) ?? KUWAIT;
    expect(choosePack([world, kuwait], b, 14)?.id).toBe('kuwait');
    expect(choosePack([world], b, 14)?.id).toBe('world');
    expect(choosePack([{ ...kuwait, bbox: [50, 24, 51, 25] }], b, 14)).toBeNull();
  });
});

describe('map packs inside packages', () => {
  async function setup() {
    const root = await writeProject(join(base, 'hcl'), hcl(), {
      'issues.json': JSON.stringify({ schema: 'aio.issues/1', issues: [sampleIssue()] }),
      'thumbnail.jpg': 'jpg',
    });
    const registry = new ProjectRegistry();
    const opened = await openProject(root, registry);
    if (!opened.ok) throw new Error(opened.error);
    const jobs = createPackageJobs({
      registry,
      cache: createPlanCache(),
      createdBy: 'test',
      chooseTarget: () => Promise.resolve(join(base, 'HCl customer.aio')),
      progress: () => undefined,
      packs: {
        dir: () => packsDir,
        list: () => Promise.resolve([kuwait]),
      },
      tempDir: () => base,
    });
    return { jobs, id: opened.id };
  }

  const options = (projectId: string) => ({
    projectId,
    exclude: [],
    readOnly: true,
    aiPolicy: 'forbid' as const,
    exports: ['issues-csv' as const],
    mapPack: { maxZoom: 12, marginKm: 2 },
  });

  it('reports the region size before export, then embeds exactly that region', async () => {
    const { jobs, id } = await setup();
    const without = await jobs.plan({ projectId: id, exclude: [] });
    const plan = await jobs.plan({
      projectId: id,
      exclude: [],
      mapPack: { maxZoom: 12, marginKm: 2 },
    });
    if (!plan.ok || !without.ok) throw new Error('no plan');
    const region = plan.plan.mapPack;
    expect(region).toMatchObject({ ok: true, sourceId: 'kuwait', maxZoom: 12 });
    if (!region?.ok) throw new Error('no region');
    expect(region.bytes).toBeGreaterThan(0);
    expect(plan.plan.totalBytes).toBeGreaterThan(without.plan.totalBytes + region.bytes);
    expect(plan.plan.totalFiles).toBe(without.plan.totalFiles + 2);

    const r = await jobs.export({ jobId: 'j', options: options(id) });
    if (!r.ok || !r.path) throw new Error(r.ok ? 'cancelled' : r.error);

    // The customer opens it on a machine without packs.
    const registry = new ProjectRegistry();
    const opened = await openProject(r.path, registry);
    if (!opened.ok) throw new Error(opened.error);
    const pkg = registry.package(opened.id);
    if (!pkg) throw new Error('not a package');
    const member = pkg.archive.entries.get('packs/kuwait.pmtiles');
    expect(member?.size).toBe(region.bytes);

    const embedded = await embeddedPacks([], registry.openPackages());
    expect(embedded.map((e) => e.id)).toEqual(['pkg-hcl-customer-kuwait']);
    const listed = listWithEmbedded([], embedded);
    expect(listed[0]).toMatchObject({
      id: 'pkg-hcl-customer-kuwait',
      label: 'Kuwait streets, HCl Tank',
      maxZoom: 12,
      source: 'package',
      build: '20261003',
    });
    expect(listed[0]?.bbox).toEqual(region.bbox);

    // A machine with Kuwait installed uses its own pack.
    expect(await embeddedPacks([kuwait], registry.openPackages())).toEqual([]);
    expect(await embeddedPacks([world], registry.openPackages())).toHaveLength(1);

    // aio://packs serves the embedded pack from inside the package, by range.
    const handler = createAioHandler({
      projectRoot: () => undefined,
      projectPackage: (pid) => registry.package(pid)?.archive,
      packsDir: () => join(base, 'empty'),
      embeddedPack: (pid) => findEmbedded(pid, registry.openPackages()),
    });
    const res = await handler(
      new Request('aio://packs/pkg-hcl-customer-kuwait.pmtiles', {
        headers: { Range: 'bytes=0-126' },
      }),
    );
    expect(res.status).toBe(206);
    const head = Buffer.from(await res.arrayBuffer());
    expect(head.toString('ascii', 0, 7)).toBe('PMTiles');
    const missing = await handler(new Request('aio://packs/pkg-hcl-customer-oman.pmtiles'));
    expect(missing.status).toBe(404);

    // The member is a complete pack: extract it and check its header.
    const out = join(base, 'check.pmtiles');
    await pkg.archive.copyTo('packs/kuwait.pmtiles', out);
    const h = await readHeader(out);
    expect(h.maxZoom).toBe(12);
    expect(h.end).toBe((await stat(out)).size);
    expect(JSON.parse(await readFile(join(packsDir, 'kuwait.json'), 'utf8'))).toEqual(kuwait);
  });

  it('explains when no installed pack covers the site, and exports nothing', async () => {
    await writeProject(join(base, 'hcl'), hcl());
    const registry = new ProjectRegistry();
    const opened = await openProject(join(base, 'hcl'), registry);
    if (!opened.ok) throw new Error(opened.error);
    const jobs = createPackageJobs({
      registry,
      cache: createPlanCache(),
      createdBy: 'test',
      chooseTarget: () => Promise.resolve(join(base, 'x.aio')),
      progress: () => undefined,
      packs: { dir: () => packsDir, list: () => Promise.resolve([]) },
    });
    const plan = await jobs.plan({
      projectId: opened.id,
      exclude: [],
      mapPack: { maxZoom: 12, marginKm: 2 },
    });
    expect(plan.ok && plan.plan.mapPack?.ok === false && plan.plan.mapPack.reason).toMatch(
      /No installed map pack covers/,
    );
    const r = await jobs.export({ jobId: 'j', options: options(opened.id) });
    expect(!r.ok && r.error).toMatch(/No installed map pack covers/);
    await expect(stat(join(base, 'x.aio'))).rejects.toThrow();
  });
});
