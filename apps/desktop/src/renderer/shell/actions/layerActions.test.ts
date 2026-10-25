// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { actionsFor, makeActionCtx, NO_HOST } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { builder } from '../../builder/state';
import { toasts } from '../../exports/exports';
import { bridge } from '../../shell';
import { askRemove } from '../removal';
import { renameRequest } from '../renameRequest';
import { commitLayerRename, registerLayerActions } from './layerActions';

vi.mock('../removal', () => ({ askRemove: vi.fn() }));
vi.mock('../../workspace/compareWith', () => ({
  COMPARE_WITH_ACTIONS: [],
  compareWith: vi.fn(),
  compareTargets: vi.fn(() => []),
}));

const manifest = {
  captures: [
    { id: 'sep', label: 'Survey', date: '2024-09-04' },
    { id: 'oct', label: 'Oct', date: '2024-10-02' },
  ],
  layers: [
    {
      kind: 'mesh',
      id: 'quad-sep',
      name: 'Quad 2024-09-04',
      visible: true,
      src: { path: 'm.glb' },
      transform: [],
    },
    {
      kind: 'vector',
      id: 'v',
      name: 'Outline',
      visible: true,
      capture: 'oct',
      src: { path: 'v.geojson' },
      format: 'geojson',
    },
    { kind: 'basemap', id: 'bm', name: 'Streets', visible: true, pack: 'p', style: 'dark' },
  ],
} as unknown as ProjectManifest;
let off: () => void;
beforeEach(() => {
  off = registerLayerActions();
  workspace.setState({ project: { id: 'p', root: 'C:/p', manifest } } as unknown as Partial<
    ReturnType<typeof workspace.getState>
  >);
});
afterEach(() => {
  off();
});
const items = (layerIds: string[], over = {}) =>
  actionsFor({ kind: 'layers', layerIds }, makeActionCtx({ manifest, ...over }));

describe('dataset actions', () => {
  it('every row gets Show or Hide, Zoom to, Rename, File under, Compare, Export, Reveal, Properties, Delete', () => {
    expect(items(['v'], { host: { ...NO_HOST, from: 'oct' } }).map((i) => i.id)).toEqual([
      'layer.hide',
      'layer.zoomTo',
      'layer.rename',
      'layer.moveToDate',
      'layer.compare',
      'layer.export',
      'layer.reveal',
      'layer.properties',
      'layer.delete',
    ]);
  });

  it('a hidden row offers Show', () => {
    expect(items(['v'], { hidden: { v: true } })[0]?.id).toBe('layer.show');
  });

  it('a basemap offers Show or Hide and Properties only', () => {
    expect(items(['bm']).map((i) => i.id)).toEqual(['layer.hide', 'layer.properties']);
  });

  it('marked rows get only the multi actions, and Compare is greyed across dates', () => {
    const many = items(['quad-sep', 'v']);
    expect(many.map((i) => i.id)).toEqual([
      'layer.hide',
      'layer.zoomTo',
      'layer.moveToDate',
      'layer.compare',
      'layer.export',
      'layer.delete',
    ]);
    expect(many.find((i) => i.id === 'layer.compare')?.disabled).toBe(
      'These datasets are on different survey dates.',
    );
  });

  it('a basemap among the marked rows drops the actions it cannot take part in', () => {
    expect(items(['v', 'bm']).map((i) => i.id)).toEqual(['layer.hide', 'layer.delete']);
  });

  it('Delete on marked rows counts and deletes only the deletable ones, like the header', () => {
    vi.mocked(askRemove).mockClear();
    const del = items(['v', 'bm']).find((i) => i.id === 'layer.delete');
    expect(del?.label).toBe('Delete 1 dataset…');
    expect(items(['v', 'quad-sep']).find((i) => i.id === 'layer.delete')?.label).toBe(
      'Delete 2 datasets…',
    );
    expect(items(['v']).find((i) => i.id === 'layer.delete')?.label).toBe('Delete…');
    del?.run();
    expect(askRemove).toHaveBeenCalledWith([{ layer: 'v' }]);
  });

  it('a package greys Export and Reveal, a read-only project greys Delete and File under', () => {
    const pkg = items(['v'], { pkg: true, canEdit: false });
    const why = (id: string) => pkg.find((i) => i.id === id)?.disabled;
    expect(why('layer.export')).toBe('This is a package: its files stay inside it.');
    expect(why('layer.reveal')).toBe('This is a package: its files stay inside it.');
    expect(why('layer.delete')).toBe('This project can only be viewed.');
    expect(why('layer.moveToDate')).toBe('This project can only be viewed.');
  });

  it('File under lists every date, newest first, the current folder greyed', () => {
    const move = items(['v'], { host: { ...NO_HOST, from: 'oct' } }).find(
      (i) => i.id === 'layer.moveToDate',
    );
    expect(move?.present).toBe('inline');
    // its own group: never glued to Rename above or Compare with another date below
    expect(move?.section).toBe('date');
    const order = items(['v']).map((i) => i.id);
    expect(order.indexOf('layer.moveToDate')).toBeGreaterThan(order.indexOf('layer.rename'));
    expect(order.indexOf('layer.moveToDate')).toBeLessThan(order.indexOf('layer.compare'));
    expect(move?.sub.map((s) => [s.testId, Boolean(s.disabled)])).toEqual([
      ['move-to-every', false],
      ['move-to-oct', true],
      ['move-to-sep', false],
    ]);
  });

  it('File under greys the current folder with a reason, not its own name again', () => {
    for (const from of ['oct', 'every']) {
      const move = items(['v'], { host: { ...NO_HOST, from } }).find(
        (i) => i.id === 'layer.moveToDate',
      );
      const current = move?.sub.find((s) => s.checked);
      expect(current?.disabled).toBe('Filed here now');
      expect(current?.disabled).not.toBe(current?.label);
    }
  });

  it('File under sends the layers to the picked date, or to none', () => {
    const moveLayers = vi.fn();
    const move = items(['v'], { host: { ...NO_HOST, from: 'oct', moveLayers } }).find(
      (i) => i.id === 'layer.moveToDate',
    );
    move?.run('sep');
    move?.run('every');
    expect(moveLayers.mock.calls).toEqual([
      [['v'], 'sep'],
      [['v'], null],
    ]);
  });

  it('Rename asks the sidebar for the field and shows F2; a read-only project greys it', () => {
    expect(items(['v']).find((i) => i.id === 'layer.rename')?.shortcut).toBe('F2');
    items(['v'])
      .find((i) => i.id === 'layer.rename')
      ?.run();
    expect(renameRequest.getState().layerId).toBe('v');
    expect(items(['v'], { canEdit: false }).find((i) => i.id === 'layer.rename')?.disabled).toBe(
      'This project can only be viewed.',
    );
  });

  it('Delete goes through the shared removal dialog with the deletable layers', () => {
    items(['v'])
      .find((i) => i.id === 'layer.delete')
      ?.run();
    expect(askRemove).toHaveBeenCalledWith([{ layer: 'v' }]);
  });

  it('commitLayerRename pins the date a name gave before renaming', async () => {
    const save = vi.spyOn(builder.getState(), 'saveLayers').mockResolvedValue(null);
    expect(await commitLayerRename('quad-sep', 'Quad')).toBeNull();
    expect(save.mock.calls).toEqual([
      [['quad-sep'], { capture: 'sep' }],
      [['quad-sep'], { name: 'Quad' }],
    ]);
    save.mockClear();
    await commitLayerRename('v', 'Site outline');
    expect(save.mock.calls).toEqual([[['v'], { name: 'Site outline' }]]);
  });

  describe('Export', () => {
    let sent: [string, unknown][] = [];
    let spy: { mockRestore(): void } | null = null;
    afterEach(() => {
      spy?.mockRestore();
    });
    const reply = (picked: string | null, exported?: unknown) => {
      sent = [];
      spy = vi.spyOn(bridge, 'call').mockImplementation(((channel: string, req: unknown) => {
        sent.push([channel, req]);
        return Promise.resolve(
          channel === 'dialog:openFolder'
            ? { ok: true, value: { path: picked } }
            : { ok: true, value: exported },
        );
      }) as unknown as typeof bridge.call);
    };
    const run = async () => {
      items(['v'])
        .find((i) => i.id === 'layer.export')
        ?.run();
      await new Promise((r) => setTimeout(r, 20));
    };

    it('exports into the picked folder and reports the layers it skipped', async () => {
      reply('C:/out', { ok: true, written: 1, skipped: ['Old'], cancelled: false });
      await run();
      const exp = sent.find((c) => c[0] === 'layer:export');
      expect(exp?.[1]).toMatchObject({ projectId: 'p', layerIds: ['v'], dir: 'C:/out' });
      const last = toasts.getState().toasts.at(-1);
      expect(last?.state).toBe('done');
      expect(last?.message).toContain('Old');
    });

    it('does nothing when the folder picker is cancelled', async () => {
      reply(null);
      await run();
      expect(sent.map((c) => c[0])).toEqual(['dialog:openFolder']);
    });
  });
});
