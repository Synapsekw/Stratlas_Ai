import { describe, expect, it } from 'vitest';
import { pinTarget } from './fit';
import { surfaceFrameFromCorners } from './surface';

describe('surfaceFrameFromCorners', () => {
  it('maps image px through the corners, base height from the top-left corner', () => {
    const f = surfaceFrameFromCorners(
      { tl: [10, 2, 20], tr: [110, 2, 20], bl: [10, 2, 70] },
      [1000, 500],
      true,
    );
    expect(f).toEqual({ a: 0.1, b: 0, c: 0, d: 0.1, tx: 10, tz: 20, baseY: 2, provisional: true });
  });

  it('puts the corners back where they were, rotated too', () => {
    const tl: [number, number, number] = [5, 1, -3];
    const tr: [number, number, number] = [5 + 80, 1, -3 - 60];
    const bl: [number, number, number] = [5 + 30, 1, -3 + 40];
    const f = surfaceFrameFromCorners({ tl, tr, bl }, [800, 500], false);
    const s = { drawing: () => f };
    expect(pinTarget({ t: 0, surface: 'd', at: [800, 0] }, s)?.xz).toEqual([85, -63]);
    expect(pinTarget({ t: 0, surface: 'd', at: [0, 500] }, s)?.xz).toEqual([35, 37]);
    expect(pinTarget({ t: 0, surface: 'd', at: [0, 0] }, s)?.y).toBe(1);
  });
});
