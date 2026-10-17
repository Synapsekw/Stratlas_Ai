import { NO_SERVER, type PreviewGrid } from '@aio/rf';
import {
  DEFAULT_RF_THRESHOLDS,
  RF_RUN_SCHEMA,
  type ProjectManifest,
  type RfRun,
} from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { writeGridTiff } from '../../main/rf/export';
import { antennasFile, lteSettings, sectorsFile, unit } from './__fixtures__/rfData';
import {
  classStatsOf,
  coverageShift,
  gridCorners,
  gridsFromPreview,
  gridsFromRun,
  type CoverageGrids,
} from './coverageGrids';
import { coverageImage, hatchAt } from './coverageImage';
import { mapPlacement, scenePlacement } from './coverageDraw';
import { RSRP_RAMP, rgb } from './coverageRamp';

const GRID: PreviewGrid = {
  width: 4,
  height: 2,
  resolutionM: 10,
  originEast: 500_000,
  originNorth: 2_700_020,
};

/** -70 excellent, -90 good, -100 fair, -110 poor, -120 none, then three with no data. */
function grids(): CoverageGrids {
  return {
    key: 'g',
    source: 'preview',
    grid: GRID,
    rsrp: Float32Array.from([-70, -90, -100, -110, -120, Number.NaN, Number.NaN, Number.NaN]),
    bestServer: Uint8Array.from([0, 1, 0, 1, 0, NO_SERVER, NO_SERVER, NO_SERVER]),
    overlap: Uint8Array.from([1, 2, 3, 2, 1, 0, 0, 0]),
    sectorIds: ['sec-a', 'sec-b'],
    thresholds: DEFAULT_RF_THRESHOLDS,
  };
}

function run(): RfRun {
  return {
    schema: RF_RUN_SCHEMA,
    runId: 'rf-1',
    createdAt: '2026-10-17T10:00:00Z',
    status: 'done',
    inputs: {
      sectors: sectorsFile(
        [
          { id: 'sec-a', antennaIds: ['ant-a'] },
          { id: 'sec-b', antennaIds: ['ant-b'] },
        ],
        [lteSettings('ant-a')],
      ),
      antennas: [
        { id: 'ant-a', centre: [500_015, 2_700_010, 131.5], groundZ: 100, azimuthGridDeg: 90 },
      ],
    },
    catalogue: [],
    model: { model: 'tr38901', environment: 'uma' },
    grid: {
      crs: 'EPSG:32640',
      resolutionM: 10,
      radiusM: 100,
      origin: [GRID.originEast, GRID.originNorth],
      width: 4,
      height: 2,
      nodata: -9999,
    },
    timings: { totalMs: 1 },
    warnings: [],
    usedUnreviewed: false,
    patterns: [],
    outputs: { rsrp: 'rsrp.tif', bestServer: 'best-server.tif', overlap: 'overlap.tif' },
  };
}

describe('coverage grids', () => {
  it('reads a run from its GeoTIFFs, nodata as no service and no server', () => {
    const r = run();
    const geo = { ...r.grid };
    const tif = (v: number[]) => new Uint8Array(writeGridTiff(Float32Array.from(v), geo));
    const g = gridsFromRun(r, {
      rsrp: tif([-70, -90, -100, -110, -120, -9999, -9999, -9999]),
      bestServer: tif([0, 1, 0, 1, 0, -9999, -9999, -9999]),
      overlap: tif([1, 2, 3, 2, 1, 0, 0, 0]),
    });
    expect(g.key).toBe('run:rf-1');
    expect(Array.from(g.rsrp.slice(0, 5))).toEqual([-70, -90, -100, -110, -120]);
    expect(Number.isNaN(g.rsrp[5])).toBe(true);
    expect(Array.from(g.bestServer)).toEqual([0, 1, 0, 1, 0, NO_SERVER, NO_SERVER, NO_SERVER]);
    expect(g.sectorIds).toEqual(['sec-a', 'sec-b']);
    // a grid of another size is refused
    expect(() =>
      gridsFromRun(
        { ...r, grid: { ...r.grid, width: 8, height: 1 } },
        {
          rsrp: tif([0]),
          bestServer: tif([0]),
          overlap: tif([0]),
        },
      ),
    ).toThrow();
  });

  it('works the class areas out over the reached pixels', () => {
    const s = classStatsOf(grids());
    expect(s.map((x) => x.cls)).toEqual(['excellent', 'good', 'fair', 'poor', 'none']);
    for (const x of s) {
      expect(x.areaM2).toBe(100);
      expect(x.share).toBeCloseTo(0.2, 10);
    }
  });

  it('numbers a preview best server by the sectors file, so colours match the run', () => {
    const out = {
      sectorIds: ['sec-b'],
      rsrpDbm: Float32Array.from([-80, Number.NaN]),
      bestServer: Uint8Array.from([0, NO_SERVER]),
      overlap: Uint8Array.from([1, 0]),
    };
    const g = gridsFromPreview('p', { ...GRID, width: 2, height: 1 }, out, DEFAULT_RF_THRESHOLDS, [
      'sec-a',
      'sec-b',
    ]);
    expect(Array.from(g.bestServer)).toEqual([1, NO_SERVER]);
    expect(g.sectorIds).toEqual(['sec-a', 'sec-b']);
  });
});

describe('the coverage picture', () => {
  it('draws every class but no service, which is transparent like no data', () => {
    const img = coverageImage(grids(), { view: 'rsrp', showFrom: 'all', hatch: false });
    expect([img.width, img.height, img.scale]).toEqual([4, 2, 1]);
    const alpha = (i: number) => img.data[i * 4 + 3];
    expect([0, 1, 2, 3].map(alpha)).toEqual([255, 255, 255, 255]);
    expect([4, 5, 6, 7].map(alpha)).toEqual([0, 0, 0, 0]);
    expect(Array.from(img.data.slice(0, 3))).toEqual(rgb(RSRP_RAMP.excellent));
  });

  it('leaves out the classes Show from hides', () => {
    const img = coverageImage(grids(), { view: 'rsrp', showFrom: 'good', hatch: false });
    expect([0, 1, 2, 3].map((i) => img.data[i * 4 + 3])).toEqual([255, 255, 0, 0]);
  });

  it('draws the hatch larger, with the pattern ink on the hatched classes only', () => {
    const img = coverageImage(grids(), { view: 'rsrp', showFrom: 'all', hatch: true });
    expect(img.scale).toBe(3);
    expect(img.width).toBe(12);
    // excellent has no hatch: one colour throughout its 3 x 3 block
    const at = (x: number, y: number) =>
      Array.from(img.data.slice((y * 12 + x) * 4, (y * 12 + x) * 4 + 3));
    const ex = new Set([0, 1, 2].flatMap((x) => [0, 1, 2].map((y) => at(x, y).join(','))));
    expect(ex.size).toBe(1);
    // good is hatched: its block holds the fill and the ink
    const good = new Set([3, 4, 5].flatMap((x) => [0, 1, 2].map((y) => at(x, y).join(','))));
    expect(good.size).toBe(2);
    expect(hatchAt('rising', 0, 0)).toBe(true);
    expect(hatchAt('none', 0, 0)).toBe(false);
  });

  it('shows overlap only where two or more sectors are close and the best is fair or better', () => {
    const img = coverageImage(grids(), { view: 'overlap', showFrom: 'all', hatch: false });
    // -70 with 1 server, -90 with 2, -100 with 3, -110 (poor) with 2
    expect([0, 1, 2, 3].map((i) => img.data[i * 4 + 3])).toEqual([0, 255, 255, 0]);
  });
});

describe('the line-up shift', () => {
  const manifest = {
    crs: { epsg: 32640 },
    origin: [500_000, 2_700_000, 100],
    captures: [
      {
        id: 'cap-1',
        label: 'Survey',
        lineUp: { eastM: 12, northM: -7, with: 'cap-0', at: '2026-10-17T09:00:00Z' },
      },
    ],
    layers: [],
  } as unknown as ProjectManifest;

  it('takes the shift of the survey date the inventory belongs to', () => {
    const file = antennasFile([unit('ant-a', 90)]);
    expect(coverageShift(file, manifest)).toBeNull();
    const dated = { ...file, run: { ...file.run, captureId: 'cap-1' } };
    expect(coverageShift(dated, manifest)).toEqual({ eastM: 12, northM: -7 });
  });

  it('moves the grid corners, the map image and the 3D sheet by it', () => {
    const shift = { eastM: 12, northM: -7 };
    expect(gridCorners(GRID, null)[0]).toEqual([500_000, 2_700_020]);
    expect(gridCorners(GRID, shift)).toEqual([
      [500_012, 2_700_013],
      [500_052, 2_700_013],
      [500_052, 2_699_993],
      [500_012, 2_699_993],
    ]);
    const bores = [
      {
        east: 500_015,
        north: 2_700_010,
        z: 131.5,
        azimuthGridDeg: 90,
        downtiltDeg: 0,
        sectorIndex: 0,
      },
    ];
    const plain = mapPlacement(grids(), manifest, null, bores);
    const moved = mapPlacement(grids(), manifest, shift, bores);
    if (!plain || !moved) throw new Error('no projection');
    // 12 m east is a larger longitude, 7 m south a smaller latitude
    expect(moved.corners[0][0]).toBeGreaterThan(plain.corners[0][0]);
    expect(moved.corners[0][1]).toBeLessThan(plain.corners[0][1]);
    expect(moved.arrows[0]?.path[0]?.[0]).toBeGreaterThan(plain.arrows[0]?.path[0]?.[0] ?? 0);

    const origin = [500_000, 2_700_000, 100] as const;
    const s0 = scenePlacement(grids(), origin, null, bores);
    const s1 = scenePlacement(grids(), origin, shift, bores);
    expect(s0.centre).toEqual([20, -10]);
    // x east += 12, z south += 7 (north -7)
    expect(s1.centre).toEqual([32, -3]);
    expect(s1.sizeM).toEqual([40, 20]);
    expect(s1.arrows[0]?.from).toEqual([27, 31.5, -3]);
    // azimuth 90 (east), level: along +x
    expect(s1.arrows[0]?.dir[0]).toBeCloseTo(1, 10);
    expect(s1.arrows[0]?.dir[2]).toBeCloseTo(0, 10);
  });
});
