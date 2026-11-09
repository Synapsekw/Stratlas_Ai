import { Box3, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { ChunkSeed } from './manager';
import { robustCloudBox } from './robustBox';

const seed = (
  key: string,
  min: [number, number, number],
  max: [number, number, number],
  points: number,
  children: string[] = [],
): ChunkSeed =>
  ({ key, bounds: { min, max }, lod: 3, spacing: 0.1, children, points }) as unknown as ChunkSeed;

const header = new Box3(new Vector3(-22, -4, -20), new Vector3(47, 33, 18));

describe('robustCloudBox', () => {
  it('leaves out a sparse far node that holds under the trim share of the points', () => {
    const dense = [
      seed('a', [-7, -1, -7], [0, 5, 0], 40000),
      seed('b', [0, -1, 0], [7, 5, 7], 40000),
      seed('far', [40, 28, 10], [47, 33, 18], 20),
    ];
    const box = robustCloudBox(dense, header, 0.005);
    box.min.toArray().forEach((v, i) => {
      expect(v).toBeCloseTo([-7, -1, -7][i] ?? 0, 0);
    });
    box.max.toArray().forEach((v, i) => {
      expect(v).toBeCloseTo([7, 5, 7][i] ?? 0, 0);
    });
  });

  it('cuts inside a coarse node that mostly holds strays, not at its far wall', () => {
    const nodes = [
      seed('a', [-9, -1, -1], [0, 1, 1], 50000),
      seed('b', [0, -1, -1], [9, 1, 1], 50000),
      // 1.5 % of the points spread over 9 m: the 0.5 % trim lands a third of the way in
      seed('far', [9, -1, -1], [18, 1, 1], 1500),
    ];
    const box = robustCloudBox(
      nodes,
      new Box3(new Vector3(-9, -1, -1), new Vector3(18, 1, 1)),
      0.005,
    );
    expect(box.max.x).toBeGreaterThan(9);
    expect(box.max.x).toBeLessThan(15.5);
    expect(box.min.x).toBeCloseTo(-9 + 0.045, 1);
  });

  it('ignores nodes that have children (their children cover them)', () => {
    const box = robustCloudBox(
      [
        seed('root', [-22, -4, -20], [47, 33, 18], 5000, ['x']),
        seed('x', [0, 0, 0], [5, 5, 5], 9000),
      ],
      header,
      0.005,
    );
    box.max.toArray().forEach((v) => {
      expect(v).toBeCloseTo(5, 0);
    });
  });

  it('never grows past the header box', () => {
    const tight = new Box3(new Vector3(0, 0, 0), new Vector3(2, 2, 2));
    const box = robustCloudBox([seed('a', [-5, -5, -5], [5, 5, 5], 1000)], tight, 0.005);
    expect(box.equals(tight)).toBe(true);
  });

  it('falls back to the header box when the seeds say too little', () => {
    expect(robustCloudBox([], header, 0.005).equals(header)).toBe(true);
    expect(robustCloudBox([seed('a', [0, 0, 0], [1, 1, 1], 0)], header, 0.005).equals(header)).toBe(
      true,
    );
  });
});
