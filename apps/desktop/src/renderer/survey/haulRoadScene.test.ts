// @vitest-environment jsdom
import type { MapController } from '@aio/maps';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../shell', () => ({ bridge: { call: () => Promise.resolve({ ok: false }) }, jobs: {} }));

const { attachHaulMap } = await import('./haulRoadScene');
const { haul } = await import('./haulRoadStore');

/** A map whose style loads when told to, and which can drop its layers (a style reload). */
function fakeMap() {
  const handlers = new Map<string, Set<() => void>>();
  const sources = new Map<string, { setData: (d: unknown) => void }>();
  const layers = new Set<string>();
  let loaded = false;
  const map = {
    isStyleLoaded: () => loaded,
    getSource: (id: string) => sources.get(id),
    addSource: (id: string) => {
      sources.set(id, { setData: () => undefined });
    },
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    addLayer: (l: { id: string }) => {
      layers.add(l.id);
    },
    removeLayer: (id: string) => {
      layers.delete(id);
    },
    removeSource: (id: string) => {
      sources.delete(id);
    },
    on: (ev: string, fn: () => void) => {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev)?.add(fn);
    },
    off: (ev: string, fn: () => void) => {
      handlers.get(ev)?.delete(fn);
    },
  };
  const fire = (ev: string) => {
    for (const fn of [...(handlers.get(ev) ?? [])]) fn();
  };
  return {
    ctl: { map } as unknown as MapController,
    layers,
    sources,
    handlers,
    fire,
    load: () => {
      loaded = true;
    },
  };
}

const frame = { epsg: 32756, toLocal: () => [0, 0, 0] as const, toSite: () => [0, 0, 0] as const };

describe('attachHaulMap', () => {
  it('draws the centreline once the map is idle when it was attached while the style loaded', () => {
    haul.setState({ pieces: [], shown: true });
    const m = fakeMap();
    const detach = attachHaulMap(m.ctl, frame as never);
    expect(m.layers.size).toBe(0);
    m.load();
    m.fire('idle');
    expect(m.layers.has('aio-haul-road-line')).toBe(true);
    expect(m.sources.has('aio-haul-road')).toBe(true);
    detach();
    expect(m.layers.size).toBe(0);
    expect(m.handlers.get('idle')?.size ?? 0).toBe(0);
  });

  it('draws the layer again when the map is idle after it was dropped', () => {
    const m = fakeMap();
    m.load();
    const detach = attachHaulMap(m.ctl, frame as never);
    expect(m.layers.has('aio-haul-road-line')).toBe(true);
    m.layers.clear();
    m.fire('idle');
    expect(m.layers.has('aio-haul-road-line')).toBe(true);
    detach();
  });
});
