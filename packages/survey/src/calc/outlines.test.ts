import type { MeasurementsFile, SitePoint, SurveyMeasurement, VolumesFile } from '@aio/schema';
import { MeasurementsFile as MeasurementsFileSchema } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { kitToSite, openWithKitPiles } from './kitPiles';
import { addKitOutlines, kitOutlines, outlineOn, seriesRequests } from './outlines';

const sq = (x0: number, z0: number, s: number): [number, number][] => [
  [x0, z0],
  [x0 + s, z0],
  [x0 + s, z0 + s],
  [x0, z0 + s],
];
const fc = { fill: 0, cut: 0, net: 0 };
const vols = { tin: fc, plane: fc, avg: fc, low: fc };
const ORIGIN = [1000, 2000, 0];
const toSite = (xz: readonly [number, number]) => kitToSite(ORIGIN, xz);
const site = (r: [number, number][]): SitePoint[] => r.map((xz) => toSite(xz));

const RING_1 = sq(0, 0, 10);
const RING_2 = sq(30, 30, 6);

function volumes(): VolumesFile {
  const ep = (captureId: string, ring: [number, number][]) => ({
    captureId,
    areaM2: 1,
    topM: 1,
    heightM: 1,
    ring,
    volumes: vols,
  });
  return {
    schema: 'aio.volumes/1',
    densityTPerM3: 1.6,
    deadbandM: 0.1,
    defaultBase: 'tin',
    bases: [],
    captures: [
      { epoch: 'e1', captureId: 'c1', date: '2026-01-01', label: '1 Jan 2026' },
      { epoch: 'e2', captureId: 'c2', date: '2026-02-01', label: '1 Feb 2026' },
    ],
    piles: [
      {
        id: 'P01',
        name: 'Pile 1',
        zoneRing: RING_2,
        change: fc,
        epochs: { e1: ep('c1', RING_1), e2: ep('c2', RING_2) },
      },
      {
        id: 'P02',
        name: 'Pile 2',
        zoneRing: RING_2,
        change: fc,
        epochs: { e1: ep('c1', []), e2: ep('c2', sq(60, 0, 5)) },
      },
    ],
    totals: {},
    pileChange: fc,
    siteChange: fc,
  };
}

const measurement = (
  id: string,
  points: SitePoint[],
  over: Partial<SurveyMeasurement> = {},
): SurveyMeasurement => ({
  id,
  family: 'polygon',
  tool: 'volume',
  label: id,
  scope: { kind: 'site' },
  points,
  items: [],
  results: [],
  createdAt: '2026-10-25T00:00:00Z',
  ...over,
});
const kitPile = (id: string, pile: string, points: SitePoint[]) =>
  measurement(id, points, { origin: { kind: 'kit-pile', pile } });

/** A project converted before per-date outlines: kit piles with only the latest toe line. */
const oldFile = (): MeasurementsFile => ({
  schema: 'aio.measurements/1',
  measurements: [kitPile('m1', 'P01', site(RING_2)), kitPile('m2', 'P02', site(sq(60, 0, 5)))],
  kitPilesConverted: ['P01', 'P02'],
});

describe('outlineOn and seriesRequests', () => {
  const a = site(RING_1);
  const b = site(RING_2);

  it("outlineOn is the date's own outline, else points", () => {
    const m = measurement('m', b, { outlines: [{ capture: 'c1', points: a }] });
    expect(outlineOn(m, 'c1')).toBe(a);
    expect(outlineOn(m, 'c2')).toBe(b);
    expect(outlineOn(measurement('n', b), 'c1')).toBe(b);
  });

  it('one run over every capture without outlines', () => {
    expect(seriesRequests(measurement('m', b), ['c1', 'c2', 'c3'])).toEqual([
      { ring: b, captures: ['c1', 'c2', 'c3'] },
    ]);
  });

  it('one run per distinct outline, in capture order; equal vertices share a run', () => {
    const m = measurement('m', b, {
      outlines: [
        { capture: 'c2', points: a },
        { capture: 'c3', points: b.map((p): SitePoint => [p[0], p[1], 7]) },
      ],
    });
    const reqs = seriesRequests(m, ['c1', 'c2', 'c3', 'c4']);
    expect(reqs.map((r) => r.captures)).toEqual([['c1', 'c3', 'c4'], ['c2']]);
    expect(reqs[0]?.ring).toBe(b);
    expect(reqs[1]?.ring).toBe(a);
  });
});

describe('kitOutlines', () => {
  it('one outline per date with a toe line, in survey order, by capture id', () => {
    const v = volumes();
    const [p1, p2] = v.piles;
    if (!p1 || !p2) throw new Error('missing pile');
    expect(kitOutlines(p1, v, toSite)).toEqual([
      { capture: 'c1', points: site(RING_1) },
      { capture: 'c2', points: site(RING_2) },
    ]);
    // a date with no toe line has no outline
    expect(kitOutlines(p2, v, toSite).map((o) => o.capture)).toEqual(['c2']);
  });

  it("drapes each outline on its own date's DSM", () => {
    const v = volumes();
    const p1 = v.piles[0];
    if (!p1) throw new Error('missing pile');
    const o = kitOutlines(p1, v, toSite, (epoch) => (epoch === 'e1' ? 11 : 22));
    expect(o.map((x) => x.points.every((p) => p[2] === (x.capture === 'c1' ? 11 : 22)))).toEqual([
      true,
      true,
    ]);
  });
});

describe('addKitOutlines: the one-time fill for projects converted before outlines', () => {
  it("fills unmoved kit piles with each date's outline and lists them", () => {
    const { file, changed } = addKitOutlines(oldFile(), volumes(), null, { toSite });
    expect(changed).toEqual(['m1', 'm2']);
    expect(file.kitOutlinesAdded).toEqual(['m1', 'm2']);
    expect(file.measurements[0]?.outlines?.map((o) => o.capture)).toEqual(['c1', 'c2']);
    expect(file.measurements[0]?.points).toEqual(site(RING_2));
    expect(MeasurementsFileSchema.safeParse(file).success).toBe(true);
  });

  it('never runs twice', () => {
    const once = addKitOutlines(oldFile(), volumes(), null, { toSite }).file;
    // even with the outlines gone again, a listed id is not filled twice
    const stripped: MeasurementsFile = {
      ...once,
      measurements: once.measurements.map((m) => {
        const rest = { ...m };
        delete rest.outlines;
        return rest;
      }),
    };
    const twice = addKitOutlines(stripped, volumes(), null, { toSite });
    expect(twice.changed).toEqual([]);
    expect(twice.file).toBe(stripped);
  });

  it('a pile the person moved or reshaped gets none, and other measurements are untouched', () => {
    const f = oldFile();
    f.measurements = [
      kitPile('m1', 'P01', site(sq(31, 30, 6))),
      kitPile('m2', 'P02', site(sq(60, 0, 8))),
      measurement('m3', site(RING_2)),
      kitPile('m4', 'gone', site(RING_2)),
    ];
    const r = addKitOutlines(f, volumes(), null, { toSite });
    expect(r.changed).toEqual([]);
    expect(r.file).toBe(f);
  });

  it('a hand-edited toe line counts as the latest one', () => {
    const f = oldFile();
    const edited = sq(30, 30, 7);
    const m1 = f.measurements[0];
    if (!m1) throw new Error('missing');
    f.measurements = [{ ...m1, points: site(edited) }];
    const r = addKitOutlines(
      f,
      volumes(),
      {
        schema: 'aio.boundaries/1',
        edits: [
          {
            pile: 'P01',
            epoch: 'e2',
            ring: edited,
            volumes: vols,
            areaM2: 49,
            topM: 1,
            heightM: 1,
            autoNet: 0,
            updatedAt: '2026-10-25T00:00:00Z',
          },
        ],
      },
      { toSite },
    );
    expect(r.changed).toEqual(['m1']);
    expect(r.file.measurements[0]?.outlines?.[1]?.points).toEqual(site(edited));
  });
});

describe('openWithKitPiles adds the outlines once', () => {
  const openOpts = { origin: ORIGIN, materials: [], now: 'now', newId: () => 'x' };

  it('an old converted project gets its outlines, and opening again changes nothing', () => {
    const kit = { volumes: volumes(), edits: null };
    const opened = openWithKitPiles(oldFile(), kit, { ...openOpts, readOnly: false });
    expect(opened.kitOutlinesAdded).toEqual(['m1', 'm2']);
    expect(opened.measurements.every((m) => (m.outlines?.length ?? 0) > 0)).toBe(true);
    expect(openWithKitPiles(opened, kit, { ...openOpts, readOnly: false })).toBe(opened);
  });

  it('a fresh conversion carries outlines without listing them', () => {
    let n = 0;
    const opened = openWithKitPiles(
      { schema: 'aio.measurements/1', measurements: [] },
      { volumes: volumes(), edits: null },
      { ...openOpts, newId: () => `id${String(++n)}`, readOnly: false },
    );
    expect(opened.measurements[0]?.outlines?.map((o) => o.capture)).toEqual(['c1', 'c2']);
    expect(opened.kitOutlinesAdded).toBeUndefined();
  });
});
