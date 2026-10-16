// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { actionsFor, makeActionCtx, t, type ActionCtx } from '@aio/ui';
import { dateTags, workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { builder } from '../../builder/state';
import { askRemove } from '../removal';
import { updateCapture } from '../dateFolders';
import { registerDateActions } from './dateActions';
import { exportLayersFlow, zoomToLayers } from './layerActions';

vi.mock('../dateFolders', () => ({
  updateCapture: vi.fn(() => Promise.resolve(null)),
  moveLayersToDate: vi.fn(),
}));
vi.mock('../removal', () => ({ askRemove: vi.fn() }));
vi.mock('./layerActions', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  zoomToLayers: vi.fn(() => Promise.resolve()),
  exportLayersFlow: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../workspace/compareWith', () => ({
  COMPARE_WITH_ACTIONS: [],
  compareWith: vi.fn(() => true),
  compareTargets: vi.fn(() => [
    { capture: 'oct', reason: null },
    { capture: 'sep', reason: 'compare.with.noRaster' },
  ]),
}));

const captures = [
  { id: 'sep', label: 'Survey', date: '2024-09-04' },
  { id: 'oct', label: 'Baseline', date: '2024-10-02', colour: 6, icon: 'flag' },
];
const manifest = { captures, layers: [] } as unknown as ProjectManifest;
let off: () => void;
beforeEach(() => {
  off = registerDateActions();
});
afterEach(() => {
  off();
});
const items = (captureId: string | null, over: Partial<ActionCtx> = {}) =>
  actionsFor(
    { kind: 'date', captureId },
    makeActionCtx({
      manifest,
      tags: dateTags(captures),
      folderLayers: { sep: ['a', 'b'], every: ['c'] },
      ...over,
    }),
  );
const ids = (captureId: string | null, over: Partial<ActionCtx> = {}) =>
  items(captureId, over).map((i) => i.testId);

describe('date actions', () => {
  it('a date folder in an editable project lists its items by section', () => {
    expect(ids('sep')).toEqual([
      'date-menu-view',
      'date-menu-toggle',
      'date-menu-show',
      'date-menu-hide',
      'ctx-item-date.zoomTo',
      'date-menu-rename',
      'date-menu-colour',
      'date-menu-icon',
      'ctx-item-date.addData',
      'date-menu-compare',
      'ctx-item-date.export',
      'date-menu-delete',
    ]);
  });

  it('Every date keeps its reduced set', () => {
    expect(ids(null)).toEqual(['date-menu-toggle', 'date-menu-show', 'date-menu-hide']);
  });

  it('View this date is greyed for the date already in view', () => {
    const view = items('sep', { focus: 'sep' }).find((i) => i.id === 'date.view');
    expect(view?.disabled).toBe(t('actions.reason.inView'));
    expect(items('sep').find((i) => i.id === 'date.view')?.disabled).toBe(false);
  });

  it('Show and Hide grey out when nothing would change', () => {
    const shown = items('sep');
    expect(shown.find((i) => i.id === 'date.show')?.disabled).toBe('Nothing to change.');
    expect(shown.find((i) => i.id === 'date.hide')?.disabled).toBe(false);
    const hidden = items('sep', { hidden: { a: true, b: true } });
    expect(hidden.find((i) => i.id === 'date.show')?.disabled).toBe(false);
    expect(hidden.find((i) => i.id === 'date.hide')?.disabled).toBe('Nothing to change.');
  });

  it('a read-only project greys rename, colour, icon, add data and delete with the reason', () => {
    const list = items('sep', { canEdit: false });
    for (const id of ['date.rename', 'date.colour', 'date.icon', 'date.addData', 'date.delete']) {
      expect(list.find((i) => i.id === id)?.disabled).toBe(t('actions.reason.readOnly'));
    }
    expect(list.find((i) => i.id === 'date.view')?.disabled).toBe(false);
  });

  it('a package greys Export with the package reason', () => {
    const list = items('sep', { pkg: true, canEdit: false });
    expect(list.find((i) => i.id === 'date.export')?.disabled).toBe(t('actions.reason.package'));
  });

  it('a colour pick saves the colour and Reset shows once one is picked', () => {
    const list = items('oct');
    const colour = list.find((i) => i.id === 'date.colour');
    expect(colour?.present).toBe('picks');
    expect(colour?.sub.find((s) => s.id === '6')?.checked).toBe(true);
    expect(colour?.sub.find((s) => s.id === '5')?.testId).toBe('date-menu-colour-5');
    colour?.run('5');
    expect(updateCapture).toHaveBeenCalledWith('oct', { colour: 5 });
    expect(list.some((i) => i.testId === 'date-menu-reset')).toBe(true);
    expect(items('sep').some((i) => i.testId === 'date-menu-reset')).toBe(false);
  });

  it('an icon pick saves the icon, none clears it, and Reset clears both', () => {
    const list = items('oct');
    const icon = list.find((i) => i.id === 'date.icon');
    expect(icon?.sub[0]?.testId).toBe('date-menu-icon-none');
    expect(icon?.sub.find((s) => s.id === 'flag')?.checked).toBe(true);
    icon?.run('pin');
    expect(updateCapture).toHaveBeenCalledWith('oct', { icon: 'pin' });
    icon?.run('none');
    expect(updateCapture).toHaveBeenCalledWith('oct', { icon: null });
    list.find((i) => i.id === 'date.reset')?.run();
    expect(updateCapture).toHaveBeenCalledWith('oct', { colour: null, icon: null });
  });

  it('a failed save shows the error in the note', async () => {
    vi.mocked(updateCapture).mockResolvedValueOnce('No space left.');
    const note = vi.fn();
    const host = { ...makeActionCtx({ manifest }).host, note };
    items('oct', { host })
      .find((i) => i.id === 'date.colour')
      ?.run('2');
    await vi.waitFor(() => {
      expect(note).toHaveBeenCalledWith('No space left.', true);
    });
  });

  it('Compare with lists the dates with their reasons', () => {
    const cmp = items('sep').find((i) => i.id === 'date.compare');
    expect(cmp?.sub.map((s) => [s.testId, s.disabled ?? false])).toEqual([
      ['compare-to-oct', false],
      ['compare-to-sep', expect.any(String)],
    ]);
  });

  it('Compare with needs two survey dates', () => {
    const one = { captures: captures.slice(0, 1), layers: [] } as unknown as ProjectManifest;
    expect(ids('sep', { manifest: one })).not.toContain('date-menu-compare');
  });

  it('Rename asks the surface to show the name field', () => {
    const renameDate = vi.fn();
    const host = { ...makeActionCtx({ manifest }).host, renameDate };
    items('sep', { host })
      .find((i) => i.id === 'date.rename')
      ?.run();
    expect(renameDate).toHaveBeenCalledWith('sep');
  });

  it('Show all and Hide all set the folder layers visible or hidden', () => {
    const setLayersVisible = vi.spyOn(workspace.getState(), 'setLayersVisible');
    const list = items('sep', { hidden: { a: true } });
    list.find((i) => i.id === 'date.show')?.run();
    expect(setLayersVisible).toHaveBeenLastCalledWith(['a', 'b'], true);
    list.find((i) => i.id === 'date.hide')?.run();
    expect(setLayersVisible).toHaveBeenLastCalledWith(['a', 'b'], false);
    setLayersVisible.mockRestore();
  });

  it('Delete asks the shared removal dialog for the date', () => {
    items('sep')
      .find((i) => i.id === 'date.delete')
      ?.run();
    expect(askRemove).toHaveBeenCalledWith([{ capture: 'sep' }]);
  });

  it('Add data to this date runs the same import as Add data', async () => {
    const pick = vi.spyOn(builder.getState(), 'pickAndImport').mockResolvedValue();
    items('sep')
      .find((i) => i.id === 'date.addData')
      ?.run();
    await vi.waitFor(() => {
      expect(pick).toHaveBeenCalledOnce();
    });
    pick.mockRestore();
  });

  it('Zoom to and Export run the dataset flows on the folder, basemaps left out', async () => {
    const withLayers = {
      captures,
      layers: [
        { kind: 'mesh', id: 'a', name: 'A', visible: true },
        { kind: 'basemap', id: 'b', name: 'Streets', visible: true },
      ],
    } as unknown as ProjectManifest;
    const list = items('sep', { manifest: withLayers });
    list.find((i) => i.id === 'date.zoomTo')?.run();
    list.find((i) => i.id === 'date.export')?.run();
    await vi.waitFor(() => {
      expect(zoomToLayers).toHaveBeenCalledWith(['a'], expect.any(Function));
      expect(exportLayersFlow).toHaveBeenCalledWith(['a']);
    });
  });
});
