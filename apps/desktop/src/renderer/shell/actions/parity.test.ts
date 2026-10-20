// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { actionsFor, makeActionCtx, NO_HOST, type MenuTarget } from '@aio/ui';
import { dateTags, workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../removal', () => ({ askRemove: vi.fn() }));
vi.mock('../dateFolders', () => ({
  updateCapture: vi.fn(() => Promise.resolve(null)),
  moveLayersToDate: vi.fn(),
}));
vi.mock('../../workspace/compareWith', () => ({
  COMPARE_WITH_ACTIONS: [],
  compareWith: vi.fn(),
  compareTargets: vi.fn(() => [
    { capture: 'oct', reason: null },
    { capture: 'sep', reason: null },
  ]),
}));
vi.mock('../../builder/alignSession', () => ({
  alignTo: { getState: () => ({ alignTo: vi.fn() }) },
  alignCamera: { getState: () => ({ start: vi.fn() }) },
}));

vi.mock('../../builder/dropSession', () => ({
  dropToGround: { getState: () => ({ drop: vi.fn() }) },
}));

const { registerDateActions } = await import('./dateActions');
const { registerLayerActions } = await import('./layerActions');
const { registerKindActions } = await import('./kindActions');
const { cleanup } = await import('../../pointcloud/cleanupStore');

/**
 * Parity with the menus before the shared registry (the old LayerDateMenu and DateFolderMenu in
 * DateMenus.tsx, with the cleanup, Place model and engineering items the sidebar passed in): every
 * item they offered, by test id, is still offered for the same kind of target.
 */
const captures = [
  { id: 'sep', label: 'Survey', date: '2024-09-04', colour: 3, icon: 'flag' },
  { id: 'oct', label: 'Baseline', date: '2024-10-02' },
];
const L = (o: Record<string, unknown>) => ({ visible: true, ...o });
const manifest = {
  captures,
  layers: [
    L({ kind: 'pointcloud', id: 'cloud', name: 'Cloud', format: 'copc', capture: 'oct' }),
    L({ kind: 'mesh', id: 'mesh', name: 'Model', capture: 'oct' }),
    L({ kind: 'photos', id: 'set', name: 'Set', capture: 'oct', items: [{ id: 'a' }] }),
    L({ kind: 'vector', id: 'v', name: 'Outline', capture: 'oct', format: 'geojson' }),
  ],
} as unknown as ProjectManifest;

let offs: (() => void)[] = [];
beforeEach(() => {
  offs = [registerDateActions(), registerLayerActions(), registerKindActions()];
  workspace.setState({ project: { id: 'p', root: 'C:/p', manifest } } as unknown as Partial<
    ReturnType<typeof workspace.getState>
  >);
});
afterEach(() => {
  for (const off of offs) off();
});

/** Every test id a menu offers, its pick lists included. */
function offered(target: MenuTarget): string[] {
  const c = makeActionCtx({
    manifest,
    tags: dateTags(captures),
    folderLayers: { sep: ['cloud', 'v'], oct: ['mesh'] },
    host: { ...NO_HOST, from: 'oct' },
  });
  return actionsFor(target, c)
    .flatMap((i) => [i.testId, ...i.sub.map((s) => s.testId)])
    .filter((id): id is string => id !== undefined);
}

const dateIds = [
  'date-menu-view',
  'date-menu-toggle',
  'date-menu-show',
  'date-menu-hide',
  'date-menu-compare',
  'compare-to-oct',
  'date-menu-rename',
  'date-menu-colour-1',
  'date-menu-colour-6',
  'date-menu-icon-none',
  'date-menu-icon-flag',
  'date-menu-reset',
  'date-menu-delete',
];

describe('menu parity with the menus before the registry', () => {
  it('a survey date folder still offers every item the old folder menu had', () => {
    const got = offered({ kind: 'date', captureId: 'sep' });
    for (const id of dateIds) expect(got, id).toContain(id);
  });

  it('a dataset row still offers File under, Compare and Delete (multi-select too)', () => {
    for (const layerIds of [['v'], ['v', 'mesh']]) {
      const got = offered({ kind: 'layers', layerIds });
      for (const id of [
        'move-to-every',
        'move-to-sep',
        'move-to-oct',
        'move-compare',
        'compare-to-oct',
        'menu-delete',
      ]) {
        expect(got, `${layerIds.join('+')} ${id}`).toContain(id);
      }
    }
  });

  it('a COPC point cloud still offers the cleanup items and Create engineering model', () => {
    const got = offered({ kind: 'layers', layerIds: ['cloud'] });
    for (const id of [
      'menu-pointcloud-cleanup',
      'menu-pointcloud-removeNoise',
      'menu-pointcloud-saveCleaned',
      'menu-create-engineering',
    ]) {
      expect(got, id).toContain(id);
    }
  });

  it('Reset cleanup still appears only once a cleanup recipe exists', () => {
    const target: MenuTarget = { kind: 'layers', layerIds: ['cloud'] };
    expect(offered(target)).not.toContain('menu-pointcloud-resetCleanup');
    const before = cleanup.store.getState().layers;
    cleanup.store.setState({ layers: { ...before, cloud: { present: {} } } } as never);
    try {
      expect(offered(target)).toContain('menu-pointcloud-resetCleanup');
    } finally {
      cleanup.store.setState({ layers: before });
    }
  });

  it('a png-packed cloud does not offer cleanup, and a read-only project greys the edits', () => {
    const png = {
      ...manifest,
      layers: [L({ kind: 'pointcloud', id: 'cloud', name: 'Cloud', format: 'png-packed' })],
    } as unknown as ProjectManifest;
    const cloud: MenuTarget = { kind: 'layers', layerIds: ['cloud'] };
    expect(
      actionsFor(cloud, makeActionCtx({ manifest: png })).filter((i) =>
        i.id.startsWith('pointcloud.'),
      ),
    ).toEqual([]);
    const ro = actionsFor(cloud, makeActionCtx({ manifest, canEdit: false }));
    const why = (id: string) => ro.find((i) => i.id === id)?.disabled;
    expect(why('pointcloud.cleanup')).toBe(false);
    expect(why('pointcloud.removeNoise')).toBeTruthy();
    expect(why('pointcloud.saveCleaned')).toBeTruthy();
  });

  it('a model row still offers Place model and Create engineering model', () => {
    const got = offered({ kind: 'layers', layerIds: ['mesh'] });
    expect(got).toContain('menu-place-model');
    expect(got).toContain('menu-create-engineering');
  });

  it('a photos row still offers Create engineering model', () => {
    expect(offered({ kind: 'layers', layerIds: ['set'] })).toContain('menu-create-engineering');
  });
});

describe('measurement items', () => {
  it('actions appear in the measurement menu and the card overflow', async () => {
    const { registerMeasureActions } = await import('./measureActions');
    const { registerReportActions } = await import('./reportActions');
    const { measureStore } = await import('../../survey/measureStore');
    const { emptyMeasurements } = await import('@aio/schema');
    const line = {
      id: 'm1',
      family: 'line' as const,
      tool: 'distance' as const,
      label: 'Line',
      scope: { kind: 'site' as const },
      items: [],
      results: [],
      points: [
        [0, 0, 0],
        [3, 4, 0],
      ] as [number, number, number][],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    measureStore.setState({
      file: { ...emptyMeasurements(), measurements: [line, { ...line, id: 'm2' }] },
    });
    const more = [registerMeasureActions(), registerReportActions()];
    try {
      // the Datasets row and the card's "⋯" ask the registry for the same target
      const one = offered({ kind: 'measurements', ids: ['m1'], clicked: 'm1' });
      for (const id of [
        'ctx-item-measure.addToReport',
        'ctx-item-measure.export',
        'measure-export-csv',
        'measure-export-dxf',
        'measure-export-png',
      ])
        expect(one, id).toContain(id);
      // several marked: Add to report takes them all; Export acts on one
      const two = offered({ kind: 'measurements', ids: ['m1', 'm2'], clicked: 'm1' });
      expect(two).toContain('ctx-item-measure.addToReport');
      expect(two).not.toContain('ctx-item-measure.export');
    } finally {
      for (const off of more) off();
    }
  });

  it('a dataset row offers no measurement items', () => {
    expect(
      offered({ kind: 'layers', layerIds: ['v'] }).some((id) => id.startsWith('ctx-item-measure.')),
    ).toBe(false);
  });
});
