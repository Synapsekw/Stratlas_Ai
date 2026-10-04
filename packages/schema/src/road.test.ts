import { describe, expect, it } from 'vitest';
import { Layer, parseRoadModel, type RoadModelInput } from './index';

function road(): RoadModelInput {
  return {
    schema: 'aio.road/1',
    name: 'Test road',
    centreline: {
      points: [
        [0, 0, 0],
        [100, 0, 0],
        [100, 0, 100],
      ],
      chainageKm: [0, 0.1, 0.2],
      lengthKm: 0.2,
    },
    pci: {
      standard: 'ASTM D6433',
      severities: ['Low', 'Medium', 'High'],
      headline: 'medium',
      network: { low: 94.8, medium: 87.6, high: 77.5 },
      coveragePct: 99.7,
      ratings: [
        { min: 86, label: 'Good', color: '#1f9d55' },
        { min: 0, label: 'Failed', color: '#6d6d6d' },
      ],
      grid: { cellM: 15, origin: [-10, 0, -10] },
      sections: [
        { fromKm: 0, toKm: 0.25, pavementM2: 100, pci: { low: 90, medium: 80, high: null } },
      ],
      units: [
        {
          id: 'u0-0',
          pavementM2: 156.5,
          pci: { low: 99, medium: 94.6, high: 86.2 },
          km: 0.01,
          deducts: [{ distress: 'potholes', densityPct: 0.5, deduct: 5.4 }],
          cells: [
            [0, 0],
            [0, 1],
          ],
        },
      ],
    },
    density: {
      gridOrigin: [-10, 0, -10],
      sizes: {
        '20': [{ i: 0, j: 1, pavementM2: 42, defects: 2, defectM2: 1.5, coverPct: 3.6 }],
      },
    },
    overlays: { centreline: 'road/centreline.geojson', pciUnits: 'road/pci-units.geojson' },
  };
}

describe('road model (aio.road/1)', () => {
  it('parses a road document', () => {
    const r = parseRoadModel(road());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.pci.units[0]?.cells).toHaveLength(2);
      expect(r.value.density.sizes['20']?.[0]?.defects).toBe(2);
    }
  });

  it('needs one chainage per centreline vertex', () => {
    const doc = road();
    doc.centreline.chainageKm = [0, 0.1];
    const r = parseRoadModel(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/chainage/i);
  });

  it('refuses another schema with a message a person can act on', () => {
    const r = parseRoadModel({ ...road(), schema: 'aio.road/2' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/newer/);
    expect(parseRoadModel(null).ok).toBe(false);
  });
});

describe('vector layer', () => {
  it('declares a GeoJSON file with a simple style', () => {
    const layer = Layer.parse({
      kind: 'vector',
      id: 'centreline',
      name: 'Centreline',
      src: { path: 'road/centreline.geojson' },
      format: 'geojson',
      style: {
        line: { color: '#ffffff', width: 2, dash: [3, 3] },
        label: { field: 'label' },
        minZoom: 12,
      },
    });
    expect(layer.kind).toBe('vector');
    expect(layer.visible).toBe(true);
  });

  it('colours by a numeric property with step stops', () => {
    const layer = Layer.parse({
      kind: 'vector',
      id: 'pci',
      name: 'PCI units',
      src: { path: 'road/pci-units.geojson' },
      format: 'geojson',
      style: {
        fill: { color: '#6d6d6d', opacity: 0.6 },
        colorBy: {
          field: 'pciMedium',
          stops: [
            [0, '#6d6d6d'],
            [86, '#1f9d55'],
          ],
        },
      },
    });
    expect(layer.kind === 'vector' && layer.style?.colorBy?.stops).toHaveLength(2);
  });

  it('rejects unsorted colour stops', () => {
    expect(() =>
      Layer.parse({
        kind: 'vector',
        id: 'pci',
        name: 'PCI units',
        src: { path: 'x.geojson' },
        format: 'geojson',
        style: {
          colorBy: {
            field: 'v',
            stops: [
              [5, '#000000'],
              [1, '#ffffff'],
            ],
          },
        },
      }),
    ).toThrow();
  });
});
