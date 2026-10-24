// @vitest-environment jsdom
import type { JobRecord, ProjectManifest } from '@aio/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const started: { pipeline: string; project: string; params: Record<string, unknown> }[] = [];
const list: Pick<JobRecord, 'pipeline' | 'project' | 'status'>[] = [];
vi.mock('../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: true, value: { ok: true } }) },
  jobs: {
    getState: () => ({
      jobs: list,
      start: (req: (typeof started)[number]) => {
        started.push(req);
        return Promise.resolve(null);
      },
    }),
  },
}));

const { prepareDsms } = await import('./haulRoadStore');
const { workspace } = await import('@aio/workspace');

const manifest = {
  captures: [{ id: 'm3', label: 'Survey 31 March 2026' }],
  layers: [{ id: 'dsm-3', kind: 'raster', role: 'dsm', capture: 'm3', name: 'DSM 31 March 2026' }],
} as unknown as ProjectManifest;

describe("the haul-road panel's Prepare the DSMs", () => {
  beforeEach(() => {
    started.length = 0;
    list.length = 0;
    workspace.setState({
      project: { id: 'p', root: 'C:/projects/p', manifest },
    } as unknown as Parameters<typeof workspace.setState>[0]);
  });

  it('prepares every DSM of the project', async () => {
    expect(await prepareDsms()).toBeNull();
    expect(started).toEqual([
      {
        pipeline: 'survey.prepare',
        project: 'C:/projects/p',
        params: {
          surfaces: [
            {
              id: 'dsm-m3',
              name: 'DSM 31 March 2026',
              source: { kind: 'dsm', layer: 'dsm-3' },
              capture: 'm3',
            },
          ],
        },
      },
    ]);
  });

  it('starts none beside a prepare job at work on the project (the background one)', async () => {
    list.push({ pipeline: 'survey.prepare', project: 'C:/projects/p', status: 'running' });
    expect(await prepareDsms()).toBeNull();
    expect(started).toEqual([]);
  });

  it('is not held back by a finished prepare job or one on another project', async () => {
    list.push(
      { pipeline: 'survey.prepare', project: 'C:/projects/p', status: 'done' },
      { pipeline: 'survey.prepare', project: 'C:/projects/other', status: 'running' },
    );
    expect(await prepareDsms()).toBeNull();
    expect(started).toHaveLength(1);
  });
});
