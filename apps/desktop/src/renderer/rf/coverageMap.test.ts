import { describe, expect, it } from 'vitest';
import { attachCoverageMap, type CoverageMapLike } from './coverageMap';

describe('attachCoverageMap', () => {
  it('takes its wait for a loading style off the map on dispose', () => {
    const on = new Map<string, Set<() => void>>();
    const add = (type: string, fn: () => void) => {
      if (!on.has(type)) on.set(type, new Set());
      on.get(type)?.add(fn);
    };
    const map: CoverageMapLike = {
      isStyleLoaded: () => false,
      getSource: () => undefined,
      addSource: () => undefined,
      removeSource: () => undefined,
      getLayer: () => undefined,
      addLayer: () => undefined,
      removeLayer: () => undefined,
      setPaintProperty: () => undefined,
      setLayoutProperty: () => undefined,
      on: add,
      once: add,
      off: (type, fn) => on.get(type)?.delete(fn),
    };
    const view = attachCoverageMap({ map });
    view.draw({ image: null, arrows: [], visible: true, opacity: 0.6 });
    expect(on.get('idle')?.size).toBe(1);
    view.dispose();
    expect(on.get('idle')?.size ?? 0).toBe(0);
    expect(on.get('styledata')?.size ?? 0).toBe(0);
  });
});
