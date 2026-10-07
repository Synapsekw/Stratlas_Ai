import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AccuracyReport,
  GcpFile,
  GlobeSettings,
  HardwareProbe,
  LAYER_KINDS,
  Layer,
  LayerDerived,
  MapPackInfo,
  PIPELINES,
  PhotoRun,
  PipelineName,
  RasterPackInfo,
  RasterPackMeta,
  SCHEMA_REGISTRY,
  Settings,
  TilesetsFile,
  defaultGlobeSettings,
  emptyTilesets,
  ipc,
  keepUnknownLayers,
  parseManifest,
  parseManifestTolerant,
  photoRunDir,
  pipelineParams,
  unknownLayersOf,
  type ProjectManifest,
} from './index';

/** Keys of an object schema (sorted). */
const keysOf = (schema: z.ZodType): string[] => Object.keys((schema as z.ZodObject).shape).sort();

const NOW = '2026-10-07T09:00:00Z';

function manifest(): ProjectManifest {
  return {
    schema: 'aio.project/1',
    id: 'demo-quarry',
    name: 'Demo quarry',
    crs: { epsg: 32639 },
    origin: [500000, 2900000, 0],
    captures: [{ id: 'c1', label: 'Survey 1', date: '2026-09-01' }],
    layers: [
      {
        kind: 'mesh',
        id: 'site',
        name: 'Site model',
        visible: true,
        src: { path: 'models/site.glb' },
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
    ],
    severityModels: [],
    classCatalogues: [],
  };
}

const NEWER_LAYER = {
  kind: 'gaussian-splat',
  id: 'splat-1',
  name: 'Splat from a newer build',
  visible: true,
  src: { path: 'splats/site.spz' },
  later: { nested: [1, 'ü', null] },
};

describe('M10 additive rule: no layer kind, raster format, derived kind or record field', () => {
  // Pinned at 0.9.0. A new value here makes an 0.9 build refuse the whole manifest (plan, "Global
  // constraints"); M10's outputs use these kinds and record their provenance in run.json instead.
  it('keeps the 0.9 layer kinds, raster formats and derived kinds', () => {
    expect([...LAYER_KINDS].sort()).toEqual(
      [
        'basemap',
        'legacy',
        'mesh',
        'panoramas',
        'photos',
        'pointcloud',
        'raster',
        'vector',
        'video',
      ].sort(),
    );
    const enumOf = (kind: string, field: string): unknown => {
      const option = Layer.options.find((o) => o.shape.kind.value === kind);
      const shape = option?.shape as Record<string, z.ZodEnum> | undefined;
      return shape?.[field]?.options;
    };
    expect(enumOf('raster', 'format')).toEqual(['cog', 'pmtiles', 'kit-pyramid', 'image']);
    expect(enumOf('raster', 'role')).toEqual(['ortho', 'dsm', 'plan']);
    expect(enumOf('pointcloud', 'format')).toEqual(['copc', 'potree2', 'kit-packed', 'png-packed']);
    expect(LayerDerived.shape.kind.options).toEqual(['change', 'model']);
  });

  it('keeps the 0.9 key sets of Settings and MapPackInfo (globe settings and raster packs have their own files)', () => {
    expect(keysOf(Settings)).toEqual(
      [
        'anthropicWorkspaceId',
        'change',
        'cloudAi',
        'contrast',
        'dataRoot',
        'direction',
        'inference',
        'localModel',
        'motion',
        'offlineOnly',
        'reportBranding',
        'reportContents',
        'routes',
        'sidebarCollapsed',
        'team',
        'theme',
        'updateCheck',
        'updateUrl',
      ].sort(),
    );
    expect(keysOf(MapPackInfo)).toEqual(
      ['bbox', 'build', 'builtAt', 'id', 'label', 'maxZoom', 'sizeBytes', 'source'].sort(),
    );
  });

  it('registers every new file schema', () => {
    const m10 = SCHEMA_REGISTRY.filter((e) => e.since === '0.10').map((e) => e.family);
    expect(m10.sort()).toEqual(
      [
        'aio.gcp',
        'aio.globe-settings',
        'aio.photo-accuracy',
        'aio.photo-run',
        'aio.raster-pack',
        'aio.tilesets',
      ].sort(),
    );
  });
});

describe('manifest reading tolerates layer kinds of a newer build', () => {
  it('opens the project without the unknown layer and reports it', () => {
    const raw = { ...manifest(), layers: [...manifest().layers, NEWER_LAYER] };
    const r = parseManifestTolerant(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.manifest.layers.map((l) => l.id)).toEqual(['site']);
    expect(r.value.unknownLayers).toEqual([NEWER_LAYER]);
    expect(parseManifest(raw)).toEqual({ ok: true, value: manifest() });
    expect(unknownLayersOf(raw)).toEqual([NEWER_LAYER]);
  });

  it('keeps the unknown layer on save, unchanged and after the known ones', () => {
    const before = { ...manifest(), layers: [NEWER_LAYER, ...manifest().layers] };
    const next = manifest();
    next.layers.push({
      kind: 'raster',
      id: 'ortho-1',
      name: 'Ortho',
      visible: true,
      src: { path: 'rasters/ortho-1' },
      role: 'ortho',
      format: 'kit-pyramid',
    });
    const kept = keepUnknownLayers(before, next);
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.value.layers.map((l) => (l as { id: string }).id)).toEqual([
      'site',
      'ortho-1',
      'splat-1',
    ]);
    expect(kept.value.layers[2]).toEqual(NEWER_LAYER);
    expect(keepUnknownLayers(undefined, next)).toEqual({ ok: true, value: next });
  });

  it('refuses a new layer that takes the id of an unknown one, and duplicate ids across both', () => {
    const before = { ...manifest(), layers: [...manifest().layers, NEWER_LAYER] };
    const next = manifest();
    next.layers.push({
      kind: 'mesh',
      id: 'splat-1',
      name: 'Another model',
      visible: true,
      src: { path: 'models/other.glb' },
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    });
    const kept = keepUnknownLayers(before, next);
    expect(kept.ok).toBe(false);
    if (!kept.ok) expect(kept.error).toMatch(/used by a layer from a newer version of Quadrion AI/);
    const dup = parseManifest({
      ...manifest(),
      layers: [...manifest().layers, { ...NEWER_LAYER, id: 'site' }],
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain('Duplicate id "site" in layers');
  });

  it('still refuses a bad known layer, an unknown layer without an id, and a newer manifest', () => {
    const bad = { ...manifest(), layers: [{ ...manifest().layers[0], transform: [1] }] };
    expect(parseManifest(bad).ok).toBe(false);
    const noId = { ...manifest(), layers: [{ kind: 'gaussian-splat', name: 'x' }] };
    expect(parseManifest(noId).ok).toBe(false);
    expect(parseManifest({ ...manifest(), schema: 'aio.project/2' })).toEqual({
      ok: false,
      error:
        'Project was saved by a newer version of Quadrion AI (schema aio.project/2). Update the app to open it.',
    });
  });
});

// ---------------------------------------------------------------- new files

const camera = {
  id: 'cam-1',
  make: 'Stratlas Synthetic',
  model: 'SYN-20',
  widthPx: 1600,
  heightPx: 1200,
  photos: 60,
};

const RUN = {
  schema: 'aio.photo-run/1',
  id: '20261007-0900',
  createdAt: NOW,
  status: 'aligned',
  preset: 'standard',
  photos: {
    source: { layer: 'photos' },
    count: 60,
    registered: 58,
    rejected: [{ name: 'IMG_0007.JPG', reason: 'Motion blur' }],
  },
  cameras: [camera],
  crs: { epsg: 32639 },
  heights: { source: 'ellipsoidal', geoid: 'egm2008' },
  stages: [{ name: 'inspect', state: 'done', seconds: 3 }],
  outputs: { layers: [], tilesets: [], files: ['photogrammetry/20261007-0900/sparse/'] },
  versions: { pack: '0.4.0', colmap: '4.2.1' },
} as const;

describe('photogrammetry files', () => {
  it('reads a run.json and keeps keys a later build adds', () => {
    const r = PhotoRun.parse({ ...RUN, laterField: { x: 1 } });
    expect((r as Record<string, unknown>).laterField).toEqual({ x: 1 });
    expect(photoRunDir(RUN.id)).toBe('photogrammetry/20261007-0900');
    expect(PhotoRun.safeParse({ ...RUN, id: '../escape' }).success).toBe(false);
    expect(
      PhotoRun.safeParse({ ...RUN, outputs: { ...RUN.outputs, files: ['C:/elsewhere/x.tif'] } })
        .success,
    ).toBe(false);
  });

  it('reads gcp.json, refuses duplicate points and keeps draft, confirmed and skipped marks', () => {
    const point = (id: string, role: 'control' | 'check') => ({
      id,
      role,
      xyz: [500010, 2900020, 12.5],
      accuracy: { horizontalM: 0.02, verticalM: 0.03 },
      marks: [
        { photo: 'IMG_0001.JPG', px: [812.5, 401.25], by: 'detector', at: NOW, state: 'draft' },
        { photo: 'IMG_0002.JPG', px: [790, 433], by: 'person', at: NOW, state: 'confirmed' },
        { photo: 'IMG_0003.JPG', px: [0, 0], by: 'person', at: NOW, state: 'skipped' },
      ],
    });
    const gcp = {
      schema: 'aio.gcp/1',
      crs: { epsg: 32639 },
      points: [point('GCP1', 'control'), point('CHK1', 'check')],
    };
    expect(GcpFile.parse(gcp)).toEqual(gcp);
    const dup = GcpFile.safeParse({
      ...gcp,
      points: [point('GCP1', 'control'), point('GCP1', 'check')],
    });
    expect(dup.success).toBe(false);
  });

  it('accuracy reports always say checkpoints were not in the adjustment', () => {
    const report = {
      schema: 'aio.photo-accuracy/1',
      run: RUN.id,
      createdAt: NOW,
      crs: { epsg: 32639 },
      images: { total: 60, registered: 58 },
      meanReprojPx: 0.61,
      points: [
        { id: 'CHK1', role: 'check', dxM: 0.01, dyM: -0.02, dzM: 0.03, reprojPx: 0.5, marks: 4 },
      ],
      rmse: { check: { n: 1, horizontalM: 0.022, verticalM: 0.03 } },
      checkpointsInAdjustment: false,
      warnings: [{ code: 'gcp-outlier', message: 'GCP 6 is 0.98 m off.', point: 'GCP6' }],
    };
    expect(AccuracyReport.safeParse(report).success).toBe(true);
    expect(AccuracyReport.safeParse({ ...report, checkpointsInAdjustment: true }).success).toBe(
      false,
    );
  });

  it('a hardware probe says why processing cannot run', () => {
    const probe = {
      platform: 'darwin',
      arch: 'x64',
      cpu: { model: 'Test CPU', cores: 8 },
      memoryBytes: 16 * 2 ** 30,
      freeDiskBytes: 200 * 2 ** 30,
      gpus: [],
      cuda: false,
      processing: 'unsupported-platform',
    };
    expect(HardwareProbe.safeParse(probe).success).toBe(true);
  });
});

describe('tilesets.json', () => {
  it('lists tilesets inside the project and refuses duplicates and paths outside it', () => {
    const entry = {
      id: 'mesh-full',
      name: 'Processed mesh',
      kind: 'mesh',
      src: 'tiles/mesh-full/tileset.json',
      run: RUN.id,
      visible: true,
    };
    expect(TilesetsFile.parse({ schema: 'aio.tilesets/1', entries: [entry] }).entries).toHaveLength(
      1,
    );
    expect(
      TilesetsFile.safeParse({ schema: 'aio.tilesets/1', entries: [entry, entry] }).success,
    ).toBe(false);
    expect(
      TilesetsFile.safeParse({
        schema: 'aio.tilesets/1',
        entries: [{ ...entry, src: '../x/tileset.json' }],
      }).success,
    ).toBe(false);
    expect(TilesetsFile.parse(emptyTilesets())).toEqual({ schema: 'aio.tilesets/1', entries: [] });
  });
});

describe('raster packs and globe settings', () => {
  const imagery = {
    schema: 'aio.raster-pack/1',
    id: 'synthetic-imagery',
    kind: 'imagery',
    label: 'Synthetic imagery',
    bbox: [49.9, 26.1, 50.1, 26.3],
    minZoom: 0,
    maxZoom: 16,
    tileSize: 512,
    format: 'webp',
    licence: 'CC0-1.0',
    attribution: 'CC0 test fixture',
    customerLicence: false,
    builtAt: NOW,
  };

  it('needs a height encoding and datum on terrain, and none on imagery', () => {
    expect(RasterPackMeta.safeParse(imagery).success).toBe(true);
    expect(RasterPackMeta.safeParse({ ...imagery, encoding: 'terrarium' }).success).toBe(false);
    const terrain = { ...imagery, id: 'synthetic-dem', kind: 'terrain', format: 'png' };
    expect(RasterPackMeta.safeParse(terrain).success).toBe(false);
    expect(
      RasterPackMeta.safeParse({ ...terrain, encoding: 'terrarium', verticalDatum: 'egm2008' })
        .success,
    ).toBe(true);
    const info = { ...imagery, schema: undefined };
    expect(RasterPackInfo.safeParse({ ...info, sizeBytes: 1024, source: 'import' }).success).toBe(
      true,
    );
  });

  it('globe settings default to the best covering packs', () => {
    expect(GlobeSettings.parse(defaultGlobeSettings())).toEqual(defaultGlobeSettings());
    expect(
      GlobeSettings.safeParse({ schema: 'aio.globe-settings/1', terrainExaggeration: 9 }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------- pipelines and channels

/** Smallest valid parameters of each M10 pipeline (the Python stubs test the same names). */
const M10_PARAMS = {
  'photo.align': { photos: { layer: 'photos' }, preset: 'standard' },
  'photo.georef': { run: RUN.id },
  'photo.products': { run: RUN.id, products: ['ortho', 'dsm'] },
  'opf.import': { src: 'D:/in/project.opf' },
  'opf.export': { run: RUN.id, out: 'D:/out/opf' },
  'tiles.mesh': { layer: 'mesh-1' },
  'tiles.cloud': { layer: 'cloud-1' },
  'packs.imagery': {
    src: ['D:/in/ortho.tif'],
    dest: 'D:/data/packs/imagery',
    id: 'site-imagery',
    label: 'Site imagery',
    licence: 'customer',
    attribution: 'Customer imagery',
    customerLicence: true,
  },
  'packs.terrain': {
    src: ['D:/in/dem.tif'],
    dest: 'D:/data/packs/terrain',
    id: 'site-dem',
    label: 'Site terrain',
    licence: 'CC0-1.0',
    attribution: 'CC0 test fixture',
    verticalDatum: 'egm2008',
  },
} as const satisfies Partial<Record<PipelineName, Record<string, unknown>>>;

describe('M10 pipelines', () => {
  it('names every pipeline with a title, and parses its smallest parameters', () => {
    for (const [name, params] of Object.entries(M10_PARAMS)) {
      const pipeline = PipelineName.parse(name);
      expect(PIPELINES.find((p) => p.name === pipeline)?.title).toBeTruthy();
      const r = pipelineParams(pipeline).safeParse(params);
      expect(r.success, `${name}: ${r.success ? '' : r.error.message}`).toBe(true);
      expect(pipelineParams(pipeline).safeParse({ ...params, bogus: 1 }).success).toBe(false);
    }
  });

  it('checks paths and choices before Python starts', () => {
    expect(
      pipelineParams('photo.align').safeParse({ photos: { layer: 'p' }, preset: 'ultra' }).success,
    ).toBe(false);
    expect(pipelineParams('photo.products').safeParse({ run: RUN.id, products: [] }).success).toBe(
      false,
    );
    expect(
      pipelineParams('photo.georef').safeParse({ run: RUN.id, gcp: '../gcp.json' }).success,
    ).toBe(false);
    expect(
      pipelineParams('tiles.mesh').safeParse({ layer: 'a', src: 'models/a.glb' }).success,
    ).toBe(false);
    expect(pipelineParams('tiles.mesh').safeParse({}).success).toBe(false);
  });
});

describe('M10 IPC channels', () => {
  const channels = [
    'photo:probe',
    'photo:estimate',
    'photo:runs',
    'photo:readRun',
    'photo:readGcp',
    'photo:writeGcp',
    'photo:applyPoses',
    'photo:cleanWork',
    'globe:sites',
    'globe:packs',
    'globe:getSettings',
    'globe:setSettings',
    'tilesets:list',
    'tilesets:write',
    'imageryPacks:list',
    'imageryPacks:import',
    'imageryPacks:remove',
    'terrainPacks:list',
    'terrainPacks:import',
    'terrainPacks:remove',
  ] as const;

  it('declares every channel, each able to answer a typed not-implemented', () => {
    for (const c of channels) {
      expect(Object.keys(ipc)).toContain(c);
      const r = ipc[c].response.safeParse({ ok: false, error: 'x', code: 'not-implemented' });
      expect(r.success, c).toBe(true);
    }
    expect(Object.keys(ipc).filter((c) => c.startsWith('odm:'))).toEqual([]);
  });
});
