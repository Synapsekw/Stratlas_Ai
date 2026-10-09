import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  Alignment,
  ComparisonItem,
  CustomBase,
  DesignsFile,
  ENTITLEMENTS,
  EXPORT_FORMATS,
  EXPORT_FORMAT_KIND,
  GeoidPackMeta,
  ImportItem,
  HeightTiles,
  LAYER_KINDS,
  Layer,
  MeasurementsFile,
  OP_KINDS,
  OP_PAYLOADS,
  OP_PERMISSION,
  PIPELINES,
  PipelineName,
  ProjectType,
  RECORD_KINDS,
  REPORT_SECTIONS,
  SCHEMA_REGISTRY,
  Settings,
  SiteCalibration,
  SiteTransform,
  SurveyDefaults,
  SurveyOverlaysFile,
  SurveyQa,
  SurveySettings,
  SurveyTemplatesFile,
  TerrainEditsFile,
  TinHeader,
  can,
  defaultSurveySettings,
  emptyDesigns,
  emptyMeasurements,
  emptySurveyTemplates,
  ipc,
  isKnownOpKind,
  pipelineParams,
  type OpKind,
} from './index';

/** Keys of an object schema (sorted). */
const keysOf = (schema: z.ZodType): string[] => Object.keys((schema as z.ZodObject).shape).sort();

/** Absolute on the machine running the tests ("D:/..." is not absolute on macOS). */
const abs = (...parts: string[]): string => resolve(sep, ...parts);

const NOW = '2026-10-08T09:00:00Z';
const SHA = 'a'.repeat(64);

describe('M11 additive rule: no layer kind, raster role, project type, setting or report section', () => {
  // Pinned at 0.10.0. Survey data lives in `<project>/survey/` and new userData files instead
  // (plan "Global constraints"); a new value here would make an 0.10 build refuse the file.
  it('keeps the 0.10 layer kinds and raster roles', () => {
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
    const raster = Layer.options.find((o) => o.shape.kind.value === 'raster');
    const role = (raster?.shape as Record<string, z.ZodEnum> | undefined)?.role;
    expect(role?.options).toEqual(['ortho', 'dsm', 'plan']);
  });

  it('keeps the 0.10 project types and report sections, plus exactly the four of G9', () => {
    expect(ProjectType.options).toEqual(['inspection', 'volumetric', 'road', 'twin', 'fusion']);
    // G9 (not G0): the survey sections. `ReportContentsSettings` is strict over these ids, so
    // settings keep them in `reportSectionsExtra`, which 0.10 carries over without reading.
    expect([...REPORT_SECTIONS]).toEqual([
      'contents',
      'summary',
      'scope',
      'site',
      'statistics',
      'register',
      'issues',
      'appendices',
      'audit',
      'approvals',
      'processing',
      'measurements',
      'earthworks',
      'stockpiles',
      'landfill',
    ]);
  });

  it('adds exactly the three G9 export formats, under existing package export kinds', () => {
    expect(EXPORT_FORMATS.slice(-3)).toEqual([
      'measurements-csv',
      'stockpile-csv',
      'survey-report-pdf',
    ]);
    expect(EXPORT_FORMATS).toHaveLength(13);
    expect(EXPORT_FORMAT_KIND['measurements-csv']).toBe('files');
    expect(EXPORT_FORMAT_KIND['stockpile-csv']).toBe('files');
    expect(EXPORT_FORMAT_KIND['survey-report-pdf']).toBe('report-pdf');
  });

  it('keeps the 0.10 Settings keys (survey defaults are their own userData file)', () => {
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
  });

  it('registers every new file schema since 0.11', () => {
    const m11 = SCHEMA_REGISTRY.filter((e) => e.since === '0.11').map((e) => e.family);
    expect(m11.sort()).toEqual(
      [
        'aio.alignment',
        'aio.designs',
        'aio.geoid-pack',
        'aio.height-tiles',
        'aio.measurements',
        'aio.site-calibration',
        'aio.site-transform',
        'aio.survey-compare',
        'aio.survey-defaults',
        'aio.survey-overlays',
        'aio.survey-qa',
        'aio.survey-settings',
        'aio.survey-templates',
        'aio.terrain-edits',
        'aio.tin',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------- new files

const volumeItem = {
  id: 'cmp-1',
  from: { kind: 'previous' },
  to: { kind: 'current' },
  useDeadband: false,
};

const measurement = (id: string) => ({
  id,
  family: 'polygon',
  tool: 'volume',
  label: 'Stockpile A',
  scope: { kind: 'survey', capture: 'c1' },
  points: [
    [500000, 2900000, 10],
    [500020, 2900000, 10.5],
    [500020, 2900020, 11],
  ],
  items: [volumeItem],
  results: [
    {
      item: 'cmp-1',
      status: 'ok',
      cutM3: 12.5,
      fillM3: 40,
      netM3: 27.5,
      totalM3: 52.5,
      areaM2: 200,
      areaCutM2: 60,
      areaFillM2: 120,
      areaUnchangedM2: 20,
      uncoveredM2: 0,
      fromLabel: 'Survey 1',
      toLabel: 'Survey 2',
      fromCapture: 'c1',
      toCapture: 'c2',
      deadbandM: 0,
      usedDeadband: false,
      cellM: 0.1,
      engine: 'ts',
      fingerprint: 'fp-1',
      computedAt: NOW,
    },
  ],
  createdAt: NOW,
});

describe('survey files', () => {
  it('reads site settings, their defaults and the userData survey defaults', () => {
    expect(SurveySettings.parse(defaultSurveySettings())).toEqual(defaultSurveySettings());
    const geoid = {
      ...defaultSurveySettings(),
      crs: { epsg: 32639 },
      verticalDatum: { kind: 'geoid', epsg: 3855, geoid: 'egm2008' },
      calibration: 'cal-1',
      units: { ...defaultSurveySettings().units, distance: 'us-ft' },
    };
    expect(SurveySettings.safeParse(geoid).success).toBe(true);
    expect(
      SurveySettings.safeParse({ ...geoid, units: { ...geoid.units, distance: 'furlong' } })
        .success,
    ).toBe(false);
    expect(
      SurveyDefaults.safeParse({ schema: 'aio.survey-defaults/1', order: 'ENZ' }).success,
    ).toBe(true);
  });

  it('reads measurements.json and refuses duplicate ids', () => {
    expect(MeasurementsFile.parse(emptyMeasurements())).toEqual(emptyMeasurements());
    const file = { schema: 'aio.measurements/1', measurements: [measurement('m-1')] };
    expect(MeasurementsFile.parse(file)).toEqual(file);
    const dup = MeasurementsFile.safeParse({
      ...file,
      measurements: [measurement('m-1'), measurement('m-1')],
    });
    expect(dup.success).toBe(false);
    if (!dup.success)
      expect(dup.error.issues.map((i) => i.message)).toContain('Duplicate measurement "m-1"');
  });

  it('refuses a typed reference level without levelM and a custom vertex with z and offsetM', () => {
    const level = { kind: 'reference', mode: 'level' };
    expect(ComparisonItem.safeParse({ ...volumeItem, from: level }).success).toBe(false);
    expect(
      ComparisonItem.safeParse({ ...volumeItem, from: { ...level, levelM: 12.5 } }).success,
    ).toBe(true);
    expect(
      ComparisonItem.safeParse({
        ...volumeItem,
        from: { kind: 'reference', mode: 'perimeter-min' },
      }).success,
    ).toBe(true);
    const vertices = [
      { e: 0, n: 0, z: 10 },
      { e: 10, n: 0, offsetM: -0.5 },
      { e: 10, n: 10, z: 11 },
    ];
    expect(CustomBase.safeParse({ kind: 'custom', vertices }).success).toBe(true);
    expect(
      CustomBase.safeParse({
        kind: 'custom',
        vertices: [...vertices, { e: 0, n: 10, z: 1, offsetM: 1 }],
      }).success,
    ).toBe(false);
    expect(
      CustomBase.safeParse({ kind: 'custom', vertices: [...vertices, { e: 0, n: 10 }] }).success,
    ).toBe(false);
  });

  it('refuses a comparison with a base on both sides (a base is sampled on the other side)', () => {
    const smart = { kind: 'smart' };
    expect(
      ComparisonItem.safeParse({ ...volumeItem, from: smart, to: { kind: 'current' } }).success,
    ).toBe(true);
    expect(
      ComparisonItem.safeParse({ ...volumeItem, from: smart, to: { kind: 'fit-plane' } }).success,
    ).toBe(false);
  });

  it('reads templates, prepared height tiles, overlays, cleanups and QA', () => {
    expect(SurveyTemplatesFile.parse(emptySurveyTemplates())).toEqual(emptySurveyTemplates());
    const templates = {
      schema: 'aio.survey-templates/1',
      templates: [
        {
          id: 'stockpile',
          name: 'Stockpile',
          family: 'polygon',
          tool: 'volume',
          items: ['cut', 'fill', 'net'],
          fields: [{ id: 'material', name: 'Material', type: 'dropdown', options: ['Sand'] }],
          comparisons: [{ from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
          set: 'mining',
        },
      ],
    };
    expect(SurveyTemplatesFile.safeParse(templates).success).toBe(true);

    const tiles = {
      schema: 'aio.height-tiles/1',
      id: 'dsm-1',
      name: 'DSM',
      source: { kind: 'dsm', layer: 'dsm' },
      capture: 'c1',
      crs: { epsg: 32639 },
      cellM: 0.1,
      tileSize: 256,
      originE: 500000,
      originN: 2900000,
      cols: 4,
      rows: 3,
      levels: 3,
      bounds: [500000, 2900000, 5, 500102.4, 2900076.8, 31],
      tiles: ['0_0', '1_0', '3_2'],
      fingerprint: 'fp-dsm',
      preparedAt: NOW,
    };
    expect(HeightTiles.safeParse(tiles).success).toBe(true);
    expect(HeightTiles.safeParse({ ...tiles, tileSize: 512 }).success).toBe(false);

    const overlays = {
      schema: 'aio.survey-overlays/1',
      overlays: [
        {
          id: 'contours-1',
          name: 'Contours 0.5 m',
          kind: 'contours',
          source: { surface: 'dsm-1' },
          options: { minorM: 0.5, majorM: 2.5 },
          dir: 'survey/overlays/contours-1',
          visible: true,
          fingerprint: 'fp-ov',
          createdAt: NOW,
        },
      ],
    };
    expect(SurveyOverlaysFile.safeParse(overlays).success).toBe(true);

    const edits = {
      schema: 'aio.terrain-edits/1',
      edits: [
        {
          id: 'e1',
          kind: 'cleanup',
          surface: 'dsm-1',
          ring: [
            [0, 0],
            [5, 0],
            [5, 5],
          ],
          method: 'tin',
          enabled: true,
          createdAt: NOW,
        },
      ],
    };
    expect(TerrainEditsFile.safeParse(edits).success).toBe(true);

    const qa = {
      schema: 'aio.survey-qa/1',
      capture: 'c1',
      level: 'moderate',
      status: 'released',
      checkpoints: {
        count: 2,
        rmseM: 0.04,
        meanM: 0.01,
        maxAbsM: 0.05,
        points: [
          { name: 'CHK1', dz: 0.03 },
          { name: 'CHK2', dz: null },
        ],
      },
      hold: { at: NOW, reason: 'RMSE above 0.10 m' },
      release: { at: NOW, note: 'Checked against the GNSS log.' },
      checkedAt: NOW,
    };
    expect(SurveyQa.safeParse(qa).success).toBe(true);
    expect(SurveyQa.safeParse({ ...qa, release: { at: NOW, note: '' } }).success).toBe(false);
  });
});

describe('design files', () => {
  it('lets the Builder import list name a design (G6)', () => {
    expect(ImportItem.parse({ file: 'pad.xml', kind: 'design', status: 'queued' }).kind).toBe(
      'design',
    );
  });

  const design = (id: string) => ({
    id,
    name: 'Bulk earthworks',
    src: 'design.xml',
    sha256: SHA,
    bytes: 2048,
    format: 'landxml',
    units: 'm',
    crs: { epsg: 32639 },
    calibrated: false,
    importedAt: NOW,
    layers: [
      {
        id: 'fg',
        name: 'Finished ground',
        kind: 'surface',
        file: 'fg.tin',
        glb: 'fg.glb',
        counts: { triangles: 2, vertices: 4 },
        visible: true,
        archived: false,
        verticalOffsetM: -0.3,
      },
    ],
  });

  it('reads designs.json and refuses duplicate ids', () => {
    expect(DesignsFile.parse(emptyDesigns())).toEqual(emptyDesigns());
    const file = { schema: 'aio.designs/1', designs: [design('d1')], activeAlignment: 'd1/cl' };
    expect(DesignsFile.parse(file)).toEqual(file);
    const dup = DesignsFile.safeParse({ ...file, designs: [design('d1'), design('d1')] });
    expect(dup.success).toBe(false);
    if (!dup.success)
      expect(dup.error.issues.map((i) => i.message)).toContain('Duplicate design "d1"');
  });

  it('reads a TIN header and a horizontal alignment', () => {
    const tin = {
      schema: 'aio.tin/1',
      crs: { epsg: 32639 },
      bounds: [0, 0, 9, 10, 10, 11],
      vertexCount: 4,
      triangleCount: 2,
      verticesAt: 256,
      trianglesAt: 352,
    };
    expect(TinHeader.safeParse(tin).success).toBe(true);
    expect(TinHeader.safeParse({ ...tin, triangleCount: 2_000_001 }).success).toBe(false);
    const alignment = {
      schema: 'aio.alignment/1',
      name: 'Haul road CL',
      crs: { epsg: 32639 },
      startStation: 0,
      elements: [
        { type: 'line', start: [0, 0], end: [100, 0], length: 100 },
        {
          type: 'spiral',
          spiral: 'clothoid',
          start: [100, 0],
          end: [140, 2],
          radiusStart: null,
          radiusEnd: 200,
          rot: 'ccw',
          length: 40,
          dirStart: Math.PI / 2,
        },
        {
          type: 'arc',
          start: [140, 2],
          end: [180, 10],
          center: [130, 200],
          radius: 200,
          rot: 'ccw',
          length: 41,
        },
      ],
      equations: [{ back: 150, ahead: 200 }],
    };
    expect(Alignment.safeParse(alignment).success).toBe(true);
    expect(Alignment.safeParse({ ...alignment, elements: [] }).success).toBe(false);
  });
});

describe('geodesy files', () => {
  it('reads a site calibration, a site transform and a geoid pack', () => {
    const calibration = {
      schema: 'aio.site-calibration/1',
      id: 'cal-1',
      name: 'Site grid',
      source: { format: 'jobxml', file: 'survey/calibration/job.jxl', sha256: SHA },
      projection: { epsg: 32639 },
      geoid: 'egm2008',
      horizontal: {
        originE: 500000,
        originN: 2900000,
        shiftE: 1000,
        shiftN: 2000,
        rotationRad: 0.001,
        scale: 0.9996,
      },
      vertical: { originE: 500000, originN: 2900000, shiftM: 0.12, slopeN: 0, slopeE: 0 },
      pairs: [
        {
          name: 'CP1',
          local: [2000, 1000, 10],
          grid: [2900000, 500000, 10],
          useH: true,
          useV: true,
        },
      ],
      rmsH: 0.01,
      computedAt: NOW,
    };
    expect(SiteCalibration.safeParse(calibration).success).toBe(true);
    expect(
      SiteCalibration.safeParse({
        ...calibration,
        pairs: [{ name: 'CP1', local: [0, 0, 0], useH: true, useV: true }],
      }).success,
    ).toBe(false);

    const transform = {
      schema: 'aio.site-transform/1',
      from: { epsg: 32639 },
      to: { epsg: 32639 },
      operation: 'Inverse of UTM zone 39N + UTM zone 39N',
      geoid: 'egm2008',
      geoidGrid: {
        file: 'geoid.f64',
        originX: 500000,
        originY: 2900000,
        spacingM: 10,
        cols: 20,
        rows: 20,
        bands: 1,
      },
      fingerprint: 'fp-geo',
      writtenAt: NOW,
    };
    expect(SiteTransform.safeParse(transform).success).toBe(true);

    const pack = {
      schema: 'aio.geoid-pack/1',
      id: 'egm2008',
      name: 'EGM2008',
      bbox: [-180, -90, 180, 90],
      verticalEpsg: 3855,
      projFile: 'us_nga_egm08_25.tif',
      licence: 'Public domain',
      attribution: 'NGA',
      sha256: SHA,
      bytes: 1024,
    };
    expect(GeoidPackMeta.safeParse(pack).success).toBe(true);
    expect(GeoidPackMeta.safeParse({ ...pack, id: '../egm' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------- pipelines and channels

/** Smallest valid parameters of each M11 pipeline (python/tests/test_m11_params.py uses the same). */
const M11_PARAMS = {
  'survey.prepare': {
    surfaces: [{ id: 'dsm-1', name: 'DSM', source: { kind: 'dsm', layer: 'dsm' } }],
  },
  'survey.compare': { site: { from: { kind: 'previous' }, to: { kind: 'current' } } },
  'survey.overlay': { surface: 'dsm-1', kind: 'contours' },
  'survey.section': {
    line: [
      [0, 0],
      [10, 0],
    ],
    surfaces: [{ kind: 'current' }],
    format: 'csv',
    out: abs('out', 'section.csv'),
  },
  'survey.export': {
    what: 'surface',
    format: 'geotiff',
    crs: 'site',
    surface: 'dsm-1',
    out: abs('out', 'dsm.tif'),
  },
  'survey.qa': { capture: 'c1', surface: 'dsm-1', level: 'moderate' },
  'survey.cleanup': { surface: 'dsm-1', edits: ['e1'] },
  'design.import': { src: abs('in', 'design.xml') },
  'geo.calibration': { src: abs('in', 'job.jxl'), crs: { epsg: 32639 } },
  'hydro.flood': { surface: 'dsm-1', levelM: 10, mode: 'all-below' },
  'hydro.flow': { surface: 'dsm-1', mode: 'catchment' },
  'hydro.rainfall': {
    surface: 'dsm-1',
    hyetograph: abs('in', 'rain.csv'),
    manningN: 0.03,
    infiltrationMmPerH: 0,
    cellM: 1,
  },
  'haul.analyse': {
    surface: 'dsm-1',
    centreline: [
      [0, 0],
      [100, 0],
    ],
    intervalM: 10,
    limits: {},
  },
} as const satisfies Partial<Record<PipelineName, Record<string, unknown>>>;

describe('M11 pipelines', () => {
  it('names every pipeline with a title, and parses its smallest parameters', () => {
    expect(Object.keys(M11_PARAMS)).toHaveLength(13);
    for (const [name, params] of Object.entries(M11_PARAMS)) {
      const pipeline = PipelineName.parse(name);
      expect(PIPELINES.find((p) => p.name === pipeline)?.title).toBeTruthy();
      const r = pipelineParams(pipeline).safeParse(params);
      expect(r.success, `${name}: ${r.success ? '' : r.error.message}`).toBe(true);
      expect(pipelineParams(pipeline).safeParse({ ...params, bogus: 1 }).success).toBe(false);
    }
  });

  it('refuses a comparison of both stored items and the whole site', () => {
    const compare = pipelineParams('survey.compare');
    const items = [
      {
        measurement: 'm-1',
        ring: [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
        item: volumeItem,
      },
    ];
    expect(compare.safeParse({ items }).success).toBe(true);
    expect(compare.safeParse({ items, ...M11_PARAMS['survey.compare'] }).success).toBe(false);
    expect(compare.safeParse({}).success).toBe(false);
  });
});

describe('M11 IPC channels', () => {
  const channels = [
    'survey:readSettings',
    'survey:writeSettings',
    'survey:readMeasurements',
    'survey:writeMeasurements',
    'survey:readTemplates',
    'survey:writeTemplates',
    'survey:readDesigns',
    'survey:writeDesigns',
    'survey:surfaces',
    'survey:readOverlays',
    'survey:writeOverlays',
    'survey:readQa',
    'survey:releaseHold',
    'survey:readTerrainEdits',
    'survey:writeTerrainEdits',
    'geodesy:searchCrs',
    'geodesy:readCalibration',
    'geodesy:applyCalibration',
    'geoidPacks:list',
    'geoidPacks:import',
    'geoidPacks:remove',
    'surveyAi:suggest',
  ] as const;

  it('declares every channel, each able to answer a typed not-implemented', () => {
    for (const c of channels) {
      expect(Object.keys(ipc)).toContain(c);
      const r = ipc[c].response.safeParse({ ok: false, error: 'x', code: 'not-implemented' });
      expect(r.success, c).toBe(true);
    }
  });

  it('declares the QA and terrain edit channels of G8 (additive)', () => {
    const qa = {
      schema: 'aio.survey-qa/1',
      capture: 'c1',
      level: 'strict',
      status: 'released',
      release: { at: NOW, note: 'Checked against the GNSS log.' },
      checkedAt: NOW,
    };
    const edits = { schema: 'aio.terrain-edits/1', edits: [] };
    expect(ipc['survey:readQa'].request.safeParse({ projectId: 'p1' }).success).toBe(true);
    expect(
      ipc['survey:readQa'].response.safeParse({ ok: true, files: [qa], readOnly: false }).success,
    ).toBe(true);
    const release = ipc['survey:releaseHold'].request;
    expect(release.safeParse({ projectId: 'p1', capture: 'c1', note: 'Checked.' }).success).toBe(
      true,
    );
    expect(release.safeParse({ projectId: 'p1', capture: 'c1', note: '   ' }).success).toBe(false);
    expect(ipc['survey:releaseHold'].response.safeParse({ ok: true, qa }).success).toBe(true);
    expect(
      ipc['survey:readTerrainEdits'].response.safeParse({ ok: true, file: edits, readOnly: true })
        .success,
    ).toBe(true);
    expect(
      ipc['survey:writeTerrainEdits'].request.safeParse({ projectId: 'p1', file: edits }).success,
    ).toBe(true);
  });
});

describe('M11 journal ops and entitlements', () => {
  const PAYLOADS = {
    'measurement.create': { record: measurement('m-1') },
    'measurement.patch': { set: { label: 'Stockpile B' }, was: { label: 'Stockpile A' } },
    'measurement.delete': {},
    'design.add': { record: { id: 'd1', name: 'Bulk earthworks' } },
    'design.patch': { set: { 'layers.fg.verticalOffsetM': -0.4 } },
    'design.archive': { set: { archived: true } },
    'survey.settings': { set: { 'units.distance': 'us-ft' } },
    'survey.calibration': { record: { id: 'cal-1', appliedAt: NOW } },
    'survey.hold': { capture: 'c1', action: 'release', note: 'Checked against the GNSS log.' },
  } as const satisfies Partial<Record<OpKind, unknown>>;

  it('knows every M11 op kind, with a payload schema and a permission', () => {
    for (const [kind, payload] of Object.entries(PAYLOADS)) {
      expect(isKnownOpKind(kind), kind).toBe(true);
      expect(OP_KINDS).toContain(kind);
      if (!isKnownOpKind(kind)) continue;
      const r = OP_PAYLOADS[kind].safeParse(payload);
      expect(r.success, `${kind}: ${r.success ? '' : r.error.message}`).toBe(true);
      expect(OP_PERMISSION[kind]).toBeTruthy();
    }
    expect(OP_PAYLOADS['survey.hold'].safeParse({ capture: 'c1', action: 'lift' }).success).toBe(
      false,
    );
    expect(RECORD_KINDS).toEqual(expect.arrayContaining(['measurement', 'design', 'survey']));
  });

  it('lists the five survey entitlements, all allowed in M11', () => {
    const survey = ['survey.measure', 'survey.designs', 'survey.hydro', 'survey.haul', 'survey.ai'];
    expect(ENTITLEMENTS.filter((e) => e.startsWith('survey.'))).toEqual(survey);
    for (const e of ENTITLEMENTS) expect(can(e), e).toBe(true);
  });
});
