import type { Issue, ProjectManifest, RoadModel } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  chainageAt,
  chainageBins,
  defectRows,
  densityBreaks,
  densityColor,
  filterDefects,
  gridCellRing,
  isRoadProject,
  pciRating,
  pointAtKm,
  sortDefects,
  type DefectRow,
} from './model';

const road: RoadModel = {
  schema: 'aio.road/1',
  name: 'Test',
  centreline: {
    // 100 m east, then 100 m south
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
    ratings: [
      { min: 86, label: 'Good', color: '#1f9d55' },
      { min: 71, label: 'Satisfactory', color: '#8bc34a' },
      { min: 0, label: 'Failed', color: '#6d6d6d' },
    ],
    grid: { cellM: 15, origin: [-10, 0, -10] },
    sections: [],
    units: [],
  },
  density: { gridOrigin: [-10, 0, -10], sizes: {} },
};

describe('road project', () => {
  const base = { layers: [], classCatalogues: [] } as unknown as ProjectManifest;
  it('is a road survey when it has the road review or a road class catalogue', () => {
    expect(isRoadProject(base)).toBe(false);
    expect(
      isRoadProject({
        ...base,
        layers: [
          {
            kind: 'legacy',
            id: 'r',
            name: 'Road review',
            visible: true,
            viewer: 'road',
            entry: { path: 'legacy/x.html' },
          },
        ],
      }),
    ).toBe(true);
    expect(
      isRoadProject({
        ...base,
        classCatalogues: [{ id: 'c', name: 'C', assetType: 'road', classes: [] }],
      }),
    ).toBe(true);
  });
});

describe('chainage', () => {
  it('finds the chainage and side offset of a point near the centreline', () => {
    const a = chainageAt(road, 50, 3);
    expect(a.km).toBeCloseTo(0.05, 6);
    expect(a.offsetM).toBeCloseTo(3, 6);
    const b = chainageAt(road, 104, 40);
    expect(b.km).toBeCloseTo(0.14, 6);
    expect(b.offsetM).toBeCloseTo(4, 6);
  });

  it('places a chainage on the centreline, clamped to the road', () => {
    const p = pointAtKm(road, 0.15);
    expect(p[0]).toBeCloseTo(100, 9);
    expect(p[2]).toBeCloseTo(50, 9);
    expect(pointAtKm(road, -1)).toEqual([0, 0, 0]);
    expect(pointAtKm(road, 9)).toEqual([100, 0, 100]);
  });
});

describe('PCI', () => {
  it('rates a value by the highest class minimum it reaches', () => {
    expect(pciRating(road.pci.ratings, 87.6)?.label).toBe('Good');
    expect(pciRating(road.pci.ratings, 85.4)?.label).toBe('Satisfactory');
    expect(pciRating(road.pci.ratings, null)).toBeNull();
  });
});

describe('density', () => {
  it('breaks counts at quantiles of the non-zero cells, strictly increasing', () => {
    const values = [0, 0, 1, 1, 1, 2, 2, 3, 4, 5, 8, 12, 30];
    const br = densityBreaks(values, 'count');
    expect(br[0]).toBe(1);
    for (let i = 1; i < br.length; i++) expect(br[i]).toBeGreaterThan(br[i - 1] ?? 0);
    expect(densityBreaks([0, 2, 3], 'pct')).toEqual([0.5, 2, 5, 10, 20]);
  });

  it('colours zero cells faint and the top break with the hottest colour', () => {
    const br = [1, 2, 5];
    expect(densityColor(0, br)).toBeNull();
    expect(densityColor(1, br)).toBe('#f2c94c');
    expect(densityColor(100, br)).toBe('#e8384f');
  });

  it('turns a grid cell into its local ring', () => {
    expect(gridCellRing([-10, 0, -10], 15, 1, 2)).toEqual([
      [20, 0, 5],
      [35, 0, 5],
      [35, 0, 20],
      [20, 0, 20],
    ]);
  });
});

const manifest = {
  severityModels: [
    {
      id: 'sev',
      name: 'Road',
      levels: [
        { value: 1, label: 'Low', color: '#fad34b', criteria: '' },
        { value: 2, label: 'Medium', color: '#ff7a2d', criteria: '' },
        { value: 3, label: 'High', color: '#ee3f4b', criteria: '' },
      ],
    },
  ],
  classCatalogues: [
    {
      id: 'c',
      name: 'C',
      assetType: 'road',
      classes: [
        { id: 'potholes', label: 'Potholes', color: '#ff4fa3' },
        { id: 'bleeding', label: 'Bleeding', color: '#ff7a2d' },
      ],
    },
  ],
} as unknown as ProjectManifest;

function issue(id: string, classId: string, severity: number, x: number, area: number): Issue {
  return {
    id,
    code: `D${id.padStart(4, '0')}`,
    classId,
    severityModelId: 'sev',
    severity,
    status: 'reviewed',
    title: `${classId} defect`,
    note: '',
    author: 't',
    createdAt: '2024-04-02T00:00:00+03:00',
    updatedAt: '2024-04-02T00:00:00+03:00',
    sightings: [
      {
        on: 'map',
        layer: 'ortho',
        geojson: { type: 'Point', coordinates: [x, 0] },
      },
      {
        on: 'image',
        layer: 'closeups',
        photo: `f${id}`,
        geom: { type: 'point', x: 1, y: 1 },
      },
    ],
    measurements: [{ kind: 'area', value: area, unit: 'm2' }],
    source: 'import',
  };
}

// a fake projection: lon is local x, lat is -z
const toLocal = (lon: number, lat: number): [number, number] => [lon, -lat];

describe('defect rows', () => {
  const rows = defectRows(
    [
      issue('1', 'potholes', 3, 10, 2),
      issue('2', 'bleeding', 1, 90, 20),
      issue('3', 'potholes', 1, 50, 5),
    ],
    manifest,
    road,
    toLocal,
  );

  it('carries chainage, area, severity label and colours, and the close-up', () => {
    const r: DefectRow | undefined = rows.find((x) => x.id === '2');
    if (!r) throw new Error('row 2 missing');
    expect(r.km).toBeCloseTo(0.09, 6);
    expect(r.areaM2).toBe(20);
    expect(r.severityLabel).toBe('Low');
    expect(r.classLabel).toBe('Bleeding');
    expect(r.photo).toEqual({ layer: 'closeups', photo: 'f2' });
  });

  it('filters by severity, class, chainage range and search', () => {
    const all = { severities: null, classes: null, kmRange: null, search: '' };
    expect(filterDefects(rows, { ...all, severities: new Set([3]) }).map((r) => r.id)).toEqual([
      '1',
    ]);
    expect(filterDefects(rows, { ...all, classes: new Set(['potholes']) })).toHaveLength(2);
    expect(filterDefects(rows, { ...all, kmRange: [0.04, 0.1] }).map((r) => r.id)).toEqual([
      '2',
      '3',
    ]);
    expect(filterDefects(rows, { ...all, search: 'D0003' }).map((r) => r.id)).toEqual(['3']);
    expect(filterDefects(rows, { ...all, search: 'km 0.09' }).map((r) => r.id)).toEqual(['2']);
  });

  it('sorts worst first (severity, then area), by chainage or by area', () => {
    expect(sortDefects(rows, 'severity').map((r) => r.id)).toEqual(['1', '2', '3']);
    expect(sortDefects(rows, 'chainage').map((r) => r.id)).toEqual(['1', '3', '2']);
    expect(sortDefects(rows, 'area').map((r) => r.id)).toEqual(['2', '3', '1']);
  });

  it('counts defects per chainage bin and severity', () => {
    const bins = chainageBins(rows, 0.2, 0.1);
    expect(bins).toHaveLength(2);
    expect(bins[0]?.bySeverity).toEqual({ 1: 2, 3: 1 });
    expect(bins[0]?.total).toBe(3);
    expect(bins[1]?.total).toBe(0);
    expect(bins[1]?.fromKm).toBeCloseTo(0.1, 9);
  });
});
