import { utmToWgs84 } from '@aio/geo';
import type { Issue, LibraryEntry, ProjectManifest } from '@aio/schema';
import { exportPackage, openZip } from '@aio/project/package';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  globeProjectReader,
  globeRastersOf,
  globeSites,
  originLonLat,
  registerGlobeIpc,
  siteOf,
  type GlobeProject,
} from './globe';
import { collectHandlers } from './notYet';

const manifest = (over: Partial<ProjectManifest> = {}): ProjectManifest => ({
  schema: 'aio.project/1',
  id: 'p1',
  name: 'Desert site',
  crs: { epsg: 32639 },
  origin: [745_000, 3_245_000, 12],
  captures: [
    { id: 'c1', label: 'March', date: '2026-03-01' },
    { id: 'c2', label: 'June', date: '2026-06-01' },
  ],
  layers: [],
  severityModels: [],
  classCatalogues: [],
  ...over,
});

const issue = (id: string, severity: Issue['severity'], status: Issue['status']): Issue => ({
  id,
  code: `F0${id.slice(-1)}`,
  classId: 'c',
  severityModelId: 's',
  severity,
  status,
  title: 't',
  note: '',
  author: 'a',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  sightings: [{ on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] } }],
  source: 'human',
});

const entry = (id: string, path: string, over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id,
  name: id,
  path,
  kind: 'native',
  ...over,
});

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-globe-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('library projects as Globe sites', () => {
  it('places a project origin through its CRS (EPSG and WKT)', () => {
    const [lon, lat] = utmToWgs84(745_000, 3_245_000, 39);
    const ll = originLonLat(manifest());
    expect(ll?.[0]).toBeCloseTo(lon, 9);
    expect(ll?.[1]).toBeCloseTo(lat, 9);
    const wkt = originLonLat(
      manifest({
        crs: { wkt: '+proj=utm +zone=39 +datum=WGS84 +units=m +no_defs' },
      }),
    );
    expect(wkt?.[0]).toBeCloseTo(lon, 9);
    expect(originLonLat(manifest({ crs: { epsg: 2154 } }))).toBeNull(); // not bundled
    expect(originLonLat(manifest({ crs: { wkt: 'not a crs' } }))).toBeNull();
  });

  it('does not place a project on a local grid (it would land at 0 N 0 E)', () => {
    for (const wkt of [
      'LOCAL_CS["Site grid",UNIT["metre",1]]',
      ' local_cs["Site grid",UNIT["metre",1]]',
      'ENGCRS["Site grid",EDATUM["Site datum"],CS[Cartesian,2],AXIS["e",east],AXIS["n",north],UNIT["metre",1]]',
    ]) {
      expect(originLonLat({ crs: { wkt }, origin: [0, 0, 0] })).toBeNull();
      expect(originLonLat({ crs: { wkt }, origin: [0.5, 0.2, 0] })).toBeNull();
    }
  });

  it('counts open issues by severity and lists captures and tilesets', async () => {
    const projects: Record<string, GlobeProject> = {
      a: {
        manifest: manifest({ name: 'A' }),
        issues: [issue('i1', 3, 'draft'), issue('i2', 3, 'reviewed'), issue('i3', 1, 'closed')],
        tilesets: {
          schema: 'aio.tilesets/1',
          entries: [
            {
              id: 'mesh-1',
              name: 'Mesh',
              kind: 'mesh',
              src: 'tiles/mesh-1/tileset.json',
              visible: true,
            },
          ],
        },
      },
      b: { manifest: manifest({ name: 'B', crs: { epsg: 2154 } }), issues: [], tilesets: null },
    };
    const sites = await globeSites(
      [entry('a', 'A'), entry('b', 'B'), entry('k', 'K', { kind: 'aik' })],
      (e) => Promise.resolve(projects[e.id] ?? null),
    );
    expect(sites).toHaveLength(1); // b has no bundled CRS, k is a kit export
    expect(sites[0]).toMatchObject({
      projectId: 'a',
      name: 'A',
      issues: { open: 2, bySeverity: { '3': 2 } },
      captures: [{ id: 'c1' }, { id: 'c2' }],
      tilesets: [{ id: 'mesh-1', kind: 'mesh' }],
    });
  });

  it('reads folder projects, skips unreadable ones and locked packages', async () => {
    const root = join(dir, 'p1');
    await mkdir(root);
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest()));
    await writeFile(
      join(root, 'issues.json'),
      JSON.stringify({ schema: 'aio.issues/1', issues: [issue('i1', 2, 'draft')] }),
    );
    const read = globeProjectReader({ package: () => undefined });
    const p = await read(entry('p1', root));
    expect(p?.issues).toHaveLength(1);
    expect(p?.tilesets).toBeNull();
    expect(await read(entry('x', join(dir, 'missing')))).toBeNull();
    expect(
      await read(
        entry('pkg', join(dir, 'x.aio'), { package: { encrypted: true, readOnly: true } }),
      ),
    ).toBeNull();
  });

  it('lists the kit-pyramid rasters of a project, in manifest order, with the frame', () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const m = manifest({
      layers: [
        {
          kind: 'raster',
          id: 'ortho',
          name: 'Ortho March',
          visible: true,
          src: { path: 'packs/ortho/tiles.json' },
          role: 'ortho',
          format: 'kit-pyramid',
          capture: 'c1',
        },
        {
          kind: 'raster',
          id: 'dsm',
          name: 'DSM',
          visible: true,
          src: { path: 'packs/dsm/tiles.json' },
          role: 'dsm',
          format: 'kit-pyramid',
        },
        {
          kind: 'raster',
          id: 'heat',
          name: 'Change heat',
          visible: true,
          src: { path: 'change/c1-c2/tiles.json' },
          role: 'plan',
          format: 'kit-pyramid',
          derived: { kind: 'change', from: 'c1', to: 'c2', changeId: 'ch1' },
        },
        {
          kind: 'raster',
          id: 'draft',
          name: 'Draft',
          visible: true,
          src: { path: 'drafts/tiles.json' },
          role: 'plan',
          format: 'kit-pyramid',
          derived: { kind: 'model', draft: true },
        },
        {
          kind: 'raster',
          id: 'cog',
          name: 'Cloud optimised',
          visible: true,
          src: { path: 'packs/ortho/ortho.tif' },
          role: 'ortho',
          format: 'cog',
        },
        {
          kind: 'raster',
          id: 'hashed',
          name: 'Content addressed',
          visible: true,
          src: { hash: 'a'.repeat(64) },
          role: 'ortho',
          format: 'kit-pyramid',
        },
        {
          kind: 'mesh',
          id: 'mesh',
          name: 'Mesh',
          visible: true,
          src: { path: 'mesh/tileset.json' },
          transform: identity,
        },
      ],
    });
    expect(globeRastersOf(m.layers)).toEqual([
      {
        layerId: 'ortho',
        name: 'Ortho March',
        role: 'ortho',
        src: 'packs/ortho/tiles.json',
        capture: 'c1',
      },
      { layerId: 'dsm', name: 'DSM', role: 'dsm', src: 'packs/dsm/tiles.json' },
      {
        layerId: 'heat',
        name: 'Change heat',
        role: 'plan',
        src: 'change/c1-c2/tiles.json',
        change: true,
      },
    ]);
    const site = siteOf('p1', { manifest: m, issues: [], tilesets: null });
    expect(site?.frame).toEqual({ crs: { epsg: 32639 }, origin: [745_000, 3_245_000, 12] });
    expect(site?.rasters).toHaveLength(3);
  });

  it('leaves rasters out of a site with none, and does not place a local-grid project', () => {
    const site = siteOf('p1', { manifest: manifest(), issues: [], tilesets: null });
    expect(site?.frame).toEqual({ crs: { epsg: 32639 }, origin: [745_000, 3_245_000, 12] });
    expect(site?.rasters).toBeUndefined();
    const local = siteOf('l1', {
      manifest: manifest({ crs: { wkt: 'LOCAL_CS["Site grid",UNIT["metre",1]]' } }),
      issues: [],
      tilesets: null,
    });
    expect(local).toBeNull();
  });
});

describe('globe reads an open package', () => {
  async function opened(extra: Record<string, string>) {
    const root = join(dir, 'proj');
    await mkdir(root);
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest()));
    await writeFile(
      join(root, 'issues.json'),
      JSON.stringify({ schema: 'aio.issues/1', issues: [issue('i1', 2, 'draft')] }),
    );
    for (const [k, v] of Object.entries(extra)) await writeFile(join(root, k), v);
    const out = join(dir, 'p.aio');
    await exportPackage({
      root,
      out,
      manifest: manifest(),
      exclude: [],
      header: { readOnly: true, aiPolicy: 'forbid', exports: ['issues-csv'] },
    });
    const archive = await openZip(out);
    return globeProjectReader({
      package: () => ({ archive, manifest: manifest() }) as never,
    });
  }
  const tilesets = JSON.stringify({
    schema: 'aio.tilesets/1',
    entries: [
      { id: 'mesh-1', name: 'Mesh', kind: 'mesh', src: 'tiles/mesh-1/tileset.json', visible: true },
    ],
  });

  it('reads issues.json and tilesets.json from the package', async () => {
    const read = await opened({ 'tilesets.json': tilesets });
    const p = await read(
      entry('p1', join(dir, 'p.aio'), { package: { encrypted: false, readOnly: true } }),
    );
    expect(p?.issues).toHaveLength(1);
    expect(p?.tilesets?.entries[0]?.id).toBe('mesh-1');
  });

  it('answers null tilesets when the member is missing or invalid', async () => {
    const e = entry('p1', join(dir, 'p.aio'), { package: { encrypted: false, readOnly: true } });
    expect((await (await opened({}))(e))?.tilesets).toBeNull();
    await rm(join(dir, 'p.aio'), { force: true });
    await rm(join(dir, 'proj'), { recursive: true, force: true });
    expect((await (await opened({ 'tilesets.json': '{nope' }))(e))?.tilesets).toBeNull();
  });
});

describe('raster packs and Globe settings', () => {
  const meta = (id: string, kind: 'imagery' | 'terrain') => ({
    schema: 'aio.raster-pack/1',
    id,
    kind,
    label: id,
    bbox: [46, 22, 57, 31],
    minZoom: 0,
    maxZoom: 10,
    tileSize: 256,
    format: kind === 'imagery' ? 'webp' : 'png',
    ...(kind === 'terrain' ? { encoding: 'terrarium', verticalDatum: 'egm2008' } : {}),
    licence: 'CC0-1.0',
    attribution: 'Synthetic test pack',
    customerLicence: false,
    builtAt: '2026-10-07T00:00:00.000Z',
  });

  it("lists the installed packs through G7's raster pack lister", async () => {
    const img = join(dir, 'packs', 'imagery');
    await mkdir(img, { recursive: true });
    await writeFile(join(img, 'gcc.json'), JSON.stringify(meta('gcc', 'imagery')));
    await writeFile(join(img, 'gcc.pmtiles'), Buffer.alloc(1234));
    const ipc = collectHandlers((handle) => {
      registerGlobeIpc({
        handle,
        library: () => Promise.resolve([]),
        readProject: () => Promise.resolve(null),
        dataRoot: () => Promise.resolve(dir),
        settingsFile: join(dir, 'globe.json'),
      });
    });
    expect(await ipc.call('globe:packs', {})).toMatchObject({
      ok: true,
      imagery: [{ id: 'gcc', sizeBytes: 1234, attribution: 'Synthetic test pack' }],
      terrain: [],
    });
  });

  it('lists the packs of open packages after the installed ones', async () => {
    const img = join(dir, 'packs', 'imagery');
    await mkdir(img, { recursive: true });
    await writeFile(join(img, 'gcc.json'), JSON.stringify(meta('gcc', 'imagery')));
    await writeFile(join(img, 'gcc.pmtiles'), Buffer.alloc(10));
    const ipc = collectHandlers((handle) => {
      registerGlobeIpc({
        handle,
        library: () => Promise.resolve([]),
        readProject: () => Promise.resolve(null),
        dataRoot: () => Promise.resolve(dir),
        settingsFile: join(dir, 'globe.json'),
        packageRasterPacks: (kind) =>
          Promise.resolve(
            kind === 'imagery'
              ? [{ ...meta('pkg-p1-site', 'imagery'), sizeBytes: 5, source: 'package' as const }]
              : [],
          ) as never,
      });
    });
    const r = await ipc.call('globe:packs', {});
    expect(r).toMatchObject({ ok: true });
    expect((r as { imagery: { id: string }[] }).imagery.map((p) => p.id)).toEqual([
      'gcc',
      'pkg-p1-site',
    ]);
  });

  it('falls back to the installed packs when listing package packs throws', async () => {
    const img = join(dir, 'packs', 'imagery');
    await mkdir(img, { recursive: true });
    await writeFile(join(img, 'gcc.json'), JSON.stringify(meta('gcc', 'imagery')));
    await writeFile(join(img, 'gcc.pmtiles'), Buffer.alloc(10));
    const ipc = collectHandlers((handle) => {
      registerGlobeIpc({
        handle,
        library: () => Promise.resolve([]),
        readProject: () => Promise.resolve(null),
        dataRoot: () => Promise.resolve(dir),
        settingsFile: join(dir, 'globe.json'),
        packageRasterPacks: () => Promise.reject(new Error('damaged package')),
      });
    });
    const r = await ipc.call('globe:packs', {});
    expect(r).toMatchObject({ ok: true, terrain: [] });
    expect((r as { imagery: { id: string }[] }).imagery.map((p) => p.id)).toEqual(['gcc']);
  });

  it('logs a failing package pack listing once, not on every call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const ipc = collectHandlers((handle) => {
        registerGlobeIpc({
          handle,
          library: () => Promise.resolve([]),
          readProject: () => Promise.resolve(null),
          dataRoot: () => Promise.resolve(dir),
          settingsFile: join(dir, 'globe.json'),
          packageRasterPacks: () => Promise.reject(new Error('damaged package')),
        });
      });
      await ipc.call('globe:packs', {});
      await ipc.call('globe:packs', {});
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('damaged package');
    } finally {
      warn.mockRestore();
    }
  });

  it('answers every channel: sites, packs, and settings saved in globe.json', async () => {
    const file = join(dir, 'globe.json');
    const ipc = collectHandlers((handle) => {
      registerGlobeIpc({
        handle,
        library: () => Promise.resolve([entry('a', 'A')]),
        readProject: () => Promise.resolve({ manifest: manifest(), issues: [], tilesets: null }),
        dataRoot: () => Promise.resolve(dir),
        settingsFile: file,
      });
    });
    expect(ipc.channels()).toEqual([
      'globe:getSettings',
      'globe:packs',
      'globe:setSettings',
      'globe:sites',
    ]);
    expect(await ipc.call('globe:sites', {})).toMatchObject({
      ok: true,
      sites: [{ projectId: 'a' }],
    });
    expect(await ipc.call('globe:packs', {})).toEqual({ ok: true, imagery: [], terrain: [] });
    expect(await ipc.call('globe:getSettings', {})).toMatchObject({
      ok: true,
      settings: { schema: 'aio.globe-settings/1', imagery: 'auto', terrain: 'auto' },
    });
    const settings = {
      schema: 'aio.globe-settings/1' as const,
      terrain: 'off' as const,
      showIssues: false,
    };
    expect(await ipc.call('globe:setSettings', { settings })).toEqual({ ok: true });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject(settings);
    expect(await ipc.call('globe:getSettings', {})).toMatchObject({ ok: true, settings });
    await writeFile(file, '{"schema":"aio.globe-settings/9"}');
    expect(await ipc.call('globe:getSettings', {})).toMatchObject({
      settings: { imagery: 'auto' },
    });
  });
});
