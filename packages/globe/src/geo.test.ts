import { crsDefinition } from '@aio/geo';
import type { Issue, Vec3 } from '@aio/schema';
import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import { globeToSite, headingPitch, siteToGlobe } from './camera';
import {
  applyMatrix,
  ecefToGeodetic,
  ecefToLocal,
  enuToEcefMatrix,
  geodeticToEcef,
  localToEcef,
  localToEcefMatrix,
  projectToLonLat,
  type SiteGeoref,
} from './geodesy';
import { issuePins, lastCapture, sightingAnchor, sitesBounds } from './sites';
import {
  decodeTerrarium,
  encodeTerrarium,
  geoidFor,
  gridGeoid,
  heightFromTiles,
  heightmapFor,
  NO_GEOID,
  sampleGrid,
  terrainZoom,
  terrariumHeight,
  tilesForRect,
} from './terrarium';
import {
  imageryLayerOrder,
  lonLatToTileXY,
  packAt,
  packCovers,
  rasterPackUrl,
  selectPacks,
  tileBounds,
} from './tiles';

/** PROJ's geocentric conversion (proj4), the reference for our ECEF maths. */
const geocent = proj4(crsDefinition(4326), '+proj=geocent +datum=WGS84 +units=m +no_defs');
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The fictional desert site of the synthetic data (UTM zone 39N). */
const SITE: SiteGeoref = {
  crs: { epsg: 32639 },
  origin: [745_000, 3_245_000, 12],
  heightOffset: -18.4,
};

describe('Web Mercator tiles and pack choice', () => {
  it('addresses tiles as MapLibre and Cesium do (y from the north)', () => {
    expect(tileBounds(0, 0, 0)[2]).toBeCloseTo(180, 9);
    expect(tileBounds(0, 0, 0)[3]).toBeCloseTo(85.0511287798, 9);
    const [w, s, e, n] = tileBounds(10, 691, 430);
    const [fx, fy] = lonLatToTileXY((w + e) / 2, (s + n) / 2, 10);
    expect([Math.floor(fx), Math.floor(fy)]).toEqual([691, 430]);
    expect(rasterPackUrl('imagery', 'gcc-s2')).toBe('aio://packs/imagery/gcc-s2.pmtiles');
  });

  const world = { id: 'world', bbox: [-180, -85, 180, 85] as const, minZoom: 0, maxZoom: 9 };
  const gcc = { id: 'gcc', bbox: [46, 22, 57, 31] as const, minZoom: 5, maxZoom: 13 };

  it('draws the coarse pack below the detailed one, and picks the best pack at a point', () => {
    expect(imageryLayerOrder([gcc, world]).map((p) => p.id)).toEqual(['world', 'gcc']);
    expect(packAt([gcc, world], 48, 29)?.id).toBe('gcc');
    expect(packAt([gcc, world], 10, 50)?.id).toBe('world');
    expect(packAt([gcc], 10, 50)).toBeNull();
    expect(packCovers(gcc, 4, 10, 6)).toBe(false); // below its minimum zoom
    const [x, y] = lonLatToTileXY(48, 29, 8).map(Math.floor) as [number, number];
    expect(packCovers(gcc, 8, x, y)).toBe(true);
    expect(selectPacks([world, gcc], 'auto')).toHaveLength(2);
    expect(selectPacks([world, gcc], 'gcc').map((p) => p.id)).toEqual(['gcc']);
    expect(selectPacks([world, gcc], 'off')).toEqual([]);
  });
});

describe('Terrarium terrain', () => {
  it('decodes and encodes heights to 1/256 m', () => {
    expect(terrariumHeight(128, 0, 0)).toBe(0);
    for (const h of [-431.25, 0, 12.5, 8848.86]) {
      const [r, g, b] = encodeTerrarium(h);
      expect(Math.abs(terrariumHeight(r, g, b) - h)).toBeLessThanOrEqual(1 / 512);
    }
  });

  it('samples a decoded tile bilinearly and builds a heightmap with the geoid added', () => {
    const rgba: number[] = [];
    for (const h of [0, 10, 20, 30]) rgba.push(...encodeTerrarium(h), 255);
    const g = decodeTerrarium(rgba, 2, 2);
    expect(sampleGrid(g, 0.5, 0.5)).toBeCloseTo(0, 6);
    expect(sampleGrid(g, 1, 1)).toBeCloseTo(15, 6);
    expect(sampleGrid(g, 9, 9)).toBeCloseTo(30, 6); // clamped
    const hm = heightmapFor(
      [0, 0, 1, 1],
      3,
      () => 5,
      () => -20,
    );
    expect([...hm]).toEqual(Array(9).fill(-15));
    expect(heightmapFor([0, 0, 1, 1], 2, () => null, NO_GEOID)[0]).toBe(0);
  });

  it('reads a height from the tile under a point', () => {
    const z = 12;
    const [fx, fy] = lonLatToTileXY(49.5, 29.3, z);
    const grid = { width: 4, height: 4, values: new Float32Array(16).fill(42) };
    const tile = (x: number, y: number) =>
      x === Math.floor(fx) && y === Math.floor(fy) ? grid : null;
    expect(heightFromTiles(49.5, 29.3, z, tile)).toBeCloseTo(42, 6);
    expect(heightFromTiles(10, 10, z, tile)).toBeNull();
  });

  it('asks for few tiles per heightmap tile, within the pack zooms', () => {
    const rect = [45, 22.5, 56.25, 33.75] as const; // a geographic level-4 tile
    const z = terrainZoom(4, rect, { minZoom: 0, maxZoom: 12 });
    expect(tilesForRect(rect, z).length).toBeLessThanOrEqual(16);
    expect(terrainZoom(14, [49, 29, 49.01, 29.01], { minZoom: 0, maxZoom: 12 })).toBe(12);
  });

  it('adds the geoid only to heights above the geoid', () => {
    const geoid = gridGeoid({
      west: -180,
      north: 90,
      stepDeg: 90,
      cols: 4,
      rows: 3,
      values: [0, 0, 0, 0, -10, -20, -30, -40, 0, 0, 0, 0],
    });
    expect(geoid(-90, 0)).toBeCloseTo(-20, 9);
    expect(geoid(-135, 0)).toBeCloseTo(-15, 9);
    expect(geoid(-90, 45)).toBeCloseTo(-10, 9);
    expect(geoidFor('egm2008', geoid)(-90, 0)).toBeCloseTo(-20, 9);
    expect(geoidFor('ellipsoid', geoid)(-90, 0)).toBe(0);
  });
});

describe('ECEF and the project frame (two renderers, one truth)', () => {
  it('matches PROJ geocentric coordinates within 1 mm, and inverts them', () => {
    for (const [lon, lat, h] of [
      [47.98, 29.37, 12],
      [-122.4, 37.8, 2500],
      [0, 0, 0],
      [179.9, -89.5, -400],
      [10, 89.9999, 100],
    ] as const) {
      const ours = geodeticToEcef(lon, lat, h);
      const ref = geocent.forward([lon, lat, h]) as unknown as [number, number, number];
      expect(dist(ours, ref)).toBeLessThan(0.001);
      const back = ecefToGeodetic(...ours);
      expect(back[0]).toBeCloseTo(lon, 9);
      expect(back[1]).toBeCloseTo(lat, 9);
      expect(back[2]).toBeCloseTo(h, 4);
    }
  });

  it('builds an east-north-up root transform that agrees with PROJ within 1 mm', () => {
    const m = enuToEcefMatrix(47.98, 29.37, 12);
    // 100 m east, 50 m north, 3 m up, then to geodetic and through PROJ
    const p = applyMatrix(m, [100, 50, 3]);
    const [lon, lat, h] = ecefToGeodetic(...p);
    const ref = geocent.forward([lon, lat, h]) as unknown as [number, number, number];
    expect(dist(p, ref)).toBeLessThan(0.001);
    expect(dist(applyMatrix(m, [0, 0, 0]), geodeticToEcef(47.98, 29.37, 12))).toBeLessThan(1e-6);
  });

  it('places a surveyed point through the project CRS, never as UTM metres', () => {
    const local: Vec3 = [120.5, 3.2, -80.25]; // 120.5 m east, 80.25 m north, 3.2 m up
    const e = localToEcef(local, SITE);
    const [lon, lat] = projectToLonLat([745_120.5, 3_245_080.25, 15.2], SITE.crs);
    const ref = geocent.forward([lon, lat, 15.2 + SITE.heightOffset]) as unknown as Vec3;
    expect(dist(e, ref)).toBeLessThan(0.001);
    expect(dist(ecefToLocal(e, SITE), local)).toBeLessThan(0.001);
  });

  it('linearises the site frame at its origin (imported tilesets)', () => {
    const m = localToEcefMatrix(SITE);
    expect(dist(applyMatrix(m, [0, 0, 0]), localToEcef([0, 0, 0], SITE))).toBeLessThan(1e-6);
    expect(dist(applyMatrix(m, [100, 5, -100]), localToEcef([100, 5, -100], SITE))).toBeLessThan(
      0.002,
    );
  });
});

describe('camera hand-off', () => {
  it('goes Globe to site to Globe within 1 cm and 0.01 degrees', () => {
    const position = localToEcef([-300, 250, 400], SITE);
    const look = localToEcef([20, 0, -30], SITE);
    const d: Vec3 = [look[0] - position[0], look[1] - position[1], look[2] - position[2]];
    const n = Math.hypot(...d);
    const globe = { position, direction: [d[0] / n, d[1] / n, d[2] / n] as Vec3 };
    const site = globeToSite(globe, SITE);
    expect(site.position[0]).toBeCloseTo(-300, 2);
    expect(site.position[1]).toBeCloseTo(250, 2);
    expect(Math.hypot(site.target[0] - 20, site.target[2] + 30)).toBeLessThan(1); // on the ground
    const back = siteToGlobe(site, SITE);
    expect(dist(back.position, globe.position)).toBeLessThan(0.01);
    const a = headingPitch(globe);
    const b = headingPitch(back);
    expect(Math.abs(a.heading - b.heading)).toBeLessThan(0.01);
    expect(Math.abs(a.pitch - b.pitch)).toBeLessThan(0.01);
    expect(a.pitch).toBeLessThan(0);
  });

  it('puts the target ahead when the camera looks at the horizon', () => {
    const position = localToEcef([0, 50, 0], SITE);
    const ahead = localToEcef([0, 50, -10], SITE); // north, level
    const d: Vec3 = [ahead[0] - position[0], ahead[1] - position[1], ahead[2] - position[2]];
    const n = Math.hypot(...d);
    const site = globeToSite({ position, direction: [d[0] / n, d[1] / n, d[2] / n] }, SITE);
    expect(site.target[2]).toBeCloseTo(-100, 1);
    expect(headingPitch(siteToGlobe(site, SITE)).heading).toBeLessThan(2); // grid north ~ true north
  });
});

describe('sites and issue pins', () => {
  const base = {
    classId: 'c',
    severityModelId: 'sev',
    note: '',
    author: 'a',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    source: 'human' as const,
  };
  const issues: Issue[] = [
    {
      ...base,
      id: 'i1',
      code: 'F01',
      title: 'Crack',
      severity: 3,
      status: 'draft',
      sightings: [{ on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [1, 2, 3], n: [0, 1, 0] } }],
    },
    {
      ...base,
      id: 'i2',
      code: 'F02',
      title: 'Photo only',
      severity: 1,
      status: 'draft',
      sightings: [
        { on: 'image', layer: 'p', photo: 'x', geom: { type: 'point', x: 1, y: 1 } },
        { on: 'pointcloud', layer: 'c', geom: { type: 'box3', min: [0, 0, 0], max: [2, 4, 6] } },
      ],
    },
    {
      ...base,
      id: 'i3',
      code: 'F03',
      title: 'Closed',
      severity: 'uncertain',
      status: 'closed',
      sightings: [{ on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] } }],
    },
  ];
  const models = [
    {
      id: 'sev',
      name: 'S',
      levels: [
        { value: 1, label: 'Low', color: '#00ff00', criteria: '' },
        { value: 3, label: 'High', color: '#ff0000', criteria: '' },
      ],
    },
  ];

  it('pins open issues at their first 3D sighting, coloured by severity', () => {
    const pins = issuePins(issues, { severityModels: models });
    expect(pins.map((p) => [p.code, p.local, p.colour])).toEqual([
      ['F01', [1, 2, 3], '#ff0000'],
      ['F02', [1, 2, 3], '#00ff00'],
    ]);
    expect(sightingAnchor({ on: 'map', layer: 'm', geojson: {} })).toBeNull();
  });

  it('frames every site and names the last capture', () => {
    expect(sitesBounds([])).toBeNull();
    expect(sitesBounds([{ lonLat: [48, 29] }, { lonLat: [51, 25] }], 1)).toEqual([47, 24, 52, 30]);
    expect(
      lastCapture({
        captures: [
          { id: 'a', label: 'A', date: '2026-01-02' },
          { id: 'b', label: 'B', date: '2026-03-04' },
        ],
      }),
    ).toBe('2026-03-04');
  });
});
