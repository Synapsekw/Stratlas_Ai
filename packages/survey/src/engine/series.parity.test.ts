/**
 * Volume per survey date and the spread across bases, two executors, one formula (ADR 0009): every
 * case of `packages/schema/src/__fixtures__/survey/series.json`, run through `compareSeries` and
 * `baseSpread`, agrees with the Python core's stored results to 1e-6 relative, with the same
 * statuses, reasons, labels, captures and fingerprints. The Python results are written by
 * `python/tests/survey_fixtures.py` (`series_cases`); `python/tests/test_survey_series.py` checks
 * the core still reproduces them.
 */
import type { ComparisonItem, ComparisonResult, SurfaceRef } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Resolve, ResolvedSurface, SiteContext } from './compare';
import { baseSpread, compareSeries, seriesApplies, spreadPct, type BaseSpread } from './series';
import { ArraySurface } from './tiles';

const FIXTURES = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  'schema',
  'src',
  '__fixtures__',
  'survey',
);

type FixtureSurface =
  | {
      kind: 'grid';
      name: string;
      fingerprint: string;
      originE: number;
      originN: number;
      cellM: number;
      nx: number;
      ny: number;
      base: number;
      scale: number;
      z: (number | null)[];
    }
  | {
      kind: 'tin';
      name: string;
      fingerprint: string;
      vertices: [number, number, number][];
      triangles: [number, number, number][];
      offsetM: number;
    };

/** A survey date: its capture and the prepared surface it has (null: none). */
interface FixtureDate {
  capture: string;
  surface: string | null;
}

/** The Python core's result without `engine` and `computedAt`. */
type Expected = Pick<ComparisonResult, (typeof NUMBERS)[number] | (typeof TEXT)[number]>;

interface SeriesCase {
  id: string;
  note: string;
  ring: [number, number][];
  item: ComparisonItem;
  site?: SiteContext;
  dates: FixtureDate[];
  expected: Expected[];
}

interface SpreadCase {
  id: string;
  note: string;
  ring: [number, number][];
  item: ComparisonItem;
  site?: SiteContext;
  dates: FixtureDate[];
  at: string;
  expected: BaseSpread | null;
}

const surfaces = JSON.parse(readFileSync(join(FIXTURES, 'surfaces.json'), 'utf8')) as Record<
  string,
  FixtureSurface
>;
/** The spread formula on totals alone (a single ok base cannot happen on a surface). */
interface FormulaCase {
  id: string;
  note: string;
  totals: number[];
  expected: number | null;
}

const { series, spread, formula } = JSON.parse(
  readFileSync(join(FIXTURES, 'series.json'), 'utf8'),
) as {
  series: SeriesCase[];
  spread: SpreadCase[];
  formula: FormulaCase[];
};

function fixtureSurface(s: FixtureSurface, capture?: string): ResolvedSurface {
  if (s.kind === 'grid') {
    const h = Float64Array.from(s.z, (k) => (k === null ? NaN : s.base + k * s.scale));
    return {
      kind: 'grid',
      name: s.name,
      fingerprint: s.fingerprint,
      ...(capture !== undefined ? { capture } : {}),
      grid: new ArraySurface(s.originE, s.originN, s.cellM, s.nx, s.ny, h),
    };
  }
  return {
    kind: 'tin',
    name: s.name,
    fingerprint: s.fingerprint,
    tin: {
      header: {},
      vertices: Float64Array.from(s.vertices.flat()),
      triangles: Uint32Array.from(s.triangles.flat()),
    },
    offsetM: s.offsetM,
  };
}

/** The dates viewed on `capture`, by `projectResolver`'s rules (and its messages). */
function atResolver(dates: readonly FixtureDate[], capture: string): Resolve {
  const caps = dates.filter((d) => d.surface !== null);
  const k = caps.findIndex((d) => d.capture === capture);
  const pick = (id: string, cap?: string) => {
    const s = surfaces[id];
    return s ? Promise.resolve(fixtureSurface(s, cap)) : Promise.reject(new Error(`No ${id}`));
  };
  return (ref: SurfaceRef) => {
    switch (ref.kind) {
      case 'survey':
        return pick(ref.surface, ref.capture);
      case 'current':
      case 'previous': {
        const d = k < 0 ? undefined : ref.kind === 'current' ? caps[k] : caps[k - 1];
        if (!d?.surface)
          return Promise.reject(
            new Error(`There is no ${ref.kind} survey with a prepared surface.`),
          );
        return pick(d.surface, d.capture);
      }
      case 'design':
        return pick(`${ref.design}/${ref.layer}`);
      default:
        return Promise.reject(new Error(`"${ref.kind}" is not a surface.`));
    }
  };
}

const NUMBERS = [
  'cutM3',
  'fillM3',
  'netM3',
  'totalM3',
  'areaM2',
  'areaCutM2',
  'areaFillM2',
  'areaUnchangedM2',
  'uncoveredM2',
  'deadbandM',
  'cellM',
] as const;

const TEXT = [
  'item',
  'status',
  'reason',
  'fromLabel',
  'toLabel',
  'fromCapture',
  'toCapture',
  'usedDeadband',
  'fingerprint',
] as const;

/** 1e-6 relative to the larger magnitude (and to the polygon's area or volume scale near zero). */
function close(a: number, b: number, scale: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b), 1e-3 * scale);
}

const now = () => '2026-10-09T00:00:00Z';

describe('volume per survey date against the Python core (series.json)', () => {
  it('has the cases', () => {
    expect(series.length).toBeGreaterThanOrEqual(8);
    expect(spread.length).toBeGreaterThanOrEqual(4);
    expect(new Set(series.map((c) => c.dates.length))).toEqual(new Set([2, 3]));
    expect(new Set(series.flatMap((c) => c.expected.map((r) => r.status)))).toEqual(
      new Set(['ok', 'partial', 'refused']),
    );
  });

  it.each(series.map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    const rs = await compareSeries(
      c.ring,
      c.item,
      (cap) => atResolver(c.dates, cap),
      c.dates.map((d) => d.capture),
      { ...(c.site ? { site: c.site } : {}), now },
    );
    expect(seriesApplies(c.item)).toBe(true);
    expect(rs).toHaveLength(c.expected.length);
    rs.forEach((r, k) => {
      const e = c.expected[k];
      if (!e) throw new Error(`No expected result for date ${k}`);
      expect(r.engine).toBe('ts');
      // every row carries its viewing date
      expect([r.toCapture, r.fromCapture]).toContain(c.dates[k]?.capture);
      expect(Object.fromEntries(TEXT.map((t) => [t, r[t]]))).toEqual(
        Object.fromEntries(TEXT.map((t) => [t, e[t]])),
      );
      const scale = Math.max(e.areaM2, e.fillM3 + e.cutM3, 1);
      for (const n of NUMBERS)
        if (!close(r[n], e[n], scale))
          expect.fail(`date ${k} ${n}: TypeScript ${r[n]}, Python ${e[n]}`);
    });
  });
});

describe('the spread formula against the Python core (series.json)', () => {
  it('has the one-total case', () => {
    expect(formula.find((c) => c.totals.length === 1)?.expected).toBeNull();
  });

  it.each(formula.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const got = spreadPct(c.totals);
    if (c.expected === null) expect(got).toBeNull();
    else expect(close(got ?? NaN, c.expected, 100)).toBe(true);
  });
});

describe('the spread across bases against the Python core (series.json)', () => {
  it.each(spread.map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    const s = await baseSpread(c.ring, c.item, atResolver(c.dates, c.at), {
      ...(c.site ? { site: c.site } : {}),
      now,
    });
    const e = c.expected;
    if (e === null) {
      expect(s).toBeNull();
      return;
    }
    expect(s).not.toBeNull();
    if (!s) return;
    expect(s.nets.map((n) => n.base)).toEqual(e.nets.map((n) => n.base));
    const scale = Math.max(...e.nets.map((n) => Math.abs(n.netM3)), 1);
    s.nets.forEach((n, k) => {
      const want = e.nets[k]?.netM3 ?? NaN;
      if (!close(n.netM3, want, scale))
        expect.fail(`${n.base}: TypeScript ${n.netM3}, Python ${want}`);
    });
    // a percentage: near zero, held to 1e-7 percentage points
    if (!close(s.pct, e.pct, 100)) expect.fail(`pct: TypeScript ${s.pct}, Python ${e.pct}`);
  });
});
