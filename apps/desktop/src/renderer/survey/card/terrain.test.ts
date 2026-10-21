import { polygonAreas, type HeightSampler } from '@aio/survey';
import { describe, expect, it } from 'vitest';
import {
  collect,
  NOW_BUDGET,
  presample,
  readNow,
  readsSurface,
  readTerrain,
  sliced,
  type Asked,
} from './terrain';

const E0 = 512_340;
const N0 = 2_710_250;
const at = (x: number, y: number): [number, number, number] => [E0 + x, N0 + y, 0];

/** A rough pile, as in the survey package's budget test. */
const pile: HeightSampler = {
  heightAt: (e, n) => {
    const x = e - E0 - 50;
    const y = n - N0 - 50;
    const r = Math.hypot(x, y);
    return 30 + (r < 45 ? 12 * Math.cos(((r / 45) * Math.PI) / 2) ** 1.5 : 0) + 0.1 * Math.sin(x);
  },
};
const toe = Array.from({ length: 48 }, (_, k) => {
  const a = (k / 48) * 2 * Math.PI;
  return at(50 + 47 * Math.cos(a), 50 + 47 * Math.sin(a));
});

/** Spend about `ms` milliseconds, as a raycast through a large mesh does. */
const busy = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* spin */
  }
};

describe('which cards read the terrain', () => {
  it('reads it for an area, a distance and a height above the surface, never for a pile', () => {
    expect(readsSurface('area')).toBe(true);
    expect(readsSurface('distance')).toBe(true);
    expect(readsSurface('elevation-difference')).toBe(true);
    expect(readsSurface('volume')).toBe(false);
    expect(readsSurface('elevation')).toBe(false);
  });

  it('follows a template that leaves the terrain rows out, or asks for them', () => {
    // the area's secondary line still shows its terrain area
    expect(readsSurface('area', ['area'])).toBe(true);
    expect(readsSurface('volume', ['net', 'terrain-area'])).toBe(true);
    expect(readsSurface('distance', ['horizontal'])).toBe(false);
  });
});

describe('presampling the terrain', () => {
  it('asks each place once and gives the same terrain area as sampling directly', async () => {
    const direct = polygonAreas(toe, pile).terrainM2;
    let asked = 0;
    const s = await presample(
      (h) => {
        // the card reads the rows three times (primary, secondary line, readout)
        for (let i = 0; i < 3; i++) polygonAreas(toe, h);
      },
      (es, ns) => {
        asked += es.length;
        return Promise.resolve(
          Float64Array.from(es, (e, k) => pile.heightAt(e, ns[k] ?? 0) ?? NaN),
        );
      },
    );
    expect(asked).toBe(collect((h) => polygonAreas(toe, h)).es.length);
    expect(polygonAreas(toe, s).terrainM2).toBe(direct);
  });

  it('answers no data where the surface had none', async () => {
    const s = await presample(
      (h) => {
        h.heightAt(1, 2);
      },
      (es) => Promise.resolve(new Float64Array(es.length).fill(NaN)),
    );
    expect(s.heightAt(1, 2)).toBeNull();
  });
});

describe('sampling the 3D stage a slice at a time', () => {
  it('hands the main thread back between slices, never holding it much past a slice', async () => {
    const slices: number[] = [];
    let start = performance.now();
    const sample = sliced(
      {
        heightAt: () => {
          busy(2);
          return 1;
        },
      },
      {
        sliceMs: 10,
        yieldTo: () => {
          slices.push(performance.now() - start);
          return new Promise<void>((r) => {
            setTimeout(() => {
              start = performance.now();
              r();
            }, 0);
          });
        },
      },
    );
    const zs = await sample(new Float64Array(40), new Float64Array(40));
    expect(Array.from(zs).every((z) => z === 1)).toBe(true);
    // 40 samples of 2 ms in slices of 10 ms: the thread is given back several times
    expect(slices.length).toBeGreaterThanOrEqual(5);
    expect(Math.max(...slices)).toBeLessThan(10 + 2 + 5);
  });

  it('stops when the card is closed', async () => {
    const ctl = new AbortController();
    let calls = 0;
    const sample = sliced(
      {
        heightAt: () => {
          calls++;
          busy(1);
          return 1;
        },
      },
      {
        sliceMs: 3,
        signal: ctl.signal,
        yieldTo: () => {
          ctl.abort();
          return Promise.resolve();
        },
      },
    );
    await expect(sample(new Float64Array(100), new Float64Array(100))).rejects.toBeDefined();
    expect(calls).toBeLessThan(100);
  });
});

describe('reading in the render', () => {
  const places = (n: number): Asked => ({
    es: Float64Array.from({ length: n }, (_, k) => k),
    ns: new Float64Array(n),
  });

  it('reads a few places now, and nothing when more are asked than the budget', () => {
    let calls = 0;
    const h: HeightSampler = {
      heightAt: () => {
        calls++;
        return 4;
      },
    };
    expect(Array.from(readNow(h, places(1)) ?? [])).toEqual([4]);
    calls = 0;
    expect(readNow(h, places(NOW_BUDGET.places + 1))).toBeNull();
    expect(calls).toBe(0);
  });

  it('never holds the render past its time budget plus one read', () => {
    // 3D raycasts of 5 ms: the budget of 8 ms allows two, then gives up
    let calls = 0;
    const h: HeightSampler = {
      heightAt: () => {
        calls++;
        busy(5);
        return 1;
      },
    };
    const t0 = performance.now();
    expect(readNow(h, places(NOW_BUDGET.places))).toBeNull();
    const ms = performance.now() - t0;
    expect(calls).toBeLessThanOrEqual(2);
    expect(ms).toBeLessThan(NOW_BUDGET.ms + 5 + 4);
  });
});

describe('reading off the render', () => {
  it('says when the surface had no data anywhere (the terrain not loaded yet)', async () => {
    const none = await readTerrain(
      (h) => polygonAreas(toe, h),
      (es) => Promise.resolve(new Float64Array(es.length).fill(NaN)),
    );
    expect(none.empty).toBe(true);
    const some = await readTerrain(
      (h) => polygonAreas(toe, h),
      (es, ns) =>
        Promise.resolve(Float64Array.from(es, (e, k) => pile.heightAt(e, ns[k] ?? 0) ?? NaN)),
    );
    expect(some.empty).toBe(false);
  });

  it('a card closed before the read starts reads nothing', async () => {
    const ctl = new AbortController();
    let asked = 0;
    const read = readTerrain(
      (h) => polygonAreas(toe, h),
      (es) => {
        asked += es.length;
        return Promise.resolve(new Float64Array(es.length));
      },
      { signal: ctl.signal },
    );
    ctl.abort();
    await expect(read).rejects.toBeDefined();
    expect(asked).toBe(0);
  });
});
