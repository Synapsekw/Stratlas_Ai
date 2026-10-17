/**
 * Python to TypeScript hand-off: a run folder written by the real `rf.coverage` job
 * (`__fixtures__/py-run/`, a synthetic two-sector site, 21 x 21 pixels) read the way the app reads
 * runs. Regenerate with `cd python && uv run python scripts/rf_desktop_fixture.py`; the values
 * below are the ones it prints.
 */
import { parseRfRun } from '@aio/schema';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRf, type RfDeps } from '../rf';
import { readGridTiff } from './export';

const FIXTURE = join(__dirname, '__fixtures__', 'py-run');
const RUN_ID = 'rf-py-fixture';
const NODATA = -9999;

/** (row, col) to the generator's printed values: RSRP dBm, best server, overlap. */
const PIXELS: [number, number, number, number, number][] = [
  [10, 10, -81.6073, 0, 2],
  [4, 10, -92.5792, 0, 1],
  [16, 10, -93.7135, 1, 1],
  [10, 3, -114.1247, 0, 2],
  [0, 0, NODATA, NODATA, 0],
];

let base: string;
let root: string;
let deps: RfDeps;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-rf-py-'));
  root = join(base, 'proj');
  await mkdir(join(root, 'rf', 'runs'), { recursive: true });
  await cp(FIXTURE, join(root, 'rf', 'runs', RUN_ID), { recursive: true });
  await mkdir(join(base, 'out'), { recursive: true });
  deps = {
    userDir: join(base, 'userData', 'rf-catalogue'),
    builtinDir: join(base, 'builtin'),
    projects: { root: (id) => (id === 'p' ? root : undefined), package: () => undefined },
    choose: (name) => Promise.resolve(join(base, 'out', name)),
  };
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const grid = async (file: string) => readGridTiff(await readFile(join(FIXTURE, file)));

describe('a run folder written by the Python job', () => {
  it('parses as aio.rf-run/1 with the expected shape', async () => {
    const r = parseRfRun(JSON.parse(await readFile(join(FIXTURE, 'run.json'), 'utf8')));
    if (!r.ok) throw new Error(r.error);
    const run = r.value;
    expect(run.runId).toBe(RUN_ID);
    expect(run.status).toBe('done');
    expect(run.model).toEqual({ model: 'tr38901', environment: 'uma' });
    expect(run.grid).toMatchObject({
      crs: 'EPSG:32640',
      resolutionM: 25,
      radiusM: 250,
      origin: [499750, 2700275],
      width: 21,
      height: 21,
      nodata: NODATA,
    });
    expect(run.inputs.sectors.sectors.map((s) => s.id)).toEqual(['sec-s1', 'sec-s2']);
    expect(run.inputs.antennas.map((a) => a.id)).toEqual(['ant-s1', 'ant-s2']);
    expect(run.outputs).toEqual({
      rsrp: 'rsrp.tif',
      bestServer: 'best-server.tif',
      overlap: 'overlap.tif',
      pathLossDir: 'pathloss',
    });
    expect(run.outputs.pathLossDir).toMatch(/^(pathloss|path-loss)/);
  });

  it('reads through the app run reader and the export path', async () => {
    const rf = createRf(deps);
    const listed = await rf.listRuns({ projectId: 'p' });
    expect(listed.ok && listed.runs.map((x) => x.runId)).toEqual([RUN_ID]);
    const one = await rf.readRun({ projectId: 'p', runId: RUN_ID });
    expect(one.ok && one.run.grid.width).toBe(21);
    const tif = await rf.export({ projectId: 'p', runId: RUN_ID, format: 'geotiff' });
    if (!tif.ok || tif.path === null) throw new Error('no GeoTIFF export');
    const back = readGridTiff(await readFile(tif.path));
    expect(back.data[10 * 21 + 10]).toBeCloseTo(-81.6073, 3);
    const csv = await rf.export({ projectId: 'p', runId: RUN_ID, format: 'csv' });
    if (!csv.ok || csv.path === null) throw new Error('no CSV export');
    expect((await readFile(csv.path, 'utf8')).split('\r\n')[1]).toMatch(/^sec-s1,S1,/);
  });

  it('holds the composite grids the generator printed, georeferenced in the project CRS', async () => {
    const [rsrp, best, overlap] = await Promise.all([
      grid('rsrp.tif'),
      grid('best-server.tif'),
      grid('overlap.tif'),
    ]);
    for (const t of [rsrp, best, overlap]) {
      expect([t.width, t.height]).toEqual([21, 21]);
      expect(t.epsg).toBe(32640);
      expect(t.origin).toEqual([499750, 2700275]);
      expect(t.pixelSize).toEqual([25, 25]);
      expect(t.nodata).toBe(NODATA);
    }
    for (const [row, col, dbm, server, count] of PIXELS) {
      const i = row * 21 + col;
      expect(rsrp.data[i]).toBeCloseTo(dbm, 3);
      expect(best.data[i]).toBe(server);
      expect(overlap.data[i]).toBe(count);
    }
    // best server is a 0-based index into run.inputs.sectors.sectors (two sectors), else nodata
    const servers = new Set(Array.from(best.data).filter((v) => v !== NODATA));
    expect([...servers].sort()).toEqual([0, 1]);
  });

  it('has a path-loss grid per antenna, NaN beyond the radius', async () => {
    const index = JSON.parse(await readFile(join(FIXTURE, 'pathloss', 'index.json'), 'utf8')) as {
      grids: { file: string; antennaId: string }[];
    };
    expect(index.grids.map((g) => g.antennaId)).toEqual(['ant-s1', 'ant-s2']);
    for (const g of index.grids) {
      const bytes = await readFile(join(FIXTURE, 'pathloss', g.file));
      expect(bytes.length).toBe(21 * 21 * 4);
      expect(Number.isNaN(bytes.readFloatLE(0))).toBe(true);
      expect(bytes.readFloatLE((10 * 21 + 10) * 4)).toBeGreaterThan(40);
    }
  });
});
