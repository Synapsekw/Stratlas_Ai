// @vitest-environment jsdom
import type { Issue } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const log: string[] = [];
const disk: { issues: Issue[] } = { issues: [] };

vi.mock('../shell', () => ({
  bridge: {
    call: (channel: string) => {
      log.push(channel);
      return Promise.resolve({
        ok: true,
        value: { ok: true, manifest: workspace.getState().project?.manifest, issues: disk.issues },
      });
    },
  },
}));
// the approvals are read on a later turn than project:open answers (main queues their reads)
vi.mock('@aio/collab/ui', () => ({
  loadCollab: async () => {
    log.push('collab:start');
    await new Promise((r) => setTimeout(r, 5));
    log.push('collab:done');
  },
}));
vi.mock('@aio/annotate', () => ({ issueSaver: { schedule: () => undefined } }));
vi.mock('@aio/change', () => ({ changeStore: { getState: () => ({ load: () => undefined }) } }));
vi.mock('../detections/store', () => ({ loadDetections: () => Promise.resolve() }));

const { reloadRecords } = await import('./reload');

const issue = (status: Issue['status']): Issue => ({
  id: 'i_f05',
  code: 'F05',
  classId: 'corrosion',
  severityModelId: 'sev4',
  severity: 2,
  status,
  title: 'Flange corrosion',
  note: '',
  author: 'Rana Example',
  createdAt: '2026-10-07T08:00:00.000Z',
  updatedAt: '2026-10-07T08:00:00.000Z',
  sightings: [{ on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] } }],
  source: 'human',
});

beforeEach(() => {
  log.length = 0;
  workspace.getState().openProject(
    {
      id: 'p1',
      root: 'C:/synthetic/p1',
      manifest: {
        schema: 'aio.project/1',
        id: 'p1',
        name: 'Synthetic site',
        crs: { epsg: 32639 },
        origin: [0, 0, 0],
        captures: [],
        layers: [],
        severityModels: [],
        classCatalogues: [],
      },
    } as never,
    [issue('reviewed')],
  );
});

afterEach(() => {
  workspace.getState().closeProject();
});

describe('reloadRecords (journal:changed)', () => {
  it('shows the merged issues only once the approvals are read again', async () => {
    disk.issues = [issue('approved')];
    const off = workspace.subscribe((s, prev) => {
      if (s.issues !== prev.issues) log.push(`issues:${s.issues[0]?.status ?? ''}`);
    });
    await reloadRecords('p1', [{ rec: 'issue', id: 'i_f05' }]);
    off();
    expect(log).toEqual(['project:open', 'collab:start', 'collab:done', 'issues:approved']);
  });

  it('leaves another project alone', async () => {
    disk.issues = [issue('approved')];
    await reloadRecords('p2', [{ rec: 'issue', id: 'i_f05' }]);
    expect(log).toEqual([]);
    expect(workspace.getState().issues[0]?.status).toBe('reviewed');
  });
});
