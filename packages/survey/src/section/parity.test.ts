/**
 * The TypeScript section sampler against the Python one (`aio_pipelines/survey/section.py`) on
 * the shared fixture: G2's surfaces (a cone grid, the cone with holes, a pad TIN and its offset
 * copy) along one line. `python/tests/test_survey_section.py` writes the fixture and checks the
 * Python sampler and the `survey.section` CSV give the same numbers.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Resolve, ResolvedSurface } from '../engine/compare';
import { ArraySurface } from '../engine/tiles';
import { resolveSection, sampleSection, type SectionRef } from './profile';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SURFACES = join(HERE, '..', '..', '..', 'schema', 'src', '__fixtures__', 'survey');

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

interface Parity {
  surfaces: SectionRef[];
  line: [number, number][];
  expected: {
    stepM: number;
    chainage: number[];
    e: number[];
    n: number[];
    profiles: { surface: string; label: string; z: (number | null)[] }[];
  };
}

function resolvedOf(s: FixtureSurface): ResolvedSurface {
  if (s.kind === 'grid') {
    const h = Float64Array.from(s.z, (v) => (v === null ? NaN : s.base + v * s.scale));
    return {
      kind: 'grid',
      name: s.name,
      fingerprint: s.fingerprint,
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

describe('section parity with the Python sampler', () => {
  const all = JSON.parse(readFileSync(join(SURFACES, 'surfaces.json'), 'utf8')) as Record<
    string,
    FixtureSurface
  >;
  const fx = JSON.parse(
    readFileSync(join(HERE, '__fixtures__', 'section-parity.json'), 'utf8'),
  ) as Parity;
  const resolve: Resolve = (ref) => {
    const key =
      ref.kind === 'survey'
        ? ref.surface
        : ref.kind === 'design'
          ? `${ref.design}/${ref.layer}`
          : '';
    const s = all[key];
    return s ? Promise.resolve(resolvedOf(s)) : Promise.reject(new Error(`no ${key}`));
  };

  it('gives the same stations and heights to 1e-9', async () => {
    const { surfaces, missing } = await resolveSection(fx.surfaces, resolve);
    expect(missing).toEqual([]);
    const sec = await sampleSection({ line: fx.line }, surfaces);
    const exp = fx.expected;
    expect(sec.step).toBe(exp.stepM);
    expect(sec.chainage.length).toBe(exp.chainage.length);
    exp.chainage.forEach((c, k) => {
      expect(Math.abs((sec.chainage[k] ?? NaN) - c)).toBeLessThan(1e-9);
      expect(Math.abs((sec.e[k] ?? NaN) - (exp.e[k] ?? NaN))).toBeLessThan(1e-9);
      expect(Math.abs((sec.n[k] ?? NaN) - (exp.n[k] ?? NaN))).toBeLessThan(1e-9);
    });
    exp.profiles.forEach((p, i) => {
      const got = sec.profiles[i];
      expect(got?.surface).toBe(p.surface);
      expect(got?.label).toBe(p.label);
      p.z.forEach((z, k) => {
        const g = got?.z[k] ?? null;
        expect(g === null, `${p.surface} at ${String(k)}`).toBe(z === null);
        if (z !== null && g !== null) expect(Math.abs(g - z)).toBeLessThan(1e-9);
      });
    });
  });
});
