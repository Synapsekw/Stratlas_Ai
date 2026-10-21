// Thermal analysis M1 (plan 2026-10-21-thermal-analysis) is additive, pinned against the 0.21
// schema (tools/compat/schema-0.21):
// - everything it writes lives in the new folder `thermal/` (`aio.thermal`, `aio.thermalRaster`),
//   which 0.21 never opens; the manifest and issues of a project with thermal photos stay as 0.21
//   reads them, before and after a decode;
// - the one known exception, as in M10 and M11: the job index lists thermal.decode jobs, which
//   0.21's index reader skips one by one instead of refusing the file.
// The decode itself runs when the pipeline Python is there (QUADRION_E2E_PYTHON, else the repo's
// venv), on the photos of the e2e fixture (apps/desktop/e2e/thermal-fixture.py).
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import { familyOf } from './families.mjs';
import * as v021 from './schema-0.21/index.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const PYTHON =
  process.env.QUADRION_E2E_PYTHON ??
  (process.platform === 'win32'
    ? join(REPO, 'python', '.venv', 'Scripts', 'python.exe')
    : join(REPO, 'python', '.venv', 'bin', 'python'));
const FIXTURE = join(REPO, 'apps', 'desktop', 'e2e', 'thermal-fixture.py');
const LAYER = 'thermal-2026-10-01';

/** The project of thermal-bench.spec.ts (thermalFixture.ts), as plain JSON. */
const manifest = current.ProjectManifest.parse({
  schema: current.SCHEMA_VERSION,
  id: 'e2e-thermal',
  name: 'E2E thermal photos',
  customer: 'E2E',
  site: 'Synthetic site, thermal photos',
  crs: { wkt: 'LOCAL_CS["Site grid",UNIT["metre",1]]' },
  origin: [0, 0, 0],
  captures: [{ id: 'c1', label: '1 Oct 2026', date: '2026-10-01' }],
  layers: [
    {
      kind: 'photos',
      id: LAYER,
      name: 'Thermal photos',
      capture: 'c1',
      items: [
        { id: 'th1', src: { path: 'photos/th1.jpg' }, takenAt: '2026-10-01T09:00:00Z' },
        { id: 'vis1', src: { path: 'photos/vis1.jpg' }, takenAt: '2026-10-01T09:00:01Z' },
        { id: 'th2', src: { path: 'photos/th2.jpg' }, takenAt: '2026-10-01T09:00:10Z' },
      ],
    },
  ],
  severityModels: [],
  classCatalogues: [],
});
const issues = { schema: 'aio.issues/1', issues: [] };

/** Every file under `dir`, as forward-slash paths relative to it. */
function filesOf(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? filesOf(p, base) : [relative(base, p).split('\\').join('/')];
  });
}

const temps = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

describe('thermal analysis M1 is additive', () => {
  it('writes its files into thermal/, which 0.21 never reads', () => {
    for (const family of ['aio.thermal', 'aio.thermalRaster', 'aio.thermalCandidates']) {
      const row = current.SCHEMA_REGISTRY.find((e) => e.family === family);
      expect(row?.home, family).toBe('project');
      expect(row?.where.startsWith('thermal/'), family).toBe(true);
    }
    expect(v021.SCHEMA_REGISTRY.some((e) => e.where.startsWith('thermal/'))).toBe(false);
    expect(v021.SCHEMA_REGISTRY.some((e) => e.family.startsWith('aio.thermal'))).toBe(false);
  });

  it('0.21 reads the manifest and issues of a project with thermal photos', () => {
    expect(v021.ProjectManifest.safeParse(manifest).success).toBe(true);
    expect(familyOf('issues.json')?.pick(v021)?.safeParse(issues).success).toBe(true);
  });

  it('the job index lists thermal.decode jobs that 0.21 skips one by one', () => {
    const job = {
      id: '20261021-090000-thermal-decode-a1b2',
      pipeline: 'thermal.decode',
      project: 'D:/data/projects/demo',
      params: { layerId: LAYER },
      status: 'done',
      progress: 1,
      steps: [],
      artifacts: [],
      createdAt: '2026-10-21T09:00:00Z',
      updatedAt: '2026-10-21T09:00:00Z',
    };
    expect(current.JobRecord.safeParse(job).success).toBe(true);
    expect(v021.JobRecord.safeParse(job).success).toBe(false);
    expect(v021.JobRecord.safeParse({ ...job, pipeline: 'photo.align', params: {} }).success).toBe(
      true,
    );
  });

  it.skipIf(!existsSync(PYTHON))(
    'after a decode, 0.21 still parses the manifest and every file of an existing family',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'thermal-compat-'));
      temps.push(root);
      writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
      writeFileSync(join(root, 'issues.json'), JSON.stringify(issues, null, 2));
      const env = {
        ...process.env,
        PYTHONPATH: [join(REPO, 'python', 'src'), join(REPO, 'python', 'tests')].join(
          process.platform === 'win32' ? ';' : ':',
        ),
        PYTHONDONTWRITEBYTECODE: '1',
      };
      mkdirSync(join(root, 'photos'), { recursive: true });
      execFileSync(PYTHON, [FIXTURE, join(root, 'photos')], { env, encoding: 'utf8' });
      const before = new Map(
        filesOf(root).map((f) => [f, readFileSync(join(root, f)).toString('base64')]),
      );
      const decode = [
        'import json, sys, threading',
        'from aio_pipelines.runtime import Job',
        'from aio_pipelines.thermal.pipeline import ThermalDecode',
        'job = Job("j1", ThermalDecode(), sys.argv[1], {"layerId": sys.argv[2]},',
        '          lambda m, p: None, threading.Event())',
        'print(json.dumps(job.run()))',
      ].join('\n');
      execFileSync(PYTHON, ['-c', decode, root, LAYER], { env, encoding: 'utf8' });

      const after = filesOf(root);
      // the decode made rasters for the two thermal photos
      const index = JSON.parse(
        readFileSync(join(root, 'thermal', 'rasters', LAYER, 'index.json'), 'utf8'),
      );
      expect(current.ThermalRasterIndex.safeParse(index).success).toBe(true);
      // the whole layer was asked for: the visual twin is listed as unsupported, with no raster
      expect(Object.keys(index.photos).sort()).toEqual(['th1', 'th2', 'vis1']);
      expect(index.photos.vis1.status).toBe('unsupported');
      expect(existsSync(join(root, 'thermal', 'rasters', LAYER, 'vis1.f32'))).toBe(false);
      for (const id of ['th1', 'th2']) {
        expect(index.photos[id].status).toBe('ok');
        const meta = JSON.parse(
          readFileSync(join(root, 'thermal', 'rasters', LAYER, `${id}.json`), 'utf8'),
        );
        expect(current.ThermalRasterMeta.safeParse(meta).success).toBe(true);
      }

      // nothing it wrote outside thermal/ and jobs/ (the job's own folder), nothing it changed
      const outside = after.filter((f) => !f.startsWith('thermal/') && !f.startsWith('jobs/'));
      expect(outside.sort()).toEqual([...before.keys()].sort());
      for (const f of outside)
        expect(readFileSync(join(root, f)).toString('base64'), f).toBe(before.get(f));

      // every file of an existing family parses with 0.21, the manifest among them
      const known = after.filter((f) => familyOf(f) !== undefined);
      expect(known).toContain('manifest.json');
      for (const f of known) {
        const schema = familyOf(f)?.pick(v021);
        expect(schema, f).toBeTruthy();
        const r = schema.safeParse(JSON.parse(readFileSync(join(root, f), 'utf8')));
        expect(r.success, `${f}: ${r.error?.message ?? ''}`).toBe(true);
      }
    },
    120_000,
  );
});
