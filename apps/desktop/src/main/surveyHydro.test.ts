import type { HydroRun } from '@aio/schema';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectHandlers } from './notYet';
import { registerSurveyHydroIpc, type HydroArchive } from './surveyHydro';

const run = (id: string, computedAt: string): HydroRun => ({
  schema: 'aio.hydro-run/1',
  id,
  pipeline: 'hydro.flood',
  jobId: `job-${id}`,
  computedAt,
  surface: { id: 'dsm-m1', name: 'DSM m1', fingerprint: 'sha256:abc' },
  params: { surface: 'dsm-m1', levelM: 100, mode: 'all-below' },
  cellM: 1,
  results: { levelM: 100, mode: 'all-below', areaM2: 10, volumeM3: 5, maxDepthM: 1, wetCells: 10 },
  files: { outline: 'outline.geojson', dxf: 'outline.dxf' },
  fingerprint: 'sha256:def',
});

describe('survey hydrology runs (G10)', () => {
  let root: string;
  let pkgEntries: Map<string, unknown>;
  let pkgFiles: Map<string, Buffer>;
  const archive: HydroArchive = {
    get entries() {
      return pkgEntries;
    },
    read: (name) => {
      const b = pkgFiles.get(name);
      return b ? Promise.resolve(b) : Promise.reject(new Error('missing'));
    },
  };
  const projects = {
    root: (id: string) => (id === 'p' ? root : undefined),
    package: (id: string) => (id === 'pkg' ? {} : undefined),
  };
  const ipc = collectHandlers((handle) => {
    registerSurveyHydroIpc({
      handle,
      projects,
      projectPackage: (id) => (id === 'pkg' ? archive : undefined),
    });
  });
  const put = async (folder: string, doc: unknown) => {
    await mkdir(join(root, 'survey', 'hydro', folder), { recursive: true });
    await writeFile(join(root, 'survey', 'hydro', folder, 'run.json'), JSON.stringify(doc));
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aio-hydro-'));
    pkgEntries = new Map();
    pkgFiles = new Map();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists no runs for a site without hydrology', async () => {
    expect(await ipc.call('survey:readHydroRuns', { projectId: 'p' })).toEqual({
      ok: true,
      runs: [],
    });
  });

  it('lists the runs newest first and leaves out broken, misplaced and newer files', async () => {
    await put('a', run('a', '2026-10-09T10:00:00Z'));
    await put('b', run('b', '2026-10-09T11:00:00Z'));
    await put('moved', run('other', '2026-10-09T12:00:00Z'));
    await put('newer', { ...run('newer', '2026-10-09T12:00:00Z'), schema: 'aio.hydro-run/9' });
    await put('bad', { schema: 'aio.hydro-run/1', id: 'bad' });
    await mkdir(join(root, 'survey', 'hydro', 'empty'), { recursive: true });
    const r = await ipc.call('survey:readHydroRuns', { projectId: 'p' });
    expect(r.ok && r.runs.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('reads a package in place', async () => {
    const doc = run('pit', '2026-10-09T10:00:00Z');
    pkgEntries.set('survey/hydro/pit/run.json', {});
    pkgEntries.set('survey/hydro/pit/outline.dxf', {});
    pkgFiles.set('survey/hydro/pit/run.json', Buffer.from(JSON.stringify(doc)));
    const r = await ipc.call('survey:readHydroRuns', { projectId: 'pkg' });
    expect(r).toEqual({ ok: true, runs: [doc] });
  });

  it('answers for a project that is not open', async () => {
    const r = await ipc.call('survey:readHydroRuns', { projectId: 'nope' });
    expect(r.ok).toBe(false);
  });
});
