// @vitest-environment jsdom
import { emptyMeasurements, ProjectManifest, type RemoveTarget, type SitePoint } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@aio/annotate', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAnnotateReadOnly: () => false,
}));

import { shell } from '../shell';
import {
  askNewFolder,
  isDirty,
  measureStore,
  revealMeasurement,
  setMeasureVisibilityMemory,
  undoDeleteMeasurements,
} from '../survey/measureStore';
import { createMeasureVisibilityMemory } from '../survey/measureVisibility';
import { removal } from './removal';
import { renameRequest } from './renameRequest';
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
