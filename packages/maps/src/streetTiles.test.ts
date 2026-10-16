// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStreetTiles } from './streetTiles';

// WebGL is unavailable in jsdom. The map dependency controls its real event boundary explicitly;
// the renderer, its watchdog, canvas delivery and statistics remain production code.
const fake = vi.hoisted(() => {
  class FakeMap {
    readonly listeners = new Map<string, Set<() => void>>();
    constructor() {
      maps.push(this);
    }
    on(event: string, listener: () => void) {
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }
    off(event: string, listener: () => void) {
      this.listeners.get(event)?.delete(listener);
      return this;
    }
    once(event: string) {
      return new Promise<void>((resolve) => {
        const listener = () => {
          this.off(event, listener);
          resolve();
        };
        this.on(event, listener);
      });
    }
    emit(event: string) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
    }
    jumpTo() {
      /* The test decides when this view produces map events. */
    }
    triggerRepaint() {
      /* Rendering is delivered explicitly by emit. */
    }
    setPixelRatio() {
      /* Pixel geometry does not affect the event deadline. */
    }
    project() {
      return { x: 0, y: 0 };
    }
    getCanvas() {
      return Object.assign(document.createElement('canvas'), { width: 768, height: 768 });
    }
    remove() {
      /* Leave subscriptions visible so the test checks their cleanup. */
    }
  }
  const maps: FakeMap[] = [];
  return { FakeMap, maps };
});
vi.mock('maplibre-gl', () => ({
  Map: fake.FakeMap,
  addProtocol: vi.fn(),
  AJAXError: class extends Error {},
}));
vi.mock('./runtime', () => ({ installBasemap: vi.fn(), basemapResource: vi.fn() }));

let now = 0;
const copy = vi.fn();
beforeEach(() => {
  fake.maps.length = 0;
  now = 0;
  copy.mockClear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: copy } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function drawing() {
  const source = createStreetTiles([
    { id: 'synthetic', label: 'Synthetic', bbox: [-180, -85, 180, 85], maxZoom: 14, sizeBytes: 1 },
  ]);
  if (!source) throw new Error('missing street renderer');
  const pending = source.request(6, 32, 32);
  if (!pending) throw new Error('missing tile request');
  const map = fake.maps[0];
  if (!map) throw new Error('missing hidden map');
  map.emit('load');
  await vi.advanceTimersByTimeAsync(0);
  return { source, pending, map };
}

describe('hidden street tile rendering deadlines', () => {
  it('lets queued rendering finish when the watchdog itself was delayed by a busy renderer', async () => {
    const { source, pending, map } = await drawing();
    // WARP held the UI thread for 15 seconds. The overdue 8-second timer runs before the
    // already queued rendering/data events; it cannot diagnose MapLibre inactivity then.
    now = 15_000;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(copy).not.toHaveBeenCalled();
    map.emit('render');
    map.emit('idle');
    expect(await pending).toBeInstanceOf(HTMLCanvasElement);
    expect(source.stats().timeouts).toBe(0);
    source.dispose();
  });

  it('waits for an actively progressing tile instead of copying an unfinished picture at eight seconds', async () => {
    const { source, pending, map } = await drawing();
    for (const event of ['render', 'data', 'render']) {
      now += 6_000;
      await vi.advanceTimersByTimeAsync(6_000);
      map.emit(event);
      expect(copy).not.toHaveBeenCalled();
    }
    map.emit('idle');
    await pending;
    expect(source.stats().timeouts).toBe(0);
    source.dispose();
  });

  it('still reports a genuinely stalled tile', async () => {
    const { source, pending } = await drawing();
    now = 8_000;
    await vi.advanceTimersByTimeAsync(8_000);
    await pending;
    expect(source.stats().timeouts).toBe(1);
    source.dispose();
  });

  it('bounds even a tile that keeps producing events without ever completing', async () => {
    const { source, pending, map } = await drawing();
    for (let i = 0; i < 4; i++) {
      now += 6_000;
      await vi.advanceTimersByTimeAsync(6_000);
      map.emit('render');
      expect(copy).not.toHaveBeenCalled();
    }
    now = 30_000;
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;
    expect(source.stats().timeouts).toBe(1);
    expect(map.listeners.get('idle')?.size ?? 0).toBe(0);
    source.dispose();
  });

  it('cancels a disposed draw without a false timeout or dangling idle listener', async () => {
    const { source, pending, map } = await drawing();
    source.dispose();
    now = 8_000;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await pending).toBeNull();
    expect(source.stats().timeouts).toBe(0);
    expect(map.listeners.get('idle')?.size ?? 0).toBe(0);
  });
});
