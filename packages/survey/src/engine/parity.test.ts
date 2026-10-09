/**
 * Two executors, one formula (ADR 0009): every shared fixture in
 * `packages/schema/src/__fixtures__/survey/` run through the TypeScript executor agrees with the
 * Python reference core's stored result to 1e-6 relative, with the same status, reason, labels,
 * captures and fingerprint. The Python results are written by `python/tests/survey_fixtures.py`
 * (and `python/tests/test_survey_fixtures.py` checks the core still reproduces them).
 */
import type { ComparisonItem, ComparisonResult, SurfaceRef } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SURVEY_ENGINE_VERSION } from '../index';
import {
  compareItem,
  ENGINE_VERSION,
  type Resolve,
  type ResolvedSurface,
  type SiteContext,
} from './compare';
import { ArraySurface, decodeTile, TILE } from './tiles';

// ------------------------------------------------------------------------- the fixtures

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

interface FixtureCase {
  id: string;
  note: string;
  ring: [number, number][];
  item: ComparisonItem;
  site?: SiteContext;
  captures?: Record<'current' | 'previous', { surface: string; capture: string }>;
  expected: Pick<
    ComparisonResult,
    | (typeof NUMBERS)[number]
    | 'status'
    | 'reason'
    | 'fromLabel'
    | 'toLabel'
    | 'fromCapture'
    | 'toCapture'
    | 'usedDeadband'
    | 'fingerprint'
  >;
}

function readFixtures(): { surfaces: Record<string, FixtureSurface>; cases: FixtureCase[] } {
  const surfaces = JSON.parse(readFileSync(join(FIXTURES, 'surfaces.json'), 'utf8')) as Record<
    string,
    FixtureSurface
  >;
  const { cases } = JSON.parse(readFileSync(join(FIXTURES, 'cases.json'), 'utf8')) as {
    cases: FixtureCase[];
  };
  return { surfaces, cases };
}

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

function fixtureResolver(surfaces: Record<string, FixtureSurface>, c: FixtureCase): Resolve {
  return (ref: SurfaceRef) => {
    const pick = (id: string, capture?: string) => {
      const s = surfaces[id];
      if (!s) return Promise.reject(new Error(`No fixture surface ${id}`));
      return Promise.resolve(fixtureSurface(s, capture));
    };
    switch (ref.kind) {
      case 'survey':
        return pick(ref.surface, ref.capture);
      case 'current':
      case 'previous': {
        const cap = c.captures?.[ref.kind];
        if (!cap) return Promise.reject(new Error(`No ${ref.kind} capture`));
        return pick(cap.surface, cap.capture);
      }
      case 'design':
        return pick(`${ref.design}/${ref.layer}`);
      default:
        return Promise.reject(new Error(`${ref.kind} is not a surface`));
    }
  };
}

const { surfaces, cases } = readFixtures();

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

/** 1e-6 relative to the larger magnitude (and to the polygon's area or volume scale near zero). */
function close(a: number, b: number, scale: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b), 1e-3 * scale);
}

describe('TypeScript executor against the Python core (shared fixtures)', () => {
  it('has the fixtures and the same engine version', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(ENGINE_VERSION).toBe(SURVEY_ENGINE_VERSION);
  });

  it.each(cases.map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    const r = await compareItem(c.ring, c.item, fixtureResolver(surfaces, c), {
      ...(c.site ? { site: c.site } : {}),
      now: () => '2026-10-09T00:00:00Z',
    });
    const e = c.expected;
    expect(r.engine).toBe('ts');
    expect({
      status: r.status,
      reason: r.reason,
      fromLabel: r.fromLabel,
      toLabel: r.toLabel,
      fromCapture: r.fromCapture,
      toCapture: r.toCapture,
      usedDeadband: r.usedDeadband,
      fingerprint: r.fingerprint,
    }).toEqual({
      status: e.status,
      reason: e.reason,
      fromLabel: e.fromLabel,
      toLabel: e.toLabel,
      fromCapture: e.fromCapture,
      toCapture: e.toCapture,
      usedDeadband: e.usedDeadband,
      fingerprint: e.fingerprint,
    });
    const scale = Math.max(e.areaM2, e.fillM3 + e.cutM3, 1);
    for (const k of NUMBERS) {
      if (!close(r[k], e[k], scale))
        expect.fail(
          `${k}: TypeScript ${r[k]}, Python ${e[k]} (relative ${Math.abs(r[k] - e[k]) / Math.max(Math.abs(e[k]), 1e-12)})`,
        );
    }
  });
});

describe('height tiles written by the Python core', () => {
  it('decode to the same heights', async () => {
    const dir = join(FIXTURES, 'tiles', 'cone');
    const meta = JSON.parse(readFileSync(join(dir, 'tiles.json'), 'utf8')) as {
      tiles: string[];
      cellM: number;
    };
    expect(meta.tiles).toEqual(['0_0']);
    const tile = await decodeTile(new Uint8Array(readFileSync(join(dir, '0', '0_0.bin'))));
    const s = surfaces.cone;
    if (s?.kind !== 'grid') throw new Error('cone fixture');
    let same = 0;
    for (let j = 0; j < TILE; j++)
      for (let i = 0; i < TILE; i++) {
        const k = j * TILE + i;
        const has = ((tile.mask[k >> 3] ?? 0) >> (k & 7)) & 1;
        const want = i < s.nx && j < s.ny ? s.z[j * s.nx + i] : null;
        if (want === null || want === undefined) {
          expect(has).toBe(0);
          continue;
        }
        expect(has).toBe(1);
        expect(tile.base + (tile.rel[k] ?? 0)).toBe(s.base + want * s.scale);
        same++;
      }
    expect(same).toBe(s.nx * s.ny);
  });
});
