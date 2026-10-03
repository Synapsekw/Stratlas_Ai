import { describe, expect, it } from 'vitest';
import { boxDistance, chunkPriority, selectChunks, type LodCandidate } from './lod';

const box = (x: number, size = 10, lod = 1) => ({
  min: [x, 0, 0] as [number, number, number],
  max: [x + size, size, size] as [number, number, number],
  lod,
});

function cand(key: string, x: number, points: number, extra: Partial<LodCandidate> = {}) {
  const b = box(x, extra.lod === 0 ? 1000 : 10, extra.lod ?? 1);
  return { key, points, bounds: { min: b.min, max: b.max }, lod: b.lod, loaded: false, ...extra };
}

describe('boxDistance', () => {
  it('is zero inside and euclidean outside', () => {
    const b = { min: [0, 0, 0] as const, max: [10, 10, 10] as const };
    expect(boxDistance(b, [5, 5, 5])).toBe(0);
    expect(boxDistance(b, [13, 14, 5])).toBe(5);
  });
});

describe('chunkPriority', () => {
  it('ranks nearer chunks higher and lod 0 highest', () => {
    const near = cand('a', 0, 1);
    const far = cand('b', 500, 1);
    const root = cand('r', 0, 1, { lod: 0 });
    const eye = [-20, 5, 5] as const;
    expect(chunkPriority(near, eye)).toBeGreaterThan(chunkPriority(far, eye));
    expect(chunkPriority(root, eye)).toBe(Infinity);
  });
});

describe('selectChunks', () => {
  const eye = [-5, 5, 5] as const;

  it('loads the nearest chunks first until the budget is reached', () => {
    const r = selectChunks(
      [cand('far', 300, 100), cand('near', 0, 100), cand('mid', 50, 100)],
      eye,
      {
        budget: 200,
      },
    );
    expect(r.load).toEqual(['near', 'mid']);
    expect(r.unload).toEqual([]);
  });

  it('always loads lod 0 even past the budget', () => {
    const r = selectChunks([cand('root', 0, 500, { lod: 0 }), cand('near', 0, 100)], eye, {
      budget: 200,
    });
    expect(r.load).toEqual(['root']);
  });

  it('skips chunks too small on screen', () => {
    const r = selectChunks([cand('tiny', 100_000, 1)], eye, { budget: 1e9, minScreenRatio: 0.01 });
    expect(r.load).toEqual([]);
  });

  it('keeps loaded chunks within the hysteresis margin and unloads beyond it', () => {
    const chunks = [
      cand('a', 0, 100),
      cand('b', 50, 100, { loaded: true }),
      cand('c', 300, 100, { loaded: true }),
    ];
    // budget 100 wants only a; b fits in 100 * 2 kept total, c does not
    const r = selectChunks(chunks, eye, { budget: 100, hysteresis: 2 });
    expect(r.load).toEqual(['a']);
    expect(r.unload).toEqual(['c']);
  });

  it('does not report already loaded wanted chunks', () => {
    const r = selectChunks([cand('a', 0, 10, { loaded: true })], eye, { budget: 100 });
    expect(r).toEqual({ load: [], unload: [] });
  });
});
