import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classAreasCsv,
  contourPolygons,
  coverageGeoJson,
  readGridTiff,
  writeGridTiff,
  type GridGeo,
} from './export';

const geo: GridGeo = {
  crs: 'EPSG:32640',
  resolutionM: 10,
  origin: [500_000, 2_700_000],
  width: 4,
  height: 3,
  nodata: -9999,
};

describe('GeoTIFF', () => {
  it('reads back the same values, CRS, origin, pixel size and nodata', () => {
    const data = new Float32Array([
      -70.5, -80.25, -90, -100, -110.125, -9999, -85, -95, -105, -115, -75, -65.75,
    ]);
    const back = readGridTiff(writeGridTiff(data, geo));
    expect(back.width).toBe(4);
    expect(back.height).toBe(3);
    expect([...back.data]).toEqual([...data]);
    expect(back.epsg).toBe(32640);
    expect(back.origin).toEqual([500_000, 2_700_000]);
    expect(back.pixelSize).toEqual([10, 10]);
    expect(back.nodata).toBe(-9999);
  });

  it('writes a classic little endian TIFF', () => {
    const bytes = writeGridTiff(new Float32Array(12), geo);
    expect(String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0)).toBe('II');
    expect(bytes.readUInt16LE(2)).toBe(42);
  });

  it('splits a large grid into several strips and reads it back', () => {
    const big: GridGeo = { ...geo, width: 700, height: 400 };
    const data = new Float32Array(700 * 400).map((_, i) => -60 - (i % 997) / 10);
    const back = readGridTiff(writeGridTiff(data, big));
    expect(back.data.length).toBe(data.length);
    expect(back.data[123_456]).toBe(data[123_456]);
    expect(back.data[data.length - 1]).toBe(data[data.length - 1]);
  });

  it('refuses a CRS that is not an EPSG code', () => {
    expect(() => writeGridTiff(new Float32Array(12), { ...geo, crs: 'LOCAL_CS' })).toThrow(/EPSG/);
  });

  it('refuses a data length that does not match the grid', () => {
    expect(() => writeGridTiff(new Float32Array(5), geo)).toThrow(/12/);
  });

  it('refuses a file that is not a TIFF', () => {
    expect(() => readGridTiff(Buffer.from('not a tiff at all'))).toThrow(/TIFF/);
  });
});

describe('GeoTIFF from another tool', () => {
  const fixture = (name: string): Buffer => readFileSync(join(__dirname, '__fixtures__', name));

  it('reads a stripped Float32 GeoTIFF written by rasterio', () => {
    const t = readGridTiff(fixture('stripped.tif'));
    expect([t.width, t.height]).toEqual([4, 3]);
    expect([...t.data]).toEqual([
      -70.5, -80.25, -90, -100, -110.125, -9999, -85, -95, -105, -115, -75, -65.75,
    ]);
    expect(t.epsg).toBe(32640);
    expect(t.origin).toEqual([500_000, 2_700_000]);
    expect(t.pixelSize).toEqual([10, 10]);
    expect(t.nodata).toBe(-9999);
  });

  it('refuses a tiled GeoTIFF instead of reading zeros', () => {
    expect(() => readGridTiff(fixture('tiled.tif'))).toThrow(/tiled/);
  });

  it('refuses a geographic CRS and a code a GeoKey cannot hold', () => {
    expect(() => writeGridTiff(new Float32Array(12), { ...geo, crs: 'EPSG:4326' })).toThrow(
      /geographic/,
    );
    expect(() => writeGridTiff(new Float32Array(12), { ...geo, crs: 'EPSG:100000' })).toThrow(
      /65535/,
    );
  });
});

/** A grid of rows (top first) as a Float32Array. */
const grid = (rows: number[][]): Float32Array => Float32Array.from(rows.flat());
const H = -60; // above the threshold
const L = -120; // below
const g = (w: number, h: number, origin: [number, number] = [0, 0]): GridGeo => ({
  crs: 'EPSG:32640',
  resolutionM: 10,
  origin,
  width: w,
  height: h,
  nodata: -9999,
});

type Ring = readonly (readonly [number, number])[];

/** Signed area (positive: counter clockwise, y up). */
function area(ring: Ring): number {
  let a = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const p = ring[i];
    const q = ring[i + 1];
    if (p && q) a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function inside(pt: readonly [number, number], ring: Ring): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    const crosses = a[1] > pt[1] !== b[1] > pt[1];
    if (crosses && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

describe('contourPolygons', () => {
  it('draws one closed counter clockwise ring round a single blob', () => {
    const data = grid([
      [L, L, L, L, L],
      [L, H, H, H, L],
      [L, H, H, H, L],
      [L, H, H, H, L],
      [L, L, L, L, L],
    ]);
    const polys = contourPolygons(data, g(5, 5), -100);
    expect(polys).toHaveLength(1);
    const rings = polys[0] ?? [];
    expect(rings).toHaveLength(1);
    const ring = rings[0] ?? [];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(area(ring)).toBeGreaterThan(0);
    // the 3 x 3 high samples span 20 m between centres; the edge sits part way to the low ones
    expect(area(ring)).toBeGreaterThan(30 * 30 * 0.5);
    expect(area(ring)).toBeLessThan(50 * 50);
  });

  it('puts the contour at the interpolated crossing, in map coordinates', () => {
    // two samples in a row: -90 and -110, threshold -100 crosses half way between centres
    const polys = contourPolygons(Float32Array.from([-90, -110]), g(2, 1, [1000, 2000]), -100);
    const ring = polys[0]?.[0] ?? [];
    // first centre at x = 1005, second at 1015, crossing at 1010
    expect(ring.map((p) => p[0])).toContain(1010);
    const ys = ring.map((p) => p[1]);
    // the row centre is at y = 1995; the footprint reaches half a pixel either side
    expect(Math.max(...ys)).toBe(2000);
    expect(Math.min(...ys)).toBe(1990);
  });

  it('nests a hole inside its shell with clockwise winding', () => {
    const data = grid([
      [L, L, L, L, L, L, L],
      [L, H, H, H, H, H, L],
      [L, H, L, L, L, H, L],
      [L, H, L, L, L, H, L],
      [L, H, L, L, L, H, L],
      [L, H, H, H, H, H, L],
      [L, L, L, L, L, L, L],
    ]);
    const polys = contourPolygons(data, g(7, 7), -100);
    expect(polys).toHaveLength(1);
    const [shell, hole, ...rest] = polys[0] ?? [];
    expect(rest).toHaveLength(0);
    expect(area(shell ?? [])).toBeGreaterThan(0);
    expect(area(hole ?? [])).toBeLessThan(0);
    expect(Math.abs(area(hole ?? []))).toBeLessThan(area(shell ?? []));
    for (const p of hole ?? []) expect(inside(p, shell ?? [])).toBe(true);
    expect(hole?.[0]).toEqual(hole?.[hole.length - 1]);
  });

  it('keeps an island inside a hole as its own polygon, not a hole of the shell', () => {
    const rows: number[][] = Array.from({ length: 11 }, () => Array<number>(11).fill(L));
    const put = (r: number, c: number, v: number): void => {
      const row = rows[r];
      if (row) row[c] = v;
    };
    for (let r = 1; r <= 9; r++) for (let c = 1; c <= 9; c++) put(r, c, H); // shell block
    for (let r = 3; r <= 7; r++) for (let c = 3; c <= 7; c++) put(r, c, L); // hole
    put(5, 5, H); // island in the hole
    const polys = contourPolygons(grid(rows), g(11, 11), -100);
    expect(polys).toHaveLength(2);
    const withHole = polys.find((p) => p.length === 2);
    const island = polys.find((p) => p.length === 1);
    expect(withHole).toBeDefined();
    expect(island).toBeDefined();
    const hole = withHole?.[1] ?? [];
    for (const p of island?.[0] ?? []) expect(inside(p, hole)).toBe(true);
    expect(area(island?.[0] ?? [])).toBeGreaterThan(0);
  });

  it('makes separate polygons for separate blobs', () => {
    const data = grid([
      [H, L, L, H],
      [L, L, L, L],
    ]);
    expect(contourPolygons(data, g(4, 2), -100)).toHaveLength(2);
  });

  it('closes a saddle consistently', () => {
    const data = grid([
      [H, L],
      [L, H],
    ]);
    const polys = contourPolygons(data, g(2, 2), -100);
    for (const poly of polys)
      for (const ring of poly) expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(polys.length).toBeGreaterThanOrEqual(1);
  });

  it('treats nodata and NaN as outside', () => {
    const data = grid([
      [H, -9999, Number.NaN],
      [H, -9999, Number.NaN],
    ]);
    const polys = contourPolygons(data, g(3, 2), -100);
    expect(polys).toHaveLength(1);
    const xs = (polys[0]?.[0] ?? []).map((p) => p[0]);
    expect(Math.max(...xs)).toBe(10); // the edge of the valid pixel, half a pixel from its centre
  });

  it('returns nothing when no sample reaches the threshold', () => {
    expect(contourPolygons(new Float32Array(9).fill(L), g(3, 3), -100)).toEqual([]);
  });
});

const thresholds = { excellentDbm: -80, goodDbm: -95, fairDbm: -105, poorDbm: -115 };

describe('coverageGeoJson', () => {
  it('has one feature per threshold that is reached, with the CRS named', () => {
    const data = grid([
      [L, -110, -100, -90, -70],
      [L, -110, -100, -90, -70],
    ]);
    const fc = coverageGeoJson(data, g(5, 2), thresholds);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.crs.properties.name).toBe('urn:ogc:def:crs:EPSG::32640');
    expect(fc.features.map((f) => f.properties.class)).toEqual([
      'poor',
      'fair',
      'good',
      'excellent',
    ]);
    expect(fc.features[0]?.geometry.type).toBe('MultiPolygon');
    // higher classes are smaller
    const areas = fc.features.map((f) => f.properties.areaM2);
    expect(areas).toEqual([...areas].sort((a, b) => b - a));
    // pixel count times 100 m2: poor is the 8 pixels at or above -115, excellent the 2 at -70
    expect(areas[0]).toBe(800);
    expect(areas[3]).toBe(200);
  });
});

describe('classAreasCsv', () => {
  it('counts the area of each class per best server sector, and in total', () => {
    const csv = classAreasCsv({
      rsrp: Float32Array.from([-70, -90, -100, -110, -130, -9999]),
      bestServer: Float32Array.from([0, 0, 1, 1, 1, -1]),
      grid: g(6, 1),
      thresholds,
      sectors: [
        { id: 'sec-a', name: 'Sector, A' },
        { id: 'sec-b', name: 'B' },
      ],
    });
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(
      'sector_id,sector_name,excellent_m2,good_m2,fair_m2,poor_m2,none_m2,covered_m2',
    );
    expect(lines[1]).toBe('sec-a,"Sector, A",100,100,0,0,0,200');
    expect(lines[2]).toBe('sec-b,B,0,0,100,100,100,200');
    expect(lines[3]).toBe('all,All sectors,100,100,100,100,100,400');
  });

  it('keeps a sector name that a spreadsheet would run as a formula as text', () => {
    const csv = classAreasCsv({
      rsrp: Float32Array.from([-70]),
      bestServer: Float32Array.from([0]),
      grid: g(1, 1),
      thresholds,
      sectors: [{ id: '@id', name: '=HYPERLINK("http://x")' }],
    });
    expect(csv.split('\r\n')[1]).toBe(`'@id,"'=HYPERLINK(""http://x"")",100,0,0,0,0,100`);
  });
});
