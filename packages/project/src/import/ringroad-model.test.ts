import { describe, expect, it } from 'vitest';
import { Issue, SeverityModel, ClassCatalogue, validateIssueAgainstModel } from '@aio/schema';
import {
  ROAD_CATALOGUE,
  ROAD_SEVERITY_MODEL,
  RrData,
  RrGrid,
  buildPciIndex,
  buildRoadDoc,
  buildRoadIssue,
  classIdOf,
  closeupFrame,
  defectCode,
  pathToImagePolygon,
  pciUnitsGeojson,
  readDefects,
  severityOfStage,
  svgPathRings,
} from './ringroad-model';

const ring: [number, number][] = [
  [47.9941983, 29.3854666],
  [47.9941824, 29.3854715],
  [47.9941707, 29.3854795],
  [47.9941983, 29.3854666],
];
const data = RrData.parse({
  fields: [
    'id',
    'type',
    'stage',
    'area',
    'clusterArea',
    'pct',
    'km',
    'c',
    'g',
    'path',
    'cropWH',
    'len',
    'utm',
  ],
  rows: [
    [
      0,
      'Bleeding',
      1,
      10.64,
      5097.48,
      0.21,
      7.452,
      [47.9941911, 29.3854794],
      ring,
      'M601.4,721.0 402.8,650.4 255.0,528.2 601.4,721.0Z',
      [7.83, 7.04],
      4.8,
      [790614.47, 3254422.84],
    ],
    [
      12,
      'Alligator Cracker',
      3,
      2.5,
      30,
      8.3,
      0.5,
      [47.99, 29.38],
      ring,
      'M0,0 100,0 100,100Z M500,500 900,500 900,900 500,900Z',
      [2, 2],
      1.5,
      [787313.6 + 17 * 15 + 3, 3254469.2 - 152 * 15 - 4],
    ],
  ],
  centerline: [
    [47.97028, 29.372529],
    [47.970208, 29.372486],
  ],
  chainage: [0, 0.0085],
  meta: { road: '1st Ring Road', gsd_cm: 1.25, crs: 'WGS 84 / UTM zone 38N (EPSG:32638)' },
});
const grid = RrGrid.parse({
  origin: [787313.5686505446, 3254469.226646473],
  density: { '10': [[0, 166, 42, 0, 0, 0]] },
  pci: {
    unit_m: 15,
    min_pavement_m2: 135,
    coverage_pct: 99.7,
    road: [94.8, 87.6, 77.5],
    sections: [[0, 10960.7, 90.6, 78.1, 59.3]],
    units: [
      [
        152,
        17,
        156.5,
        [99, 94.6, 86.2],
        1.085,
        [['longitudinal_transverse_cracking', 0.57, 5.4]],
        [
          [152, 17],
          [152, 16],
        ],
      ],
    ],
  },
});

describe('severity model and classes', () => {
  it('maps the delivered stages Few, Intermediate, Extensive to Low, Medium, High', () => {
    expect(severityOfStage(1)).toBe(1);
    expect(severityOfStage(2)).toBe(2);
    expect(severityOfStage(3)).toBe(3);
    expect(() => severityOfStage(4)).toThrow(/stage/);
    expect(ROAD_SEVERITY_MODEL.name).toBe('Road distress (ASTM D6433)');
    expect(ROAD_SEVERITY_MODEL.levels.map((l) => l.label)).toEqual(['Low', 'Medium', 'High']);
    expect(SeverityModel.safeParse(ROAD_SEVERITY_MODEL).success).toBe(true);
  });

  it('has one class per delivered defect type, with the alligator typo fixed in the label', () => {
    expect(ClassCatalogue.safeParse(ROAD_CATALOGUE).success).toBe(true);
    expect(ROAD_CATALOGUE.classes).toHaveLength(10);
    expect(classIdOf('Alligator Cracker')).toBe('alligator-cracking');
    expect(ROAD_CATALOGUE.classes.find((c) => c.id === 'alligator-cracking')?.label).toBe(
      'Alligator cracking',
    );
    expect(() => classIdOf('Shoving')).toThrow(/Shoving/);
  });

  it('codes issues by shapefile FID', () => {
    expect(defectCode(0)).toBe('D0000');
    expect(defectCode(2114)).toBe('D2114');
  });
});

describe('close-up outlines', () => {
  it('reads every ring of an SVG path in the 0..1000 view box', () => {
    expect(svgPathRings('M0,0 100,0 100,100Z M500,500 900,500 900,900Z')).toEqual([
      [
        [0, 0],
        [100, 0],
        [100, 100],
      ],
      [
        [500, 500],
        [900, 500],
        [900, 900],
      ],
    ]);
  });

  it('scales the largest ring to image pixels and drops the closing point', () => {
    const poly = pathToImagePolygon(
      'M0,0 100,0 100,100Z M500,500 900,500 900,900 500,900Z',
      200,
      100,
    );
    expect(poly).toEqual([
      [100, 50],
      [180, 50],
      [180, 90],
      [100, 90],
    ]);
    expect(
      pathToImagePolygon('M601.4,721.0 402.8,650.4 255.0,528.2 601.4,721.0Z', 1000, 1000),
    ).toHaveLength(3);
  });
});

describe('PCI sample units', () => {
  const index = buildPciIndex(grid);

  it('finds the unit of a UTM position through any of its 15 m cells', () => {
    const u = index.at(787313.5686505446 + 16 * 15 + 1, 3254469.226646473 - 152 * 15 - 1);
    expect(u?.id).toBe('u152-17');
    expect(u?.pci).toEqual([99, 94.6, 86.2]);
    expect(index.at(787313.57 + 3 * 15, 3254469.22 - 3 * 15)).toBeNull();
  });

  it('writes the units as lon/lat polygons with their PCI values', () => {
    const fc = pciUnitsGeojson(grid, (e, n) => [e / 1000, n / 1000]);
    expect(fc.features).toHaveLength(1);
    const f = fc.features[0];
    expect(f?.properties).toMatchObject({
      id: 'u152-17',
      pciLow: 99,
      pciMedium: 94.6,
      pciHigh: 86.2,
    });
    expect(f?.geometry.type).toBe('MultiPolygon');
    expect(f?.geometry.coordinates).toHaveLength(2);
  });
});

describe('defects as issues', () => {
  const defects = readDefects(data);
  const index = buildPciIndex(grid);
  const ctx = {
    mapLayer: 'ortho',
    photosLayer: 'closeups',
    photoSize: (id: string) => (id === 'f0000' ? { width: 621, height: 558 } : null),
    pciUnitAt: index.at,
    createdAt: '2024-04-02T00:00:00+03:00',
    author: 'MPW defect shapefile',
  };

  it('reads the rows by the field list', () => {
    expect(defects[1]).toMatchObject({ id: 12, type: 'Alligator Cracker', stage: 3, km: 0.5 });
  });

  it('builds an issue with a lon/lat map polygon and the close-up outline', () => {
    const d = defects[0];
    if (!d) throw new Error('no defect');
    const issue = buildRoadIssue(d, ctx);
    expect(Issue.safeParse(issue).success).toBe(true);
    expect(validateIssueAgainstModel(issue, ROAD_SEVERITY_MODEL).ok).toBe(true);
    expect(issue).toMatchObject({
      id: 'rr-0000',
      code: 'D0000',
      classId: 'bleeding',
      severity: 1,
      status: 'reviewed',
      title: 'Bleeding at km 7.452',
      source: 'import',
    });
    expect(issue.sightings[0]).toEqual({
      on: 'map',
      layer: 'ortho',
      geojson: { type: 'Polygon', coordinates: [ring] },
    });
    const img = issue.sightings[1];
    expect(img?.on).toBe('image');
    if (img?.on !== 'image' || img.geom.type !== 'polygon') throw new Error('no image polygon');
    expect(img.photo).toBe('f0000');
    expect(img.geom.points[0]).toEqual([373.47, 402.32]);
    expect(issue.measurements).toEqual([
      { kind: 'area', value: 10.64, unit: 'm2' },
      { kind: 'distance', value: 4.8, unit: 'm' },
    ]);
    expect(issue.note).toContain('Stage as delivered: Few');
    expect(issue.note).toContain('10.64 m²');
    expect(issue.note).toContain('outside the PCI sample units');
  });

  it('names the PCI unit in the note and grades the delivered stage', () => {
    const d = defects[1];
    if (!d) throw new Error('no defect');
    const issue = buildRoadIssue(d, ctx);
    expect(issue.severity).toBe(3);
    expect(issue.classId).toBe('alligator-cracking');
    expect(issue.title).toBe('Alligator cracking at km 0.500');
    expect(issue.note).toContain('PCI sample unit u152-17');
    expect(issue.note).toContain('PCI 99 Low, 95 Medium, 86 High');
    // no close-up of that size: only the map sighting
    expect(issue.sightings).toHaveLength(1);
  });

  it('never writes en or em dashes', () => {
    for (const d of defects) {
      const issue = buildRoadIssue(d, ctx);
      expect(`${issue.title} ${issue.note}`).not.toMatch(/[–—]/);
    }
  });
});

describe('close-up frames', () => {
  const block = { name: 'B', ox: 1000, oy: 5000, sx: 0.0125, sy: 0.0125, w: 400000, h: 400000 };

  it('reproduces the build window: whole source pixels around the box at the native level', () => {
    // 5 m box: native 397 px, level 0; start floors, end ceils to whole 1.25 cm pixels
    const f = closeupFrame([1100.001, 4900.002, 1105.001, 4905.002], [block]);
    expect(f.level).toBe(0);
    expect(f.left).toBeCloseTo(1100, 9);
    expect(f.right).toBeCloseTo(1105.0125, 9);
    expect(f.top).toBeCloseTo(4905.0125, 9);
    expect(f.bottom).toBeCloseTo(4900, 9);
  });

  it('reads a coarser overview for a large box', () => {
    // 40 m box: native 3175 px, level 1 (2.5 cm pixels)
    const f = closeupFrame([1100.01, 4900.01, 1140.01, 4940.01], [block]);
    expect(f.level).toBe(1);
    expect(f.left).toBeCloseTo(1100, 9);
    expect(f.right).toBeCloseTo(1140.025, 9);
  });

  it('takes the last block that covers the box centre (it is drawn on top)', () => {
    const other = { ...block, name: 'C', ox: 1100.005 };
    expect(closeupFrame([1100.001, 4900.002, 1105.001, 4905.002], [block, other]).block).toBe('C');
    expect(closeupFrame([1000.5, 4900, 1001, 4900.5], [block, other]).block).toBe('B');
  });
});

describe('road.json', () => {
  it('carries the centreline in the local frame with chainage, and the PCI units', () => {
    const doc = buildRoadDoc(data, grid, {
      origin: [789000, 3253000, 0],
      toProject: (lon, lat) => [lon * 1000, lat * 1000],
      overlays: { centreline: 'road/centreline.geojson', pciUnits: 'road/pci-units.geojson' },
    });
    expect(doc.schema).toBe('aio.road/1');
    expect(doc.centreline.chainageKm).toEqual([0, 0.0085]);
    const p0 = doc.centreline.points[0] ?? [];
    expect(p0[0]).toBeCloseTo(47970.28 - 789000, 3);
    expect(p0[1]).toBe(0);
    expect(p0[2]).toBeCloseTo(-(29372.529 - 3253000), 3);
    expect(doc.pci.network).toEqual({ low: 94.8, medium: 87.6, high: 77.5 });
    expect(doc.pci.grid.cellM).toBe(15);
    expect(doc.pci.grid.origin[0]).toBeCloseTo(787313.5686505446 - 789000, 3);
    expect(doc.pci.grid.origin[2]).toBeCloseTo(-(3254469.226646473 - 3253000), 3);
    expect(doc.pci.units[0]).toMatchObject({
      id: 'u152-17',
      pavementM2: 156.5,
      pci: { low: 99, medium: 94.6, high: 86.2 },
      km: 1.085,
      deducts: [{ distress: 'longitudinal_transverse_cracking', densityPct: 0.57, deduct: 5.4 }],
      cells: [
        [152, 17],
        [152, 16],
      ],
    });
    expect(doc.density.sizes['10']?.[0]).toEqual({
      i: 0,
      j: 166,
      pavementM2: 42,
      defects: 0,
      defectM2: 0,
      coverPct: 0,
    });
  });
});
