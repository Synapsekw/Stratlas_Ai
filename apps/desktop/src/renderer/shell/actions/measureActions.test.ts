// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { emptyMeasurements, type SitePoint } from '@aio/schema';
import { actionsFor, makeActionCtx, t, type MenuTarget } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const go = vi.hoisted(() => vi.fn());
const moveToDate = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true, moved: 1, seq: 1 })));
const flags = vi.hoisted(() => ({ annotateReadOnly: false }));
vi.mock('../../survey/measureMoveRun', () => ({ moveMeasurementsToDate: moveToDate }));
vi.mock('@aio/annotate', () => ({ isAnnotateReadOnly: () => flags.annotateReadOnly }));
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
const colourOf = (id: string) =>
  measureStore.getState().file.measurements.find((x) => x.id === id)?.style?.color;
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
  moveToDate.mockClear();
  flags.annotateReadOnly = false;
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
    expect(colourOf('m1')).toBe('#06d6a0');
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

  describe('with survey dates', () => {
    const dated = {
      ...manifest,
      captures: [
        { id: 'd1', label: '2026-01-01', date: '2026-01-01' },
        { id: 'd2', label: '2026-06-01', date: '2026-06-01' },
        { id: 'd3', label: '2026-09-01', date: '2026-09-01' },
      ],
    } as unknown as ProjectManifest;
    const on = (id: string, capture: string, folder?: string) => ({
      ...m(id, folder),
      scope: { kind: 'survey' as const, capture },
    });
    const setup = (list: ReturnType<typeof on>[]) => {
      workspace.getState().closeProject();
      workspace.getState().openProject({ id: 'p1', root: '/p1', manifest: dated });
      const file = { ...emptyMeasurements(), measurements: list };
      measureStore.setState({ file, savedText: JSON.stringify(file) });
    };
    const move = (target: MenuTarget) =>
      actionsFor(target, makeActionCtx({ manifest: dated })).find(
        (i) => i.id === 'measure.moveToFolder',
      );

    it('Move to folder lists only the folders of the marked measurements date', () => {
      setup([on('a', 'd1'), on('b', 'd1', 'Piles'), on('c', 'd2', 'Pads')]);
      expect(move(one('a'))?.sub.map((s) => s.id)).toEqual(['to:Piles', 'none', 'new']);
    });

    it('Move to folder is disabled across dates with the reason', () => {
      setup([on('a', 'd1', 'Piles'), on('c', 'd2', 'Pads')]);
      const sub = move({ kind: 'measurements', ids: ['a', 'c'], clicked: 'a' })?.sub ?? [];
      expect(sub.length).toBeGreaterThan(0);
      for (const s of sub) expect(s.disabled, s.id).toBe(t('actions.measure.spansDates'));
    });

    const toDate = (target: MenuTarget, c = makeActionCtx({ manifest: dated })) =>
      actionsFor(target, c).find((i) => i.id === 'measure.moveToDate');

    it('Move to date lists the other survey dates, newest first, and moves there', () => {
      setup([on('a', 'd2'), on('b', 'd1')]);
      const item = toDate(one('a'));
      expect(item?.disabled).toBe(false);
      expect(item?.sub.map((s) => s.id)).toEqual(['d3', 'd1']);
      item?.run('d1');
      expect(moveToDate).toHaveBeenCalledWith(['a'], 'd1');
    });

    it('Move to date lists every date for a Needs a date measurement', () => {
      setup([{ ...m('a'), scope: { kind: 'site' as const } } as unknown as ReturnType<typeof on>]);
      expect(toDate(one('a'))?.sub.map((s) => s.id)).toEqual(['d3', 'd2', 'd1']);
    });

    it('Move to date is disabled for antenna measurements with the reason', () => {
      setup([{ ...on('a', 'd1'), tool: 'antenna-tilt' } as unknown as ReturnType<typeof on>]);
      expect(toDate(one('a'))?.disabled).toBe(t('tree.measure.move.telecom'));
    });

    it('Move to date is disabled while the measurements are read-only', () => {
      setup([on('a', 'd1')]);
      measureStore.setState({ readOnly: true });
      expect(toDate(one('a'))?.disabled).toBe(t('actions.reason.package'));
      measureStore.setState({ readOnly: false });
      flags.annotateReadOnly = true;
      expect(toDate(one('a'))?.disabled).toBe(t('actions.reason.readOnly'));
      toDate(one('a'))?.run('d2');
      expect(moveToDate).not.toHaveBeenCalled();
    });

    it('a project with no dates still lists every folder', () => {
      setup([]);
      workspace.getState().closeProject();
      workspace.getState().openProject({ id: 'p1', root: '/p1', manifest });
      const file = {
        ...emptyMeasurements(),
        measurements: [m('a'), m('b', 'Fence'), m('c', 'Gate')],
      };
      measureStore.setState({ file, savedText: JSON.stringify(file) });
      const sub = actionsFor(one('a'), ctx()).find((i) => i.id === 'measure.moveToFolder')?.sub;
      expect(sub?.map((s) => s.id)).toEqual(['to:Fence', 'to:Gate', 'none', 'new']);
    });
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
