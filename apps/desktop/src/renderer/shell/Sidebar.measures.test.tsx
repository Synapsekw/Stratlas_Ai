// @vitest-environment jsdom
import {
  emptyMeasurements,
  type ComparisonResult,
  type HeightTiles,
  type JobRecord,
  ProjectManifest,
  type RemoveTarget,
  type SitePoint,
  type SurveyMeasurement,
} from '@aio/schema';
import { formatDate } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { stageShow } from '../workspace/StageShow';
import { timeline } from '../workspace/timeline';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const lookOnly = vi.hoisted(() => ({ on: false }));
const prepare = vi.hoisted(() => ({ fn: vi.fn<() => Promise<string | null>>() }));
vi.mock('../survey/compareStore', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  prepareSurfaces: () => prepare.fn(),
}));
// the fixture's piles carry their figures but no prepared surfaces, so the inventory's own rule
// would count none of them; these tests are about the rows, so every figure counts here
vi.mock('../survey/useInventory', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useCounted: () => () => true,
}));
vi.mock('@aio/annotate', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAnnotateReadOnly: () => lookOnly.on,
  isAnnotateReadOnly: () => lookOnly.on,
}));

import { jobs, shell } from '../shell';
import { preparedSurfaces } from '../survey/surfaceStates';
import {
  askNewFolder,
  deleteMeasurements,
  isDirty,
  renameMeasurement,
  revertMeasurements,
  measureStore,
  replaceMeasurements,
  revealMeasurement,
  select,
  setMeasureNote,
  setMeasureVisibilityMemory,
  undoDeleteMeasurements,
} from '../survey/measureStore';
import { createMeasureVisibilityMemory } from '../survey/measureVisibility';
import { removal } from './removal';
import { renameRequest } from './renameRequest';
import { MeasureMenu } from '../survey/MeasureMenu';
import { Sidebar } from './Sidebar';

const mesh = {
  kind: 'mesh',
  id: 'mesh',
  name: 'Site model',
  visible: true,
  src: { path: 'models/site.glb' },
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
};
const project = (captures: unknown[], layers: unknown[]) =>
  ProjectManifest.parse({
    schema: 'aio.project/1',
    id: 'p',
    name: 'P',
    crs: { epsg: 32633 },
    origin: [500000, 4500000, 0],
    captures,
    layers,
    severityModels: [],
    classCatalogues: [],
  });
const plain = project([], [mesh]);
// survey dates on: two captures, the model filed under the first
const dated = project(
  [
    { id: 'c1', label: 'Survey', date: '2026-10-12' },
    { id: 'c2', label: 'Survey', date: '2026-10-14' },
  ],
  [{ ...mesh, capture: 'c1' }],
);

const measurement = (id: string, folder?: string) => ({
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
});

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
  } as unknown as Storage;
}

let host: HTMLDivElement;
let root: Root | undefined;
const asked: RemoveTarget[][] = [];

function render(m: ProjectManifest = plain) {
  workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest: m });
  removal.setState({
    trash: null,
    held: 0,
    loadTrash: () => Promise.resolve(),
    ask: (targets) => {
      asked.push(targets);
      return Promise.resolve();
    },
  });
  act(() => {
    root = createRoot(host);
    root.render(<Sidebar />);
  });
}

const q = (sel: string) => document.body.querySelector<HTMLElement>(sel);
const qa = (sel: string) => [...document.body.querySelectorAll<HTMLElement>(sel)];
const row = (id: string) => q(`[data-testid="measure-row"][data-id="${id}"]`);
const name = (id: string) => row(id)?.querySelector<HTMLElement>('.tn') ?? null;
const layerRow = (id: string) => q(`[data-testid="tree-row-${id}"]`);
const groupOrder = () =>
  qa('.tgroup-row').map((el) => el.dataset.testid?.slice('tree-group-'.length));
const fire = (el: Element | null, e: Event) => {
  if (!el) throw new Error('no element');
  act(() => {
    el.dispatchEvent(e);
  });
  return e;
};
const click = (el: Element | null, init: MouseEventInit = {}) =>
  fire(el, new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
const ctrlClick = (el: Element | null) => click(el, { ctrlKey: true });
const contextMenu = (el: Element | null) =>
  fire(
    el,
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
  );
const keyDown = (el: Element | null, key: string, init: KeyboardEventInit = {}) =>
  fire(el, new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
const type = (el: HTMLElement | null, text: string) => {
  if (!(el instanceof HTMLInputElement)) throw new Error('no field');
  el.value = text;
};
const measures = () => measureStore.getState().file.measurements;
const labelOf = (id: string) => measures().find((m) => m.id === id)?.label;
const folderOf = (id: string) => measures().find((m) => m.id === id)?.folder;

beforeEach(() => {
  asked.length = 0;
  lookOnly.on = false;
  setMeasureVisibilityMemory(createMeasureVisibilityMemory(memoryStorage()));
  const file = {
    ...emptyMeasurements(),
    measurements: [measurement('a', 'Fence'), measurement('b', 'Fence'), measurement('c')],
  };
  measureStore.setState({
    projectId: 'p',
    status: 'ready',
    readOnly: false,
    file,
    savedText: JSON.stringify(file),
    selected: [],
    focus: null,
    editing: null,
    hiddenMeasurements: [],
    reveal: null,
    newFolder: null,
  });
  renameRequest.getState().done();
  shell.setState({
    pkg: null,
    screen: 'scene',
    settings: { ...shell.getState().settings, sidebarCollapsed: false },
  });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  workspace.getState().closeProject();
  host.remove();
});

describe('Datasets: measurements', () => {
  it('lists measurements after the maps, hides from the eye without marking the file unsaved', () => {
    render();
    expect(groupOrder()).toEqual(['models', 'measurements']);
    // the group starts open
    expect(qa('[data-testid="measure-row"]')).toHaveLength(3);
    click(row('a')?.querySelector('[data-testid="measure-row-eye"]') ?? null);
    expect(measureStore.getState().hiddenMeasurements).toEqual(['a']);
    expect(isDirty(measureStore.getState())).toBe(false);
  });

  it('a plain click selects the measurement for the Selected panel', () => {
    render();
    click(name('c'));
    expect(measureStore.getState().focus).toBe('c');
    expect(measureStore.getState().selected).toEqual(['c']);
  });

  it('right-click on a marked row acts on every marked measurement', () => {
    render();
    ctrlClick(name('a'));
    ctrlClick(name('c'));
    expect(measureStore.getState().selected).toEqual(['a', 'c']);
    contextMenu(row('c'));
    expect(q('[data-testid="measure-menu"]')?.textContent).toContain('2 measurements');
  });

  it('marks that no longer hold a measurement let go of the measurement selection', () => {
    render();
    const mesh = () => layerRow('mesh')?.querySelector('.tn') ?? null;
    ctrlClick(mesh());
    click(name('c'), { shiftKey: true });
    expect(measureStore.getState().selected).toEqual(['a', 'b', 'c']);
    // the range shrinks back to the model alone
    click(mesh(), { shiftKey: true });
    expect(measureStore.getState().selected).toEqual([]);
  });

  it('Escape lets go of the marked measurements’ selection', () => {
    render();
    ctrlClick(name('a'));
    ctrlClick(name('b'));
    measureStore.setState({ focus: null });
    keyDown(row('b'), 'Escape');
    expect(measureStore.getState().selected).toEqual([]);
  });

  it('a plain click on a layer row lets go of the marked measurements’ selection too', () => {
    render();
    ctrlClick(name('a'));
    ctrlClick(name('b'));
    measureStore.setState({ focus: null });
    click(layerRow('mesh')?.querySelector('.tn') ?? null);
    expect(row('a')?.classList.contains('marked')).toBe(false);
    expect(measureStore.getState().selected).toEqual([]);
  });

  it('marking only layers leaves the measurement selection alone', () => {
    render();
    click(name('c'));
    ctrlClick(layerRow('mesh')?.querySelector('.tn') ?? null);
    keyDown(layerRow('mesh'), 'Escape');
    expect(measureStore.getState().selected).toEqual(['c']);
  });

  it('mixed marks: a layer row menu acts on layers only, the header asks for the layers first', () => {
    render();
    ctrlClick(layerRow('mesh')?.querySelector('.tn') ?? null);
    ctrlClick(name('a'));
    contextMenu(layerRow('mesh'));
    expect(q('[data-testid="move-menu"]')).not.toBeNull();
    expect(q('[data-testid="move-menu"]')?.textContent).not.toContain('2 datasets');
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    click(q('[data-testid="tree-marked-delete"]'));
    // the dialog may be cancelled: nothing is deleted before it is confirmed, the
    // measurement stays marked for a second Delete
    expect(measures().map((m) => m.id)).toContain('a');
    expect(asked).toEqual([[{ layer: 'mesh' }]]);
    expect(row('a')?.classList.contains('marked')).toBe(true);
    // confirmed: the model goes, the measurement is still marked and deletes on its own
    act(() => {
      removal.setState((s) => ({ removed: s.removed + 1 }));
    });
    expect(row('a')?.classList.contains('marked')).toBe(true);
    asked.length = 0;
    click(q('[data-testid="tree-marked-delete"]'));
    expect(measures().map((m) => m.id)).not.toContain('a');
    expect(asked).toEqual([]);
  });

  it('the Delete key deletes the marked measurements, or the focused one', () => {
    render();
    ctrlClick(name('a'));
    keyDown(row('a'), 'Delete');
    expect(measures().map((m) => m.id)).toEqual(['b', 'c']);
    expect(asked).toEqual([]);
    const del = keyDown(row('c'), 'Delete');
    expect(del.defaultPrevented).toBe(true);
    expect(measures().map((m) => m.id)).toEqual(['b']);
    // a stray Delete is taken back with the notice's Undo
    act(() => {
      undoDeleteMeasurements();
    });
    expect(measures().map((m) => m.id)).toEqual(['b', 'c']);
  });

  it('Delete from the menu lets go of the deleted marks: no stuck header, no ghost count', () => {
    render();
    ctrlClick(name('a'));
    ctrlClick(name('c'));
    expect(q('[data-testid="tree-marked-delete"]')).not.toBeNull();
    contextMenu(row('c'));
    click(q('[data-testid="ctx-item-measure.delete"]'));
    expect(measures().map((m) => m.id)).toEqual(['b']);
    expect(q('[data-testid="tree-marked-delete"]')).toBeNull();
    ctrlClick(name('b'));
    contextMenu(row('b'));
    expect(q('[data-testid="measure-menu"]')?.textContent).not.toContain('measurements');
    expect(q('[data-testid="ctx-item-measure.delete"]')?.textContent).toBe('Delete');
  });

  it('a measurement deleted elsewhere (3D, map, the panel) drops out of the marks', () => {
    render();
    ctrlClick(name('a'));
    ctrlClick(name('b'));
    act(() => {
      deleteMeasurements(['a', 'b']);
    });
    expect(q('[data-testid="tree-marked-delete"]')).toBeNull();
  });

  it.each([
    ['survey dates off', plain],
    ['survey dates on', dated],
  ])('right-click on the Measurements heading or a folder opens no menu (%s)', (_, m) => {
    render(m);
    for (const el of [
      q('[data-testid="tree-group-measurements"]'),
      q('[data-testid="measure-folder"][data-folder="Fence"]'),
    ]) {
      expect(contextMenu(el).defaultPrevented).toBe(true);
      expect(q('[data-testid="ctx-menu"]')).toBeNull();
      expect(q('[data-testid="move-menu"]')).toBeNull();
    }
  });

  it('Shift+F10 on a measurement row’s eye opens that measurement’s menu', () => {
    render();
    keyDown(row('c')?.querySelector('[data-testid="measure-row-eye"]') ?? null, 'F10', {
      shiftKey: true,
    });
    expect(q('[data-testid="measure-menu"]')).not.toBeNull();
    expect(q('[data-testid="ctx-menu"]')).toBeNull();
  });

  it('Rename from the menu turns the row into a 200 character field', () => {
    render();
    contextMenu(row('a'));
    click(q('[data-testid="ctx-item-measure.rename"]'));
    const field = q('[data-testid="measure-rename"]');
    expect(field).toBeInstanceOf(HTMLInputElement);
    expect((field as HTMLInputElement).maxLength).toBe(200);
    type(field, 'Fence post');
    keyDown(field, 'Enter');
    expect(labelOf('a')).toBe('Fence post');
    expect(q('[data-testid="measure-rename"]')).toBeNull();
  });

  it('New folder asks in the tree and moves the measurements into it', () => {
    render();
    act(() => {
      askNewFolder(['c']);
    });
    type(q('[data-testid="measure-folder-new"]'), 'Kerbs');
    keyDown(q('[data-testid="measure-folder-new"]'), 'Enter');
    expect(folderOf('c')).toBe('Kerbs');
    expect(q('[data-testid="measure-folder"][data-folder="Kerbs"]')).not.toBeNull();
    expect(measureStore.getState().newFolder).toBeNull();
  });

  it('with survey dates on, the group shows once below the date folders', () => {
    render(dated);
    expect(q('[data-testid="date-folder-c1"]')).not.toBeNull();
    expect(qa('[data-testid="measure-row"]')).toHaveLength(3);
    expect(qa('[data-testid="tree-group-measurements"]')).toHaveLength(1);
  });

  it.each([
    ['survey dates off', plain],
    ['survey dates on', dated],
  ])('a reveal opens a folded sidebar and scrolls to the row (%s)', (_, m) => {
    const scrolled: Element[] = [];
    const proto = Element.prototype as { scrollIntoView?: () => void };
    proto.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      shell.setState({ settings: { ...shell.getState().settings, sidebarCollapsed: true } });
      render(m);
      act(() => {
        revealMeasurement('b');
      });
      expect(shell.getState().settings.sidebarCollapsed).toBe(false);
      expect(scrolled).toContain(row('b'));
    } finally {
      delete proto.scrollIntoView;
    }
  });

  it('finishing a shape does not open a folded sidebar', () => {
    shell.setState({ settings: { ...shell.getState().settings, sidebarCollapsed: true } });
    render();
    act(() => {
      revealMeasurement('b', { openSidebar: false });
    });
    expect(shell.getState().settings.sidebarCollapsed).toBe(true);
  });

  it('a read-only package shows the rows and eyes, and no rename field', () => {
    render();
    act(() => {
      measureStore.setState({ readOnly: true });
    });
    expect(qa('[data-testid="measure-row-eye"]')).toHaveLength(3);
    keyDown(row('a'), 'F2');
    expect(q('[data-testid="measure-rename"]')).toBeNull();
    // the Delete key leaves a read-only file alone
    keyDown(row('a'), 'Delete');
    expect(measures()).toHaveLength(3);
  });
});

describe('Datasets: the measurement filter', () => {
  const box = () => q('[data-testid="measure-filter"]');
  const filter = (text: string) => {
    const el = box();
    if (!(el instanceof HTMLInputElement)) throw new Error('no filter box');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const shown = () => qa('[data-testid="measure-row"]').map((el) => el.dataset.id);
  const count = () => q('[data-testid="tree-group-measurements"] .gcount')?.textContent;

  it.each([
    ['survey dates off', plain],
    ['survey dates on', dated],
  ])('shows only the matches; the eye still covers all; clearing brings all back (%s)', (_, m) => {
    render(m);
    filter('fence');
    expect(shown()).toEqual(['a', 'b']);
    expect(count()).toBe('2 of 3');
    click(q('[data-testid="tree-group-measurements"] > .eye'));
    expect(measureStore.getState().hiddenMeasurements).toEqual(['a', 'b', 'c']);
    filter('nothing here');
    expect(shown()).toEqual([]);
    expect(q('[data-testid="measure-filter-none"]')?.textContent).toBe('No measurements match');
    click(q('[data-testid="measure-filter-clear"]'));
    expect(shown()).toEqual(['a', 'b', 'c']);
    expect(count()).toBe('3');
  });

  it('a mark the filter hides stays, but the menu, the header and Delete act on the rows in view', () => {
    render();
    ctrlClick(name('a'));
    ctrlClick(name('b'));
    ctrlClick(name('c'));
    filter('fence');
    const header = () => q('[data-testid="tree-marked-delete"]');
    expect(header()?.textContent).toContain('2 selected');
    contextMenu(row('a'));
    expect(q('[data-testid="measure-menu"]')?.textContent).toContain('2 measurements');
    keyDown(q('[data-testid="measure-menu"]'), 'Escape');
    // clearing the filter brings the whole multi-selection back
    filter('');
    expect(row('c')?.classList.contains('marked')).toBe(true);
    expect(header()?.textContent).toContain('3 selected');
    filter('fence');
    keyDown(row('a'), 'Delete');
    expect(measures().map((x) => x.id)).toEqual(['c']);
  });

  it('the selection follows the marks in view: the panel, and the 3D menu, leave hidden ones', () => {
    render();
    ctrlClick(name('a'));
    ctrlClick(name('b'));
    ctrlClick(name('c'));
    expect(measureStore.getState().selected).toEqual(['a', 'b', 'c']);
    filter('fence');
    // the Selected panel totals what the store selects: the marks in view only
    expect(measureStore.getState().selected).toEqual(['a', 'b']);
    // the 3D view's right-click menu on a marked shape acts on the same rows
    const menu = (at: { x: number; y: number; id: string; projectId: string } | null) => {
      act(() => {
        root?.render(
          <>
            <Sidebar />
            <MeasureMenu at={at} onClose={() => undefined} />
          </>,
        );
      });
    };
    menu({ x: 40, y: 50, id: 'a', projectId: 'p' });
    expect(q('[data-testid="measure-menu"]')?.textContent).toContain('2 measurements');
    click(q('[data-testid="ctx-item-measure.delete"]'));
    expect(measures().map((x) => x.id)).toEqual(['c']);
    menu(null);
  });

  it('a mark made under the filter does not select the hidden ones; clearing selects them again', () => {
    render();
    ctrlClick(name('a'));
    ctrlClick(name('c'));
    filter('fence');
    expect(measureStore.getState().selected).toEqual(['a']);
    ctrlClick(name('b'));
    expect(measureStore.getState().selected).toEqual(['a', 'b']);
    filter('nothing here');
    expect(measureStore.getState().selected).toEqual([]);
    filter('');
    expect([...measureStore.getState().selected].sort()).toEqual(['a', 'b', 'c']);
  });

  it('a 3D pick of a marked shape the filter hides selects that shape only', () => {
    render();
    ctrlClick(name('a'));
    ctrlClick(name('b'));
    ctrlClick(name('c'));
    filter('fence');
    // what the 3D view's pick does: select the shape, reveal its row (which clears the filter)
    act(() => {
      select(['c'], 'c');
      revealMeasurement('c');
    });
    expect((box() as HTMLInputElement).value).toBe('');
    expect(measureStore.getState().selected).toEqual(['c']);
  });

  it('a pick of a visible marked row survives clearing the filter and an eye toggle', () => {
    render();
    ctrlClick(name('a'));
    ctrlClick(name('b'));
    ctrlClick(name('c'));
    filter('fence');
    act(() => {
      select(['a'], 'a');
    });
    filter('');
    expect(measureStore.getState().selected).toEqual(['a']);
    filter('fence');
    click(q('[data-testid="tree-group-measurements"] > .eye'));
    expect(measureStore.getState().selected).toEqual(['a']);
  });

  it('a selection let go of (a click on empty space) stays empty through a filter change', () => {
    render();
    ctrlClick(name('a'));
    ctrlClick(name('b'));
    ctrlClick(name('c'));
    act(() => {
      select([]);
    });
    filter('fence');
    expect(measureStore.getState().selected).toEqual([]);
    filter('');
    expect(measureStore.getState().selected).toEqual([]);
  });

  it('a marked row deleted another way (the Selected panel) leaves the selection following the filter', () => {
    render();
    click(name('a'));
    ctrlClick(name('a'));
    ctrlClick(name('b'));
    ctrlClick(name('c'));
    // the Selected panel's Delete measurement takes the focused one only (the 3D and map menus
    // delete the same way)
    act(() => {
      deleteMeasurements(['a']);
    });
    expect(measureStore.getState().selected).toEqual(['b', 'c']);
    filter('fence');
    expect(measureStore.getState().selected).toEqual(['b']);
    filter('');
    expect(measureStore.getState().selected).toEqual(['b', 'c']);
  });

  it('marks in view all deleted, clearing the filter selects the hidden mark again', () => {
    render();
    ctrlClick(name('a'));
    ctrlClick(name('b'));
    ctrlClick(name('c'));
    filter('fence');
    keyDown(row('a'), 'Delete');
    expect(measures().map((x) => x.id)).toEqual(['c']);
    expect(measureStore.getState().selected).toEqual([]);
    filter('');
    expect(measureStore.getState().selected).toEqual(['c']);
  });

  it('an Undo that brings a deleted mark back selects it; the filter leaves that alone', () => {
    render();
    ctrlClick(name('a'));
    ctrlClick(name('b'));
    ctrlClick(name('c'));
    act(() => {
      deleteMeasurements(['a']);
    });
    act(() => {
      undoDeleteMeasurements();
    });
    expect(measureStore.getState().selected).toEqual(['a']);
    filter('fence');
    expect(measureStore.getState().selected).toEqual(['a']);
  });

  it('a Revert that lets go of the selection is not undone by the filter', () => {
    render();
    ctrlClick(name('a'));
    ctrlClick(name('b'));
    ctrlClick(name('c'));
    act(() => {
      deleteMeasurements(['a']);
    });
    act(() => {
      revertMeasurements();
    });
    expect(measureStore.getState().selected).toEqual([]);
    filter('fence');
    expect(measureStore.getState().selected).toEqual([]);
  });

  it('a first Ctrl+click focuses the measurement it selects', () => {
    render();
    ctrlClick(name('b'));
    expect(measureStore.getState().selected).toEqual(['b']);
    expect(measureStore.getState().focus).toBe('b');
  });

  it('the header Delete leaves a hidden marked row alone', () => {
    render();
    ctrlClick(name('a'));
    ctrlClick(name('c'));
    filter('fence');
    click(q('[data-testid="tree-marked-delete"]'));
    expect(measures().map((x) => x.id)).toEqual(['b', 'c']);
    filter('');
    expect(row('c')?.classList.contains('marked')).toBe(true);
  });

  it('a reveal of a measurement the filter hides clears the filter', () => {
    render();
    filter('fence');
    act(() => {
      revealMeasurement('a');
    });
    expect((box() as HTMLInputElement).value).toBe('fence');
    act(() => {
      revealMeasurement('c');
    });
    expect((box() as HTMLInputElement).value).toBe('');
    expect(row('c')).not.toBeNull();
  });

  it('another project starts with no filter', () => {
    render();
    filter('fence');
    act(() => {
      workspace.getState().openProject({ id: 'p2', root: 'C:/p2', manifest: plain });
    });
    expect((box() as HTMLInputElement).value).toBe('');
    expect(shown()).toEqual(['a', 'b', 'c']);
  });
});

describe('Datasets: measurements under survey dates', () => {
  const onDate = (id: string, capture: string, folder?: string): SurveyMeasurement => ({
    ...measurement(id, folder),
    scope: { kind: 'survey', capture },
  });
  const seed = (ms: SurveyMeasurement[]) => {
    const file = { ...emptyMeasurements(), measurements: ms };
    measureStore.setState({ file, savedText: JSON.stringify(file) });
  };
  const folderOfDate = (id: string) => q(`[data-testid="date-folder-${id}"]`);
  const openDate = (id: string) => {
    click(folderOfDate(id)?.querySelector('.dchev') ?? null);
  };
  const rowsIn = (el: Element | null) =>
    [...(el?.querySelectorAll<HTMLElement>('[data-testid="measure-row"]') ?? [])].map(
      (r) => r.dataset.id,
    );
  const needsGroup = () =>
    qa('[data-testid="tree-group-measurements"]').find((g) =>
      g.textContent.includes('Needs a date'),
    ) ?? null;

  it('a dated measurement is listed in its date folder, a legacy one under Needs a date', () => {
    seed([onDate('a', 'c1', 'Fence'), onDate('b', 'c2'), measurement('c')]);
    render(dated);
    openDate('c1');
    openDate('c2');
    expect(rowsIn(folderOfDate('c1'))).toEqual(['a']);
    expect(rowsIn(folderOfDate('c2'))).toEqual(['b']);
    // the date's folder row is that date's own
    expect(
      folderOfDate('c1')?.querySelector('[data-testid="measure-folder"][data-folder="Fence"]'),
    ).not.toBeNull();
    // the Every date folder holds none, and the one with no date sits below the dates
    expect(rowsIn(folderOfDate('every'))).toEqual([]);
    expect(needsGroup()).not.toBeNull();
    const all = qa('[data-testid="measure-row"]').map((r) => r.dataset.id);
    expect(all).toHaveLength(3);
    expect(all.at(-1)).toBe('c');
  });

  it('no Needs a date group when every measurement has a date', () => {
    seed([onDate('a', 'c1'), onDate('b', 'c2')]);
    render(dated);
    expect(needsGroup()).toBeNull();
  });

  // ---------------------------------------- Stockpiles (volumetrics redesign C3, spec section 5)

  const figure = (net: number, capture: string): ComparisonResult => ({
    item: 'i1',
    status: 'ok',
    cutM3: 0,
    fillM3: net,
    netM3: net,
    totalM3: net,
    areaM2: 100,
    areaCutM2: 0,
    areaFillM2: 0,
    areaUnchangedM2: 0,
    uncoveredM2: 0,
    fromLabel: 'Triangulated toe',
    toLabel: capture,
    toCapture: capture,
    deadbandM: 0,
    usedDeadband: false,
    cellM: 0.1,
    engine: 'ts',
    fingerprint: 'engine',
    computedAt: '2026-10-20T00:00:00.000Z',
  });
  /** A converted kit pile: site-scoped, its figure on both dates. */
  const kitPile = (n: number, c1: number, c2: number): SurveyMeasurement => ({
    ...measurement(`p${String(n)}`),
    family: 'polygon',
    tool: 'volume',
    label: `Pile ${String(n).padStart(2, '0')}`,
    points: [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
    ],
    items: [{ id: 'i1', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
    results: [figure(c2, 'c2')],
    series: [figure(c1, 'c1'), figure(c2, 'c2')],
    origin: { kind: 'kit-pile', pile: `P${String(n)}` },
  });
  const nineteen = () =>
    Array.from({ length: 19 }, (_, i) => kitPile(i + 1, 1000 - i * 10, 100 + i * 10));
  const stockGroup = () => q('[data-testid="tree-group-stockpiles"]');
  const stockpilesTree = () => stockGroup()?.closest('[role="treeitem"]') ?? null;
  const rowsOfStockpiles = () =>
    [...(stockpilesTree()?.querySelectorAll<HTMLElement>('[data-testid="measure-row"]') ?? [])].map(
      (r) => ({ id: r.dataset.id, meta: r.querySelector('.tm')?.textContent ?? '' }),
    );

  afterEach(() => {
    timeline.setState({ focus: null });
    stageShow.getState().reset();
  });

  it('kit piles are no longer under Needs a date and sit in Stockpiles with "19 · 14 Oct 2026"', () => {
    seed([...nineteen(), measurement('c')]);
    render(dated);
    expect(rowsIn(needsGroup()?.closest('[role="treeitem"]') ?? null)).toEqual(['c']);
    expect(stockGroup()?.querySelector('.glbl')?.textContent).toBe('Stockpiles');
    expect(stockGroup()?.querySelector('.gcount')?.textContent).toBe(
      `19 · ${formatDate('2026-10-14')}`,
    );
  });

  it('rows sort by the date’s volume, ten shown then "9 more"', () => {
    seed(nineteen());
    render(dated);
    const rows = rowsOfStockpiles();
    expect(rows).toHaveLength(10);
    expect(rows[0]?.id).toBe('p19');
    expect(rows[0]?.meta).toMatch(/^280/);
    expect(stockpilesTree()?.querySelector('.titem.more')?.textContent).toBe('9 more');
  });

  it('the same pile shows another figure when the date in focus changes', () => {
    seed(nineteen());
    render(dated);
    act(() => {
      timeline.setState({ focus: 'c1' });
    });
    const rows = rowsOfStockpiles();
    expect(rows[0]?.id).toBe('p1');
    expect(rows[0]?.meta).toMatch(/^1\D?000/);
    expect(stockGroup()?.querySelector('.gcount')?.textContent).toBe(
      `19 · ${formatDate('2026-10-12')}`,
    );
  });

  it('net mode (Cut & fill in front) sorts by loss and says net change', () => {
    seed([kitPile(1, 100, 150), kitPile(2, 500, 100), kitPile(3, 50, 40)]);
    render(dated);
    act(() => {
      stageShow.getState().setPane('cutFill');
    });
    expect(stockGroup()?.querySelector('.gcount')?.textContent).toBe('3 · net change');
    const rows = rowsOfStockpiles();
    expect(rows.map((r) => r.id)).toEqual(['p2', 'p3', 'p1']);
    expect(rows[0]?.meta).toMatch(/^−400/);
  });

  it('a measurement on a date the project no longer has is under Needs a date', () => {
    seed([onDate('a', 'gone')]);
    render(dated);
    expect(needsGroup()).not.toBeNull();
    expect(row('a')).not.toBeNull();
    expect(row('a')?.closest('[data-testid^="date-folder-"]')).toBeNull();
  });

  it.each([
    [
      'in a package',
      () => {
        shell.setState({ pkg: { header: { readOnly: true, exports: [] } } as never });
      },
    ],
    [
      'for a look-only reviewer',
      () => {
        lookOnly.on = true;
      },
    ],
    [
      'with a read-only measurements file',
      () => {
        measureStore.setState({ readOnly: true });
      },
    ],
  ])('measurement rows do not drag %s', (_, lock) => {
    seed([onDate('a', 'c1', 'Fence'), measurement('c')]);
    lock();
    render(dated);
    openDate('c1');
    expect(row('a')).not.toBeNull();
    expect(row('c')).not.toBeNull();
    expect(row('a')?.getAttribute('draggable')).toBeNull();
    expect(row('c')?.getAttribute('draggable')).toBeNull();
    expect(
      q('[data-testid="measure-folder"][data-folder="Fence"]')?.getAttribute('draggable'),
    ).toBeNull();
  });

  it('measurement rows drag where they may be edited', () => {
    seed([onDate('a', 'c1'), measurement('c')]);
    render(dated);
    openDate('c1');
    expect(row('a')?.getAttribute('draggable')).toBe('true');
    expect(row('c')?.getAttribute('draggable')).toBe('true');
  });

  it('a project with no dates keeps the one Measurements group', () => {
    seed([onDate('a', 'c1'), measurement('c')]);
    render(plain);
    expect(qa('[data-testid="tree-group-measurements"]')).toHaveLength(1);
    expect(needsGroup()).toBeNull();
    expect(qa('[data-testid="measure-row"]').map((r) => r.dataset.id)).toEqual(['a', 'c']);
  });

  it('a measurement note in the store shows in the sidebar, its Undo undoes the move', () => {
    seed([onDate('a', 'c1')]);
    render(dated);
    const before = measures()[0];
    act(() => {
      const next = { ...onDate('a', 'c2') };
      const seq = replaceMeasurements([next], { undoable: true });
      expect(seq).not.toBeNull();
      setMeasureNote({ text: '1 measurement moved.', danger: false, undo: true });
    });
    expect(q('[data-testid="date-note"]')?.textContent).toContain('1 measurement moved.');
    expect(measures()[0]?.scope).toEqual({ kind: 'survey', capture: 'c2' });
    click(q('[data-testid="date-undo"]'));
    expect(measures()[0]?.scope).toEqual(before?.scope);
    expect(q('[data-testid="date-note"]')).toBeNull();
  });

  it('a later edit of a moved measurement takes the Undo off the note', () => {
    seed([onDate('a', 'c1')]);
    render(dated);
    act(() => {
      replaceMeasurements([onDate('a', 'c2')], { undoable: true });
      setMeasureNote({ text: 'Moved.', danger: false, undo: true });
    });
    expect(q('[data-testid="date-undo"]')).not.toBeNull();
    act(() => {
      renameMeasurement('a', 'Edited');
    });
    expect(q('[data-testid="date-note"]')?.textContent).toContain('Moved.');
    expect(q('[data-testid="date-undo"]')).toBeNull();
    expect(labelOf('a')).toBe('Edited');
  });

  it('a look-only reviewer cannot undo a measurement move from the note', () => {
    seed([onDate('a', 'c1')]);
    render(dated);
    act(() => {
      replaceMeasurements([onDate('a', 'c2')], { undoable: true });
      setMeasureNote({ text: 'Moved.', danger: false, undo: true });
    });
    lookOnly.on = true;
    click(q('[data-testid="date-undo"]'));
    expect(measures()[0]?.scope).toEqual({ kind: 'survey', capture: 'c2' });
  });

  it('a refusal for want of surfaces offers Prepare surfaces', () => {
    seed([onDate('a', 'c1')]);
    render(dated);
    act(() => {
      setMeasureNote({ text: 'Not prepared.', danger: true, prepare: true });
    });
    expect(q('[data-testid="date-note"]')?.classList.contains('danger')).toBe(true);
    expect(q('[data-testid="date-note-prepare"]')).not.toBeNull();
  });

  const prepareNote = () => {
    act(() => {
      setMeasureNote({ text: 'Not prepared.', danger: true, prepare: true });
    });
  };
  const settle = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it('Prepare surfaces started takes the refusal away, its store note too', async () => {
    prepare.fn.mockReset().mockResolvedValue(null);
    seed([onDate('a', 'c1')]);
    render(dated);
    prepareNote();
    click(q('[data-testid="date-note-prepare"]'));
    expect(q('[data-testid="date-note-prepare"]')).toBeNull();
    await settle();
    expect(prepare.fn).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="date-note"]')).toBeNull();
    expect(measureStore.getState().note).toBeNull();
  });

  it('nothing left to prepare is said plainly, a failure as danger', async () => {
    prepare.fn.mockReset().mockResolvedValue('Every survey surface is prepared.');
    seed([onDate('a', 'c1')]);
    render(dated);
    prepareNote();
    click(q('[data-testid="date-note-prepare"]'));
    await settle();
    const n = q('[data-testid="date-note"]');
    expect(n?.textContent).toContain('Every survey surface is prepared.');
    expect(n?.textContent).not.toContain('Not prepared.');
    expect(n?.classList.contains('danger')).toBe(false);
    prepare.fn.mockResolvedValue('The job could not start.');
    prepareNote();
    click(q('[data-testid="date-note-prepare"]'));
    await settle();
    expect(q('[data-testid="date-note"]')?.textContent).toContain('The job could not start.');
    expect(q('[data-testid="date-note"]')?.classList.contains('danger')).toBe(true);
  });

  it('a note reshaped by a stale Undo still follows the store: Dismiss clears it there', () => {
    seed([onDate('a', 'c1')]);
    render(dated);
    act(() => {
      replaceMeasurements([onDate('a', 'c2')], { undoable: true });
      setMeasureNote({ text: 'Moved.', danger: false, undo: true });
    });
    const seq = measureStore.getState().note?.seq ?? -1;
    // a stale Undo (the store says no): the note stays without it
    act(() => {
      measureStore.setState({ undoChange: null });
    });
    click(q('[data-testid="date-undo"]'));
    expect(q('[data-testid="date-undo"]')).toBeNull();
    expect(measureStore.getState().note?.seq).toBe(seq);
    // the store updating the same note still reaches the slot
    act(() => {
      const n = measureStore.getState().note;
      if (n) measureStore.setState({ note: { ...n, text: 'Moved, again.' } });
    });
    expect(q('[data-testid="date-note"]')?.textContent).toContain('Moved, again.');
    click(q('[data-testid="date-note"] button[aria-label="Dismiss"]'));
    expect(q('[data-testid="date-note"]')).toBeNull();
    expect(measureStore.getState().note).toBeNull();
  });

  it('a note reshaped by Prepare clears when the store lets go of it', () => {
    prepare.fn.mockReset().mockReturnValue(new Promise(() => undefined));
    seed([onDate('a', 'c1')]);
    render(dated);
    prepareNote();
    click(q('[data-testid="date-note-prepare"]'));
    act(() => {
      setMeasureNote(null);
    });
    expect(q('[data-testid="date-note"]')).toBeNull();
  });

  it('a reveal of no measurement opens no dated tree', () => {
    seed([onDate('a', 'c1'), measurement('c')]);
    render(dated);
    openDate('c1');
    const head = () =>
      folderOfDate('c1')
        ?.querySelector('[data-testid="tree-group-measurements"]')
        ?.closest('[role="treeitem"]') ?? null;
    // fold the date's Measurements group by hand
    click(head()?.querySelector('.tgroup-btn') ?? null);
    expect(head()?.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      revealMeasurement(null);
    });
    expect(head()?.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('Datasets: survey date surface status', () => {
  const status = (id: string) => q(`[data-testid="date-status-${id}"]`)?.textContent ?? null;
  const prepJob = (status: JobRecord['status'], progress: number): JobRecord => ({
    id: 'jp',
    pipeline: 'survey.prepare',
    project: 'C:/p',
    params: {
      surfaces: [{ id: 's2', name: 'x', source: { kind: 'cloud', layer: 'pc2' }, capture: 'c2' }],
    },
    status,
    progress,
    steps: [],
    artifacts: [],
    createdAt: '',
    updatedAt: '',
  });
  afterEach(() => {
    jobs.setState({ jobs: [] });
    preparedSurfaces.setState({ projectId: null, surfaces: [] });
  });

  it('a sidebar date row reads "preparing 62 %" while its job runs and "ready" after, nothing when no job ran', () => {
    render(dated);
    expect(status('c1')).toBeNull();
    expect(status('c2')).toBeNull();
    act(() => {
      jobs.setState({ jobs: [prepJob('running', 0.62)] });
    });
    expect(status('c2')).toBe('preparing 62 %');
    // a date no job prepared says nothing
    expect(status('c1')).toBeNull();
    act(() => {
      jobs.setState({ jobs: [prepJob('done', 1)] });
      preparedSurfaces.setState({
        projectId: 'p',
        surfaces: [
          { id: 's2', capture: 'c2', source: { kind: 'cloud', layer: 'pc2' } },
        ] as unknown as HeightTiles[],
      });
    });
    expect(status('c2')).toBe('ready');
    expect(status('c1')).toBeNull();
  });
});
