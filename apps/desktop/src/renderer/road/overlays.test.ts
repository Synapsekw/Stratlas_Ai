import type { RoadModel, Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { densityCollection, pciLayers, roadOverlays } from './overlays';

const road = {
  schema: 'aio.road/1',
  name: 'Test',
  centreline: { points: [], chainageKm: [], lengthKm: 1 },
  pci: {
    ratings: [
      { min: 86, label: 'Good', color: '#1f9d55' },
      { min: 41, label: 'Poor', color: '#f2994a' },
      { min: 0, label: 'Failed', color: '#6d6d6d' },
    ],
  },
  density: {
    gridOrigin: [0, 0, 0],
    sizes: {
      '20': [
        { i: 0, j: 0, pavementM2: 400, defects: 0, defectM2: 0, coverPct: 0 },
        { i: 0, j: 1, pavementM2: 400, defects: 3, defectM2: 8, coverPct: 2 },
        { i: 1, j: 1, pavementM2: 400, defects: 9, defectM2: 40, coverPct: 10 },
      ],
    },
  },
  overlays: { centreline: 'road/centreline.geojson', pciUnits: 'road/pci-units.geojson' },
} as unknown as RoadModel;

const toLonLat = (p: Vec3 | readonly [number, number, number]): [number, number] => [p[0], -p[2]];

describe('road overlays', () => {
  it('builds density cells as polygons with a class colour and a faint empty colour', () => {
    const fc = densityCollection(road, '20', 'count', toLonLat);
    expect(fc.features).toHaveLength(3);
    const empty = fc.features[0];
    expect(empty?.properties?.empty).toBe(true);
    const hot = fc.features[2];
    expect(hot?.properties?.color).toBe('#e8384f');
    expect(hot?.geometry).toMatchObject({
      type: 'Polygon',
      coordinates: [
        [
          [20, -20],
          [40, -20],
          [40, -40],
          [20, -40],
          [20, -20],
        ],
      ],
    });
  });

  it('colours PCI units by the chosen severity with the rating steps', () => {
    const [fill] = pciLayers(road, 'high', 0.7);
    expect(fill?.paint?.['fill-color']).toEqual([
      'step',
      ['to-number', ['get', 'pciHigh'], -1],
      '#6d6d6d',
      40.5,
      '#f2994a',
      85.5,
      '#1f9d55',
    ]);
    expect(fill?.paint?.['fill-opacity']).toBe(0.7);
  });

  it('shows the centreline and only the chosen area overlay', () => {
    const url = (p: string) => `aio://project/rr/${p}`;
    const opts = {
      centreline: true,
      overlay: 'pci' as const,
      pciSeverity: 'medium' as const,
      densitySize: '20',
      densityMeasure: 'count' as const,
      opacity: 0.7,
    };
    const list = roadOverlays(road, opts, { url, toLonLat, density: null });
    expect(list.map((o) => [o.id, o.visible])).toEqual([
      ['road-pci', true],
      ['road-centreline', true],
    ]);
    expect(list[1]?.data).toBe('aio://project/rr/road/centreline.geojson');
    const none = roadOverlays(
      road,
      { ...opts, overlay: 'none', centreline: false },
      {
        url,
        toLonLat,
        density: null,
      },
    );
    expect(none.map((o) => o.visible)).toEqual([false, false]);
  });
});
