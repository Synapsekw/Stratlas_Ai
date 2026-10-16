// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatasetTree, isMenuKey, type DatasetTreeProps } from './DatasetTree';
import type { TreeGroup } from './model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host.remove();
});

const groups: TreeGroup[] = [
  {
    kind: 'models',
    label: 'Models',
    icon: 'scene',
    count: 1,
    items: [{ id: 'm', layerId: 'm', layerKind: 'mesh', name: 'Model' }],
  },
  {
    kind: 'annotations',
    label: 'Annotations',
    icon: 'anno',
    count: 1,
    items: [{ id: 'issues', name: 'Issues', meta: '3' }],
  },
];
const render = (over: Partial<DatasetTreeProps> = {}) => {
  const props: DatasetTreeProps = {
    groups,
    hidden: {},
    selectedId: null,
    activeClip: null,
    collapsed: false,
    onToggleVisible: vi.fn(),
    onSelect: vi.fn(),
    onItemMenu: vi.fn(),
    onGroupMenu: vi.fn(),
    dragGroupIds: (g) => g.items.flatMap((i) => (i.layerId ? [i.layerId] : [])),
    defaultOpen: ['models', 'annotations'],
    ...over,
  };
  root = createRoot(host);
  act(() => root?.render(<DatasetTree {...props} />));
  return props;
};
const press = (el: Element | null, key: string, shiftKey = false) => {
  act(() => {
    el?.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
  });
};

describe('menu keys on the tree', () => {
  it('knows Shift+F10 and the Menu key', () => {
    expect(isMenuKey({ key: 'F10', shiftKey: true })).toBe(true);
    expect(isMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true);
    expect(isMenuKey({ key: 'F10', shiftKey: false })).toBe(false);
  });

  it('opens a row menu from the keyboard, under the row, and an annotation row has one too', () => {
    const p = render();
    press(host.querySelector('[data-testid="tree-row-m"]'), 'F10', true);
    expect(p.onItemMenu).toHaveBeenCalledWith(expect.objectContaining({ id: 'm' }), {
      x: 24,
      y: 0,
    });
    press(host.querySelector('.titem[title="Issues"]'), 'ContextMenu');
    expect(p.onItemMenu).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'issues' }),
      expect.anything(),
    );
  });

  it('opens a group header menu from the keyboard on its fold button', () => {
    const p = render();
    press(host.querySelector('[data-testid="tree-group-toggle-models"]'), 'F10', true);
    expect(p.onGroupMenu).toHaveBeenCalledWith(groups[0], ['m'], expect.anything(), {
      expanded: true,
      toggle: expect.any(Function) as () => void,
    });
  });

  it('a group heading without layers has a menu on right-click and Shift+F10', () => {
    const p = render();
    const head = host.querySelector('[data-testid="tree-group-annotations"]');
    act(() => {
      head?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(p.onGroupMenu).toHaveBeenCalledWith(groups[1], [], expect.anything(), expect.anything());
    press(host.querySelector('[data-testid="tree-group-toggle-annotations"]'), 'F10', true);
    expect(p.onGroupMenu).toHaveBeenCalledTimes(2);
  });

  it('a rename that ends by blur does not pull focus back to the row', () => {
    render({ renamingLayer: 'm', onRenameLayerEnd: vi.fn() });
    const field = host.querySelector<HTMLInputElement>('[data-testid="layer-rename"]');
    const row = host.querySelector<HTMLElement>('[data-testid="tree-row-m"]');
    expect(row?.getAttribute('draggable')).toBeNull();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    act(() => {
      field?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(focus).not.toHaveBeenCalled();
    focus.mockRestore();
  });

  it('F2 starts a rename; the field saves on Enter and the row shows it in place', () => {
    const start = vi.fn();
    render({ onRenameLayerStart: start });
    press(host.querySelector('[data-testid="tree-row-m"]'), 'F2');
    expect(start).toHaveBeenCalledWith('m');
    const save = vi.fn();
    const end = vi.fn();
    act(() => root?.unmount());
    render({ renamingLayer: 'm', onRenameLayer: save, onRenameLayerEnd: end });
    const field = host.querySelector<HTMLInputElement>('[data-testid="layer-rename"]');
    expect(field?.getAttribute('aria-label')).toBe('Name of Model');
    if (field) field.value = 'Site model';
    press(field, 'Enter');
    expect(save).toHaveBeenCalledWith('m', 'Site model');
    expect(end).toHaveBeenCalled();
  });

  it('keeps the row strings people and tests read', () => {
    render({ hidden: { m: true } });
    expect(host.querySelector('[aria-label="Show Model"]')).not.toBeNull();
  });
});
