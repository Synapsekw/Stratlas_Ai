import { describe, expect, it } from 'vitest';
import { Assembly, AssemblyKind, Material, ParamQuality, ScaleRecord } from './assemblies';

const origin = { by: 'engineer', runId: 'r1' } as const;
const base = {
  name: 'Shaft',
  description: 'Tapered shaft',
  category: 'Shaft',
  status: 'draft',
  origin,
  quality: {},
  sources: [],
} as const;

describe('Assembly', () => {
  it('accepts a tapered shaft with an open top', () => {
    const r = Assembly.safeParse({
      ...base,
      id: 'shaft-1',
      kind: 'shaft',
      params: {
        base: [0, 0, 0],
        profile: [
          { y: 0, r: 10 },
          { y: 100, r: 7 },
        ],
        wall: 0.4,
        openTop: true,
      },
    });
    expect(r.success).toBe(true);
  });
  it('may record the run values it was last reviewed against, and nothing else there', () => {
    const shaft = (reviewed: unknown) =>
      Assembly.safeParse({
        ...base,
        id: 'shaft-1',
        kind: 'shaft',
        status: 'accepted',
        params: {
          base: [0, 0, 0],
          profile: [
            { y: 0, r: 10 },
            { y: 100, r: 7 },
          ],
          openTop: false,
        },
        ...(reviewed === undefined ? {} : { reviewed }),
      }).success;
    expect(shaft(undefined)).toBe(true);
    expect(shaft({ hash: '0a1b2c3d' })).toBe(true);
    expect(shaft({ hash: '0a1b2c3d', runId: 'run-a' })).toBe(true);
    expect(shaft({ hash: 'XYZ' })).toBe(false);
    expect(shaft({ hash: '0a1b2c3d', note: 'x' })).toBe(false);
    expect(shaft({ runId: 'run-a' })).toBe(false);
  });
  it('a warning light may record the height its level was found at', () => {
    const light = (levelFoundAt: unknown) =>
      Assembly.safeParse({
        ...base,
        id: 'light-l1-1',
        kind: 'warningLight',
        params: {
          fixture: 'twin',
          centre: [7, 45, 0],
          outward: [1, 0, 0],
          size: 0.4,
          ...(levelFoundAt === undefined ? {} : { levelFoundAt }),
        },
        quality: { centre: { basis: 'user' } },
      }).success;
    expect(light(undefined)).toBe(true);
    expect(light(40)).toBe(true);
    expect(light('40')).toBe(false);
    expect(light(5000)).toBe(false);
  });
  it('refuses an open-top shaft without a wall thickness', () => {
    const params = {
      base: [0, 0, 0],
      profile: [
        { y: 0, r: 10 },
        { y: 100, r: 7 },
      ],
      openTop: true,
    };
    const r = Assembly.safeParse({ ...base, id: 'shaft-1', kind: 'shaft', params });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message)).toContain(
      'An open-top shaft needs a wall thickness.',
    );
    const closed = { ...params, openTop: false };
    expect(
      Assembly.safeParse({ ...base, id: 'shaft-1', kind: 'shaft', params: closed }).success,
    ).toBe(true);
  });
  it('a pipe run may leave its ends open', () => {
    const pipe = (openEnds: unknown) =>
      Assembly.safeParse({
        ...base,
        id: 'pipe-1',
        kind: 'pipeRun',
        params: {
          path: [
            [0, 0, 0],
            [4, 0, 0],
          ],
          diameter: 0.2,
          ...(openEnds === undefined ? {} : { openEnds }),
        },
      }).success;
    for (const ends of [undefined, 'none', 'start', 'end', 'both']) expect(pipe(ends)).toBe(true);
    expect(pipe('middle')).toBe(false);
  });
  it('refuses a profile whose heights do not increase', () => {
    const r = Assembly.safeParse({
      ...base,
      id: 'shaft-1',
      kind: 'shaft',
      params: {
        base: [0, 0, 0],
        profile: [
          { y: 10, r: 5 },
          { y: 5, r: 4 },
        ],
        wall: 0.4,
        openTop: true,
      },
    });
    expect(r.success).toBe(false);
  });
  it('refuses a flue whose inner radius is not below the outer', () => {
    const r = Assembly.safeParse({
      ...base,
      id: 'flue-1',
      kind: 'flue',
      params: { centre: [0, 100, 0], rOuter: 1, rInner: 1.2, height: 5 },
    });
    expect(r.success).toBe(false);
  });
  it('caps lattice bays at 80', () => {
    const bays = Array.from({ length: 81 }, () => ({ height: 1, bracing: 'X' }));
    const r = Assembly.safeParse({
      ...base,
      id: 'lattice-1',
      kind: 'lattice',
      params: {
        base: [0, 0, 0],
        legs: 4,
        widthBase: 6,
        widthTop: 1.5,
        height: 81,
        bays,
        legSection: 0.15,
        braceSection: 0.08,
      },
    });
    expect(r.success).toBe(false);
  });
  it('rejects unknown params (strict)', () => {
    const r = Assembly.safeParse({
      ...base,
      id: 'cabinet-1',
      kind: 'cabinet',
      params: { base: [0, 0, 0], size: [1, 2, 1], yawDeg: 0, script: 'rm -rf' },
    });
    expect(r.success).toBe(false);
  });
  // the design spec's table (section "Assembly kinds") has 21 rows; the plan's "20" was a miscount
  it('lists all 21 kinds of the design', () => {
    expect([...AssemblyKind.options].sort()).toEqual(
      [
        'shaft',
        'band',
        'flue',
        'flareTip',
        'deck',
        'ringPlatform',
        'guardrail',
        'ladder',
        'hatch',
        'louvre',
        'duct',
        'pipeRun',
        'frame',
        'base',
        'cabinet',
        'lattice',
        'monopole',
        'antenna',
        'antennaMount',
        'warningLight',
        'earthing',
      ].sort(),
    );
  });
  it('keeps material colours in 0..1', () => {
    expect(
      Material.safeParse({
        id: 'm',
        name: 'M',
        baseColor: [1.2, 0, 0, 1],
        metallic: 0,
        roughness: 0.5,
      }).success,
    ).toBe(false);
  });

  it('allows a residual and support only on measured values', () => {
    expect(
      ParamQuality.safeParse({ basis: 'measured', residualM: 0.01, support: 900 }).success,
    ).toBe(true);
    expect(ParamQuality.safeParse({ basis: 'observed', residualM: 0.001 }).success).toBe(false);
    expect(ParamQuality.safeParse({ basis: 'inferred', support: 12 }).success).toBe(false);
    expect(ParamQuality.safeParse({ basis: 'user', coverage: 0.5 }).success).toBe(true);
  });

  it('keys quality by the params of the kind', () => {
    const shaft = {
      ...base,
      id: 'shaft-1',
      kind: 'shaft',
      params: {
        base: [0, 0, 0],
        profile: [
          { y: 0, r: 10 },
          { y: 100, r: 7 },
        ],
        wall: 0.4,
        openTop: true,
      },
    };
    expect(
      Assembly.safeParse({ ...shaft, quality: { profile: { basis: 'measured', residualM: 0.02 } } })
        .success,
    ).toBe(true);
    expect(
      Assembly.safeParse({ ...shaft, quality: { rInner: { basis: 'inferred' } } }).success,
    ).toBe(false);
  });

  it('needs the reference when the scale comes from one', () => {
    expect(ScaleRecord.safeParse({ status: 'reference' }).success).toBe(false);
    expect(
      ScaleRecord.safeParse({ status: 'reference', reference: { what: 'height', valueM: 80 } })
        .success,
    ).toBe(true);
    expect(ScaleRecord.safeParse({ status: 'provisional' }).success).toBe(true);
  });

  it('refuses an empty engineer run id', () => {
    const cabinet = {
      ...base,
      id: 'cabinet-1',
      kind: 'cabinet',
      params: { base: [0, 0, 0], size: [1, 2, 1], yawDeg: 0 },
    };
    expect(Assembly.safeParse(cabinet).success).toBe(true);
    expect(Assembly.safeParse({ ...cabinet, origin: { by: 'engineer', runId: '' } }).success).toBe(
      false,
    );
  });
});
