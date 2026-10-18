import { expect, it } from 'vitest';
import { AssemblyParamsByKind } from '@aio/schema';
import {
  bounds,
  closedAndWound,
  degenerateTriangles,
  normalsAgree,
  normalsUnit,
} from '../testGeom';
import { build, registerBuilders } from './testFixtures';
import { ACCESS_BUILDERS } from './access';
import { TELECOM_BUILDERS } from './telecom';

registerBuilders(ACCESS_BUILDERS);
registerBuilders(TELECOM_BUILDERS);

it('builds source roof faces with closed corrugated sheets and retains their ridge', () => {
  const params = AssemblyParamsByKind.deck.parse({
    y: 4,
    outline: [
      [2, 3],
      [6, 3],
      [6, 5],
      [2, 5],
    ],
    thickness: 0.012,
    openings: [],
    roofPanels: [
      [
        [2, 4, 3],
        [6, 4, 3],
        [6, 4.4, 4],
        [2, 4.4, 4],
      ],
      [
        [2, 4.4, 4],
        [6, 4.4, 4],
        [6, 4, 5],
        [2, 4, 5],
      ],
    ],
    corrugation: { pitch: 0.16, depth: 0.016 },
  });
  const prims = build('deck', params).out();
  for (const p of prims) {
    expect(closedAndWound(p)).toBe(true);
    expect(normalsAgree(p)).toBe(true);
    expect(normalsUnit(p)).toBe(true);
    expect(degenerateTriangles(p)).toBe(0);
    expect(bounds(p).max[1]).toBeCloseTo(4.408, 2);
    expect(p.indices.length).toBeGreaterThan(1000);
  }
});

it('builds individual step bolts at measured centres without continuous side rails', () => {
  const params = AssemblyParamsByKind.ladder.parse({
    bottom: [2, 3, 1],
    top: [2, 8, 1],
    width: 0.36,
    rungSpacing: 0.29,
    style: 'step-bolts',
    steps: [
      [2, 3.4, 1],
      [2.01, 3.7, 1.01],
      [2.02, 4, 1.02],
    ],
    outward: [1, 0, 0],
  });
  const prims = build('ladder', params).out();
  for (const p of prims) {
    expect(closedAndWound(p)).toBe(true);
    expect(degenerateTriangles(p)).toBe(0);
    // No rail runs to the legacy route top, and no vertical rail spans between steps.
    expect(bounds(p).max[1]).toBeLessThan(4.1);
    for (let i = 1; i < p.positions.length; i += 3) {
      const y = p.positions[i] ?? 0;
      expect([3.4, 3.7, 4].some((h) => y >= h - 0.025 && y <= h + 0.07)).toBe(true);
    }
  }
  expect(AssemblyParamsByKind.ladder.safeParse({ ...params, steps: undefined }).success).toBe(
    false,
  );
});

it('builds clamp plates, paired arms and U bolts to the supplied device anchor', () => {
  const params = AssemblyParamsByKind.antennaMount.parse({
    kind: 'clamp',
    centre: [1, 8, 2],
    anchor: [1.4, 8.05, 1.7],
    pipeDiameter: 0.12,
    azimuthDeg: 65,
    tiltDeg: 8,
    size: [0.16, 0.14, 0.5],
  });
  const prims = build('antennaMount', params).out();
  expect(prims.length).toBeGreaterThan(0);
  for (const p of prims) {
    expect(closedAndWound(p)).toBe(true);
    expect(normalsAgree(p)).toBe(true);
    expect(normalsUnit(p)).toBe(true);
    expect(degenerateTriangles(p)).toBe(0);
    expect(bounds(p).max[0]).toBeGreaterThan(1.4);
  }
});

it('distinguishes enclosure pickets from structural posts and keeps the fence open', () => {
  const params = AssemblyParamsByKind.guardrail.parse({
    path: [
      [0, 0, 0],
      [3, 0, 0],
    ],
    height: 2,
    posts: 1.5,
    rails: 2,
    pickets: { spacing: 0.15, diameter: 0.018 },
  });
  const prims = build('guardrail', params).out();
  expect(prims.length).toBe(1);
  for (const p of prims) {
    expect(closedAndWound(p)).toBe(true);
    expect(normalsUnit(p)).toBe(true);
    expect(degenerateTriangles(p)).toBe(0);
  }
  expect(() => build('guardrail', { ...params, posts: 0.00001 })).toThrow(/too close/);
});
