import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { drawEarthTile, geographicTileBox, type EarthTileOptions, type Pen } from './draw';
import {
  decodeEarth,
  earthPointCount,
  parseEarth,
  type EarthShapes,
  type EarthTopology,
} from './shapes';

/** The file the Globe bundles (`view/earthLayers.ts` imports the same one as text). */
const bundled = createRequire(import.meta.url).resolve('world-atlas/countries-50m.json');
const earth = parseEarth(readFileSync(bundled, 'utf8'));
const INK = { water: '#01141f', land: '#101317', border: '#4d5660' };

/** A pen that writes down what it is asked to draw. */
function recorder() {
  const calls: string[] = [];
  const points: [number, number][] = [];
  const fills: string[] = [];
  const dashes: number[][] = [];
  const colour = (style: string | object) => (typeof style === 'string' ? style : 'not a colour');
  const pen: Pen = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    lineCap: 'butt',
    fillRect: () => {
      calls.push('fillRect');
      fills.push(colour(pen.fillStyle));
    },
    beginPath: () => calls.push('beginPath'),
    moveTo: (x, y) => {
      calls.push('moveTo');
      points.push([x, y]);
    },
    lineTo: (x, y) => {
      points.push([x, y]);
    },
    closePath: () => undefined,
    fill: () => {
      calls.push('fill');
      fills.push(colour(pen.fillStyle));
    },
    stroke: () => calls.push('stroke'),
    setLineDash: (d) => {
      dashes.push(d);
    },
  };
  return { pen, calls, points, fills, dashes };
}

const tile = (level: number, x: number, y: number, size = 512): EarthTileOptions => ({
  box: geographicTileBox(level, x, y),
  level,
  size,
  scale: size / 512,
  ink: INK,
});

/** The geographic tile of a point at a level. */
function tileAt(lon: number, lat: number, level: number): [number, number, number] {
  const span = 180 / 2 ** level;
  return [level, Math.floor((lon + 180) / span), Math.floor((90 - lat) / span)];
}

describe('the bundled Earth shapes', () => {
  it('hold the land and the borders between countries of Natural Earth 1:50m', () => {
    expect(earth.land.length).toBeGreaterThan(1000);
    // borders come stitched into long lines, far fewer than there are pairs of neighbours
    expect(earth.borders.length).toBeGreaterThan(100);
    const points = earthPointCount(earth);
    expect(points).toBeGreaterThan(50_000);
    expect(points).toBeLessThan(250_000);
    for (const p of earth.land) {
      expect(p.box[0]).toBeGreaterThanOrEqual(-180);
      expect(p.box[2]).toBeLessThanOrEqual(180);
      expect(p.box[1]).toBeGreaterThanOrEqual(-90);
      expect(p.box[3]).toBeLessThanOrEqual(90);
    }
  });

  it('say which objects a topology has when it lacks the land', () => {
    const empty: EarthTopology = { type: 'Topology', arcs: [], objects: {} };
    expect(() => decodeEarth(empty)).toThrow(/no "land" object/);
  });

  it('decode a small topology: one square of land, no border with itself', () => {
    const square: EarthTopology = {
      type: 'Topology',
      arcs: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ],
      objects: {
        land: { type: 'GeometryCollection', geometries: [{ type: 'Polygon', arcs: [[0]] }] },
        countries: {
          type: 'GeometryCollection',
          geometries: [{ type: 'Polygon', arcs: [[0]], id: '1' }],
        },
      },
    };
    const shapes = decodeEarth(square);
    expect(shapes.land).toHaveLength(1);
    expect(shapes.land[0]?.box).toEqual([0, 0, 10, 10]);
    expect(shapes.borders).toHaveLength(0);
  });
});

describe('geographicTileBox', () => {
  it('follows the geographic tiling scheme: two squares at level 0, y from the north', () => {
    expect(geographicTileBox(0, 0, 0)).toEqual([-180, -90, 0, 90]);
    expect(geographicTileBox(0, 1, 0)).toEqual([0, -90, 180, 90]);
    expect(geographicTileBox(1, 3, 1)).toEqual([90, -90, 180, 0]);
    expect(geographicTileBox(2, 0, 0)).toEqual([-180, 45, -135, 90]);
  });
});

describe('drawEarthTile', () => {
  it('paints water, then land, then borders, in the colours given', () => {
    const r = recorder();
    const stats = drawEarthTile(r.pen, earth, tile(0, 1, 0));
    expect(r.calls.slice(0, 2)).toEqual(['fillRect', 'beginPath']);
    expect(r.calls.filter((c) => c === 'fill')).toHaveLength(1);
    expect(r.calls.at(-1)).toBe('stroke');
    expect(r.fills).toEqual([INK.water, INK.land]);
    expect(r.pen.strokeStyle).toBe(INK.border);
    expect(stats.polygons).toBeGreaterThan(300);
    expect(stats.borders).toBeGreaterThan(100);
  });

  it('paints open ocean as water alone', () => {
    // the middle of the South Pacific: inside the box around the Americas, far from their coast
    const r = recorder();
    const stats = drawEarthTile(r.pen, earth, tile(...tileAt(-125, -45, 6)));
    expect(stats.borders).toBe(0);
    // a ring that never comes near costs its first point and no more
    expect(stats.points).toBeLessThanOrEqual(stats.polygons);
    expect(stats.polygons).toBeLessThan(4);
    expect(r.fills[0]).toBe(INK.water);
  });

  it('gives a tile deep inside a continent a handful of points, not the continent', () => {
    // the Sahara, far from any coast or border at this level
    const [level, x, y] = tileAt(8.2, 24.2, 9);
    const r = recorder();
    const stats = drawEarthTile(r.pen, earth, tile(level, x, y));
    expect(stats.polygons).toBeGreaterThan(0);
    expect(stats.points).toBeLessThan(60);
    // and what is left still covers the tile: its corners are inside the traced ring
    const xs = r.points.map((p) => p[0]);
    const ys = r.points.map((p) => p[1]);
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(Math.max(...xs)).toBeGreaterThan(512);
    expect(Math.min(...ys)).toBeLessThan(0);
    expect(Math.max(...ys)).toBeGreaterThan(512);
  });

  it('drops points closer than a pixel apart at the whole-Earth levels', () => {
    const r = recorder();
    const stats = drawEarthTile(r.pen, earth, tile(0, 1, 0, 256));
    expect(stats.points).toBeLessThan(earthPointCount(earth) / 3);
  });

  it('draws borders solid far out and dashed from level 4, as the street style does', () => {
    const far = recorder();
    drawEarthTile(far.pen, earth, tile(2, 4, 1));
    expect(far.dashes[0]).toEqual([]);
    const near = recorder();
    drawEarthTile(near.pen, earth, { ...tile(...tileAt(15, 48, 5), 1024), scale: 2 });
    expect(near.dashes[0]).toEqual([2.8, 1.4]);
    expect(near.pen.lineWidth).toBeCloseTo(1.4);
    // the dash is taken back off the pen for whoever draws next
    expect(near.dashes.at(-1)).toEqual([]);
  });

  it('carries land across the antimeridian into the tile on the other side', () => {
    // a strip of land that ends exactly at 180 E reaches a tile that starts at 180 W by its pad
    const strip: EarthShapes = {
      land: [
        {
          rings: [
            {
              pts: new Float32Array([179, 0, 180, 0, 180, 10, 179, 10, 179, 0]),
              box: [179, 0, 180, 10],
            },
          ],
          box: [179, 0, 180, 10],
        },
      ],
      borders: [],
    };
    const r = recorder();
    // level 1, x 0: the tile from 180 W to 90 W, north of the equator
    const stats = drawEarthTile(r.pen, strip, tile(1, 0, 0));
    expect(stats.polygons).toBe(1);
    // drawn shifted by 360 degrees: its east edge lies on the tile's west edge (x = 0)
    expect(Math.max(...r.points.map((p) => p[0]))).toBeCloseTo(0, 5);
  });
});
