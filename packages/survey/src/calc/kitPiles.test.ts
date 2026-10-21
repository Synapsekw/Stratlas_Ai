import type { BoundaryEditsFile, MeasurementsFile, VolumesFile } from '@aio/schema';
import { MeasurementsFile as MeasurementsFileSchema } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  KIT_BASE_LABEL,
  KIT_FOLDER,
  kitBaseLabel,
  convertKitPiles,
  kitToSite,
  openWithKitPiles,
  overlapShare,
  withKitConversion,
} from './kitPiles';

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

describe('openWithKitPiles: the file as the app, the report and the assistant open it', () => {
  const opts = (readOnly: boolean) => {
    let n = 0;
    return {
      origin: [1000, 2000, 0],
      materials: [{ id: 'sand', name: ' sand ' }],
      now: '2026-10-20T00:00:00Z',
      newId: () => `id-${String(++n)}`,
      readOnly,
    };
  };
  const empty = (): MeasurementsFile => ({ schema: 'aio.measurements/1', measurements: [] });

  it('places kit points through the origin: x east, z south, Z 0', () => {
    expect(kitToSite([1000, 2000, 50], [4, 3])).toEqual([1004, 1997, 0]);
  });

  it("carries an old project's kit figures, with materials by name", () => {
    const file = openWithKitPiles(empty(), { volumes: volumes(), edits: null }, opts(true));
    expect(file.kitPilesConverted).toEqual(['P01', 'P02']);
    const [p1] = file.measurements;
    expect(p1?.material).toBe('sand');
    expect(p1?.points[1]).toEqual([1004, 2000, 0]);
    expect(p1?.series?.every((r) => r.carried?.base === 'plane')).toBe(true);
  });

  it('adds a pile found after the conversion without figures, and keeps the file otherwise', () => {
    const once = openWithKitPiles(empty(), { volumes: volumes(), edits: null }, opts(false));
    expect(openWithKitPiles(once, { volumes: volumes(), edits: null }, opts(false))).toBe(once);
    const v = volumes();
    v.piles.push({ ...at(v.piles, 1), id: 'P03', name: 'Pile 03' });
    const later = openWithKitPiles(once, { volumes: v, edits: null }, opts(false));
    const added = later.measurements.at(-1);
    expect(added?.label).toBe('Pile 03');
    expect(added?.results).toEqual([]);
    expect(added?.series).toBeUndefined();
  });

  it('marks a writable file without kit figures converted; a read-only one stays as it is', () => {
    const file = empty();
    const writable = openWithKitPiles(file, { volumes: null, edits: null }, opts(false));
    expect(writable.kitPilesConverted).toEqual([]);
    expect(openWithKitPiles(file, { volumes: null, edits: null }, opts(true))).toBe(file);
  });
});

describe('kit base names', () => {
  it("names the kit bases plainly, and a later build's base as it is", () => {
    expect(kitBaseLabel('tin')).toBe('Triangulated');
    expect(kitBaseLabel('plane')).toBe('Best-fit plane');
    expect(kitBaseLabel('avg')).toBe('Average edge level');
    expect(kitBaseLabel('low')).toBe('Lowest point');
    expect(kitBaseLabel('later')).toBe('later');
  });
});

describe('overlapShare', () => {
  const sq = (x: number, y = 0, size = 10): [number, number][] => [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
  ];
  it('is the intersection over the smaller area', () => {
    expect(overlapShare(sq(0), sq(0))).toBeCloseTo(1, 2);
    expect(overlapShare(sq(0), sq(5))).toBeCloseTo(0.5, 1);
    expect(overlapShare(sq(0), sq(2, 2, 4))).toBeCloseTo(1, 2);
    expect(overlapShare(sq(0), sq(20))).toBe(0);
    expect(overlapShare(sq(0), [])).toBe(0);
  });
});

describe('a rebuild that renumbers piles (piles match by outline, not by id)', () => {
  const sq = (x: number, size = 10): [number, number][] => [
    [x, 0],
    [x + size, 0],
    [x + size, size],
    [x, size],
  ];
  const onRing = (id: string, r: [number, number][], net = 10) => ({
    id,
    name: `Pile ${id}`,
    zoneRing: r,
    change: fc(0),
    epochs: { e2: { ...ep('c2', net), ring: r } },
  });
  const build = (piles: ReturnType<typeof onRing>[]): VolumesFile => ({ ...volumes(), piles });
  /** The file after the first build: A at x 0 as P01 ("Pile P01"), B at x 100 as P02. */
  const first = () => {
    const start = empty({ kitPilesConverted: [] });
    const out = convertKitPiles(
      build([onRing('P01', sq(0)), onRing('P02', sq(100))]),
      null,
      start,
      opts(false),
    );
    return withKitConversion(start, out);
  };
  const pileOf = (f: MeasurementsFile, label: string) =>
    f.measurements.find((m) => m.label === label)?.origin?.pile;
  const later = () => {
    let n = 100;
    return { ...opts(false), newId: () => `n${String(++n)}` };
  };

  it('relinks the measurements when the numbers shift, and makes no duplicate', () => {
    const before = first();
    // the rebuild finds a new pile west of A, so A is now P02 and B P03
    const v = build([onRing('P01', sq(-100)), onRing('P02', sq(1)), onRing('P03', sq(101))]);
    const c = convertKitPiles(v, null, before, later());
    const after = withKitConversion(before, c);
    const kit = after.measurements.filter((m) => m.origin?.kind === 'kit-pile');
    expect(kit).toHaveLength(3);
    expect(pileOf(after, 'Pile P01')).toBe('P02');
    expect(pileOf(after, 'Pile P02')).toBe('P03');
    // the really new pile gets one measurement, under the number it has now
    expect(c.added).toHaveLength(1);
    expect(at(c.added, 0).origin?.pile).toBe('P01');
    expect(kit.map((m) => m.origin?.pile).sort()).toEqual(['P01', 'P02', 'P03']);
    expect(after.kitPilesConverted).toEqual(['P01', 'P02', 'P03']);
  });

  it('swapped numbers swap the links and add nothing', () => {
    const before = first();
    const v = build([onRing('P01', sq(100)), onRing('P02', sq(0))]);
    const c = convertKitPiles(v, null, before, later());
    expect(c.added).toEqual([]);
    const after = withKitConversion(before, c);
    expect(pileOf(after, 'Pile P01')).toBe('P02');
    expect(pileOf(after, 'Pile P02')).toBe('P01');
    expect(after.kitPilesConverted).toEqual(['P01', 'P02']);
  });

  it('under half of the smaller area is not the same pile', () => {
    const before = first();
    // A is gone; B is now P01, and a new pile grazing A's old place (20 %) is P02
    const v = build([onRing('P01', sq(100)), onRing('P02', sq(8))]);
    const c = convertKitPiles(v, null, before, later());
    const after = withKitConversion(before, c);
    expect(pileOf(after, 'Pile P02')).toBe('P01');
    // the grazing pile is new; A's measurement no longer names a kit pile
    expect(c.added.map((m) => m.origin?.pile)).toEqual(['P02']);
    expect(after.measurements.find((m) => m.label === 'Pile P01')?.origin).toBeUndefined();
    const ids = after.measurements.flatMap((m) => (m.origin ? [m.origin.pile] : []));
    expect(ids.sort()).toEqual(['P01', 'P02']);
  });

  it("a number alone is not the same pile: a far-away new pile under a gone pile's number is new", () => {
    const before = first();
    const a = before.measurements.find((m) => m.label === 'Pile P01');
    // A (P01) is gone, B keeps P02, a new pile far away takes P01
    const v = build([onRing('P01', sq(500)), onRing('P02', sq(100))]);
    const c = convertKitPiles(v, null, before, later());
    expect(c.added.map((m) => m.origin?.pile)).toEqual(['P01']);
    const after = withKitConversion(before, c);
    const kept = after.measurements.find((m) => m.id === a?.id);
    // A's measurement keeps its figures and loses its kit link
    expect(kept?.origin).toBeUndefined();
    expect(kept?.results).toEqual(a?.results);
    expect(kept?.points).toEqual(a?.points);
    expect(pileOf(after, 'Pile P02')).toBe('P02');
    expect(after.kitPilesConverted).toEqual(['P01', 'P02']);
  });

  it('after a build, a converted pile with no measurement over it comes back', () => {
    const start = first();
    // the person deleted A's measurement
    const deleted = {
      ...start,
      measurements: start.measurements.filter((m) => m.label !== 'Pile P01'),
    };
    const v = build([onRing('P01', sq(0)), onRing('P02', sq(100))]);
    const rebuilt = convertKitPiles(v, null, deleted, { ...later(), rebuilt: true });
    expect(rebuilt.added.map((m) => m.origin?.pile)).toEqual(['P01']);
    expect(rebuilt.converted).toEqual([]);
    // opening the project again (no build) leaves it deleted
    expect(convertKitPiles(v, null, deleted, later()).added).toEqual([]);
  });

  it('after a build, a converted pile an existing kit-pile measurement covers is skipped', () => {
    const start = first();
    const file = { ...start, kitPilesConverted: ['P01', 'P02', 'P03'] };
    // P03 lies on B, whose measurement P02 already takes
    const v = build([onRing('P01', sq(0)), onRing('P02', sq(100)), onRing('P03', sq(101))]);
    const c = convertKitPiles(v, null, file, { ...later(), rebuilt: true });
    expect(c.added).toEqual([]);
  });

  it('the same build again changes nothing', () => {
    const before = first();
    const v = build([onRing('P01', sq(0)), onRing('P02', sq(100))]);
    const c = convertKitPiles(v, null, before, later());
    expect(c).toEqual({ added: [], converted: [], relinked: [], detached: [] });
  });

  it('openWithKitPiles keeps the relinks, and opening again changes nothing', () => {
    const o = (newId: () => string) => ({
      origin: [0, 0, 0],
      materials: [],
      now: NOW,
      newId,
      readOnly: false,
    });
    let k = 0;
    const placed = openWithKitPiles(
      empty({ kitPilesConverted: [] }),
      { volumes: build([onRing('P01', sq(0)), onRing('P02', sq(100))]), edits: null },
      o(() => `k${String(++k)}`),
    );
    const kit = { volumes: build([onRing('P01', sq(100)), onRing('P02', sq(0))]), edits: null };
    const relinked = openWithKitPiles(
      placed,
      kit,
      o(() => 'x'),
    );
    expect(relinked).not.toBe(placed);
    expect(relinked.measurements.map((m) => m.origin?.pile)).toEqual(['P02', 'P01']);
    expect(
      openWithKitPiles(
        relinked,
        kit,
        o(() => 'x'),
      ),
    ).toBe(relinked);
  });
});
