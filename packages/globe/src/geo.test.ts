import { crsDefinition } from '@aio/geo';
import type { Issue, Vec3 } from '@aio/schema';
import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import {
  globeToSite,
  headingPitch,
  padBounds,
  PARTING_SPAN_DEG,
  siteToGlobe,
  type Bounds,
} from './camera';
import type { Insets, ViewSize } from './chips';
import {
  applyMatrix,
  ecefToGeodetic,
  ecefToLocal,
  enuBasis,
  enuToEcefMatrix,
  geodeticToEcef,
  geoidShift,
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

/**
 * Where a place is drawn once CesiumJS has flown to a box (`Camera.flyTo` with a rectangle, its
 * `rectangleCameraPosition3D`): the camera stands straight above the middle of the box, north up,
 * just far enough for the corners, the middles of the north and south edges and, across the
 * equator, the ends of the equator to be in view. Pixels from the view's top left corner.
 */
function shownAfterFlightTo(box: Bounds, view: ViewSize, fovDeg = 60) {
  const [w, s, e, n] = box;
  const mid: [number, number] = [(w + e) / 2, (s + n) / 2];
  const centre = geodeticToEcef(mid[0], mid[1], 0);
  const { e: right, n: up, u } = enuBasis(mid[0], mid[1]);
  const along = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const from = (lon: number, lat: number): Vec3 => {
    const p = geodeticToEcef(lon, lat, 0);
    return [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
  };
  // the field of view is that of the longer side
  const t = Math.tan((fovDeg / 2) * (Math.PI / 180));
  const aspect = view.width / view.height;
  const tanX = aspect >= 1 ? t : t * aspect;
  const tanY = aspect >= 1 ? t / aspect : t;
  const marks: [number, number][] = [
    [w, n],
    [e, n],
    [w, s],
    [e, s],
    [mid[0], n],
    [mid[0], s],
  ];
  if (s < 0 && n > 0) marks.push([w, 0], [e, 0]);
  let d = -Infinity;
  for (const [lon, lat] of marks) {
    const v = from(lon, lat);
    const below = -along(v, u);
    d = Math.max(
      d,
      Math.abs(along(v, up)) / tanY - below,
      Math.abs(along(v, right)) / tanX - below,
    );
  }
  return (lon: number, lat: number): [number, number] => {
    const v = from(lon, lat);
    const depth = d - along(v, u);
    return [
      (view.width / 2) * (1 + along(v, right) / (depth * tanX)),
      (view.height / 2) * (1 - along(v, up) / (depth * tanY)),
    ];
  };
}

/** The room the edge of a box has to each edge of the view after the flight to `flown`, pixels. */
function roomAround(box: Bounds, flown: Bounds, view: ViewSize): Insets {
  const at = shownAfterFlightTo(flown, view);
  const [w, s, e, n] = box;
  const places: [number, number][] = [];
  // along the whole edge of the box, not only at the points the fit looks at
  for (let i = 0; i <= 16; i++) {
    const f = i / 16;
    places.push(at(w + (e - w) * f, n), at(w + (e - w) * f, s));
    places.push(at(w, s + (n - s) * f), at(e, s + (n - s) * f));
  }
  const xs = places.map((p) => p[0]);
  const ys = places.map((p) => p[1]);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: view.width - Math.max(...xs),
    bottom: view.height - Math.max(...ys),
  };
}

describe('framing sites for their chips (padBounds)', () => {
  // the Globe's own controls, then a chip: wide to the right of its site, little to the left
  const PAD: Insets = { top: 71, right: 268, bottom: 59, left: 55 };
  const WIDE: ViewSize = { width: 1668, height: 941 };
  const NARROW: ViewSize = { width: 848, height: 661 };
  const GULF: Bounds = [47, 23, 56, 31];

  /** Every edge has its room, and the view is no wider than that takes. */
  function expectFramed(box: Bounds, view: ViewSize, pad: Insets = PAD) {
    const flown = padBounds(box, view, pad);
    const room = roomAround(box, flown, view);
    for (const edge of ['top', 'right', 'bottom', 'left'] as const)
      expect(room[edge], `room at the ${edge}`).toBeGreaterThan(pad[edge] - 0.5);
    // across or down, the box fills what the pads leave: nothing is framed smaller than it must
    const spare = Math.min(
      Math.max(room.left - pad.left, room.right - pad.right),
      Math.max(room.top - pad.top, room.bottom - pad.bottom),
    );
    expect(spare, 'room to spare in the tighter direction').toBeLessThan(1);
    return flown;
  }

  it('shows why: the box alone puts its edge at the edge of the view', () => {
    const room = roomAround(GULF, GULF, NARROW);
    expect(Math.min(room.left, room.right, room.top, room.bottom)).toBeLessThan(1);
  });

  it('leaves the room asked at each edge of a wide view and of a narrow one', () => {
    for (const view of [WIDE, NARROW]) {
      const [w, s, e, n] = expectFramed(GULF, view);
      expect(w).toBeLessThanOrEqual(GULF[0]);
      expect(s).toBeLessThanOrEqual(GULF[1]);
      expect(e).toBeGreaterThanOrEqual(GULF[2]);
      expect(n).toBeGreaterThanOrEqual(GULF[3]);
    }
    // the chip runs east of its site: far more is added in the east than in the west
    const [w, , e] = padBounds(GULF, NARROW, PAD);
    expect(e - GULF[2]).toBeGreaterThan(3 * (GULF[0] - w));
  });

  it('holds for a box that is tall, far north, across the equator or half a continent wide', () => {
    expectFramed([10, 40, 12, 58], NARROW);
    expectFramed([10, 60, 30, 68], WIDE);
    expectFramed([-10, -8, 12, 9], NARROW);
    expectFramed([100, -42, 150, -12], WIDE);
    expectFramed([0, 10, 40, 40], NARROW);
    // a view taller than it is wide
    expectFramed(GULF, { width: 700, height: 1000 });
  });

  it('goes as far as the whole Earth for a box too wide for its pads', () => {
    // a sixth of the way round the Earth, in a view that keeps little more than half its width
    const box: Bounds = [0, 10, 60, 50];
    const flown = padBounds(box, NARROW, PAD);
    const room = roomAround(box, flown, NARROW);
    const least = (r: Insets) => Math.min(r.left, r.right, r.top, r.bottom);
    // short of the pads, yet every edge is well inside the view, most room in the east
    expect(least(room)).toBeGreaterThan(20);
    expect(room.right).toBeGreaterThan(200);
    expect(room.right).toBeLessThan(PAD.right);
    // from there the Earth is as wide as the view: about two radii from its centre, not more
    expect(flown[2] - flown[0]).toBeGreaterThan(100);
    expect(flown[2] - flown[0]).toBeLessThan(180);
  });

  it('gives a single site a span, about a kilometre, and frames that', () => {
    const flown = padBounds([51, 29, 51, 29], NARROW, PAD);
    expect(flown[2]).toBeGreaterThan(flown[0]);
    expect(flown[3]).toBeGreaterThan(flown[1]);
    const at = shownAfterFlightTo(flown, NARROW);
    const [x, y] = at(51, 29);
    expect(x).toBeGreaterThan(PAD.left);
    expect(x).toBeLessThan(NARROW.width - PAD.right);
    expect(y).toBeGreaterThan(PAD.top);
    expect(y).toBeLessThan(NARROW.height - PAD.bottom);
    // a pixel of the view is a metre or two of ground: near, and not on the ground
    const [x2] = at(51.01, 29);
    const metresPerPixel = (0.01 * 111_320 * Math.cos((29 * Math.PI) / 180)) / (x2 - x);
    expect(metresPerPixel).toBeGreaterThan(0.5);
    expect(metresPerPixel).toBeLessThan(4);
    // sites a few hundred metres apart are framed as wide as that least span, and no wider
    const near = padBounds([51, 29, 51.004, 29.001], NARROW, PAD);
    expect(near[2] - near[0]).toBeCloseTo(flown[2] - flown[0], 3);
  });

  it('leaves a box alone when no room is asked for', () => {
    const none = { top: 0, right: 0, bottom: 0, left: 0 };
    padBounds(GULF, NARROW, none).forEach((v, i) => {
      expect(v).toBeCloseTo(GULF[i] ?? 0, 9);
    });
  });

  it('leaves alone a box so wide that the whole Earth shows anyway', () => {
    expect(padBounds([-170, -60, 170, 75], NARROW, PAD)).toEqual([-170, -60, 170, 75]);
    expect(padBounds([-180, -90, 180, 90], WIDE, PAD)).toEqual([-180, -90, 180, 90]);
  });

  it('never turns a box inside out, whatever is asked', () => {
    const boxes: Bounds[] = [GULF, [-120, -80, 40, 85], [51, 29, 51, 29], [-179, 60, -100, 89]];
    const pads: Insets[] = [
      PAD,
      { top: 400, right: 500, bottom: 400, left: 500 },
      { top: 0, right: 847, bottom: 0, left: 0 },
    ];
    for (const box of boxes)
      for (const pad of pads) {
        const [w, s, e, n] = padBounds(box, NARROW, pad);
        expect(w).toBeLessThanOrEqual(box[0]);
        expect(e).toBeGreaterThanOrEqual(box[2]);
        expect(s).toBeLessThanOrEqual(box[1]);
        expect(n).toBeGreaterThanOrEqual(box[3]);
        expect(s).toBeGreaterThanOrEqual(-90);
        expect(n).toBeLessThanOrEqual(90);
        expect(e - w).toBeLessThanOrEqual(360);
        expect([w, s, e, n].every(Number.isFinite)).toBe(true);
      }
  });

  it('pads a box at the antimeridian past it, for the view to wrap', () => {
    // `sitesBounds` stops a box at 180 degrees; the chip of a site there still needs its room
    const box: Bounds = [168, -22, 180, -12];
    const flown = expectFramed(box, NARROW);
    expect(flown[2]).toBeGreaterThan(180);
    expect(flown[2]).toBeLessThan(200);
  });

  describe('for a click on a gathered chip (a far smaller least span)', () => {
    // two sites 150 m apart, east to west
    const NEAR: Bounds = [51, 29, 51 + 150 / (111_320 * Math.cos((29 * Math.PI) / 180)), 29];
    const apart = (flown: Bounds) => {
      const at = shownAfterFlightTo(flown, NARROW);
      return at(NEAR[2], 29)[0] - at(NEAR[0], 29)[0];
    };

    it('frames near sites by their own span, so they part', () => {
      // by the opening view's least span they land less than a chip apart, and gather again
      expect(apart(padBounds(NEAR, NARROW, PAD))).toBeLessThan(120);
      // by the gathered chip's they are as far apart as the pads allow
      const flown = padBounds(NEAR, NARROW, PAD, { minSpanDeg: PARTING_SPAN_DEG });
      expect(apart(flown)).toBeGreaterThan(NARROW.width - PAD.left - PAD.right - 1);
      const room = roomAround(NEAR, flown, NARROW);
      for (const edge of ['top', 'right', 'bottom', 'left'] as const)
        expect(room[edge], `room at the ${edge}`).toBeGreaterThan(PAD[edge] - 0.5);
    });

    it('still gives sites at one place a span, some tens of metres', () => {
      const flown = padBounds([51, 29, 51, 29], NARROW, PAD, { minSpanDeg: PARTING_SPAN_DEG });
      const at = shownAfterFlightTo(flown, NARROW);
      const [x, y] = at(51, 29);
      expect(x).toBeGreaterThan(PAD.left);
      expect(x).toBeLessThan(NARROW.width - PAD.right);
      expect(y).toBeGreaterThan(PAD.top);
      expect(y).toBeLessThan(NARROW.height - PAD.bottom);
      // a pixel of the view is a hand's width of ground: very near, and not on the ground
      const [x2] = at(51.001, 29);
      const metresPerPixel = (0.001 * 111_320 * Math.cos((29 * Math.PI) / 180)) / (x2 - x);
      expect(metresPerPixel).toBeGreaterThan(0.05);
      expect(metresPerPixel).toBeLessThan(0.3);
    });

    it('never answers with a box that is no box, however small the least span asked', () => {
      for (const minSpanDeg of [0, -1, Number.NaN]) {
        const [w, s, e, n] = padBounds([51, 29, 51, 29], NARROW, PAD, { minSpanDeg });
        expect([w, s, e, n].every(Number.isFinite), `least span ${String(minSpanDeg)}`).toBe(true);
        expect(e).toBeGreaterThan(w);
        expect(n).toBeGreaterThan(s);
      }
    });
  });

  describe('for the opening view (a box around the sites that shows anyway)', () => {
    const margin = ([w, s, e, n]: Bounds, deg = 2): Bounds => [w - deg, s - deg, e + deg, n + deg];
    const EDGES = ['top', 'right', 'bottom', 'left'] as const;
    /** The index of each edge's coordinate in a box. */
    const AT = { top: 3, right: 2, bottom: 1, left: 0 } as const;

    it('flies to that box as it is when it already leaves the room', () => {
      // a town's worth of sites: two degrees of margin are far more than a chip needs
      const town: Bounds = [51, 29, 51.3, 29.2];
      const around = margin(town);
      expect(padBounds(town, NARROW, PAD, { around })).toEqual(around);
      const room = roomAround(town, around, NARROW);
      for (const edge of EDGES) expect(room[edge]).toBeGreaterThan(PAD[edge]);
      // one site alone as well: the region around it, not a kilometre of it
      expect(padBounds([51, 29, 51, 29], WIDE, PAD, { around: margin([51, 29, 51, 29]) })).toEqual(
        margin([51, 29, 51, 29]),
      );
    });

    it('grows that box only at the edges where a chip would lack its room', () => {
      const cases: [Bounds, ViewSize][] = [
        [GULF, NARROW],
        [[40, 20, 60, 28], WIDE],
      ];
      for (const [sites, view] of cases) {
        const around = margin(sites);
        const flown = padBounds(sites, view, PAD, { around });
        const room = roomAround(sites, flown, view);
        // the margin alone leaves the chips in the east short
        expect(roomAround(sites, around, view).right).toBeLessThan(PAD.right);
        let grown = 0;
        for (const edge of EDGES) {
          expect(room[edge], `room at the ${edge}`).toBeGreaterThan(PAD[edge] - 0.5);
          const out = AT[edge] >= 2 ? 1 : -1;
          const more = out * (flown[AT[edge]] - around[AT[edge]]);
          // an edge is where the margin put it, or just as far out as its chip needs
          expect(more, `the ${edge} edge against the margin's`).toBeGreaterThanOrEqual(0);
          if (more > 0) {
            grown++;
            expect(room[edge], `room at the grown ${edge} edge`).toBeLessThan(PAD[edge] + 1);
          }
        }
        expect(grown).toBeGreaterThan(0);
        // and it is nearer than the margin's box padded all round, which is what flew before
        const before = padBounds(around, view, PAD);
        expect(flown[2] - flown[0]).toBeLessThan(before[2] - before[0]);
        expect(flown[3] - flown[1]).toBeLessThan(before[3] - before[1]);
      }
    });

    it('still grows an edge when the view is bound by its height, so the camera stays put', () => {
      // growing east alone leaves the camera where it was, to a rounding error either way
      const sites: Bounds = [51.5, 22.6, 56.4, 26.1];
      const view: ViewSize = { width: 848, height: 680 };
      const around = margin(sites);
      expect(roomAround(sites, around, view).right).toBeLessThan(PAD.right);
      const flown = padBounds(sites, view, PAD, { around });
      expect(roomAround(sites, flown, view).right).toBeGreaterThan(PAD.right - 0.5);
    });

    it('falls back to that box when a library is too wide for the room to be had', () => {
      for (const width of [80, 100]) {
        const library: Bounds = [0, 10, width, 50];
        const around = margin(library);
        expect(padBounds(library, NARROW, PAD, { around }), `${String(width)} degrees`).toEqual(
          around,
        );
        // every site is in view there, which the box grown as far as it goes does not promise
        const room = roomAround(library, around, NARROW);
        for (const edge of EDGES)
          expect(room[edge], `${String(width)} degrees, room at the ${edge}`).toBeGreaterThan(0);
      }
      // (without a box to fall back to, the west edge of the wider one is out of view)
      const lone: Bounds = [0, 10, 100, 50];
      expect(roomAround(lone, padBounds(lone, NARROW, PAD), NARROW).left).toBeLessThan(0);
    });

    it('answers with that box when the whole Earth shows anyway or no view is left', () => {
      const world: Bounds = [-170, -60, 170, 75];
      const around: Bounds = [-172, -62, 172, 77];
      expect(padBounds(world, NARROW, PAD, { around })).toEqual(around);
      const none = { top: 400, right: 500, bottom: 400, left: 500 };
      expect(padBounds(GULF, NARROW, none, { around: margin(GULF) })).toEqual(margin(GULF));
    });
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

describe('tilesets with project heights as ellipsoidal (G7 extras)', () => {
  const extras = { aio: { heights: 'project-heights-as-ellipsoidal', originLonLat: [53.5, 29.3] } };
  it('lifts them by the geoid separation at the site, along the vertical', () => {
    const shift = geoidShift(extras, () => -21.5);
    expect(Math.hypot(...(shift ?? [0, 0, 0]))).toBeCloseTo(21.5, 9);
    const up = geodeticToEcef(53.5, 29.3, 1);
    const at = geodeticToEcef(53.5, 29.3, 0);
    const dz = up[2] - at[2];
    expect((shift?.[2] ?? 0) / dz).toBeCloseTo(-21.5, 6);
    expect(geoidShift(extras, () => 0)).toBeNull();
    expect(geoidShift({ aio: { heights: 'ellipsoidal' } }, () => 5)).toBeNull();
    expect(geoidShift(undefined, () => 5)).toBeNull();
  });
});
