import { crsDefinition, localToProject } from '@aio/geo';
import type { GlobeRaster, Vec3 } from '@aio/schema';
import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import { projectToLonLat, type SiteGeoref } from './geodesy';
import {
  defaultShown,
  parsePyramid,
  pyramidPlacement,
  pyramidTilesFor,
  rasterOrder,
  type PyramidIndex,
} from './projectRasters';

/** A 600 m square pyramid around the origin, levels of 1, 2 and 4 columns of 512 px. */
const CORNERS = {
  tl: [-300, 0, -300] as Vec3,
  tr: [300, 0, -300] as Vec3,
  bl: [-300, 0, 300] as Vec3,
};
const level = (z: number, n: number) => ({
  z,
  tileSize: 512,
  cols: n,
  rows: n,
  pattern: 'rasters/ortho/{z}/{x}_{y}.webp',
});
const TILES_JSON = {
  schema: 'aio.tiles/1',
  // deliberately fine to coarse: the parser sorts them
  levels: [level(2, 4), level(0, 1), level(1, 2)],
  corners: CORNERS,
  legend: { kind: 'metres', stops: [] },
};

const pyramid = (): PyramidIndex => {
  const index = parsePyramid(TILES_JSON);
  if (!index) throw new Error('the test pyramid did not parse');
  return index;
};

/** WKT of UTM zone 40N (a Transverse Mercator equal to EPSG 32640). */
const WKT_32640 =
  'PROJCS["WGS 84 / UTM zone 40N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],' +
  'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],' +
  'PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",57],PARAMETER["scale_factor",0.9996],' +
  'PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1]]';

/** Metres per degree of longitude and latitude at a latitude (WGS84). */
function metresPerDegree(latDeg: number): [number, number] {
  const a = 6378137;
  const e2 = 0.00669437999014;
  const phi = (latDeg * Math.PI) / 180;
  const s = 1 - e2 * Math.sin(phi) ** 2;
  const n = a / Math.sqrt(s);
  const m = (a * (1 - e2)) / s ** 1.5;
  return [(n * Math.cos(phi) * Math.PI) / 180, (m * Math.PI) / 180];
}

describe('parsePyramid', () => {
  it('reads an aio.tiles/1 index, levels coarse to fine, the legend passed through', () => {
    const index = pyramid();
    expect(index.levels.map((l) => l.cols)).toEqual([1, 2, 4]);
    expect(index.levels.map((l) => l.z)).toEqual([0, 1, 2]);
    expect(index.corners).toEqual(CORNERS);
    expect(index.legend).toEqual({ kind: 'metres', stops: [] });
    expect(parsePyramid({ ...TILES_JSON, legend: undefined })?.legend).toBeUndefined();
  });

  it('refuses what is not an index', () => {
    expect(parsePyramid({ schema: 'x' })).toBeNull();
    expect(parsePyramid({ ...TILES_JSON, schema: 'x' })).toBeNull();
    expect(parsePyramid({ ...TILES_JSON, corners: undefined })).toBeNull();
    expect(parsePyramid({ ...TILES_JSON, corners: { tl: [0, 0, 0], tr: [1, 0, 0] } })).toBeNull();
    expect(parsePyramid({ ...TILES_JSON, levels: [] })).toBeNull();
    expect(parsePyramid({ ...TILES_JSON, levels: [{ z: 0 }] })).toBeNull();
    expect(parsePyramid(null)).toBeNull();
    expect(parsePyramid('tiles')).toBeNull();
  });
});

describe('pyramidPlacement', () => {
  type Frame = Pick<SiteGeoref, 'crs' | 'origin'>;
  const UTM: Frame = { crs: { epsg: 32640 }, origin: [412_000, 3_245_000, 20] };
  // near the zone edge: grid convergence about 2 degrees
  const EDGE: Frame = { crs: { epsg: 32640 }, origin: [170_000, 3_245_000, 20] };
  const WKT: Frame = { crs: { wkt: WKT_32640 }, origin: [412_000, 3_245_000, 20] };
  const frames: [string, Frame][] = [
    ['EPSG 32640', UTM],
    ['EPSG 32640 near the zone edge', EDGE],
    ['a WKT Transverse Mercator', WKT],
  ];

  /** Every point within 2 cm of exact PROJ, and back to the same (u, v) within 1e-9. */
  function expectPlacedExactly(
    index: PyramidIndex,
    frame: Frame,
    points: readonly (readonly [number, number])[],
  ) {
    const place = pyramidPlacement(index, frame);
    const { tl, tr, bl } = index.corners;
    for (const [u, v] of points) {
      const local: Vec3 = [
        tl[0] + u * (tr[0] - tl[0]) + v * (bl[0] - tl[0]),
        tl[1] + u * (tr[1] - tl[1]) + v * (bl[1] - tl[1]),
        tl[2] + u * (tr[2] - tl[2]) + v * (bl[2] - tl[2]),
      ];
      const [elon, elat] = projectToLonLat(localToProject(local, frame.origin), frame.crs);
      const [lon, lat] = place.toLonLat(u, v);
      const [mx, my] = metresPerDegree(elat);
      const err = Math.hypot((lon - elon) * mx, (lat - elat) * my);
      expect(err, `${u}, ${v}`).toBeLessThan(0.02);
      const [ru, rv] = place.toUv(lon, lat);
      expect(Math.abs(ru - u), `u at ${u}, ${v}`).toBeLessThan(1e-9);
      expect(Math.abs(rv - v), `v at ${u}, ${v}`).toBeLessThan(1e-9);
      // and from the exact point too, in ground metres
      const [eu, ev] = place.toUv(elon, elat);
      const span = Math.hypot(tr[0] - tl[0], tr[2] - tl[2]);
      expect(Math.hypot(eu - u, ev - v) * span, `uv of ${u}, ${v}`).toBeLessThan(0.02);
    }
  }

  const POINTS = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [0.5, 0.5],
    [0.25, 0.75],
  ] as const;

  it.each(frames)(
    '%s: the four corners, centre and a quarter point within 2 cm of PROJ',
    (_, frame) => {
      expectPlacedExactly(pyramid(), frame, POINTS);
    },
  );

  it.each(frames)(
    '%s: a 2 km pyramid within 2 cm of PROJ inside and at the corners',
    (_, frame) => {
      const big: PyramidIndex = {
        ...pyramid(),
        corners: { tl: [-1000, 0, -1000], tr: [1000, 0, -1000], bl: [-1000, 0, 1000] },
      };
      expectPlacedExactly(big, frame, [
        ...POINTS,
        [0.9, 0.1],
        [0.1, 0.9],
        [0.37, 0.61],
        [0.999, 0.001],
      ]);
    },
  );

  it('the WKT places like the EPSG code', () => {
    const index = pyramid();
    const a = pyramidPlacement(index, UTM).toLonLat(0.5, 0.5);
    const b = pyramidPlacement(index, WKT).toLonLat(0.5, 0.5);
    expect(Math.abs(a[0] - b[0])).toBeLessThan(1e-9);
    expect(Math.abs(a[1] - b[1])).toBeLessThan(1e-9);
  });

  it('near the zone edge the grid is turned about 2 degrees from north', () => {
    const place = pyramidPlacement(pyramid(), EDGE);
    const [lon0, lat0] = place.toLonLat(0, 0);
    const [lon1, lat1] = place.toLonLat(0, 1);
    const [mx, my] = metresPerDegree(lat0);
    const turn = (Math.atan2((lon1 - lon0) * mx, (lat0 - lat1) * my) * 180) / Math.PI;
    expect(Math.abs(turn)).toBeGreaterThan(1.5);
    expect(Math.abs(turn)).toBeLessThan(2.5);
  });

  it('the rectangle holds the four corners with a 1 % margin', () => {
    // the grid's extremes are the corners here, within a fraction of a millimetre
    const place = pyramidPlacement(pyramid(), EDGE);
    const corners = [place.toLonLat(0, 0), place.toLonLat(1, 0), place.toLonLat(0, 1)];
    corners.push(place.toLonLat(1, 1));
    const lons = corners.map((c) => c[0]);
    const lats = corners.map((c) => c[1]);
    const w = Math.max(...lons) - Math.min(...lons);
    const h = Math.max(...lats) - Math.min(...lats);
    const [west, south, east, north] = place.rect;
    expect(west).toBeCloseTo(Math.min(...lons) - 0.01 * w, 9);
    expect(east).toBeCloseTo(Math.max(...lons) + 0.01 * w, 9);
    expect(south).toBeCloseTo(Math.min(...lats) - 0.01 * h, 9);
    expect(north).toBeCloseTo(Math.max(...lats) + 0.01 * h, 9);
  });

  it('gives the ground pixel of each level, coarse to fine', () => {
    const place = pyramidPlacement(pyramid(), UTM);
    expect(place.metresPerPx).toEqual([1.171875, 0.5859375, 0.29296875]);
  });

  it('agrees with proj4 called directly', () => {
    const frame = UTM;
    const [lon, lat] = pyramidPlacement(pyramid(), frame).toLonLat(0, 0);
    const [plon, plat] = proj4(crsDefinition(32640), crsDefinition(4326), [411_700, 3_245_300]);
    expect(lon).toBeCloseTo(plon, 9);
    expect(lat).toBeCloseTo(plat, 9);
  });
});

describe('pyramidTilesFor', () => {
  const frame: Pick<SiteGeoref, 'crs' | 'origin'> = {
    crs: { epsg: 32640 },
    origin: [412_000, 3_245_000, 20],
  };
  const index = pyramid();
  const place = pyramidPlacement(index, frame);

  it('picks the coarsest level whose pixels are no larger than the asked one', () => {
    expect(pyramidTilesFor(index, place, place.rect, 2)?.z).toBe(0);
    expect(pyramidTilesFor(index, place, place.rect, 1)?.z).toBe(1);
    expect(pyramidTilesFor(index, place, place.rect, 0.5859375)?.z).toBe(1);
    expect(pyramidTilesFor(index, place, place.rect, 0.3)?.z).toBe(2);
    // zoomed past the finest level: the finest
    expect(pyramidTilesFor(index, place, place.rect, 0.01)?.z).toBe(2);
  });

  it('covers the whole pyramid for its own rectangle, tiles in (u, v)', () => {
    const got = pyramidTilesFor(index, place, place.rect, 0.3);
    expect(got?.tiles).toHaveLength(16);
    const first = got?.tiles[0];
    expect(first).toEqual({
      z: 2,
      x: 0,
      y: 0,
      path: 'rasters/ortho/2/0_0.webp',
      u0: 0,
      v0: 0,
      u1: 0.25,
      v1: 0.25,
    });
    const last = got?.tiles[15];
    expect(last?.path).toBe('rasters/ortho/2/3_3.webp');
    expect([last?.u0, last?.v0, last?.u1, last?.v1]).toEqual([0.75, 0.75, 1, 1]);
  });

  it('steps coarser while there would be more than maxTiles', () => {
    expect(pyramidTilesFor(index, place, place.rect, 0.3, 4)?.z).toBe(1);
    expect(pyramidTilesFor(index, place, place.rect, 0.3, 3)?.z).toBe(0);
    // the coarsest level is drawn even when it is still too many
    expect(pyramidTilesFor(index, place, place.rect, 0.3, 0)?.tiles).toHaveLength(1);
  });

  it('only the tiles a small rectangle touches', () => {
    // a rectangle inside the top left quarter of the pyramid
    const [w, n] = place.toLonLat(0.05, 0.05);
    const [e, s] = place.toLonLat(0.2, 0.2);
    const got = pyramidTilesFor(index, place, [w, s, e, n], 0.3);
    expect(got?.z).toBe(2);
    expect(got?.tiles.map((t) => [t.x, t.y])).toEqual([[0, 0]]);
  });

  it('nothing for a rectangle that misses the pyramid', () => {
    const [west, south, east, north] = place.rect;
    const w = east - west;
    expect(pyramidTilesFor(index, place, [east + w, south, east + 2 * w, north], 1)).toBeNull();
    expect(pyramidTilesFor(index, place, [0, 0, 1, 1], 1)).toBeNull();
  });

  it('fills every placeholder of the pattern', () => {
    const custom = { ...index, levels: [{ ...level(3, 1), pattern: 'p/{z}/{z}-{x}-{y}.png' }] };
    const got = pyramidTilesFor(custom, pyramidPlacement(custom, frame), place.rect, 5);
    expect(got?.tiles[0]?.path).toBe('p/3/3-0-0.png');
  });
});

const raster = (layerId: string, role: 'ortho' | 'dsm' | 'plan', extra = {}) => ({
  layerId,
  name: layerId,
  role,
  src: `rasters/${layerId}/tiles.json`,
  ...extra,
});
const CAPTURES = [
  { id: 'c1', label: 'First', date: '2026-10-07' },
  { id: 'c2', label: 'Second', date: '2026-10-21' },
];

describe('defaultShown', () => {
  it('the ortho of the latest survey date, the first one when several share it', () => {
    const rasters = [
      raster('ortho-c1', 'ortho', { capture: 'c1' }),
      raster('ortho-c2a', 'ortho', { capture: 'c2' }),
      raster('ortho-c2b', 'ortho', { capture: 'c2' }),
    ];
    expect(defaultShown({ captures: CAPTURES, rasters })).toEqual(['ortho-c2a']);
  });

  it('orthos without a capture fall back to the first ortho', () => {
    const rasters = [raster('dsm', 'dsm'), raster('ortho-a', 'ortho'), raster('ortho-b', 'ortho')];
    expect(defaultShown({ captures: CAPTURES, rasters })).toEqual(['ortho-a']);
    expect(defaultShown({ captures: [], rasters })).toEqual(['ortho-a']);
  });

  it('nothing without an ortho; heat maps and DSMs are never on by default', () => {
    expect(defaultShown({ captures: CAPTURES, rasters: [] })).toEqual([]);
    expect(defaultShown({ captures: CAPTURES })).toEqual([]);
    const rasters = [
      raster('dsm-c2', 'dsm', { capture: 'c2' }),
      raster('change-ortho', 'ortho', { capture: 'c2', change: true }),
      raster('change-dsm', 'dsm', { capture: 'c2', change: true }),
    ];
    expect(defaultShown({ captures: CAPTURES, rasters })).toEqual([]);
    expect(
      defaultShown({
        captures: CAPTURES,
        rasters: [...rasters, raster('o1', 'ortho', { capture: 'c1' })],
      }),
    ).toEqual(['o1']);
  });
});

describe('rasterOrder', () => {
  it('orthos by capture date, then DSMs, then plans, then heat maps, bottom first', () => {
    const rasters = [
      raster('heat', 'ortho', { capture: 'c2', change: true as const }),
      raster('dsm-c2', 'dsm', { capture: 'c2' }),
      raster('ortho-c2', 'ortho', { capture: 'c2' }),
      raster('heat-dsm', 'dsm', { change: true as const }),
      raster('ortho-c1', 'ortho', { capture: 'c1' }),
      raster('dsm-c1', 'dsm', { capture: 'c1' }),
      raster('plan', 'plan'),
      raster('heat-plan', 'plan', { change: true as const }),
    ];
    expect(rasterOrder(rasters, CAPTURES).map((r) => r.layerId)).toEqual([
      'ortho-c1',
      'ortho-c2',
      'dsm-c2',
      'dsm-c1',
      'plan',
      'heat',
      'heat-dsm',
      'heat-plan',
    ]);
    expect(rasters[0]?.layerId).toBe('heat');
  });

  it('takes the rasters of a site as the schema has them', () => {
    const rasters: GlobeRaster[] = [
      { layerId: 'heat', name: 'Heat', role: 'dsm', src: 'h/tiles.json', change: true },
      { layerId: 'o', name: 'Ortho', role: 'ortho', src: 'o/tiles.json', capture: 'c1' },
    ];
    expect(rasterOrder(rasters, CAPTURES).map((r) => r.layerId)).toEqual(['o', 'heat']);
    expect(defaultShown({ captures: CAPTURES, rasters })).toEqual(['o']);
  });
});
