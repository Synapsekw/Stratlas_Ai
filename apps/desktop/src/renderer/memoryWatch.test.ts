import type { EngineStage } from '@aio/engine';
import { createPointcloudSettings } from '@aio/pointcloud';
import { describe, expect, it, vi } from 'vitest';
import { GPU_TIERS, createGraphics } from './graphics';
import { HEAP_PRESSURE, createMemoryWatch, overLimit, type MemorySample } from './memoryWatch';

const GB = 2 ** 30;

describe('overLimit', () => {
  it('reports graphics memory over the cap and a nearly full JavaScript heap', () => {
    const ok: MemorySample = { gpuBytes: 0.5 * GB, heapUsed: GB, heapLimit: 4 * GB };
    expect(overLimit(ok, GB)).toBe(null);
    expect(overLimit({ ...ok, gpuBytes: 1.2 * GB }, GB)).toBe('memory');
    expect(overLimit({ ...ok, heapUsed: 4 * GB * (HEAP_PRESSURE + 0.01) }, GB)).toBe('memory');
    expect(overLimit({ gpuBytes: null, heapUsed: null, heapLimit: null }, GB)).toBe(null);
  });
});

describe('memory watch', () => {
  const setup = (gpuBytes: number) => {
    const clouds = createPointcloudSettings(null);
    const store = createGraphics({ renderer: 'NVIDIA GeForce RTX 3060', storage: null, clouds });
    store.getState().apply();
    const stage = {} as EngineStage;
    const read = vi.fn(() => ({ gpuBytes, heapUsed: null, heapLimit: null }));
    const watch = createMemoryWatch({ store, stage: () => stage, read, timer: false });
    return { store, clouds, watch, read };
  };

  it('steps down when the estimate is over the tier limit, then waits for eviction', () => {
    const { store, watch } = setup(GPU_TIERS.high.gpuBytes + GB);
    expect(watch.check(100_000)).toBe('memory');
    expect(store.getState().tier).toBe('medium');
    // cool-down: the smaller budget gets time to unload nodes
    expect(watch.check(105_000)).toBe(null);
    expect(store.getState().tier).toBe('medium');
    expect(watch.check(120_000)).toBe('memory');
    expect(store.getState().tier).toBe('low');
  });

  it('leaves the tier alone within the limits', () => {
    const { store, watch } = setup(GB);
    expect(watch.check(100_000)).toBe(null);
    expect(store.getState().tier).toBe('high');
  });

  it('steps down on a lost WebGL context and ignores the restore', () => {
    const { store, watch } = setup(0);
    watch.onGpuEvent({ type: 'context-lost' });
    expect(store.getState().tier).toBe('medium');
    expect(store.getState().pressureReason).toBe('context-lost');
    watch.onGpuEvent({ type: 'context-restored' });
    expect(store.getState().tier).toBe('medium');
  });
});
