/* eslint-disable @typescript-eslint/no-non-null-assertion -- fixtures are edited at known indexes */
import { describe, expect, it } from 'vitest';
import {
  AntennaId,
  DEFAULT_RF_STUDY,
  RF_CATALOGUE_SCHEMA,
  RF_RUN_SCHEMA,
  RF_SECTORS_SCHEMA,
  RfCatalogue,
  RfRun,
  RfSectorsFile,
  etiltProblems,
  parseRfCatalogue,
  parseRfRun,
  parseRfSectors,
  type RfCatalogueEntry,
} from './rf';
import { SCHEMA_REGISTRY } from './versions';
import {
  ipc,
  PIPELINES,
  PipelineName,
  pipelineParams,
  RF_COVERAGE_MIN_PACK,
  RfCoverageParams,
} from './index';

const antennaEntry: RfCatalogueEntry = {
  kind: 'antenna',
  id: 'generic-65-18',
  vendor: 'Generic',
  model: 'Generic 65 degree, 18 dBi',
  source: 'user',
  verified: false,
  ports: [
    {
      id: 'p1',
      bandRangeMhz: [1710, 2690],
      gainDbi: 18,
      hBeamwidthDeg: 65,
      vBeamwidthDeg: 7,
      frontToBackDb: 28,
      etilt: { minDeg: 0, maxDeg: 10, stepDeg: 1 },
      patterns: [{ frequencyMhz: 1800, etiltDeg: 2, file: 'patterns/generic-65-18-1800-2.msi' }],
    },
    {
      id: 'p2',
      bandRangeMhz: [3300, 3800],
      gainDbi: 21,
      hBeamwidthDeg: 65,
      vBeamwidthDeg: 6,
      frontToBackDb: 30,
      etilt: { minDeg: 2, maxDeg: 8, stepDeg: 2 },
      patterns: [],
    },
  ],
};

const aauEntry: RfCatalogueEntry = {
  kind: 'aau',
  id: 'generic-aau-64t',
  vendor: 'Generic',
  model: 'Generic 64T64R AAU',
  source: 'https://example.com/datasheet.pdf',
  verified: true,
  bandRangeMhz: [3300, 3800],
  ports: 64,
  totalPowerDbm: 53,
  ssbGainDbi: 17,
  ssbHBeamwidthDeg: 65,
  ssbVBeamwidthDeg: 12,
  etilt: { minDeg: 0, maxDeg: 12, stepDeg: 1 },
};

const radioEntry: RfCatalogueEntry = {
  kind: 'radio',
  id: 'generic-rru-2t2r',
  vendor: 'Generic',
  model: 'Generic 2T2R RRU',
  source: 'user',
  verified: false,
  bandRangeMhz: [1710, 1880],
  txPorts: 2,
  rxPorts: 2,
  maxPowerDbmPerPort: 46,
  maxBandwidthMhz: 20,
  mounting: 'tower',
};

const sectors = {
  schema: RF_SECTORS_SCHEMA,
  sectors: [
    { id: 'sec-1', name: 'S1', antennaIds: ['ant-a', 'ant-b'] },
    { id: 'sec-2', name: 'S2', antennaIds: ['ant-c'] },
  ],
  antennas: [
    {
      antennaId: 'ant-a',
      equipment: { kind: 'separate', antenna: 'generic-65-18', radio: 'generic-rru-2t2r' },
      heightOverrideM: 42.5,
      etiltDeg: 4,
      active: true,
      carriers: [
        {
          id: 'c1',
          radioUnit: 'generic-rru-2t2r',
          port: 'p1',
          tech: 'lte',
          band: 'B3',
          bandwidthMhz: 20,
          powerDbmPerPort: 43,
          feederLossDb: 0.5,
        },
      ],
    },
    {
      antennaId: 'ant-c',
      equipment: { kind: 'aau', aau: 'generic-aau-64t' },
      etiltDeg: 6,
      carriers: [
        {
          id: 'c1',
          tech: 'nr',
          band: 'n78',
          bandwidthMhz: 100,
          scsKhz: 30,
          powerDbmPerPort: 53,
          feederLossDb: 0,
        },
      ],
    },
  ],
  study: DEFAULT_RF_STUDY,
};

describe('aio.rf-sectors/1', () => {
  it('round-trips a full sectors file', () => {
    const r = parseRfSectors(sectors);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sectors).toHaveLength(2);
    expect(r.value.antennas[0]?.heightOverrideM).toBe(42.5);
    const again = parseRfSectors(JSON.parse(JSON.stringify(r.value)));
    expect(again).toEqual(r);
    expect(RfSectorsFile.parse(r.value)).toEqual(r.value);
  });

  it('defaults the study to the spec values', () => {
    expect(DEFAULT_RF_STUDY).toMatchObject({
      model: 'tr38901',
      environment: 'uma',
      ueHeightM: 1.5,
      marginPreset: 'outdoor',
      thresholds: { excellentDbm: -80, goodDbm: -95, fairDbm: -105, poorDbm: -115 },
      gridResolutionM: 10,
      radiusM: 3000,
    });
  });

  it('accepts the ant- id rule and refuses ids that do not match it', () => {
    expect(AntennaId.safeParse('ant-a1-b2').success).toBe(true);
    for (const bad of ['a1', 'ANT-a', 'ant_a', 'ant-', 'ant-A', `ant-${'x'.repeat(61)}`])
      expect(AntennaId.safeParse(bad).success, bad).toBe(false);
    const bad = structuredClone(sectors);
    bad.antennas[0]!.antennaId = 'unit-7';
    expect(parseRfSectors(bad).ok).toBe(false);
    const badSector = structuredClone(sectors);
    badSector.sectors[0]!.antennaIds = ['panel-1'];
    expect(parseRfSectors(badSector).ok).toBe(false);
  });

  it('refuses an AAU entry with a separate antenna or radio', () => {
    for (const extra of [{ antenna: 'generic-65-18' }, { radio: 'generic-rru-2t2r' }]) {
      const bad = structuredClone(sectors);
      bad.antennas[1]!.equipment = { kind: 'aau', aau: 'generic-aau-64t', ...extra } as never;
      expect(parseRfSectors(bad).ok).toBe(false);
    }
    const sep = structuredClone(sectors);
    sep.antennas[0]!.equipment = { kind: 'separate', antenna: 'a', aau: 'b' } as never;
    expect(parseRfSectors(sep).ok).toBe(false);
  });

  it('refuses duplicate antennas, sectors and unknown keys', () => {
    const dup = structuredClone(sectors);
    dup.antennas[1]!.antennaId = 'ant-a';
    expect(parseRfSectors(dup).ok).toBe(false);
    const dupSector = structuredClone(sectors);
    dupSector.sectors[1]!.id = 'sec-1';
    expect(parseRfSectors(dupSector).ok).toBe(false);
    expect(parseRfSectors({ ...sectors, extra: 1 }).ok).toBe(false);
  });

  it('refuses thresholds that are not descending and a grid outside 5 to 50 m', () => {
    const t = structuredClone(sectors);
    t.study = {
      ...DEFAULT_RF_STUDY,
      thresholds: { ...DEFAULT_RF_STUDY.thresholds, goodDbm: -70 },
    };
    expect(parseRfSectors(t).ok).toBe(false);
    for (const res of [4, 51]) {
      const g = structuredClone(sectors);
      g.study = { ...DEFAULT_RF_STUDY, gridResolutionM: res };
      expect(parseRfSectors(g).ok).toBe(false);
    }
    const far = structuredClone(sectors);
    far.study = { ...DEFAULT_RF_STUDY, radiusM: 15_001 };
    expect(parseRfSectors(far).ok).toBe(false);
  });

  it('reads a newer /2 file as refused and leaves it alone', () => {
    const raw = { ...structuredClone(sectors), schema: 'aio.rf-sectors/2', future: true };
    const before = JSON.stringify(raw);
    const r = parseRfSectors(raw, 'Quadrion AI');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('newer');
    expect(r.error).toMatch(/newer version|update/i);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('refuses another family', () => {
    const r = parseRfSectors({ ...sectors, schema: 'aio.rf-run/1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong-family');
  });
});

describe('e-tilt against the port range', () => {
  const cat = [antennaEntry, aauEntry, radioEntry];
  const settings = (etiltDeg: number, port = 'p1') =>
    ({
      antennaId: 'ant-a',
      equipment: { kind: 'separate', antenna: 'generic-65-18' },
      etiltDeg,
      carriers: [
        { id: 'c1', port, tech: 'lte', band: 'B3', bandwidthMhz: 20, powerDbmPerPort: 43 },
      ],
    }) as never;

  it('accepts a tilt inside the range on the step', () => {
    expect(etiltProblems(settings(4), cat)).toEqual([]);
    expect(etiltProblems(settings(0), cat)).toEqual([]);
    expect(etiltProblems(settings(10), cat)).toEqual([]);
  });

  it('refuses a tilt outside the port range', () => {
    expect(etiltProblems(settings(11), cat)[0]).toMatch(/0 to 10/);
    expect(etiltProblems(settings(-1), cat)).toHaveLength(1);
    // p2 allows 2 to 8 only
    expect(etiltProblems(settings(1, 'p2'), cat)).toHaveLength(1);
    expect(etiltProblems(settings(4, 'p2'), cat)).toEqual([]);
  });

  it('checks an AAU against its own range and flags an unknown entry', () => {
    const aau = {
      antennaId: 'ant-c',
      equipment: { kind: 'aau', aau: 'generic-aau-64t' },
      etiltDeg: 13,
      carriers: [],
    } as never;
    expect(etiltProblems(aau, cat)).toHaveLength(1);
    const missing = {
      antennaId: 'ant-c',
      equipment: { kind: 'aau', aau: 'nope' },
      etiltDeg: 1,
      carriers: [],
    } as never;
    expect(etiltProblems(missing, cat)[0]).toMatch(/nope/);
  });
});

describe('aio.rf-catalogue/1', () => {
  const file = {
    schema: RF_CATALOGUE_SCHEMA,
    entries: [antennaEntry, radioEntry, aauEntry],
  };

  it('round-trips the three record kinds', () => {
    const r = parseRfCatalogue(file);
    expect(r.ok).toBe(true);
    if (r.ok) expect(RfCatalogue.parse(r.value)).toEqual(r.value);
  });

  it('refuses duplicate ids, an inverted band range and a bad e-tilt range', () => {
    expect(parseRfCatalogue({ ...file, entries: [antennaEntry, antennaEntry] }).ok).toBe(false);
    const inverted = { ...radioEntry, bandRangeMhz: [1880, 1710] };
    expect(parseRfCatalogue({ ...file, entries: [inverted] }).ok).toBe(false);
    const badTilt = { ...aauEntry, etilt: { minDeg: 12, maxDeg: 0, stepDeg: 1 } };
    expect(parseRfCatalogue({ ...file, entries: [badTilt] }).ok).toBe(false);
  });

  it('reads a newer /2 file as refused', () => {
    const r = parseRfCatalogue({ ...file, schema: 'aio.rf-catalogue/2' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('newer');
  });
});

describe('aio.rf-run/1', () => {
  const run = {
    schema: RF_RUN_SCHEMA,
    runId: 'rf-20261017-101500-a1b2',
    createdAt: '2026-10-17T10:15:00.000Z',
    status: 'done',
    inputs: { sectors, antennas: [{ id: 'ant-a', centre: [10, 20, 45], groundZ: 3 }] },
    catalogue: [{ id: 'generic-65-18', kind: 'antenna', verified: false }],
    model: { model: 'tr38901', environment: 'uma' },
    grid: {
      crs: 'EPSG:32640',
      resolutionM: 10,
      radiusM: 3000,
      origin: [500000, 2800000],
      width: 600,
      height: 600,
      nodata: -9999,
    },
    timings: { totalMs: 1234 },
    warnings: ['flat ground, no buildings'],
    usedUnreviewed: false,
    patterns: [{ antennaId: 'ant-a', source: 'generic' }],
    outputs: { rsrp: 'rsrp.tif', bestServer: 'best.tif', overlap: 'overlap.tif' },
  };

  it('round-trips and refuses a newer file', () => {
    const r = parseRfRun(run);
    expect(r.ok).toBe(true);
    if (r.ok) expect(RfRun.parse(r.value)).toEqual(r.value);
    expect(parseRfRun({ ...run, schema: 'aio.rf-run/2' }).ok).toBe(false);
  });

  it('keeps run files inside the run folder', () => {
    const bad = { ...run, outputs: { ...run.outputs, rsrp: '../escape.tif' } };
    expect(parseRfRun(bad).ok).toBe(false);
  });
});

describe('contract wiring', () => {
  it('registers the three file schemas', () => {
    for (const [family, where] of [
      ['aio.rf-sectors', 'rf/sectors.json'],
      ['aio.rf-catalogue', 'rf/catalogue.json'],
      ['aio.rf-run', 'rf/runs/<runId>/run.json'],
    ] as const)
      expect(SCHEMA_REGISTRY.find((e) => e.family === family)).toMatchObject({
        version: 1,
        where: expect.stringContaining(where) as string,
      });
  });

  it('adds the rf channels', () => {
    for (const c of [
      'rf:readSectors',
      'rf:writeSectors',
      'rf:listCatalogue',
      'rf:importCatalogue',
      'rf:listRuns',
      'rf:readRun',
      'rf:export',
    ])
      expect(Object.keys(ipc), c).toContain(c);
    const w = ipc['rf:writeSectors'].request;
    expect(w.safeParse({ projectId: 'p', file: sectors }).success).toBe(true);
    expect(
      w.safeParse({ projectId: 'p', file: { ...sectors, schema: 'aio.rf-sectors/2' } }).success,
    ).toBe(false);
  });

  it('registers the rf.coverage job and its params', () => {
    expect(PipelineName.options).toContain('rf.coverage');
    expect(PIPELINES.find((p) => p.name === 'rf.coverage')?.title).toBe('Predicting coverage');
    expect(RF_COVERAGE_MIN_PACK).toMatch(/^\d+\.\d+\.\d+$/);
    const p = pipelineParams('rf.coverage');
    expect(p).toBe(RfCoverageParams);
    expect(p.safeParse({ runId: 'rf-20261017-101500-a1b2' }).success).toBe(true);
    expect(
      p.safeParse({ runId: 'rf-x1', sectorIds: ['sec-1'], includeUnreviewed: true }).success,
    ).toBe(true);
    expect(p.safeParse({ runId: '../x' }).success).toBe(false);
    expect(p.safeParse({ runId: 'rf-x1', bogus: 1 }).success).toBe(false);
  });
});
