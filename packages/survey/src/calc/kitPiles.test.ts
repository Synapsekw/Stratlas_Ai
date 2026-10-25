import type {
  BoundaryEditsFile,
  MeasurementsFile,
  SitePoint,
  SurveyMeasurement,
  VolumesFile,
} from '@aio/schema';
import { MeasurementsFile as MeasurementsFileSchema } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  KIT_BASE_LABEL,
  KIT_FOLDER,
  KIT_MATERIAL_NAME,
  kitBaseLabel,
  kitDensity,
  pileMaterial,
  convertKitPiles,
  deliberatelyDeletedKitPiles,
  restorableKitPiles,
  vanishedKitPiles,
  drapeZ,
  kitConversion,
  kitEpochOf,
  kitToSite,
  needsHeightRepair,
  repairKitHeights,
  openWithKitPiles,
  overlapShare,
  withKitConversion,
} from './kitPiles';

const at = <T>(a: readonly T[] | undefined, i: number): T => {
  const v = a?.[i];
  if (v === undefined) throw new Error('missing item');
  return v;
};

const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error('missing');
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

  it('places kit points through the origin: x east, z south, Z as given (0 without one)', () => {
    expect(kitToSite([1000, 2000, 50], [4, 3])).toEqual([1004, 1997, 0]);
    expect(kitToSite([1000, 2000, 50], [4, 3], 52.5)).toEqual([1004, 1997, 52.5]);
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

  it("keeps the kit's density when no site material matches: tonnes stay", () => {
    const none = { ...opts(false), materials: [] };
    const v = volumes();
    const file = openWithKitPiles(empty(), { volumes: v, edits: null }, none);
    const [p1, p2] = file.measurements;
    // nothing invented in the file: no material id the site does not have
    expect(p1?.material).toBeUndefined();
    expect(p2?.material).toBeUndefined();
    const kit = kitDensity(v);
    const site = [{ id: 'other', name: 'Other', densityTPerM3: 2 }];
    // worked out at read time from the kit: its density, named after its material or not at all
    const m1 = pileMaterial(must(p1), site, kit);
    const m2 = pileMaterial(must(p2), site, kit);
    expect(m1?.densityTPerM3).toBe(1.6);
    expect(m1?.name).toBe('Sand');
    expect(m2?.densityTPerM3).toBe(1.6);
    expect(m2?.name).toBe(KIT_MATERIAL_NAME);
    // a site material the person chose wins; one deleted since falls back to the kit's density
    expect(pileMaterial({ ...must(p1), material: 'other' }, site, kit)?.densityTPerM3).toBe(2);
    expect(pileMaterial({ ...must(p1), material: 'gone' }, site, kit)?.densityTPerM3).toBe(1.6);
    // no kit data, or not a kit pile: only the site's own
    expect(pileMaterial(must(p1), site, null)).toBeNull();
    expect(pileMaterial({ material: undefined, origin: undefined }, site, kit)).toBeNull();
    // a site material named as the kit's is stored at conversion, as before
    const named = openWithKitPiles(empty(), { volumes: v, edits: null }, opts(false));
    expect(named.measurements[0]?.material).toBe('sand');
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
    const c = convertKitPiles(v, null, before, { ...later(), rebuilt: true });
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
    const c = convertKitPiles(v, null, before, { ...later(), rebuilt: true });
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
    const c = convertKitPiles(v, null, before, { ...later(), rebuilt: true });
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

  it("opening after the person moved a pile's outline adds nothing and keeps its link", () => {
    const before = first();
    // A's measurement dragged off its toe line (under half of it still in common)
    const moved = {
      ...before,
      measurements: before.measurements.map((m) =>
        m.label === 'Pile P01'
          ? { ...m, points: m.points.map((p): [number, number, number] => [p[0] + 8, p[1], p[2]]) }
          : m,
      ),
    };
    const v = build([onRing('P01', sq(0)), onRing('P02', sq(100))]);
    const c = convertKitPiles(v, null, moved, later());
    expect(c).toEqual({ added: [], converted: [], relinked: [], detached: [] });
    const opened = openWithKitPiles(
      moved,
      { volumes: v, edits: null },
      {
        origin: [0, 0, 0],
        materials: [],
        now: NOW,
        newId: () => 'x',
        readOnly: false,
      },
    );
    expect(opened).toBe(moved);
    // a build does look again: the moved measurement no longer covers P01, so P01 comes back
    const rebuilt = convertKitPiles(v, null, moved, { ...later(), rebuilt: true });
    expect(rebuilt.added.map((m) => m.origin?.pile)).toEqual(['P01']);
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

describe('kit pile heights: drape at conversion, one-time repair', () => {
  const origin = [1000, 2000, 51];
  const openOpts = (heightAt?: (epoch: string, e: number, n: number) => number | null) => {
    let n = 0;
    return {
      origin,
      materials: [],
      now: NOW,
      newId: () => `id-${String(++n)}`,
      ...(heightAt ? { heightAt } : {}),
    };
  };

  it('conversion drapes the outline on the kit DSM', () => {
    const asked = new Set<string>();
    const c = kitConversion(
      empty(),
      volumes(),
      null,
      true,
      openOpts((epoch, e) => {
        asked.add(epoch);
        return 100 + e * 0.01;
      }),
    );
    expect(c.added).toHaveLength(2);
    for (const m of c.added)
      for (const p of m.points) expect(p[2]).toBeCloseTo(100 + p[0] * 0.01, 9);
    // `points` is draped with the epoch whose toe line it is (both piles' latest: e2), and each
    // date's outline with its own epoch
    expect([...asked]).toEqual(['e2', 'e1']);
  });

  it('conversion drapes an edited outline with the epoch of the edit', () => {
    const v = volumes();
    v.piles = [{ ...at(v.piles, 0), epochs: { e1: ep('c1', 100) } }];
    const asked = new Set<string>();
    const heightAt = (epoch: string) => {
      asked.add(epoch);
      return epoch === 'e1' ? 7 : 9;
    };
    const plain = kitConversion(empty(), v, null, true, openOpts(heightAt));
    expect([...asked]).toEqual(['e1']);
    expect(at(plain.added, 0).points.every((p) => p[2] === 7)).toBe(true);
    asked.clear();
    const edited = kitConversion(empty(), v, edits, true, openOpts(heightAt));
    // the edit adds an e2 toe line: `points` is draped on e2, the outlines on their own dates
    expect(at(edited.added, 0).points.every((p) => p[2] === 9)).toBe(true);
    expect([...asked]).toEqual(['e2', 'e1']);
  });

  it('conversion without heightAt keeps Z 0', () => {
    const c = kitConversion(empty(), volumes(), null, true, openOpts());
    for (const m of c.added) for (const p of m.points) expect(p[2]).toBe(0);
  });

  it('conversion keeps Z 0 when the DSM has no height under the outline', () => {
    const c = kitConversion(
      empty(),
      volumes(),
      null,
      true,
      openOpts(() => null),
    );
    for (const m of c.added) for (const p of m.points) expect(p[2]).toBe(0);
  });

  it('drapeZ fills holes from the previous vertex and leading holes from the first found', () => {
    const pts: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
      [4, 0, 0],
    ];
    const h = new Map([
      [2, 12],
      [4, 14],
    ]);
    expect(drapeZ(pts, (e) => h.get(e) ?? null)).toEqual([12, 12, 12, 12, 14]);
  });

  it('drapeZ returns null when nothing has a height', () => {
    expect(drapeZ([[0, 0, 0]], () => null)).toBeNull();
    expect(drapeZ([], () => 1)).toBeNull();
    // a non-finite height counts as none
    expect(drapeZ([[0, 0, 0]], () => Number.NaN)).toBeNull();
  });

  const converted = (): MeasurementsFile =>
    withKitConversion(empty(), kitConversion(empty(), volumes(), null, true, openOpts()));

  it('kitEpochOf reads the headline, else the latest carried date in the series', () => {
    const [p1, p2] = converted().measurements;
    const m1 = must(p1);
    const m2 = must(p2);
    expect(kitEpochOf(m1)).toBe('e2');
    expect(kitEpochOf({ ...m1, results: [] })).toBe('e2');
    expect(kitEpochOf({ ...m1, results: [], series: (m1.series ?? []).slice(0, 1) })).toBe('e1');
    expect(kitEpochOf({ ...m2, results: [] })).toBe('e2');
    expect(kitEpochOf({ ...m2, results: [], series: [] })).toBeNull();
    const plain = { ...m2, results: [] };
    delete plain.series;
    expect(kitEpochOf(plain)).toBeNull();
  });

  it('needsHeightRepair: an all-zero kit pile not repaired yet, whatever the origin height', () => {
    const file = converted();
    const m = must(file.measurements[0]);
    expect(needsHeightRepair(m, file)).toBe(true);
    // a pile a person already edited (one vertex moved) is never re-heighted
    const moved: SurveyMeasurement = {
      ...m,
      points: m.points.map((p, i): SitePoint => (i === 1 ? [p[0], p[1], 52] : p)),
    };
    expect(needsHeightRepair(moved, file)).toBe(false);
    expect(needsHeightRepair(m, { ...file, kitHeightsRepaired: [m.id] })).toBe(false);
    const own = { ...m };
    delete own.origin;
    expect(needsHeightRepair(own, file)).toBe(false);
  });

  it('repairKitHeights sets Z, lists the id, and keeps updatedAt, pickedOn, results, series, previousResults', () => {
    const base = converted();
    const m0 = must(base.measurements[0]);
    const m: SurveyMeasurement = {
      ...m0,
      updatedAt: '2026-10-21T00:00:00.000Z',
      pickedOn: m0.points.map(() => 'ground' as const),
      previousResults: [{ netM3: 1, totalM3: 2, label: 'was', replacedAt: NOW }],
    };
    const file: MeasurementsFile = { ...base, measurements: [m, ...base.measurements.slice(1)] };
    const z = m.points.map((_, i) => 50 + i);
    const out = repairKitHeights(file, new Map([[m.id, z]]));
    expect(out.repaired).toEqual([m.id]);
    expect(out.file.kitHeightsRepaired).toEqual([m.id]);
    const r = must(out.file.measurements[0]);
    expect(r.points.map((p) => p[2])).toEqual(z);
    expect(r.points.map((p) => [p[0], p[1]])).toEqual(m.points.map((p) => [p[0], p[1]]));
    expect(r.updatedAt).toBe(m.updatedAt);
    expect(r.pickedOn).toEqual(m.pickedOn);
    expect(r.results).toEqual(m.results);
    expect(r.series).toEqual(m.series);
    expect(r.previousResults).toEqual(m.previousResults);
    // the other pile is untouched, the same object
    expect(out.file.measurements[1]).toBe(file.measurements[1]);
    expect(MeasurementsFileSchema.safeParse(out.file).success).toBe(true);
  });

  it('repairKitHeights skips an id whose heights do not match the point count', () => {
    const file = converted();
    const m = must(file.measurements[0]);
    const short = repairKitHeights(file, new Map([[m.id, [50]]]));
    expect(short.repaired).toEqual([]);
    expect(short.file).toBe(file);
    const bad = repairKitHeights(file, new Map([[m.id, m.points.map(() => Number.NaN)]]));
    expect(bad.repaired).toEqual([]);
    expect(repairKitHeights(file, new Map([['nope', [1, 2, 3]]])).repaired).toEqual([]);
  });

  it('running repairKitHeights twice lists each id once', () => {
    const file = converted();
    const m = must(file.measurements[0]);
    const z = m.points.map(() => 50);
    const once = repairKitHeights(file, new Map([[m.id, z]]));
    const twice = repairKitHeights(once.file, new Map([[m.id, z]]));
    expect(twice.file.kitHeightsRepaired).toEqual([m.id]);
  });
});

describe('kit piles: each date keeps its own toe line', () => {
  const origin = [1000, 2000, 51];
  const moved: [number, number][] = [
    [10, 10],
    [16, 10],
    [16, 14],
    [10, 14],
  ];
  const twoRings = (): VolumesFile => {
    const v = volumes();
    const p = at(v.piles, 0);
    v.piles = [{ ...p, epochs: { e1: { ...ep('c1', 100), ring: moved }, e2: ep('c2', 50) } }];
    return v;
  };

  it('converts a two-epoch pile with an outline per epoch, each draped on its date', () => {
    let n = 0;
    const c = kitConversion(empty(), twoRings(), null, true, {
      origin,
      materials: [],
      now: NOW,
      newId: () => `id-${String(++n)}`,
      heightAt: (epoch) => (epoch === 'e1' ? 40 : 45),
    });
    const m = at(c.added, 0);
    // `points` is still the latest toe line (e2)
    expect(m.points).toEqual(ring.map(([x, z]) => [1000 + x, 2000 - z, 45]));
    expect(m.outlines).toEqual([
      { capture: 'c1', points: moved.map(([x, z]) => [1000 + x, 2000 - z, 40]) },
      { capture: 'c2', points: ring.map(([x, z]) => [1000 + x, 2000 - z, 45]) },
    ]);
    expect(MeasurementsFileSchema.safeParse(empty({ measurements: c.added })).success).toBe(true);
  });

  it("an edited toe line is that date's outline", () => {
    const c = convertKitPiles(twoRings(), edits, empty(), opts(false));
    const m = at(c.added, 0);
    expect(m.outlines?.map((o) => o.capture)).toEqual(['c1', 'c2']);
    expect(must(m.outlines?.[1]).points).toEqual(m.points);
    expect(must(m.outlines?.[1]).points).toHaveLength(4);
  });
});

describe('a converted kit pile whose measurement vanished (the journal decides)', () => {
  const sq = (x: number, size = 10): [number, number][] => [
    [x, 0],
    [x + size, 0],
    [x + size, size],
    [x, size],
  ];
  const onRing = (id: string, r: [number, number][]) => ({
    id,
    name: `Pile ${id}`,
    zoneRing: r,
    change: fc(0),
    epochs: { e1: { ...ep('c1', 100), ring: r }, e2: { ...ep('c2', 50), ring: r } },
  });
  const kit = (): VolumesFile => ({
    ...volumes(),
    piles: [onRing('P01', sq(0)), onRing('P02', sq(100)), onRing('P03', sq(200))],
  });
  /** Opened once as an old project, then P01's measurement left the file. */
  const vanished = () => {
    const start = empty();
    const all = withKitConversion(start, convertKitPiles(kit(), null, start, opts(true)));
    const gone = all.measurements.find((m) => m.origin?.pile === 'P01');
    return {
      gone: must(gone),
      file: { ...all, measurements: all.measurements.filter((m) => m !== gone) },
    };
  };
  const later = (deletedKitPiles?: { has(id: string): boolean }) => {
    let n = 100;
    return {
      ...opts(false),
      newId: () => `n${String(++n)}`,
      ...(deletedKitPiles ? { deletedKitPiles } : {}),
    };
  };

  let clock = 0;
  type Entry = Parameters<typeof deliberatelyDeletedKitPiles>[0][number];
  const entry = (kind: string, id: string, over: Partial<Entry> = {}): Entry => ({
    op: `op${String(++clock)}`,
    hlc: `${String(1_800_000_000_000 + clock)}.0000.chain`,
    kind,
    target: { rec: 'measurement', id },
    how: 'hand',
    ...over,
  });
  const created = (m: SurveyMeasurement, over: Partial<Entry> = {}) =>
    entry('measurement.create', m.id, {
      label: 'Stockpile kit piles converted to volume measurements',
      changes: [{ field: 'record', after: m }],
      ...over,
    });
  const deleted = (id: string, over: Partial<Entry> = {}) => entry('measurement.delete', id, over);
  /** History, newest first, as `journal:history` returns it. */
  const history = (...oldestFirst: Entry[]) => [...oldestFirst].reverse();

  it('without journal evidence, the pile stays gone (the old rule)', () => {
    const { file } = vanished();
    const c = convertKitPiles(kit(), null, file, later());
    expect(c).toEqual({ added: [], converted: [], relinked: [], detached: [] });
  });

  it('with the journal read and no deliberate deletion, the pile comes back with its kit figures', () => {
    const { file, gone } = vanished();
    const c = convertKitPiles(kit(), null, file, later(new Set()));
    expect(c.added).toHaveLength(1);
    const m = at(c.added, 0);
    expect(m.origin).toEqual({ kind: 'kit-pile', pile: 'P01' });
    expect(m.label).toBe('Pile P01');
    expect(m.folder).toBe(KIT_FOLDER);
    // converted exactly as a first conversion does: carried figures, outlines, the same points
    expect(m.points).toEqual(gone.points);
    expect(m.series?.map((r) => r.fingerprint)).toEqual(['kit:P01:e1:plane', 'kit:P01:e2:plane']);
    expect(at(m.results, 0).netM3).toBe(v4(50).plane.net);
    expect(m.outlines?.map((o) => o.capture)).toEqual(['c1', 'c2']);
    // listed once already: not listed again
    expect(c.converted).toEqual([]);
    const after = withKitConversion(file, c);
    expect(after.kitPilesConverted).toEqual(['P01', 'P02', 'P03']);
    expect(MeasurementsFileSchema.safeParse(after).success).toBe(true);
    // opening again changes nothing
    const again = convertKitPiles(kit(), null, after, later(new Set()));
    expect(again).toEqual({ added: [], converted: [], relinked: [], detached: [] });
  });

  it('a pile still held by a measurement (its outline moved) is not added again', () => {
    const { file } = vanished();
    const moved = {
      ...file,
      measurements: file.measurements.map((m) =>
        m.origin?.pile === 'P02'
          ? { ...m, points: m.points.map((p): SitePoint => [p[0] + 40, p[1], p[2]]) }
          : m,
      ),
    };
    const c = convertKitPiles(kit(), null, moved, later(new Set()));
    expect(c.added.map((m) => m.origin?.pile)).toEqual(['P01']);
  });

  it('a pile the journal shows deliberately deleted stays gone', () => {
    const { file } = vanished();
    const c = convertKitPiles(kit(), null, file, later(new Set(['P01'])));
    expect(c).toEqual({ added: [], converted: [], relinked: [], detached: [] });
  });

  it('right after a build the rule is unchanged: the evidence is not read', () => {
    const { file } = vanished();
    const without = convertKitPiles(kit(), null, file, { ...later(), rebuilt: true });
    const withIt = convertKitPiles(kit(), null, file, {
      ...later(new Set(['P01'])),
      rebuilt: true,
    });
    expect(withIt).toEqual(without);
  });

  it('openWithKitPiles restores through the same option', () => {
    const { file } = vanished();
    const o = (deletedKitPiles?: ReadonlySet<string>) => {
      let n = 0;
      return {
        origin: [1000, 2000, 0],
        materials: [],
        now: NOW,
        newId: () => `o${String(++n)}`,
        readOnly: false,
        ...(deletedKitPiles ? { deletedKitPiles } : {}),
      };
    };
    const k = { volumes: kit(), edits: null };
    expect(openWithKitPiles(file, k, o())).toBe(file);
    const restored = openWithKitPiles(file, k, o(new Set()));
    expect(restored.measurements.filter((m) => m.origin?.pile === 'P01')).toHaveLength(1);
    expect(restored.kitPilesConverted).toEqual(['P01', 'P02', 'P03']);
  });

  describe('vanishedKitPiles: whether the journal needs reading', () => {
    it('lists converted piles no kit-pile measurement holds', () => {
      const { file } = vanished();
      expect(vanishedKitPiles(file, kit(), null, [1000, 2000, 0])).toEqual(['P01']);
    });

    it('is empty when every converted pile is held, or nothing was converted yet', () => {
      const start = empty();
      const all = withKitConversion(start, convertKitPiles(kit(), null, start, opts(true)));
      expect(vanishedKitPiles(all, kit(), null, [1000, 2000, 0])).toEqual([]);
      expect(vanishedKitPiles(empty(), kit(), null, [1000, 2000, 0])).toEqual([]);
      // a pile not converted yet is a first conversion, not a vanished one
      expect(
        vanishedKitPiles(empty({ kitPilesConverted: ['P02'] }), kit(), null, [1000, 2000, 0]),
      ).toEqual(['P02']);
    });
  });

  describe('restorableKitPiles: only positive evidence restores', () => {
    const list = (e: Entry[]) => [...restorableKitPiles(e)];

    it('a clean accidental loss (create entry, no delete) is restorable', () => {
      const { gone } = vanished();
      expect(list(history(created(gone)))).toEqual(['P01']);
      const stay = deliberatelyDeletedKitPiles(history(created(gone)));
      expect(stay.has('P01')).toBe(false);
      expect(stay.has('P02')).toBe(true);
    });

    it('a delete by hand or by the assistant is not restorable', () => {
      const { gone } = vanished();
      for (const how of ['hand', 'agent'] as const) {
        const entries = history(created(gone), deleted(gone.id, { how }));
        expect(list(entries)).toEqual([]);
        expect(deliberatelyDeletedKitPiles(entries).has('P01')).toBe(true);
      }
    });

    it('a delete of any origin (external, migration, refused write, pipeline, import) is not', () => {
      const { gone } = vanished();
      const overs: Partial<Entry>[] = [
        { how: 'external' },
        { label: 'Stockpile piles recomputed with the standard base' },
        { label: 'Not saved, change undone' },
        { how: 'pipeline' },
        { how: 'import' },
      ];
      for (const over of overs)
        expect(list(history(created(gone), deleted(gone.id, over)))).toEqual([]);
    });

    it('no create entry in the journal: not restorable, with or without a delete', () => {
      const { gone } = vanished();
      expect(list([])).toEqual([]);
      expect(list(history(deleted(gone.id)))).toEqual([]);
      expect(list(history(deleted(gone.id, { how: 'external' })))).toEqual([]);
      const patch = entry('measurement.patch', gone.id, {
        changes: [{ field: 'origin', after: { kind: 'kit-pile', pile: 'P01' } }],
      });
      expect(list(history(patch))).toEqual([]);
      expect(deliberatelyDeletedKitPiles([]).has('P01')).toBe(true);
      // end to end: such a journal leaves the vanished pile gone
      const { file } = vanished();
      const c = convertKitPiles(kit(), null, file, later(deliberatelyDeletedKitPiles([])));
      expect(c.added).toEqual([]);
    });

    it('journal absent: no set is passed and the pile is not restored', () => {
      const { file } = vanished();
      expect(convertKitPiles(kit(), null, file, later()).added).toEqual([]);
    });

    it('a delete of a measurement that was not a kit pile names no pile', () => {
      const drawn: SurveyMeasurement = { ...vanished().gone, id: 'drawn' };
      delete drawn.origin;
      expect(list(history(created(drawn), deleted('drawn')))).toEqual([]);
    });

    it('a patch that relinks the pile follows it; a delete after it blocks the new pile', () => {
      const { gone } = vanished();
      const relink = () =>
        entry('measurement.patch', gone.id, {
          label: 'Stockpile piles renumbered by a build',
          changes: [
            { field: 'origin', before: gone.origin, after: { kind: 'kit-pile', pile: 'P03' } },
          ],
        });
      expect(list(history(created(gone), relink()))).toEqual(['P03']);
      expect(list(history(created(gone), relink(), deleted(gone.id)))).toEqual([]);
    });

    it('a patch that drops the link names no pile', () => {
      const { gone } = vanished();
      const drop = () =>
        entry('measurement.patch', gone.id, {
          changes: [{ field: 'origin', before: gone.origin }],
        });
      expect(list(history(created(gone), drop()))).toEqual([]);
    });

    it('a pile added again after a delete is judged by the new measurement', () => {
      const { gone } = vanished();
      const again = { ...gone, id: 'again' };
      const base = [created(gone), deleted(gone.id), created(again, { label: 'added by a build' })];
      expect(list(history(...base))).toEqual(['P01']);
      expect(list(history(...base, deleted('again', { how: 'external' })))).toEqual([]);
    });
  });
});
