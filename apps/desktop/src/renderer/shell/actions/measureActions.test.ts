// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { emptyMeasurements, type SitePoint } from '@aio/schema';
import { actionsFor, makeActionCtx, t, type MenuTarget } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const go = vi.hoisted(() => vi.fn());
vi.mock('../../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false, error: 'Not configured' }) },
  shell: { getState: () => ({ screen: 'scene', go }) },
}));

const { registerMeasureActions, flyToMeasurement } = await import('./measureActions');
const { renameRequest } = await import('../renameRequest');
const { measureStore } = await import('../../survey/measureStore');

const manifest = {
  captures: [],
  layers: [],
  crs: { kind: 'local' },
  origin: { e: 0, n: 0, z: 0 },
} as unknown as ProjectManifest;

const m = (id: string, folder?: string, color?: string) => ({
  id,
  family: 'line' as const,
  tool: 'distance' as const,
  label: id,
  scope: { kind: 'site' as const },
  items: [],
  results: [],
  points: [
    [0, 0, 0],
    [3, 4, 0],
  ] as SitePoint[],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...(folder ? { folder } : {}),
  ...(color ? { style: { color } } : {}),
});

const ctx = (o: { pkg?: boolean; canEdit?: boolean } = {}) => makeActionCtx({ manifest, ...o });
const one = (id: string): MenuTarget => ({ kind: 'measurements', ids: [id], clicked: id });
const ids = (target: MenuTarget, c = ctx()) => actionsFor(target, c).map((i) => i.id);
const styleOf = (id: string) =>
  measureStore.getState().file.measurements.find((x) => x.id === id)?.style ?? {};
const folderOf = (id: string) =>
  measureStore.getState().file.measurements.find((x) => x.id === id)?.folder;

let off: () => void;
beforeEach(() => {
  off = registerMeasureActions();
  workspace.getState().openProject({ id: 'p1', root: '/p1', manifest });
  const file = {
    ...emptyMeasurements(),
    measurements: [m('m1', undefined, '#ffd166'), m('m2', 'Fence')],
  };
  measureStore.setState({
    file,
    savedText: JSON.stringify(file),
    projectId: 'p1',
    status: 'ready',
    readOnly: false,
    hiddenMeasurements: [],
    newFolder: null,
  });
  renameRequest.getState().done();
  go.mockClear();
});
afterEach(() => {
  off();
  workspace.getState().closeProject();
});

describe('measurement menu actions', () => {
  it('offers the founder order on one measurement', () => {
    expect(ids(one('m1'))).toEqual([
      'measure.rename',
      'measure.colour',
      'measure.visibility',
      'measure.flyTo',
      'measure.moveToFolder',
      'measure.delete',
    ]);
  });

  it('several marked: every item still shows; Rename and Fly to act on the clicked one', () => {
    const items = actionsFor({ kind: 'measurements', ids: ['m1', 'm2'], clicked: 'm2' }, ctx());
    items.find((i) => i.id === 'measure.rename')?.run();
    expect(renameRequest.getState().measureId).toBe('m2');
    expect(items.find((i) => i.id === 'measure.delete')?.label).toBe('Delete 2 measurements');
    items.find((i) => i.id === 'measure.visibility')?.run();
    expect(measureStore.getState().hiddenMeasurements).toEqual(['m1', 'm2']);
  });

  it('colours from eight presets, the default yellow among them', () => {
    const colour = actionsFor(one('m1'), ctx()).find((i) => i.id === 'measure.colour');
    expect(colour?.sub.map((s) => s.swatch)).toEqual([
      '#ffd166',
      '#ef476f',
      '#06d6a0',
      '#118ab2',
      '#9b5de5',
      '#f78c40',
      '#ffffff',
      '#94a3b8',
    ]);
    expect(colour?.sub[0]?.checked).toBe(true);
    colour?.run('#06d6a0');
    expect(styleOf('m1').color).toBe('#06d6a0');
  });

  it('moves to a folder, out of one, or into a new one', () => {
    const move = () => actionsFor(one('m1'), ctx()).find((i) => i.id === 'measure.moveToFolder');
    expect(move()?.sub.map((s) => s.id)).toEqual(['to:Fence', 'none', 'new']);
    move()?.run('to:Fence');
    expect(folderOf('m1')).toBe('Fence');
    move()?.run('none');
    expect(folderOf('m1')).toBeUndefined();
    move()?.run('new');
    expect(measureStore.getState().newFolder?.ids).toEqual(['m1']);
  });

  it('a read-only package greys the edits and keeps Hide and Fly to', () => {
    measureStore.setState({ readOnly: true });
    const items = actionsFor(one('m1'), ctx({ pkg: true, canEdit: false }));
    const why = (id: string) => items.find((i) => i.id === id)?.disabled;
    for (const id of ['measure.rename', 'measure.colour', 'measure.moveToFolder', 'measure.delete'])
      expect(why(id), id).toBe(t('actions.reason.package'));
    expect(why('measure.visibility')).toBe(false);
    expect(why('measure.flyTo')).toBe(false);
  });

  it('Fly to frames the measurement through the workspace', () => {
    const fly = vi.spyOn(workspace.getState(), 'flyTo');
    expect(flyToMeasurement('m1')).toBe(true);
    expect(fly).toHaveBeenCalledWith(expect.objectContaining({ kind: 'point' }));
    expect(flyToMeasurement('gone')).toBe(false);
  });
});
