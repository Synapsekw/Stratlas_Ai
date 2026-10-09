import {
  defaultSurveySettings,
  SiteCalibration,
  type ComparisonResult,
  type SurveySettings,
} from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  compaction,
  earthworksProgress,
  inDisplayUnit,
  MEASUREMENTS_CSV_COLUMNS,
  measurementsCsv,
  parseWeighbridge,
  stockpileCsv,
  stockpileInventory,
  surveyBasis,
  usableVolume,
  type CaptureRef,
  type MeasurementReport,
  type StockpileReport,
  type SurveyReportData,
} from './surveyCsv';

const BOM = String.fromCharCode(0xfeff);
const C1: CaptureRef = { id: 'c1', label: 'Survey 1', date: '2026-01-31' };
const C2: CaptureRef = { id: 'c2', label: 'Survey 2', date: '2026-02-28' };
const C3: CaptureRef = { id: 'c3', label: 'Survey 3', date: '2026-03-31' };

const result = (net: number, over: Partial<ComparisonResult> = {}): ComparisonResult => ({
  item: 'pile',
  status: 'ok',
  cutM3: net < 0 ? -net : 0,
  fillM3: net > 0 ? net : 0,
  netM3: net,
  totalM3: Math.abs(net),
  areaM2: 400,
  areaCutM2: 0,
  areaFillM2: 100,
  areaUnchangedM2: 300,
  uncoveredM2: 0,
  fromLabel: 'Smart base (triangulated perimeter)',
  toLabel: 'Current survey (DSM)',
  deadbandM: 0,
  usedDeadband: false,
  cellM: 0.5,
  engine: 'ts',
  fingerprint: 'sha256:x',
  computedAt: '2026-10-09T08:00:00Z',
  ...over,
});

const gravel = { id: 'gravel', name: 'Gravel', code: 'G', densityTPerM3: 2 };
const sand = { id: 'sand', name: 'Sand', densityTPerM3: 1.5 };
const loose = { id: 'loose', name: 'Loose fill' };

const pile = (
  id: string,
  material: StockpileReport['material'],
  volumes: [CaptureRef, number | null][],
): StockpileReport => ({
  ref: id.toUpperCase(),
  id,
  label: `Pile ${id}`,
  material,
  base: 'Smart base',
  volumes: volumes.map(([capture, v]) => ({
    capture,
    volumeM3: v,
    status: v === null ? 'refused' : 'ok',
    reason: v === null ? '25% outside the survey' : '',
  })),
});

describe('the basis of the numbers', () => {
  it('names the display CRS, the heights and the units; the manifest CRS by default', () => {
    const b = surveyBasis(defaultSurveySettings(), { epsg: 32639 }, null);
    expect(b).toMatchObject({
      crs: 'EPSG:32639',
      verticalDatum: 'project',
      geoid: null,
      verticalCrs: null,
      calibration: null,
      distances: 'grid',
    });
    const geoid: SurveySettings = {
      ...defaultSurveySettings(),
      crs: { epsg: 2229 },
      verticalDatum: { kind: 'geoid', geoid: 'egm96', epsg: 5773 },
      distances: 'ground',
    };
    expect(surveyBasis(geoid, { epsg: 32639 }, null)).toMatchObject({
      crs: 'EPSG:2229',
      verticalDatum: 'geoid',
      geoid: 'egm96',
      verticalCrs: 'EPSG:5773',
      distances: 'ground',
    });
  });

  it('states a calibration only when the settings apply it and a person applied it', () => {
    const cal = SiteCalibration.parse({
      schema: 'aio.site-calibration/1',
      id: 'cal-1',
      name: 'Site calibration – March',
      source: { format: 'pairs' },
      projection: { epsg: 32639 },
      pairs: [],
      rmsH: 0.012,
      rmsV: 0.008,
      computedAt: '2026-10-09T08:00:00Z',
    });
    const settings = { ...defaultSurveySettings(), calibration: 'cal-1' };
    expect(surveyBasis(settings, { epsg: 32639 }, cal).calibration).toBeNull();
    const applied = { ...cal, appliedAt: '2026-10-09T09:00:00Z' };
    expect(surveyBasis(settings, { epsg: 32639 }, applied).calibration).toEqual({
      id: 'cal-1',
      name: 'Site calibration, March',
      rmsH: 0.012,
      rmsV: 0.008,
    });
    expect(surveyBasis(defaultSurveySettings(), { epsg: 32639 }, applied).calibration).toBeNull();
  });
});

describe('the stockpile inventory', () => {
  const piles = [
    pile('a', gravel, [
      [C1, 200],
      [C2, 300],
      [C3, 400],
    ]),
    pile('b', sand, [
      [C2, 100],
      [C3, 200],
    ]),
    pile('c', gravel, [
      [C2, 50],
      [C3, null],
    ]),
    pile('d', loose, [[C3, 10]]),
  ];
  const inv = stockpileInventory(piles, [C1, C2, C3]);

  it('takes the latest survey and the one before (month end)', () => {
    expect(inv.captures.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect([inv.current?.id, inv.previous?.id]).toEqual(['c3', 'c2']);
    expect(inv.rows.map((r) => [r.id, r.currentM3, r.previousM3, r.changeM3])).toEqual([
      ['a', 400, 300, 100],
      ['b', 200, 100, 100],
      ['c', null, 50, null],
      ['d', 10, null, null],
    ]);
    expect(inv.rows.map((r) => r.tonnes)).toEqual([800, 300, null, null]);
    expect(inv.rows[0]?.changeTonnes).toBe(200);
  });

  it('adds only volumes it has, and no tonnes when a pile lacks a density', () => {
    expect(inv.total).toMatchObject({
      piles: 4,
      currentM3: 610,
      previousM3: 450,
      changeM3: 200,
      tonnes: null,
      changeTonnes: 350,
    });
    expect(inv.byMaterial.map((t) => [t.material, t.piles, t.currentM3, t.tonnes])).toEqual([
      ['gravel', 2, 400, 800],
      ['sand', 1, 200, 300],
      ['loose', 1, 10, null],
    ]);
  });

  it('has no previous survey and no change with one survey', () => {
    const one = stockpileInventory([pile('a', gravel, [[C3, 40]])], [C1, C2, C3]);
    expect(one.previous).toBeNull();
    expect(one.total).toMatchObject({
      currentM3: 40,
      previousM3: null,
      changeM3: null,
      tonnes: 80,
    });
  });

  it('never adds a refused or stale result', () => {
    expect(usableVolume(result(12))).toBe(12);
    expect(usableVolume(result(-12))).toBe(12);
    expect(usableVolume(result(12, { status: 'partial' }))).toBe(12);
    expect(usableVolume(result(12, { status: 'stale' }))).toBeNull();
    expect(usableVolume(result(12, { status: 'refused' }))).toBeNull();
    expect(usableVolume(null)).toBeNull();
  });
});

describe('earthworks and landfill arithmetic', () => {
  it('progress is the share of the first volume to move that is done', () => {
    expect(earthworksProgress(1600, 320)).toBeCloseTo(0.8, 12);
    expect(earthworksProgress(1600, 0)).toBe(1);
    expect(earthworksProgress(1600, 2000)).toBe(0);
    expect(earthworksProgress(0, 10)).toBeNull();
  });

  it('compaction is tonnes over the lift volume (63,000 t over 70,104 m³ is 0.899 t/m³)', () => {
    expect(compaction(63_000, 70_104)).toBeCloseTo(0.8987, 4);
    expect(compaction(null, 10)).toBeNull();
    expect(compaction(10, 0)).toBeNull();
    expect(compaction(10, -5)).toBeNull();
  });

  it('reads a weighbridge log: date and tonnes columns, any separator, same dates added', () => {
    expect(
      parseWeighbridge(
        BOM +
          'Date;Lift;Tonnes\r\n2026-02-28;2;1440\r\n2026-03-31;3;1000\r\n2026-03-31;3;520\r\nbad;3;x\r\n',
      ),
    ).toEqual([
      { date: '2026-02-28', tonnes: 1440 },
      { date: '2026-03-31', tonnes: 1520 },
    ]);
    expect(parseWeighbridge('day,tonnes\n2026-02-28,4')).toEqual([]);
    expect(parseWeighbridge('')).toEqual([]);
  });
});

describe('units at the edges', () => {
  it('gives a value in the display unit beside its SI value', () => {
    const units = {
      ...defaultSurveySettings().units,
      distance: 'us-ft' as const,
      volume: 'yd3' as const,
    };
    expect(inDisplayUnit(1200 / 3937, 'distance', units)).toEqual({ value: 1, unit: 'US ft' });
    expect(inDisplayUnit(0.9144 ** 3, 'volume', units).value).toBeCloseTo(1, 12);
    expect(inDisplayUnit(0.05, 'grade', units)).toEqual({ value: 5, unit: '%' });
    expect(inDisplayUnit(45, 'bearing', units)).toEqual({ value: 45, unit: 'deg' });
  });
});

// ---------------------------------------------------------------- CSVs

const settings = defaultSurveySettings();
const basis = surveyBasis(settings, { epsg: 32639 }, null);

const measurement = (over: Partial<MeasurementReport>): MeasurementReport => ({
  ref: 'M1',
  id: 'm-1',
  label: 'Pile A',
  folder: null,
  template: null,
  family: 'polygon',
  tool: 'volume',
  scope: null,
  capture: C3,
  material: null,
  units: settings.units,
  values: [],
  comparisons: [],
  fields: [],
  outline: [],
  ...over,
});

const data = (over: Partial<SurveyReportData>): SurveyReportData => ({
  basis,
  captures: [C1, C2, C3],
  current: C3,
  computed: true,
  measurementCount: 1,
  measurements: [],
  stockpiles: stockpileInventory([], [C1, C2, C3]),
  earthworks: [],
  sections: [],
  landfill: [],
  ...over,
});

const lines = (csv: string) => csv.replace(BOM, '').trimEnd().split('\r\n');

describe('the measurements CSV', () => {
  it('writes every item as displayed and in SI, with what it was computed with', () => {
    const csv = measurementsCsv(
      data({
        measurements: [
          measurement({
            label: '=SUM(A1) pile',
            values: [
              {
                key: 'area',
                label: 'Horizontal area',
                si: 400,
                kind: 'area',
                display: '400.00 m²',
              },
              {
                key: 'terrain-area',
                label: 'Terrain area',
                si: null,
                kind: 'area',
                display: 'No surface under it',
              },
            ],
            comparisons: [
              { item: 'pile', label: 'Stockpile', result: result(1234.5), reason: '' },
              {
                item: 'old',
                label: 'Old',
                result: result(9, { status: 'stale' }),
                reason: '',
              },
              {
                item: 'gone',
                label: 'Gone',
                result: result(9, { status: 'refused', reason: '25% outside the survey' }),
                reason: '',
              },
            ],
            fields: [{ name: 'Product', value: 'G20' }],
          }),
        ],
      }),
    );
    expect(csv.startsWith(BOM)).toBe(true);
    const rows = lines(csv);
    expect(rows[0]).toBe(MEASUREMENTS_CSV_COLUMNS.join(','));
    const area = rows.find((r) => r.includes(',area,'));
    expect(area).toBe(
      "M1,m-1,'=SUM(A1) pile,,,volume,2026-03-31,,area,Horizontal area,400.00 m²,400,m²,400,m2,ok,,EPSG:32639,project,,,grid",
    );
    expect(rows.find((r) => r.includes(',terrain-area,'))).toContain(
      ',No surface under it,,,,,missing,',
    );
    expect(rows.find((r) => r.includes(',pile.net,'))).toContain(
      ',Stockpile: Net,1 234.5 m³,1234.5,m³,1234.5,m3,ok,',
    );
    // a stale result keeps its numbers with its status; a refused one has none
    expect(rows.find((r) => r.includes(',old.net,'))).toContain(',stale,');
    expect(rows.find((r) => r.includes(',gone.net,'))).toContain(
      ',,,,,refused,25% outside the survey; Smart base',
    );
    expect(rows.find((r) => r.includes(',field,'))).toContain(',field,Product,G20,');
    expect(rows).toHaveLength(1 + 2 + 3 * 6 + 1);
  });
});

describe('the stockpile inventory CSV', () => {
  it('has every survey, the change, the display units and the materials summary', () => {
    const inv = stockpileInventory(
      [
        pile('a', gravel, [
          [C1, 200],
          [C2, 300],
          [C3, 400],
        ]),
        pile('b', null, [
          [C2, 10],
          [C3, null],
        ]),
      ],
      [C1, C2, C3],
    );
    const units = { ...settings.units, volume: 'yd3' as const, mass: 'ston' as const };
    const rows = lines(stockpileCsv(data({ stockpiles: inv, basis: { ...basis, units } })));
    const head = rows[0]?.split(',') ?? [];
    expect(head.slice(0, 8)).toEqual([
      'row',
      'pile',
      'ref',
      'name',
      'material',
      'material_code',
      'density_t_m3',
      'base',
    ]);
    expect(head).toContain('2026-01-31_volume_m3');
    expect(head).toContain('current_volume_yd³');
    expect(head).toContain('current_mass_sh tn');
    expect(rows[1]).toMatch(
      /^pile,a,A,Pile a,Gravel,G,2,Smart base,200,400,ok,300,600,ok,400,800,ok,2026-03-31,400,800,2026-02-28,300,100,200,/,
    );
    expect(rows[2]).toContain(',refused: 25% outside the survey,');
    expect(rows.slice(3).map((r) => r.split(',').slice(0, 5).join(','))).toEqual([
      'material,,,1 piles,Gravel',
      'material,,,1 piles,(no material)',
      'total,,,2 piles,',
    ]);
    const total = rows.at(-1)?.split(',') ?? [];
    expect(total[head.indexOf('current_volume_m3')]).toBe('400');
    expect(total[head.indexOf('2026-02-28_volume_m3')]).toBe('310');
    expect(Number(total[head.indexOf('current_volume_yd³')])).toBeCloseTo(400 / 0.9144 ** 3, 6);
  });
});
