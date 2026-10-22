import { TelecomFlagParams, type Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  FLAG_DEPTH_GAP_M,
  FLAG_MIN_CLUSTER,
  FLAG_PAD_M,
  flagParams,
  flagSelection,
  nearestCluster,
  newFlagId,
} from './antennaFlag';

const eye: Vec3 = [0, 0, 0];

/** `count` points on a small patch `dist` metres along +x from the eye. */
function patch(count: number, dist: number, depthSpan = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    out.push(dist + t * depthSpan, ((i % 6) - 2.5) * 0.02, (Math.floor(i / 6) % 6) * 0.02);
  }
  return out;
}

const xs = (pts: Float32Array) => Array.from({ length: pts.length / 3 }, (_, i) => pts[i * 3] ?? 0);

describe('nearestCluster', () => {
  it('has the agreed constants', () => {
    expect(FLAG_DEPTH_GAP_M).toBe(0.4);
    expect(FLAG_MIN_CLUSTER).toBe(8);
    expect(FLAG_PAD_M).toBe(0.1);
  });

  it('is empty for no points', () => {
    expect(nearestCluster(new Float32Array(0), eye).length).toBe(0);
  });

  it('drops the far side behind a depth gap', () => {
    const pts = new Float32Array([...patch(60, 4.5), ...patch(60, 3)]);
    const kept = nearestCluster(pts, eye);
    expect(kept.length).toBe(60 * 3);
    for (const x of xs(kept)) expect(x).toBeLessThan(3.2);
  });

  it('skips a stray point in front', () => {
    const pts = new Float32Array([1, 0, 0, ...patch(40, 3)]);
    const kept = nearestCluster(pts, eye);
    expect(kept.length).toBe(40 * 3);
    for (const x of xs(kept)) expect(x).toBeGreaterThan(2.9);
  });

  it('keeps an obliquely seen face whose depth spans 0.8 m without a gap', () => {
    const pts = new Float32Array(patch(80, 3, 0.8));
    expect(nearestCluster(pts, eye).length).toBe(80 * 3);
  });
});

describe('flagSelection', () => {
  it('grows the bounds and falls back to the raycast', () => {
    const kept = new Float32Array([1, 2, 3, 3, 4, 5]);
    const s = flagSelection(kept, [9, 9, 9]);
    if (!s) throw new Error('no selection');
    expect(s.bounds.min[0]).toBeCloseTo(0.9);
    expect(s.bounds.min[2]).toBeCloseTo(2.9);
    expect(s.bounds.max[1]).toBeCloseTo(4.1);
    expect(s.anchor).toEqual([2, 3, 4]);

    const f = flagSelection(new Float32Array(0), [1, 2, 3]);
    if (!f) throw new Error('no fallback');
    expect(f.anchor).toEqual([1, 2, 3]);
    expect(f.bounds.min[0]).toBeCloseTo(0.7);
    expect(f.bounds.max[2]).toBeCloseTo(3.3);

    expect(flagSelection(new Float32Array(0), null)).toBeNull();
  });
});

describe('newFlagId', () => {
  it('matches the unit id pattern', () => {
    const id = newFlagId();
    expect(id).toMatch(/^ant-f-[a-z0-9]+-[a-z0-9]{4}$/);
    expect(id).toMatch(/^ant-[a-z0-9-]{1,60}$/);
    expect(newFlagId()).not.toBe(id);
  });
});

describe('flagParams', () => {
  it('builds valid telecom.flag params', () => {
    const p = flagParams({
      unit: 'ant-f-x1-abcd',
      redraw: true,
      layer: 'cloud-1',
      sel: {
        shape: 'lasso',
        polygon: [
          [0, 0],
          [0.5, 0],
          [0.5, 0.5],
        ],
        viewProj: Array.from({ length: 16 }, (_, i) => i),
      },
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      anchor: [0.5, 0.5, 0.5],
    });
    expect(TelecomFlagParams.parse(p)).toEqual(p);
    expect(p.redraw).toBe(true);
    expect(p.cloud.layer).toBe('cloud-1');
    const q = flagParams({
      unit: 'ant-f-x1-abcd',
      redraw: false,
      layer: 'cloud-1',
      sel: p.selection as never,
      bounds: p.selection.bounds,
      anchor: p.selection.anchor,
    });
    expect('redraw' in q).toBe(false);
  });
});
