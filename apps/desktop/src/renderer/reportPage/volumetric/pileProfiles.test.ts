// A pile's elevation profile for the volumetric report: the pile panel's default line, the
// surveys along it as the report page samples them, and the pile's own base under it (the pile
// look's base, `pileBase`), kept inside the outline.
import type { BaseSpec, SitePoint, SurveyMeasurement } from '@aio/schema';
import { pileAxis } from '@aio/survey';
import { describe, expect, it } from 'vitest';
import type { PointsAt } from '../../survey/pile/pileBase';
import { insideRing } from '../../survey/pile/pileLook';
import { pileProfile, type LineProfile, type PileProfileSource } from './pileProfiles';

/** A 40 m by 30 m boundary whose own heights differ from the ground under it. */
const RING: SitePoint[] = [
  [1000, 2000, 50],
  [1040, 2000, 52],
  [1040, 2030, 54],
  [1000, 2030, 52],
];

/** The ground the pile stands on: a tilted plane. */
const plane = (e: number, n: number) => 100 + 0.1 * (e - 1000) + 0.05 * (n - 2000);
/** The pile: a cone 10 m wide about the middle, nothing of it at the boundary. */
const cone = (e: number, n: number, top: number) =>
  Math.max(0, top - (top / 10) * Math.hypot(e - 1020, n - 2015));
const latestGround = (e: number, n: number) => plane(e, n) + cone(e, n, 5);
const earlierGround = (e: number, n: number) => plane(e, n) + cone(e, n, 2);

const at =
  (f: (e: number, n: number) => number): PointsAt =>
  (es, ns) =>
    Promise.resolve(Float64Array.from(es, (e, k) => f(e, ns[k] ?? 0)));
const noSurvey: PointsAt = (es) => Promise.resolve(new Float64Array(es.length).fill(Number.NaN));

const STATIONS = 81;

/** A surface along the line, as the report page's `sampleProfiles` returns it. */
function along(
  line: readonly (readonly [number, number])[],
  f: (e: number, n: number) => number,
  kind: LineProfile['kind'],
  date: string,
): LineProfile {
  const [a, b] = line;
  if (!a || !b) throw new Error('no line');
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const chainage: number[] = [];
  const z: number[] = [];
  for (let k = 0; k < STATIONS; k++) {
    const s = k / (STATIONS - 1);
    chainage.push(length * s);
    z.push(f(a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s));
  }
  return { ...(kind ? { kind } : {}), date, chainage, z };
}

const LATEST = { id: 'c2', date: '2026-10-01' };
const EARLIER = { id: 'c1', date: '2026-09-03' };

const pile = (from?: BaseSpec): Pick<SurveyMeasurement, 'items'> => ({
  items: from ? [{ id: 'i1', from, to: { kind: 'current' }, useDeadband: false }] : [],
});

function source(over: Partial<PileProfileSource> = {}): PileProfileSource {
  const compared = 'compared' in over ? (over.compared ?? null) : EARLIER;
  return {
    m: pile({ kind: 'smart' }),
    ring: RING,
    latest: LATEST,
    compared,
    surfaces: (line) =>
      Promise.resolve([
        along(line, latestGround, 'current', LATEST.date),
        ...(compared ? [along(line, earlierGround, 'earlier', compared.date)] : []),
      ]),
    ground: at(latestGround),
    ...over,
  };
}

const seriesOf = async (src: PileProfileSource, kind: string) =>
  (await pileProfile(src))?.series.find((s) => s.kind === kind);

describe("a pile's elevation profile", () => {
  it('has the latest survey, the compared one and the base on the same stations', async () => {
    const p = await pileProfile(source());
    if (!p) throw new Error('no profile');
    expect(p.series.map((s) => s.kind)).toEqual(['current', 'earlier', 'base']);
    const [current, earlier, base] = p.series;
    expect(current?.chainage).toHaveLength(STATIONS);
    expect(earlier?.chainage).toEqual(current?.chainage);
    expect(base?.chainage).toEqual(current?.chainage);
    expect(base?.z).toHaveLength(STATIONS);
    // which survey each line is
    expect([current?.capture, current?.date]).toEqual(['c2', '2026-10-01']);
    expect([earlier?.capture, earlier?.date]).toEqual(['c1', '2026-09-03']);
    expect(base?.capture).toBeUndefined();
    // the pile stands 5 m over its base in the middle, 2 m on the earlier survey
    const mid = (STATIONS - 1) / 2;
    expect((current?.z[mid] ?? 0) - (base?.z[mid] ?? 0)).toBeCloseTo(5, 2);
    expect((earlier?.z[mid] ?? 0) - (base?.z[mid] ?? 0)).toBeCloseTo(2, 2);
    expect(p.baseKind).toBe('own');
  });

  it("runs along the pile panel's default line on the outline given", async () => {
    const p = await pileProfile(source());
    const axis = pileAxis(RING);
    expect(p?.a).toEqual([axis.a[0], axis.a[1]]);
    expect(p?.b).toEqual([axis.b[0], axis.b[1]]);
    expect(p?.lengthM).toBeCloseTo(axis.lengthM, 6);
    // the model is read through JSON
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });

  it('has no earlier line with one survey date', async () => {
    const p = await pileProfile(source({ compared: null }));
    expect(p?.series.map((s) => s.kind)).toEqual(['current', 'base']);
  });

  it('leaves out an earlier survey that has no data under the line', async () => {
    const p = await pileProfile(
      source({
        surfaces: (line) =>
          Promise.resolve([
            along(line, latestGround, 'current', LATEST.date),
            {
              ...along(line, () => 0, 'earlier', EARLIER.date),
              z: Array<null>(STATIONS).fill(null),
            },
          ]),
      }),
    );
    expect(p?.series.map((s) => s.kind)).toEqual(['current', 'base']);
  });

  it('keeps the base inside the outline only', async () => {
    const p = await pileProfile(source());
    const base = p?.series.find((s) => s.kind === 'base');
    if (!p || !base) throw new Error('no base');
    // the line reaches past the outline at both ends
    expect(base.z[0]).toBeNull();
    expect(base.z.at(-1)).toBeNull();
    let inside = 0;
    base.chainage.forEach((c, k) => {
      const s = c / p.lengthM;
      const e = p.a[0] + (p.b[0] - p.a[0]) * s;
      const n = p.a[1] + (p.b[1] - p.a[1]) * s;
      if (insideRing(e, n, RING)) {
        inside++;
        // the Toe surface: the ground under the boundary, the pile left out
        expect(base.z[k]).toBeCloseTo(plane(e, n), 2);
      } else expect(base.z[k]).toBeNull();
    });
    expect(inside).toBeGreaterThan(STATIONS / 2);
  });

  it('gives the lowest and highest base height under the pile', async () => {
    const p = await pileProfile(source());
    // the plane over the boundary: 100 at its south-west corner, 105.5 at its north-east
    expect(p?.baseLevel?.[0]).toBeCloseTo(100, 0);
    expect(p?.baseLevel?.[1]).toBeCloseTo(105.5, 0);
    expect(p?.baseLevel?.[0]).toBeGreaterThanOrEqual(100);
    expect(p?.baseLevel?.[1]).toBeLessThanOrEqual(105.5);
  });

  it('uses the Toe surface for a pile with no base, as the pile look does', async () => {
    const none = await seriesOf(source({ m: pile() }), 'base');
    const toe = await seriesOf(source({ m: pile({ kind: 'smart' }) }), 'base');
    const lowest = await seriesOf(
      source({ m: pile({ kind: 'reference', mode: 'perimeter-min' }) }),
      'base',
    );
    expect(none?.z).toEqual(toe?.z);
    expect(none?.z).not.toEqual(lowest?.z);
    // a Lowest point is one level
    expect(new Set(lowest?.z.filter((v) => v !== null))).toEqual(new Set([100]));
  });

  it("stands the pile on its boundary's own heights when no base can be built", async () => {
    const p = await pileProfile(source({ ground: noSurvey }));
    expect(p?.baseKind).toBe('boundary');
    const base = p?.series.find((s) => s.kind === 'base');
    const mid = (STATIONS - 1) / 2;
    // the boundary's heights lie on the plane 50 + 0.05 e + 2/30 n: 52 in the middle
    expect(base?.z[mid]).toBeCloseTo(52, 2);
    expect(p?.baseLevel?.[0]).toBeGreaterThanOrEqual(50);
    expect(p?.baseLevel?.[1]).toBeLessThanOrEqual(54);
  });

  it('is null when the date is not sampled, and nothing fails', async () => {
    // no prepared surface on the latest date
    expect(await pileProfile(source({ ground: null }))).toBeNull();
    // the latest survey could not be cut
    expect(await pileProfile(source({ surfaces: () => Promise.resolve([]) }))).toBeNull();
    expect(
      await pileProfile(
        source({
          surfaces: (line) =>
            Promise.resolve([
              {
                ...along(line, () => 0, 'current', LATEST.date),
                z: Array<null>(STATIONS).fill(null),
              },
            ]),
        }),
      ),
    ).toBeNull();
    expect(
      await pileProfile(source({ surfaces: () => Promise.reject(new Error('no surface')) })),
    ).toBeNull();
    // an outline that is not an area
    expect(await pileProfile(source({ ring: RING.slice(0, 2) }))).toBeNull();
  });
});
