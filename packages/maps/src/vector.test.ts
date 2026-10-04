import type { ClassCatalogue, Issue, SeverityModel } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { issueFeatures, lineLengthM, polygonAreaM2, styleLayers } from './vector';

describe('vector style to map layers', () => {
  it('draws a dashed line with labels, from a zoom', () => {
    const layers = styleLayers({
      line: { color: '#ffffff', width: 2, dash: [3, 3] },
      label: { field: 'label' },
      minZoom: 12,
    });
    expect(layers.map((l) => l.type)).toEqual(['line', 'symbol']);
    const line = layers[0];
    expect(line?.paint).toMatchObject({ 'line-color': '#ffffff', 'line-width': 2 });
    expect(line?.paint?.['line-dasharray']).toEqual([3, 3]);
    expect(line?.minzoom).toBe(12);
    expect(layers[1]?.layout?.['text-field']).toEqual(['get', 'label']);
  });

  it('colours fills by a numeric property with step stops', () => {
    const [fill] = styleLayers({
      fill: { color: '#6d6d6d', opacity: 0.6 },
      colorBy: {
        field: 'pciMedium',
        stops: [
          [0, '#6d6d6d'],
          [86, '#1f9d55'],
        ],
      },
    });
    expect(fill?.type).toBe('fill');
    expect(fill?.paint?.['fill-color']).toEqual([
      'step',
      ['to-number', ['get', 'pciMedium'], 0],
      '#6d6d6d',
      86,
      '#1f9d55',
    ]);
    expect(fill?.paint?.['fill-opacity']).toBe(0.6);
  });

  it('draws nothing for an empty style but a default outline', () => {
    expect(styleLayers(undefined).map((l) => l.type)).toEqual(['line']);
  });
});

describe('geodesic measures', () => {
  it('measures a line along a meridian (1 degree is about 110.9 km at 29 N)', () => {
    expect(
      lineLengthM([
        [48, 29],
        [48, 30],
      ]) / 1000,
    ).toBeCloseTo(110.9, 0);
    expect(lineLengthM([[48, 29]])).toBe(0);
  });

  it('measures the area of a 100 m square near Kuwait City within 0.5 %', () => {
    const dLat = 100 / 110_860;
    const dLon = 100 / (111_320 * Math.cos((29.37 * Math.PI) / 180));
    const sq: [number, number][] = [
      [47.98, 29.37],
      [47.98 + dLon, 29.37],
      [47.98 + dLon, 29.37 + dLat],
      [47.98, 29.37 + dLat],
    ];
    expect(polygonAreaM2(sq)).toBeGreaterThan(9950);
    expect(polygonAreaM2(sq)).toBeLessThan(10050);
  });
});

const model: SeverityModel = {
  id: 'road',
  name: 'Road',
  levels: [
    { value: 1, label: 'Low', color: '#fad34b', criteria: '' },
    { value: 3, label: 'High', color: '#ee3f4b', criteria: '' },
  ],
};
const catalogue: ClassCatalogue = {
  id: 'c',
  name: 'C',
  assetType: 'road',
  classes: [{ id: 'potholes', label: 'Potholes', color: '#ff4fa3', severityModel: 'road' }],
};

function issue(id: string, severity: number, geojson: Record<string, unknown>): Issue {
  return {
    id,
    code: `D${id.padStart(4, '0')}`,
    classId: 'potholes',
    severityModelId: 'road',
    severity,
    status: 'reviewed',
    title: 'Pothole',
    note: '',
    author: 'test',
    createdAt: '2024-04-02T00:00:00+03:00',
    updatedAt: '2024-04-02T00:00:00+03:00',
    sightings: [{ on: 'map', layer: 'ortho', geojson }],
    source: 'import',
  };
}

const square = {
  type: 'Polygon',
  coordinates: [
    [
      [48, 29],
      [48.001, 29],
      [48.001, 29.001],
      [48, 29.001],
      [48, 29],
    ],
  ],
};

describe('issue features', () => {
  it('gives polygon sightings a shape and every issue a point, coloured by model and class', () => {
    const f = issueFeatures(
      [issue('1', 3, square), issue('2', 1, { type: 'Point', coordinates: [48, 29] })],
      { models: [model], catalogues: [catalogue], selectedId: '1', proj: null },
    );
    expect(f.points.features).toHaveLength(2);
    expect(f.shapes.features).toHaveLength(1);
    const shape = f.shapes.features[0];
    expect(shape?.properties).toMatchObject({
      issueId: '1',
      sevColor: '#ee3f4b',
      classColor: '#ff4fa3',
      selected: true,
    });
    const point2 = f.points.features.find((p) => p.properties?.issueId === '2');
    expect(point2?.properties).toMatchObject({ hasShape: false, sevColor: '#fad34b' });
  });

  it('keeps only the issues in the filter and draws higher severities on top', () => {
    const f = issueFeatures([issue('1', 3, square), issue('2', 1, square), issue('3', 1, square)], {
      models: [model],
      catalogues: [catalogue],
      selectedId: null,
      proj: null,
      only: new Set(['1', '2']),
    });
    expect(f.shapes.features.map((x) => String(x.properties?.issueId))).toEqual(['2', '1']);
  });
});
