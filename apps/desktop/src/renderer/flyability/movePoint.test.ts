// @vitest-environment jsdom
import { findingPoint, issueEditor } from '@aio/annotate';
import type { Issue, ProjectManifest } from '@aio/schema';
import { clearToasts, toastQueue } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMovePoint, cancelMovePoint, moveSession, startMovePoint } from './movePoint';

const manifest = {
  captures: [],
  severityModels: [
    {
      id: 'tank-1-5',
      name: 'Tank',
      levels: [
        { value: 1, label: 'Low', color: '#5b9bd5', criteria: 'Note' },
        { value: 2, label: 'High', color: '#e5484d', criteria: 'Repair' },
      ],
    },
  ],
  classCatalogues: [
    {
      id: 'tank',
      name: 'Tank',
      assetType: 'tank',
      classes: [
        { id: 'crack', label: 'Crack', color: '#e5484d', hotkey: 'c', severityModel: 'tank-1-5' },
      ],
    },
  ],
  layers: [
    { id: 'cloud-a', kind: 'pointcloud' },
    { id: 'mesh-a', kind: 'mesh' },
  ],
  crs: { kind: 'local' },
  origin: { e: 0, n: 0, z: 0 },
} as unknown as ProjectManifest;

const NOW = '2026-10-01T00:00:00.000Z';
const issue = (): Issue => ({
  id: 'i1',
  code: 'F01',
  classId: 'crack',
  severityModelId: 'tank-1-5',
  severity: 2,
  status: 'draft',
  title: 'Crack',
  note: '',
  author: 'import',
  createdAt: NOW,
  updatedAt: NOW,
  source: 'import',
  sightings: [{ on: 'pointcloud', layer: 'cloud-a', geom: { type: 'point3', p: [1, 2, 3] } }],
  external: {
    source: 'flyability',
    poi: 'poi-1',
    snapshots: ['s1'],
    wallDistanceM: 0.4,
    hitDistanceM: 0.9,
    locationCheck: 'disagrees',
  },
});

const current = () => workspace.getState().issues.find((i) => i.id === 'i1');
const pointOf = () => {
  const i = current();
  return i ? findingPoint(i) : null;
};
const hit = { layerId: 'cloud-a', point: [4, 5, 6] as [number, number, number] };

beforeEach(() => {
  workspace.getState().openProject({ id: 'p1', root: '/p1', manifest }, [issue()]);
  startMovePoint('i1');
});
afterEach(() => {
  cancelMovePoint();
  clearToasts();
  vi.restoreAllMocks();
});

describe('move point', () => {
  it('move point writes the moved issue', () => {
    const commit = vi.spyOn(issueEditor, 'commitIssues');
    expect(applyMovePoint(hit, '2026-10-02T00:00:00.000Z')).toBe('moved');
    expect(commit).toHaveBeenCalledTimes(1);
    const [issues] = commit.mock.calls[0] ?? [];
    expect(issues?.[0]?.external?.locationCheck).toBe('moved');
    expect(pointOf()).toEqual({ layer: 'cloud-a', p: [4, 5, 6] });
    expect(moveSession.getState().issueId).toBeNull();
  });

  it('a click off the cloud keeps the point and says so', () => {
    const commit = vi.spyOn(issueEditor, 'commitIssues');
    expect(applyMovePoint(null, NOW)).toBe('no-hit');
    expect(applyMovePoint({ layerId: 'mesh-a', point: [1, 1, 1] }, NOW)).toBe('not-cloud');
    expect(commit).not.toHaveBeenCalled();
    expect(pointOf()?.p).toEqual([1, 2, 3]);
    expect(moveSession.getState().issueId).toBe('i1');
    expect(toastQueue().some((x) => x.id === 'fly-move-hit')).toBe(true);
  });

  it('undo from the toast puts the point back', () => {
    applyMovePoint(hit, NOW);
    const toast = toastQueue().find((x) => x.id === 'fly-move');
    expect(toast?.action?.testId).toBe('fly-move-undo');
    toast?.action?.run();
    expect(pointOf()?.p).toEqual([1, 2, 3]);
    expect(current()?.external?.locationCheck).toBe('disagrees');
  });

  it('undo after a later edit does nothing', () => {
    applyMovePoint(hit, NOW);
    const toast = toastQueue().find((x) => x.id === 'fly-move');
    issueEditor.update('i1', { note: 'later edit' });
    toast?.action?.run();
    expect(pointOf()?.p).toEqual([4, 5, 6]);
    expect(current()?.note).toBe('later edit');
  });
});
