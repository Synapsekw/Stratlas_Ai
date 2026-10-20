import type { BoundaryEditsFile, MeasurementsFile, VolumesFile } from '@aio/schema';
import { MeasurementsFile as MeasurementsFileSchema } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { KIT_BASE_LABEL, KIT_FOLDER, convertKitPiles } from './kitPiles';

const at = <T>(a: readonly T[] | undefined, i: number): T => {
  const v = a?.[i];
  if (v === undefined) throw new Error('missing item');
  return v;
};

const fc = (net: number, cut = 2) => ({ fill: net + cut, cut, net });
const v4 = (net: number) => ({
  tin: fc(net),
  plane: fc(net + 10),
  avg: fc(net + 20),
  low: fc(net + 30),
});
const ring: [number, number][] = [
  [0, 0],
  [4, 0],
  [4, 3],
];
const ep = (captureId: string, net: number, areaM2 = 100) => ({
  captureId,
  areaM2,
  topM: 60,
  heightM: 5,
  ring,
  volumes: v4(net),
});

function volumes(): VolumesFile {
  return {
    schema: 'aio.volumes/1',
    densityTPerM3: 1.6,
    deadbandM: 0.1,
    defaultBase: 'plane',
    bases: [
      { id: 'tin', label: 'Triangulated toe' },
      { id: 'plane', label: 'Best-fit toe plane' },
      { id: 'avg', label: 'Average toe height' },
      { id: 'low', label: 'Lowest toe point' },
    ],
    captures: [
      { epoch: 'e1', captureId: 'c1', date: '2020-12-31', label: '31 Dec 2020' },
      { epoch: 'e2', captureId: 'c2', date: '2021-01-10', label: '10 Jan 2021' },
    ],
    piles: [
      {
        id: 'P01',
        name: 'Pile 01',
        material: 'Sand',
        zoneRing: ring,
        change: fc(-50),
        epochs: { e1: ep('c1', 100, 110), e2: ep('c2', 50, 90) },
      },
      {
        id: 'P02',
        name: 'Pile 02',
        zoneRing: ring,
        change: fc(300),
        epochs: { e2: ep('c2', 300) },
      },
    ],
    totals: {},
    pileChange: fc(0),
    siteChange: fc(0),
  };
}

const edits: BoundaryEditsFile = {
  schema: 'aio.boundaries/1',
  edits: [
    {
      pile: 'P01',
      epoch: 'e2',
      ring: [
        [0, 0],
        [8, 0],
        [8, 6],
        [0, 6],
      ],
      volumes: v4(70),
      areaM2: 48,
      topM: 61,
      heightM: 6,
      autoNet: 50,
      updatedAt: '2026-10-04T10:00:00.000Z',
    },
  ],
};

const empty = (over: Partial<MeasurementsFile> = {}): MeasurementsFile => ({
  schema: 'aio.measurements/1',
  measurements: [],
  ...over,
});

const NOW = '2026-10-20T09:00:00.000Z';
function opts(carry: boolean) {
  let n = 0;
  return {
    carry,
    now: NOW,
    newId: () => `id${++n}`,
    // Local frame: x east, z south; the site frame puts north up.
    toSite: ([x, z]: readonly [number, number]): [number, number, number] => [
      1000 + x,
      2000 - z,
      0,
    ],
    materialId: (name: string) => (name === 'Sand' ? 'mat-sand' : undefined),
  };
}

describe('convertKitPiles', () => {
  it('converts piles with carried figures and records the converted ids', () => {
    const out = convertKitPiles(volumes(), null, empty(), opts(true));
    expect(out.converted).toEqual(['P01', 'P02']);
    expect(out.added).toHaveLength(2);

    const m = at(out.added, 0);
    expect(m).toMatchObject({
      tool: 'volume',
      family: 'polygon',
      label: 'Pile 01',
      folder: KIT_FOLDER,
      scope: { kind: 'site' },
      material: 'mat-sand',
      origin: { kind: 'kit-pile', pile: 'P01' },
      createdAt: NOW,
    });
    expect(m.points).toEqual([
      [1000, 2000, 0],
      [1004, 2000, 0],
      [1004, 1997, 0],
    ]);
    const item = at(m.items, 0);
    expect(m.items).toHaveLength(1);
    expect(item).toMatchObject({
      from: { kind: 'smart' },
      to: { kind: 'current' },
      useDeadband: false,
    });

    // One result per date, from the default base (plane), numbers exactly as the kit had them.
    const series = m.series ?? [];
    expect(series.map((r) => r.toCapture)).toEqual(['c1', 'c2']);
    const kitE1 = v4(100).plane;
    expect(at(series, 0)).toMatchObject({
      item: item.id,
      status: 'ok',
      cutM3: kitE1.cut,
      fillM3: kitE1.fill,
      netM3: kitE1.net,
      totalM3: kitE1.fill + kitE1.cut,
      areaM2: 110,
      engine: 'ts',
      fingerprint: 'kit:P01:e1:plane',
      carried: { from: 'kit', base: 'plane', pile: 'P01', epoch: 'e1' },
      toCapture: 'c1',
      fromLabel: KIT_BASE_LABEL.plane,
      toLabel: '31 Dec 2020',
      computedAt: NOW,
      // The kit's 10 cm pile grids, not the exact TIN path.
      cellM: 0.1,
    });
    // The latest date is the headline result.
    expect(m.results).toHaveLength(1);
    expect(at(m.results, 0)).toEqual(at(series, 1));
    expect(at(m.results, 0).fingerprint).toBe('kit:P01:e2:plane');
    expect(at(m.results, 0).netM3).toBe(v4(50).plane.net);

    // A pile without a material carries none.
    expect(at(out.added, 1).material).toBeUndefined();
    expect(at(out.added, 1).series?.map((r) => r.fingerprint)).toEqual(['kit:P02:e2:plane']);

    // Every written measurement passes the schema.
    const written = empty({ measurements: out.added, kitPilesConverted: out.converted });
    expect(MeasurementsFileSchema.safeParse(written).success).toBe(true);
  });

  it('carry false adds measurements with no results', () => {
    const out = convertKitPiles(volumes(), null, empty(), opts(false));
    expect(out.converted).toEqual(['P01', 'P02']);
    for (const m of out.added) {
      expect(m.results).toEqual([]);
      expect(m.series).toBeUndefined();
      expect(m.items).toHaveLength(1);
    }
  });

  it('skips piles already converted, even when their measurement was deleted', () => {
    const out = convertKitPiles(volumes(), null, empty({ kitPilesConverted: ['P01'] }), opts(true));
    expect(out.converted).toEqual(['P02']);
    expect(out.added.map((m) => m.origin?.pile)).toEqual(['P02']);
  });

  it('uses the edited toe line from boundaries', () => {
    const out = convertKitPiles(volumes(), edits, empty(), opts(true));
    const m = at(out.added, 0);
    expect(m.points).toEqual([
      [1000, 2000, 0],
      [1008, 2000, 0],
      [1008, 1994, 0],
      [1000, 1994, 0],
    ]);
    const latest = at(m.results, 0);
    expect(latest.netM3).toBe(v4(70).plane.net);
    expect(latest.areaM2).toBe(48);
    // The unedited date keeps the automatic figure.
    expect(at(m.series, 0).netM3).toBe(v4(100).plane.net);
  });

  it('a membrane-only base (tin) is carried, never offered as a live base', () => {
    const v = { ...volumes(), defaultBase: 'tin' as const };
    const out = convertKitPiles(v, null, empty(), opts(true));
    const m = at(out.added, 0);
    expect(at(m.items, 0).from).toEqual({ kind: 'smart' });
    const r = at(m.results, 0);
    expect(r.carried?.base).toBe('tin');
    expect(r.fingerprint).toBe('kit:P01:e2:tin');
    expect(r.fromLabel).toBe(KIT_BASE_LABEL.tin);
    expect(r.netM3).toBe(v4(50).tin.net);
  });

  it('a pile gone by the last capture has no headline, but keeps its dated figures', () => {
    const v = volumes();
    v.piles = [{ ...at(v.piles, 0), epochs: { e1: ep('c1', 100, 110) } }];
    const m = at(convertKitPiles(v, null, empty(), opts(true)).added, 0);
    expect(m.results).toEqual([]);
    expect(m.series?.map((r) => r.fingerprint)).toEqual(['kit:P01:e1:plane']);
    expect(at(m.series, 0).netM3).toBe(v4(100).plane.net);
  });

  it('an empty latest toe line falls back to the latest non-empty one', () => {
    const v = volumes();
    const p = at(v.piles, 0);
    v.piles = [{ ...p, epochs: { e1: ep('c1', 100), e2: { ...ep('c2', 50), ring: [] } } }];
    const out = convertKitPiles(v, null, empty(), opts(true));
    expect(out.converted).toEqual(['P01']);
    const m = at(out.added, 0);
    expect(m.points).toEqual([
      [1000, 2000, 0],
      [1004, 2000, 0],
      [1004, 1997, 0],
    ]);
    // The figure on the last capture is still the headline.
    expect(at(m.results, 0).fingerprint).toBe('kit:P01:e2:plane');
  });

  it('caps a long name at the schema limit and converts a duplicate pile id once', () => {
    const v = volumes();
    const p = at(v.piles, 0);
    v.piles = [
      { ...p, name: 'x'.repeat(500) },
      { ...p, name: 'Copy' },
    ];
    const out = convertKitPiles(v, null, empty(), opts(true));
    expect(out.converted).toEqual(['P01']);
    expect(out.added).toHaveLength(1);
    expect(at(out.added, 0).label).toHaveLength(200);
    const written = empty({ measurements: out.added, kitPilesConverted: out.converted });
    expect(MeasurementsFileSchema.safeParse(written).success).toBe(true);
  });

  it('converts a pile whose only date comes from an edit', () => {
    const v = volumes();
    v.piles = [{ ...at(v.piles, 0), epochs: {} }];
    const out = convertKitPiles(v, edits, empty(), opts(true));
    expect(out.converted).toEqual(['P01']);
    const m = at(out.added, 0);
    expect(m.points).toHaveLength(4);
    expect(m.series).toHaveLength(1);
    expect(at(m.results, 0)).toMatchObject({
      netM3: v4(70).plane.net,
      areaM2: 48,
      toCapture: 'c2',
      toLabel: '10 Jan 2021',
      fingerprint: 'kit:P01:e2:plane',
    });
  });
});
