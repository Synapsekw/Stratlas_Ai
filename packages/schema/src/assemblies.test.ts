import { describe, expect, it } from 'vitest';
import { Assembly, AssemblyKind, Material } from './assemblies';

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
        openTop: true,
      },
    });
    expect(r.success).toBe(true);
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
});
