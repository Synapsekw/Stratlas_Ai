import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectHandlers } from './notYet';
import type { SurveyArchive } from './survey';
import { registerSurveyHaulIpc } from './surveyHaul';

/** A run as `haul.analyse` writes it (the schema's shared fixture). */
const FIXTURE = fileURLToPath(
  new URL('../../../../packages/schema/src/__fixtures__/haul/run.json', import.meta.url),
);

describe('haul-road runs (G11)', () => {
  let root: string;
  let fixture: Record<string, unknown>;
  const pkgFiles = new Map<string, Buffer>();
  const archive: SurveyArchive = {
    get entries() {
      return pkgFiles as ReadonlyMap<string, unknown>;
    },
    read: (name) => {
      const b = pkgFiles.get(name);
      return b ? Promise.resolve(b) : Promise.reject(new Error('missing'));
    },
  };
  const ipc = collectHandlers((handle) => {
    registerSurveyHaulIpc({
      handle,
      projects: {
        root: (id) => (id === 'p' ? root : undefined),
        package: (id) => (id === 'pkg' ? {} : undefined),
      },
      projectPackage: (id) => (id === 'pkg' ? archive : undefined),
    });
  });
  const run = (id: string, computedAt: string) => ({ ...fixture, id, computedAt });
  const seed = async (id: string, body: unknown) => {
    await mkdir(join(root, 'survey', 'haul', id), { recursive: true });
    await writeFile(
      join(root, 'survey', 'haul', id, 'run.json'),
      typeof body === 'string' ? body : JSON.stringify(body),
    );
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aio-haul-'));
    fixture = JSON.parse(await readFile(FIXTURE, 'utf8')) as Record<string, unknown>;
    pkgFiles.clear();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('answers no runs for a site without any', async () => {
    expect(await ipc.call('survey:readHaulRuns', { projectId: 'p' })).toEqual({
      ok: true,
      runs: [],
    });
  });

  it('lists valid runs newest first and leaves out the rest', async () => {
    await seed('older', run('older', '2026-10-01T08:00:00Z'));
    await seed('newer', run('newer', '2026-10-09T08:00:00Z'));
    await seed('broken', '{ not json');
    await seed('future', { ...run('future', '2026-10-09T09:00:00Z'), schema: 'aio.haul-run/2' });
    await mkdir(join(root, 'survey', 'haul', 'writing'), { recursive: true });
    await writeFile(join(root, 'survey', 'haul', 'stray.json'), '{}');
    const r = await ipc.call('survey:readHaulRuns', { projectId: 'p' });
    if (!r.ok) throw new Error(r.error);
    expect(r.runs.map((x) => x.id)).toEqual(['newer', 'older']);
    expect(r.runs[0]?.stations[0]?.checks.bermRight).toBe('fail');
  });

  it('reads a package in place, and refuses a project that is not open', async () => {
    pkgFiles.set(
      'survey/haul/a/run.json',
      Buffer.from(JSON.stringify(run('a', fixture.computedAt as string))),
    );
    pkgFiles.set('survey/haul/a/haul.geojson', Buffer.from('{}'));
    pkgFiles.set('survey/haul/a/b/run.json', Buffer.from('{}'));
    const r = await ipc.call('survey:readHaulRuns', { projectId: 'pkg' });
    expect(r.ok && r.runs.map((x) => x.id)).toEqual(['a']);
    const closed = await ipc.call('survey:readHaulRuns', { projectId: 'nope' });
    expect(closed.ok).toBe(false);
  });

  it('answers not available without the project registry', async () => {
    const bare = collectHandlers((handle) => {
      registerSurveyHaulIpc({ handle });
    });
    const r = await bare.call('survey:readHaulRuns', { projectId: 'p' });
    expect(r).toMatchObject({ ok: false, code: 'not-implemented' });
  });
});
