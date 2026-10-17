import type { Map as MapLibreMap } from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import {
  MEDIA_PIN_LAYERS,
  mediaPinData,
  removeMediaPins,
  setMediaPins,
  type MapPin,
} from './mediaPins';

const pins: MapPin[] = [
  { id: 'photo:ph:a', kind: 'photo', ground: [10, 0, -20], headingDeg: 95 },
  { id: 'pano:pa:b', kind: 'pano', ground: [5, 0, 5] },
];

function fakeMap() {
  const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
  const layers = new Map<string, unknown>();
  const images = new Set<string>();
  const map = {
    addSource: vi.fn((id: string) => sources.set(id, { setData: vi.fn() })),
    getSource: (id: string) => sources.get(id),
    removeSource: vi.fn((id: string) => sources.delete(id)),
    addLayer: vi.fn((l: { id: string }) => layers.set(l.id, l)),
    getLayer: (id: string) => layers.get(id),
    removeLayer: vi.fn((id: string) => layers.delete(id)),
    hasImage: (id: string) => images.has(id),
    addImage: vi.fn((id: string) => images.add(id)),
    removeImage: vi.fn((id: string) => images.delete(id)),
  };
  return { map, sources, layers, images, m: map as unknown as MapLibreMap };
}

describe('media pin arrows', () => {
  it('projects the ground point and keeps a heading only when the pin has one', () => {
    const data = mediaPinData(pins, (p) => [p[0] * 2, p[2] * 2]);
    expect(data.features).toEqual([
      {
        type: 'Feature',
        properties: { id: 'photo:ph:a', kind: 'photo', heading: 95 },
        geometry: { type: 'Point', coordinates: [20, -40] },
      },
      {
        type: 'Feature',
        properties: { id: 'pano:pa:b', kind: 'pano' },
        geometry: { type: 'Point', coordinates: [10, 10] },
      },
    ]);
  });

  it('adds the source and the arrow layer once, then only replaces the data', () => {
    const { map, sources, layers, images, m } = fakeMap();
    const data = mediaPinData(pins, (p) => [p[0], p[2]]);
    setMediaPins(m, data);
    setMediaPins(m, data);
    expect(map.addSource).toHaveBeenCalledTimes(1);
    expect(map.addLayer).toHaveBeenCalledTimes(1);
    expect([...layers.keys()]).toEqual([...MEDIA_PIN_LAYERS]);
    expect(images.size).toBe(1);
    const src = [...sources.values()][0];
    expect(src?.setData).toHaveBeenCalledTimes(1);
    const layer = layers.get('aio-media-pin-arrow') as {
      type: string;
      layout: Record<string, unknown>;
    };
    expect(layer.type).toBe('symbol');
    expect(layer.layout['icon-rotate']).toEqual(['get', 'heading']);
    expect(layer.layout['icon-rotation-alignment']).toBe('map');

    removeMediaPins(m);
    expect(layers.size).toBe(0);
    expect(sources.size).toBe(0);
    // nothing to remove a second time
    removeMediaPins(m);
    expect(map.removeLayer).toHaveBeenCalledTimes(1);
  });
});
