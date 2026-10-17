// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { EVERY_DATE, makeActionCtx, NO_HOST, type ActionCtx, type MenuTarget } from '@aio/ui';
import { dateTags, workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridge } from '../shell';
import { timeline } from '../workspace/timeline';
import { compareWith, COMPARE_WITH_ACTIONS } from '../workspace/compareWith';
import { registerSidebarActions } from './actions';
import { updateCapture } from './dateFolders';
import { TreeMenu, type TreeMenuRequest } from './DateMenus';
import { askRemove } from './removal';
import { lineUpApp, type LineUpStore } from '../lineup/lineUpStore';
import type { Box } from './layerBounds';
import { lineUpTip } from '../lineup/planLineUp';
import { t } from '@aio/ui';
import type { StoreApi } from 'zustand/vanilla';

vi.mock('./dateFolders', () => ({
  updateCapture: vi.fn(() => Promise.resolve(null)),
  moveLayersToDate: vi.fn(),
}));
vi.mock('./removal', () => ({ askRemove: vi.fn() }));
vi.mock('../workspace/compareWith', () => ({
  COMPARE_WITH_ACTIONS: [],
  compareWith: vi.fn(() => true),
  compareTargets: vi.fn((from: string) =>
    [
      { capture: 'nov', reason: null },
      { capture: 'oct', reason: null },
      { capture: 'sep', reason: 'compare.with.noRaster' },
    ].filter((x) => x.capture !== from),
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const captures = [
  { id: 'sep', label: 'Survey', date: '2024-09-04' },
  { id: 'oct', label: 'Baseline', date: '2024-10-02', colour: 6, icon: 'flag' },
  { id: 'nov', label: '2024-11-06', date: '2024-11-06' },
];
const mesh = (id: string, capture?: string) => ({
  kind: 'mesh',
  id,
  name: id,
  visible: true,
  src: { path: `${id}.glb` },
  transform: [],
  ...(capture ? { capture } : {}),
});
const manifestOf = (caps = captures) =>
  ({
    captures: caps,
    layers: [mesh('a', 'sep'), mesh('b', 'sep'), mesh('design')],
  }) as unknown as ProjectManifest;

const FOLDERS: Record<string, string[]> = { sep: ['a', 'b'], nov: [], [EVERY_DATE]: ['design'] };

let host: HTMLDivElement;
let root: Root | undefined;
let off: () => void;
beforeEach(() => {
  registerSidebarActions();
  vi.mocked(compareWith).mockClear();
  vi.mocked(updateCapture).mockClear();
  vi.mocked(askRemove).mockClear();
  COMPARE_WITH_ACTIONS.length = 0;
  workspace.setState({
    project: { id: 'p1', root: 'C:/p', manifest: manifestOf() },
  } as unknown as Partial<ReturnType<typeof workspace.getState>>);
  host = document.createElement('div');
  document.body.append(host);
  off = () => undefined;
});
afterEach(() => {
  off();
  act(() => root?.unmount());
  root = undefined;
  workspace.setState({ project: null });
  host.remove();
  vi.restoreAllMocks();
});
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) => {
  act(() => q(id)?.click());
};
const disabled = (id: string) => q(id)?.getAttribute('aria-disabled') === 'true';

interface Opts extends Partial<ActionCtx> {
  hostExtra?: Partial<ActionCtx['host']>;
  title?: string;
  label?: string;
}
function open(target: MenuTarget, testId: string, from: string, o: Opts = {}) {
  const onClose = vi.fn();
  const { hostExtra, title, label, ...over } = o;
  const manifest = over.manifest ?? manifestOf();
  const ctx = makeActionCtx({
    manifest,
    tags: dateTags(manifest.captures),
    folderLayers: FOLDERS,
    host: { ...NO_HOST, ...hostExtra },
    ...over,
  });
  const request: TreeMenuRequest = {
    target,
    x: 10,
    y: 10,
    title: title ?? 'Title',
    label: label ?? 'Survey date 2024-09-04',
    testId,
    host: { from, toggle: vi.fn(), expanded: false },
  };
  root = createRoot(host);
  act(() => root?.render(<TreeMenu request={request} ctx={ctx} onClose={onClose} />));
  return { onClose, request, ctx };
}
const date = (id: string | null, o: Opts = {}) =>
  open({ kind: 'date', captureId: id }, 'date-menu', id ?? EVERY_DATE, o);
const layers = (ids: string[], from: string, o: Opts = {}) =>
  open({ kind: 'layers', layerIds: ids }, 'move-menu', from, o);

describe('date folder menu', () => {
  it('views the date, opens the folder and shows or hides its layers', () => {
    const setVisible = vi.fn();
    vi.spyOn(workspace.getState(), 'setLayersVisible').mockImplementation(setVisible);
    const focus = vi.spyOn(timeline.getState(), 'focusSurvey').mockImplementation(() => undefined);
    const p = date('sep', { hidden: { a: true } });
    expect(q('date-menu')?.getAttribute('aria-label')).toBe('Survey date 2024-09-04');
    click('date-menu-view');
    expect(focus).toHaveBeenCalledWith('sep');
    click('date-menu-toggle');
    expect(p.request.host.toggle).toHaveBeenCalledTimes(1);
    click('date-menu-show');
    expect(setVisible).toHaveBeenLastCalledWith(['a', 'b'], true);
    click('date-menu-hide');
    expect(setVisible).toHaveBeenLastCalledWith(['a', 'b'], false);
  });

  it('greys the focused date and has no show or hide for a date without layers', () => {
    date('sep', { focus: 'sep' });
    expect(disabled('date-menu-view')).toBe(true);
    act(() => root?.unmount());
    date('nov');
    expect(q('date-menu-show')).toBeNull();
    expect(q('date-menu-hide')).toBeNull();
  });

  it('picks a colour and stays open, resets both to the automatic ones', () => {
    const { onClose } = date('oct');
    expect(q('date-menu-colour-6')?.getAttribute('aria-checked')).toBe('true');
    click('date-menu-colour-5');
    expect(updateCapture).toHaveBeenLastCalledWith('oct', { colour: 5 });
    click('date-menu-reset');
    expect(updateCapture).toHaveBeenLastCalledWith('oct', { colour: null, icon: null });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renames through the host', () => {
    const renameDate = vi.fn();
    date('sep', { hostExtra: { renameDate } });
    click('date-menu-rename');
    expect(renameDate).toHaveBeenCalledWith('sep');
  });

  it('greys rename, colour and Delete in a read-only project, and Every date is never coloured', () => {
    date('oct', { canEdit: false });
    expect(disabled('date-menu-view')).toBe(false);
    expect(disabled('date-menu-rename')).toBe(true);
    expect(disabled('date-menu-delete')).toBe(true);
    click('date-menu-delete');
    expect(askRemove).not.toHaveBeenCalled();
    act(() => root?.unmount());
    date(null);
    expect(q('date-menu-toggle')).not.toBeNull();
    expect(q('date-menu-rename')).toBeNull();
    expect(q('date-menu-colour-1')).toBeNull();
  });

  it('Delete asks for the date', () => {
    const { onClose } = date('sep');
    click('date-menu-delete');
    expect(askRemove).toHaveBeenCalledWith([{ capture: 'sep' }]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Export reaches the layer export of the folder (the folder asks where to)', () => {
    const calls: string[] = [];
    vi.spyOn(bridge, 'call').mockImplementation(((channel: string) => {
      calls.push(channel);
      return Promise.resolve({ ok: false, error: 'x' });
    }) as unknown as typeof bridge.call);
    date('sep');
    click('ctx-item-date.export');
    expect(calls).toContain('dialog:openFolder');
  });

  it('closes on a press outside and on Escape', () => {
    const { onClose } = date('sep');
    act(() => {
      q('date-menu')?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => {
      q('date-menu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('date folder menu: Compare with', () => {
  it('lists the other dates newest first and compares with the picked one', () => {
    const { onClose } = date('nov');
    click('date-menu-compare');
    expect(q('date-menu')?.textContent).toContain('Compare 6 Nov 2024 with');
    const ids = [...document.body.querySelectorAll('[data-testid^="compare-to-"]')].map((b) =>
      b.getAttribute('data-testid'),
    );
    expect(ids).toEqual(['compare-to-oct', 'compare-to-sep']);
    expect(q('compare-to-oct')?.querySelector('.sw')).not.toBeNull();
    click('compare-to-oct');
    expect(compareWith).toHaveBeenCalledWith({ from: 'nov', to: 'oct' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows why a date is off and does not compare with it', () => {
    date('nov');
    click('date-menu-compare');
    expect(disabled('compare-to-sep')).toBe(true);
    expect(q('compare-to-sep')?.textContent).toContain('No ortho');
    click('compare-to-sep');
    expect(compareWith).not.toHaveBeenCalled();
  });

  it('goes back to the menu', () => {
    const { onClose } = date('nov');
    click('date-menu-compare');
    expect(q('date-menu-toggle')).toBeNull();
    click('ctx-back');
    expect(q('date-menu-toggle')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    click('date-menu-compare');
    expect(q('date-menu')?.contains(document.activeElement)).toBe(true);
  });

  it('is offered read-only, but not with one survey date or for Every date', () => {
    date('nov', { canEdit: false });
    expect(q('date-menu-compare')).not.toBeNull();
    act(() => root?.unmount());
    date(null);
    expect(q('date-menu-compare')).toBeNull();
    act(() => root?.unmount());
    date('nov', { manifest: manifestOf(captures.slice(2)) });
    expect(q('date-menu-compare')).toBeNull();
  });

  it('renders extra actions under each enabled date with the request and close', () => {
    const seen: unknown[] = [];
    COMPARE_WITH_ACTIONS.push((p) => {
      seen.push(p.request);
      return (
        <button key={p.request.to} type="button" data-testid={`extra-${p.request.to}`}>
          Extra
        </button>
      );
    });
    date('nov');
    click('date-menu-compare');
    expect(q('extra-oct')).not.toBeNull();
    expect(q('extra-sep')).toBeNull();
    expect(seen).toContainEqual({ from: 'nov', to: 'oct' });
  });
});

describe('dataset menu', () => {
  it('lists Every date and the dates newest first, the current one marked and off', () => {
    layers(['design'], EVERY_DATE);
    const ids = [...document.body.querySelectorAll('[data-testid^="move-to-"]')].map((b) =>
      b.getAttribute('data-testid'),
    );
    expect(ids).toEqual(['move-to-every', 'move-to-nov', 'move-to-oct', 'move-to-sep']);
    expect(q('move-menu')).not.toBeNull();
    expect(disabled('move-to-every')).toBe(true);
    expect(q('move-to-every')?.getAttribute('aria-checked')).toBe('true');
    expect(q('move-to-oct')?.getAttribute('aria-checked')).toBe('false');
    // a name beside the date, unless the label only repeats the date
    expect(q('move-to-nov')?.textContent).not.toContain('2024-11-06');
    expect(q('move-to-oct')?.textContent).toContain('Baseline');
  });

  it('files the dataset under the picked date, or under none', () => {
    const moveLayers = vi.fn();
    const { onClose } = layers(['design'], 'oct', { hostExtra: { moveLayers } });
    click('move-to-sep');
    expect(moveLayers).toHaveBeenLastCalledWith(['design'], 'sep');
    click('move-to-every');
    expect(moveLayers).toHaveBeenLastCalledWith(['design'], null);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('the current date is marked and off', () => {
    layers(['a'], 'sep');
    expect(q('move-to-sep')?.getAttribute('aria-checked')).toBe('true');
    expect(disabled('move-to-sep')).toBe(true);
  });

  it('heads the menu of a group with the group and its count, and names it', () => {
    open(
      { kind: 'group', group: 'models', layerIds: ['a', 'b'], captureId: 'nov' },
      'move-menu',
      'nov',
      { title: 'Models · 2 datasets', label: 'Models menu' },
    );
    const menu = q('move-menu');
    expect(menu?.textContent).toContain('Models · 2 datasets');
    expect(menu?.getAttribute('aria-label')).toBe('Models menu');
  });

  it('a group carries all its layers to the picked date', () => {
    const moveLayers = vi.fn();
    open(
      { kind: 'group', group: 'models', layerIds: ['a', 'b'], captureId: 'nov' },
      'move-menu',
      'nov',
      {
        hostExtra: { moveLayers },
      },
    );
    click('move-to-oct');
    expect(moveLayers).toHaveBeenCalledWith(['a', 'b'], 'oct');
  });

  it('offers Compare with another date inside the menu, and File under only when editable', () => {
    layers(['design'], 'oct', { canEdit: false });
    expect(q('move-compare')).not.toBeNull();
    expect(disabled('move-to-sep')).toBe(false);
    expect(disabled('ctx-item-layer.moveToDate')).toBe(false);
    act(() => root?.unmount());
    layers(['design'], 'oct');
    expect(q('move-to-sep')).not.toBeNull();
    expect(document.body.textContent).toContain('File under');
  });

  it('compares the layers with the picked date', () => {
    const { onClose } = layers(['design'], 'oct');
    click('move-compare');
    expect(q('move-menu')?.textContent).toContain('Compare 2 Oct 2024 with');
    expect(q('move-menu')?.querySelector('[data-testid="compare-to-nov"]')).not.toBeNull();
    click('compare-to-nov');
    expect(compareWith).toHaveBeenCalledWith({ from: 'oct', to: 'nov', layers: ['design'] });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has no compare item with one survey date or for a layer in Every date', () => {
    // a layer filed under no date has no date to compare from: greyed with its reason
    layers(['design'], EVERY_DATE);
    expect(disabled('move-compare')).toBe(true);
    act(() => root?.unmount());
    layers(['design'], 'nov', { manifest: manifestOf(captures.slice(1, 2)) });
    expect(q('move-compare')).toBeNull();
  });

  it('with dates off has no File under list, only Compare and Delete', () => {
    layers(['design'], 'oct', { datesOn: false });
    expect(document.body.querySelector('[data-testid^="move-to-"]')).toBeNull();
    expect(document.body.textContent).not.toContain('File under');
    expect(q('move-compare')).not.toBeNull();
    expect(q('menu-delete')).not.toBeNull();
  });

  it('Delete is the last item and asks the removal dialog', () => {
    const { onClose } = layers(['design'], 'oct');
    const items = [...document.body.querySelectorAll('[role="menuitem"]')];
    expect(items.at(-1)?.getAttribute('data-testid')).toBe('menu-delete');
    click('menu-delete');
    expect(askRemove).toHaveBeenCalledWith([{ layer: 'design' }]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('read-only: no File under, no Delete, though the menu opens to compare', () => {
    layers(['design'], 'oct', { canEdit: false });
    expect(q('move-compare')).not.toBeNull();
    expect(disabled('menu-delete')).toBe(true);
    click('move-to-sep');
    click('menu-delete');
    expect(askRemove).not.toHaveBeenCalled();
  });

  it('closes on Escape, and Back returns to the menu', () => {
    const { onClose } = layers(['design'], 'oct');
    click('move-compare');
    // Escape inside the Compare view goes back; Escape on the menu closes it
    act(() => {
      q('compare-to-nov')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(q('move-compare')).not.toBeNull();
    act(() => {
      q('move-menu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('an empty menu asks to be closed', () => {
    const { onClose } = open({ kind: 'photos', picks: [] }, 'ctx-menu', 'x');
    expect(q('ctx-menu')).toBeNull();
    expect(onClose).toHaveBeenCalled();
  });
});

describe('date folder menu: line up', () => {
  const lineUp = { eastM: -2, northM: 0.2, with: 'sep', at: '2026-10-17T10:00:00.000Z' };
  const ortho = (id: string, capture: string) => ({
    kind: 'raster',
    id,
    name: id,
    visible: true,
    role: 'ortho',
    format: 'cog',
    src: { path: `${id}.tif` },
    capture,
  });
  const fake = () => {
    const open = vi.fn(() => Promise.resolve());
    const remove = vi.fn(() => Promise.resolve());
    const store = { getState: () => ({ open, remove }) } as unknown as StoreApi<LineUpStore>;
    return { open, remove, store };
  };
  afterEach(() => {
    lineUpApp.setState({ store: null, preview: null, extents: null });
  });

  it('shows a lined-up date and removes its line-up', async () => {
    const withLineUp = {
      ...manifestOf(),
      captures: captures.map((c) => (c.id === 'oct' ? { ...c, lineUp } : c)),
    } as unknown as ProjectManifest;
    workspace.setState({
      project: { id: 'p1', root: 'C:/p', manifest: withLineUp },
    } as unknown as Partial<ReturnType<typeof workspace.getState>>);
    // the folder's tooltip says what it was lined up with
    expect(lineUpTip(withLineUp, 'oct', t)).toBe('Lined up with Survey (2.01 m)');
    expect(lineUpTip(withLineUp, 'nov', t)).toBeNull();

    const { remove, store } = fake();
    lineUpApp.setState({ store });
    date('oct', { manifest: withLineUp });
    await act(async () => {
      q('date-menu-remove-line-up')?.click();
      await Promise.resolve();
    });
    expect(remove).toHaveBeenCalledWith('oct');
    act(() => root?.unmount());
    date('nov', { manifest: withLineUp });
    expect(q('date-menu-remove-line-up')).toBeNull();
    expect(q('date-menu-line-up')).not.toBeNull();
  });

  it('opens the step from the date menu with the other date', async () => {
    const two = {
      captures: captures.slice(0, 2),
      layers: [ortho('o-sep', 'sep'), ortho('o-oct', 'oct')],
    } as unknown as ProjectManifest;
    workspace.setState({
      project: { id: 'p1', root: 'C:/p', manifest: two },
    } as unknown as Partial<ReturnType<typeof workspace.getState>>);
    const { open, store } = fake();
    lineUpApp.setState({ store });
    date('sep', { manifest: two });
    await act(async () => {
      q('date-menu-line-up')?.click();
      await Promise.resolve();
    });
    expect(open).toHaveBeenCalledWith('sep', 'oct');
  });

  it('opens the step with the date it most overlaps when there are more', async () => {
    const three = {
      captures,
      layers: [ortho('o-sep', 'sep'), ortho('o-oct', 'oct'), ortho('o-nov', 'nov')],
    } as unknown as ProjectManifest;
    workspace.setState({
      project: { id: 'p1', root: 'C:/p', manifest: three },
    } as unknown as Partial<ReturnType<typeof workspace.getState>>);
    const box = (x0: number, x1: number): Box => ({ min: [x0, 0, 0], max: [x1, 5, 100] });
    const { open, store } = fake();
    lineUpApp.setState({
      store,
      extents: () =>
        Promise.resolve({ 'o-sep': box(0, 100), 'o-oct': box(90, 190), 'o-nov': box(20, 120) }),
    });
    date('sep', { manifest: three });
    await act(async () => {
      q('date-menu-line-up')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(open).toHaveBeenCalledWith('sep', 'nov');
  });
});
