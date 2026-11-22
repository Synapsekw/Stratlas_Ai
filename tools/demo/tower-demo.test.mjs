// The Demo tower (tower-demo.mjs, telecom finalize item 64): built from antenna_synth.py, it opens
// as an ordinary Telecom towers project holding a point cloud and posed photos, with no antenna
// list yet, its truth.json equal to tower-truth.json, in its budget and free of client data.
// The build needs the pipeline Python (python/.venv after `uv sync`); skipped without it.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../packages/schema/src/index.ts';
import { checkFolder } from './check-no-client-data.mjs';
import { readLasHeader } from './formats.mjs';
import { pipelinePython } from './photo-demo.mjs';
import {
  TOWER_BUDGET_MB,
  TOWER_ID,
  TOWER_NAME,
  TRUTH_FILE,
  buildTowerDemo,
  towerTruth,
} from './tower-demo.mjs';

const hasPython = (() => {
  try {
    return existsSync(pipelinePython());
  } catch {
    return false;
  }
})();

describe('tower truth', () => {
  it('puts each unit in project terms: grid azimuth, downtilt, centre altitude, size', () => {
    const t = towerTruth(
      {
        height: 40,
        units: [
          {
            name: 'panel-120',
            kind: 'panel',
            centre: [1.5, 37.5, 0.8],
            azimuthDeg: 120,
            downtiltDeg: 4,
            plumbDeg: 1,
            widthM: 0.3,
            heightM: 1.4,
            depthM: 0.15,
          },
          {
            name: 'dish-60',
            kind: 'dish',
            centre: [2, 36.1, -1.2],
            azimuthDeg: 60,
            elevationDeg: 1,
            diameterM: 0.6,
            widthM: 0.6,
            heightM: 0.6,
            depthM: 0.15,
          },
        ],
      },
      { origin: [500000, 2600000, 386], epsg: 32631, convergenceDeg: -0.71234 },
    );
    expect(t.units[0]).toMatchObject({
      azimuthDeg: 120,
      downtiltDeg: 4,
      centreAltitudeM: 423.5,
      heightAboveBaseM: 37.5,
      // x east, z south in the local frame: north is origin N minus z
      centre: [500001.5, 2599999.2, 423.5],
      widthM: 0.3,
      heightM: 1.4,
      depthM: 0.15,
    });
    expect(t.units[1]).toMatchObject({ kind: 'dish', diameterM: 0.6, elevationDeg: 1 });
    expect(t.units[1]).not.toHaveProperty('downtiltDeg');
    expect(t).toMatchObject({ north: 'grid', convergenceDeg: -0.7123 });
  });
});

describe.skipIf(!hasPython)('Demo tower', () => {
  let out;
  let built;
  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), 'tower-demo-test-'));
    built = await buildTowerDemo({ out, quick: true });
  }, 240_000);
  afterAll(async () => {
    if (out) await rm(out, { recursive: true, force: true });
  });

  it('opens as a Telecom towers project holding a point cloud and photos', async () => {
    expect(built.root).toBe(join(out, TOWER_ID));
    const m = schema.parseManifest(
      JSON.parse(await readFile(join(built.root, 'manifest.json'), 'utf8')),
    );
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.value).toMatchObject({ id: TOWER_ID, name: TOWER_NAME, purpose: 'telecom' });
    const cloud = m.value.layers.find((l) => l.kind === 'pointcloud');
    expect(cloud?.id).toBe('tower-cloud');
    const index = JSON.parse(await readFile(join(built.root, cloud.src.path), 'utf8'));
    expect(index.schema).toBe('aio.pngcloud/1');
    for (const c of index.chunks) expect(existsSync(join(built.root, c.file))).toBe(true);
    expect(cloud.pointCount).toBeGreaterThan(200_000);
    const photos = m.value.layers.find((l) => l.kind === 'photos');
    expect(photos?.items.length).toBeGreaterThanOrEqual(8);
    for (const p of photos.items) {
      expect(existsSync(join(built.root, p.src.path))).toBe(true);
      expect(p.pos).toHaveLength(3);
      expect(p.q).toHaveLength(4);
    }
  });

  it('keeps the dated cloud measured points as sources/tower-cloud.las, which Prepare surfaces reads', async () => {
    const m = JSON.parse(await readFile(join(built.root, 'manifest.json'), 'utf8'));
    const cloud = m.layers.find((l) => l.kind === 'pointcloud');
    // a dated cloud: the app prepares its surface when the project opens, from this file
    expect(cloud.capture).toBe(m.captures[0].id);
    const las = readLasHeader(await readFile(join(built.root, 'sources', `${cloud.id}.las`)));
    expect(las.signature).toBe('LASF');
    expect(las.points).toBe(cloud.pointCount);
    expect(las.epsg).toBe(32631);
    // in the project CRS: the tower base at the origin, its top 40 m above
    expect(las.min[2]).toBeCloseTo(m.origin[2], 0);
    expect(las.max[2]).toBeGreaterThan(m.origin[2] + 39);
    expect(las.min[0]).toBeLessThan(m.origin[0]);
    expect(las.max[0]).toBeGreaterThan(m.origin[0]);
  });

  it('has no antenna list yet, and the known truth beside it', async () => {
    expect(existsSync(join(built.root, 'telecom', 'antennas.json'))).toBe(false);
    const truth = JSON.parse(await readFile(join(built.root, 'truth.json'), 'utf8'));
    expect(truth).toEqual(JSON.parse(await readFile(TRUTH_FILE, 'utf8')));
    const kinds = truth.units.map((u) => u.kind);
    expect(kinds).toEqual(expect.arrayContaining(['panel', 'dish', 'other']));
  });

  it('stays in its budget and carries no client data', () => {
    const r = checkFolder(built.root, { maxMb: TOWER_BUDGET_MB });
    expect(r.findings).toEqual([]);
  });
});
