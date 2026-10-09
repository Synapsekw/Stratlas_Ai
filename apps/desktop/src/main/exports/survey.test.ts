import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPORT_RUNS_MAX, surveyRunIds } from './survey';

const HAUL = join(
  import.meta.dirname,
  '../../../../../packages/schema/src/__fixtures__/haul/run.json',
);

const hydro = (id: string, computedAt: string) => ({
  schema: 'aio.hydro-run/1',
  id,
  jobId: 'job-1',
  pipeline: 'hydro.flood',
  computedAt,
  surface: { id: 'dsm-1', name: 'DSM', fingerprint: 'sha256:ab' },
  params: {},
  cellM: 0.5,
  files: {},
  fingerprint: 'sha256:cd',
  results: { levelM: 1, mode: 'all-below', areaM2: 1, volumeM3: 1, maxDepthM: 1, wetCells: 1 },
});

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('surveyRunIds', () => {
  it('names the haul-road and hydrology runs newest first, as the panels list them', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aio-runs-'));
    const haul = JSON.parse(await readFile(HAUL, 'utf8')) as Record<string, unknown>;
    for (const [id, at] of [
      ['road-a', '2026-10-08T10:00:00Z'],
      ['road-b', '2026-10-09T10:00:00Z'],
    ] as const) {
      await mkdir(join(dir, 'survey', 'haul', id), { recursive: true });
      await writeFile(
        join(dir, 'survey', 'haul', id, 'run.json'),
        JSON.stringify({ ...haul, id, computedAt: at }),
      );
    }
    for (let k = 0; k < REPORT_RUNS_MAX + 2; k++) {
      const id = `flood-${String(k).padStart(2, '0')}`;
      await mkdir(join(dir, 'survey', 'hydro', id), { recursive: true });
      await writeFile(
        join(dir, 'survey', 'hydro', id, 'run.json'),
        JSON.stringify(hydro(id, `2026-10-${String(10 + k)}T00:00:00Z`)),
      );
    }
    // a run being written has no run.json yet
    await mkdir(join(dir, 'survey', 'hydro', 'partial'), { recursive: true });
    const projects = { root: () => dir, package: () => undefined };
    const ids = await surveyRunIds(projects, 'p1');
    expect(ids.haul).toEqual(['road-b', 'road-a']);
    expect(ids.hydro).toHaveLength(REPORT_RUNS_MAX);
    expect(ids.hydro[0]).toBe(`flood-${String(REPORT_RUNS_MAX + 1)}`);
    expect(await surveyRunIds({ root: () => undefined, package: () => undefined }, 'x')).toEqual({
      haul: [],
      hydro: [],
    });
  });
});
