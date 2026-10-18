import { NO_SERVER } from '@aio/rf';
import { RF_RUN_SCHEMA, type RfRun } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { writeGridTiff } from '../../main/rf/export';
import { lteSettings, sectorsFile } from './__fixtures__/rfData';
import { coverageImage } from './coverageImage';
import {
  connectRunReader,
  serveRunReader,
  type RunClientPort,
  type RunReaderPort,
} from './runClient';
import { MAX_DRAWN_SIDE, classStatsOf, gridsFromRun, readRunGrids } from './runGrids';

/** A run whose grid is `width` x `height` cells at 5 m. */
function bigRun(width: number, height: number): RfRun {
  return {
    schema: RF_RUN_SCHEMA,
    runId: 'rf-big',
    createdAt: '2026-10-18T10:00:00Z',
    status: 'done',
    inputs: {
      sectors: sectorsFile(
        [
          { id: 'sec-a', antennaIds: ['ant-a'] },
          { id: 'sec-b', antennaIds: ['ant-b'] },
        ],
        [lteSettings('ant-a')],
      ),
      antennas: [],
    },
    catalogue: [],
    model: { model: 'tr38901', environment: 'uma' },
    grid: {
      crs: 'EPSG:32640',
      resolutionM: 5,
      radiusM: 100,
      origin: [500_000, 2_700_000],
      width,
      height,
      nodata: -9999,
    },
    timings: { totalMs: 1 },
    warnings: [],
    usedUnreviewed: false,
    patterns: [],
    outputs: { rsrp: 'rsrp.tif', bestServer: 'best-server.tif', overlap: 'overlap.tif' },
  } as unknown as RfRun;
}

/** Bands of every class, some no-data columns, and a best server and overlap that follow x. */
function bytesOf(run: RfRun) {
  const { width: w, height: h } = run.grid;
  const rsrp = new Float32Array(w * h);
  const best = new Float32Array(w * h);
  const over = new Float32Array(w * h);
  const levels = [-70, -90, -100, -110, -120, -9999, -85];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      rsrp[i] = levels[(x * 7 + y * 3) % levels.length] ?? -9999;
      best[i] = rsrp[i] === -9999 ? -9999 : x % 2;
      over[i] = rsrp[i] === -9999 ? 0 : 1 + (y % 3);
    }
  const geo = { ...run.grid };
  const tif = (d: Float32Array) => new Uint8Array(writeGridTiff(d, geo));
  return { rsrp: tif(rsrp), bestServer: tif(best), overlap: tif(over) };
}

describe('a run past the drawing cap', () => {
  it('is drawn at most 2048 cells on the long side, with the class areas of the full grid', () => {
    const run = bigRun(4100, 300);
    const bytes = bytesOf(run);
    const full = gridsFromRun(run, bytes);
    const drawn = readRunGrids(run, bytes);

    // drawn: at most 2048 on the long side, the picture too
    expect(drawn.grid.width).toBeLessThanOrEqual(MAX_DRAWN_SIDE);
    expect(drawn.grid.height).toBeLessThanOrEqual(MAX_DRAWN_SIDE);
    expect(drawn.grid.width).toBe(Math.ceil(4100 / 3));
    expect(drawn.grid.height).toBe(100);
    expect(drawn.rsrp.length).toBe(drawn.grid.width * drawn.grid.height);
    expect(drawn.grid.resolutionM).toBe(15);
    expect([drawn.grid.originEast, drawn.grid.originNorth]).toEqual([500_000, 2_700_000]);
    expect(drawn.reducedFrom).toEqual({ width: 4100, height: 300, step: 3 });
    const img = coverageImage(drawn, { view: 'rsrp', showFrom: 'all', hatch: false });
    expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(MAX_DRAWN_SIDE);

    // the class areas match the full grid's, not the reduced one's
    const want = classStatsOf(full);
    const got = classStatsOf(drawn);
    expect(got).toEqual(want);
    expect(got.reduce((a, s) => a + s.areaM2, 0)).toBeGreaterThan(0);

    // a drawn cell is the full grid's middle cell of its block, in all three grids
    const at = (x: number, y: number) => y * 4100 + x;
    const j = 5 * drawn.grid.width + 7;
    const i = at(7 * 3 + 1, 5 * 3 + 1);
    expect(drawn.rsrp[j]).toEqual(full.rsrp[i]);
    expect(drawn.bestServer[j]).toBe(full.bestServer[i]);
    expect(drawn.overlap[j]).toBe(full.overlap[i]);
  });

  it('leaves a run within the cap whole', () => {
    const run = bigRun(2048, 40);
    const g = readRunGrids(run, bytesOf(run));
    expect([g.grid.width, g.grid.height, g.grid.resolutionM]).toEqual([2048, 40, 5]);
    expect(g.reducedFrom).toBeUndefined();
    expect(g.classStats).toBeUndefined();
    expect(g.bestServer.includes(NO_SERVER)).toBe(true);
  });

  it('reads through the run reader port, fetching the three files', async () => {
    const run = bigRun(2100, 10);
    const b = bytesOf(run);
    const files: Record<string, Uint8Array> = { a: b.rsrp, b: b.bestServer, c: b.overlap };
    // a message channel stand-in: the worker side and the client side in one test
    const worker: RunReaderPort = {
      onmessage: null,
      postMessage: (m) => client.onmessage?.({ data: m }),
    };
    const client: RunClientPort = {
      onmessage: null,
      postMessage: (m) => worker.onmessage?.({ data: m }),
    };
    serveRunReader(worker, (url) => {
      const f = files[url];
      return Promise.resolve({
        ok: f !== undefined,
        arrayBuffer: () => Promise.resolve(f ? f.slice().buffer : new ArrayBuffer(0)),
      });
    });
    const reader = connectRunReader(client);
    const g = await reader.read(run, ['a', 'b', 'c']);
    expect(g.grid.width).toBe(1050);
    expect(g.reducedFrom?.step).toBe(2);
    await expect(reader.read(run, ['a', 'missing', 'c'])).rejects.toThrow('no coverage grids');
    reader.dispose();
    await expect(reader.read(run, ['a', 'b', 'c'])).rejects.toThrow('closed');
  });
});
