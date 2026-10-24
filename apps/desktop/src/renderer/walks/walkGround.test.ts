import type { Layer } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  cachedGround,
  createWalkGround,
  drapePoints,
  drapeRunsInFrames,
  drapeStations,
  groundTiers,
  layerGround,
  type FrameScheduler,
} from './walkGround';

const layer = (id: string, kind: string, role?: string) =>
  ({ id, kind, ...(role ? { role } : {}) }) as unknown as Layer;

const LAYERS = [
  layer('mesh', 'mesh'),
  layer('ortho', 'raster', 'ortho'),
  layer('cloud', 'pointcloud'),
  layer('dsm', 'raster', 'dsm'),
  layer('streets', 'basemap'),
  layer('walk', 'walk'),
];

/** Frames run only when the test steps them. */
function frames(): FrameScheduler & { step(): void; pending(): number } {
  const queue = new Map<number, () => void>();
  let next = 1;
  return {
    request(cb) {
      queue.set(next, cb);
      return next++;
    },
    cancel(h) {
      queue.delete(h);
    },
    step() {
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) cb();
    },
    pending: () => queue.size,
  };
}

describe('groundTiers', () => {
  it('the DSM first, then the ground imagery, then models and clouds', () => {
    expect(groundTiers(LAYERS)).toEqual([['dsm'], ['ortho', 'streets'], ['mesh', 'cloud']]);
  });
});

describe('layerGround', () => {
  it('takes the DSM straight down before anything else', () => {
    const ray = vi.fn((_x: number, _z: number, id: string) =>
      id === 'dsm' ? 4 : id === 'ortho' ? 9 : 12,
    );
    expect(layerGround(LAYERS, ray)(1, 2)).toBe(4);
    expect(ray).toHaveBeenCalledWith(1, 2, 'dsm');
    expect(ray).not.toHaveBeenCalledWith(1, 2, 'mesh');
  });

  it('off the DSM: the imagery, else the top of the models and clouds', () => {
    const imagery = layerGround(LAYERS, (_x, _z, id) =>
      id === 'ortho' ? 3 : id === 'streets' ? 1 : null,
    );
    expect(imagery(0, 0)).toBe(3);
    const models = layerGround(LAYERS, (_x, _z, id) =>
      id === 'mesh' ? 5 : id === 'cloud' ? 7 : null,
    );
    expect(models(0, 0)).toBe(7);
  });

  it('null where nothing is drawn under the point', () => {
    expect(layerGround(LAYERS, () => null)(0, 0)).toBeNull();
  });

  it('asks only the layers a ray can hit now', () => {
    const ray = vi.fn((_x: number, _z: number, id: string) => (id === 'mesh' ? 2 : 8));
    const g = layerGround(LAYERS, ray, () => new Set(['mesh']));
    expect(g(0, 0)).toBe(2);
    expect(ray).toHaveBeenCalledTimes(1);
  });
});

describe('cachedGround', () => {
  it('asks once per cell until cleared', () => {
    const ground = vi.fn(() => 3);
    const g = cachedGround(ground, 1);
    expect(g(0.1, 0.2)).toBe(3);
    expect(g(0.3, 0.4)).toBe(3);
    expect(g(5.2, 0)).toBe(3);
    expect(ground).toHaveBeenCalledTimes(2);
    g.clear();
    g(0.1, 0.2);
    expect(ground).toHaveBeenCalledTimes(3);
  });

  it('remembers a miss too', () => {
    const ground = vi.fn(() => null);
    const g = cachedGround(ground, 1);
    expect(g(0, 0)).toBeNull();
    expect(g(0, 0)).toBeNull();
    expect(ground).toHaveBeenCalledTimes(1);
  });
});

describe('drapeStations', () => {
  it('the first point, one about every step along the run, and the last', () => {
    const pts: [number, number, number][] = [0, 0.5, 1, 1.5, 2, 2.2].map((x) => [x, 0, 0]);
    expect(drapeStations(pts, 1)).toEqual([0, 2, 4, 5]);
    expect(drapeStations([], 1)).toEqual([]);
  });
});

describe('drapePoints', () => {
  it('lays the run on the ground, lifted, interpolated between stations', () => {
    const pts: [number, number, number][] = [
      [0, 0, 0],
      [0.5, 0, 0],
      [1, 0, 0],
    ];
    const out = drapePoints(pts, (x) => 10 + x * 2, 0.15, 1);
    [10.15, 11.15, 12.15].forEach((y, i) => {
      expect(out[i]?.[1]).toBeCloseTo(y, 9);
    });
    expect(out.map((p) => p[0])).toEqual([0, 0.5, 1]);
  });

  it('keeps the stored (pin) height where the ground answers nothing', () => {
    const pts: [number, number, number][] = [
      [0, 2, 0],
      [5, 2, 0],
    ];
    expect(drapePoints(pts, () => null, 0.15).map((p) => p[1])).toEqual([2.15, 2.15]);
    // part on the ground, part off it
    const half = drapePoints(pts, (x) => (x < 1 ? 6 : null), 0, 1);
    expect(half.map((p) => p[1])).toEqual([6, 2]);
  });
});

describe('drapeRunsInFrames', () => {
  const run = (n: number): [number, number, number][] =>
    Array.from({ length: n }, (_, i) => [i, 0, 0] as [number, number, number]);

  it('a short walk drapes at once', () => {
    const done = vi.fn();
    const f = frames();
    drapeRunsInFrames([run(5)], () => 1, 0, done, { budget: 100, scheduler: f });
    expect(done).toHaveBeenCalledTimes(1);
    const [draped] = done.mock.calls[0]?.[0] as [number, number, number][][];
    expect(draped?.map((p) => p[1])).toEqual([1, 1, 1, 1, 1]);
    expect(f.pending()).toBe(0);
  });

  it('spreads a long walk over frames, at most the budget each', () => {
    const ground = vi.fn(() => 2);
    const done = vi.fn();
    const f = frames();
    drapeRunsInFrames([run(6), run(5)], ground, 0.5, done, { budget: 4, scheduler: f });
    // 11 stations: 4 now, 4 next frame, 3 after
    expect(ground).toHaveBeenCalledTimes(4);
    expect(done).not.toHaveBeenCalled();
    f.step();
    expect(ground).toHaveBeenCalledTimes(8);
    expect(done).not.toHaveBeenCalled();
    f.step();
    expect(ground).toHaveBeenCalledTimes(11);
    expect(done).toHaveBeenCalledTimes(1);
    const [a, b] = done.mock.calls[0]?.[0] as [number, number, number][][];
    expect(a?.length).toBe(6);
    expect(b?.every((p) => p[1] === 2.5)).toBe(true);
  });

  it('a cancelled drape stops asking and never reports', () => {
    const ground = vi.fn(() => 2);
    const done = vi.fn();
    const f = frames();
    const cancel = drapeRunsInFrames([run(10)], ground, 0, done, { budget: 3, scheduler: f });
    cancel();
    f.step();
    expect(ground).toHaveBeenCalledTimes(3);
    expect(done).not.toHaveBeenCalled();
  });

  it('no runs: done at once with none', () => {
    const done = vi.fn();
    drapeRunsInFrames([], () => 0, 0, done, { scheduler: frames() });
    expect(done).toHaveBeenCalledWith([]);
  });
});

describe('createWalkGround', () => {
  it('remembers answers until resampled, and moves its version then', () => {
    const ray = vi.fn(() => 4);
    const source = vi.fn(() => ray);
    const g = createWalkGround(source);
    expect(g.ground(0, 0)).toBe(4);
    expect(g.ground(0, 0)).toBe(4);
    expect(ray).toHaveBeenCalledTimes(1);
    expect(g.store.getState().version).toBe(0);
    g.resample();
    expect(g.store.getState().version).toBe(1);
    expect(g.ground(0, 0)).toBe(4);
    expect(ray).toHaveBeenCalledTimes(2);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('no 3D view: every ask is null and nothing is remembered', () => {
    let ray: (() => number) | null = null;
    const g = createWalkGround(() => ray);
    expect(g.ground(0, 0)).toBeNull();
    ray = () => 2;
    expect(g.ground(0, 0)).toBe(2);
  });
});
