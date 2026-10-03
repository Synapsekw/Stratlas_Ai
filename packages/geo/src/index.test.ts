import { describe, expect, it } from 'vitest';
import { createFrame } from './index';

describe('createFrame', () => {
  it('round-trips UTM coordinates to 1 mm', () => {
    const f = createFrame([245_000, 3_179_000, 0], 32639);
    const p: [number, number, number] = [245_884.9123, 3_179_597.1456, 151.5];
    const back = f.toProject(f.toLocal(p));
    back.forEach((v, i) => {
      expect(Math.abs(v - (p[i] ?? 0))).toBeLessThan(0.001);
    });
  });

  it('puts the origin at local zero', () => {
    const f = createFrame([10, 20, 30], 32639);
    expect(f.toLocal([10, 20, 30])).toEqual([0, 0, 0]);
  });
});
