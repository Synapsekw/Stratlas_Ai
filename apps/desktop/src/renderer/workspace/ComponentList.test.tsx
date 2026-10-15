// @vitest-environment jsdom
import type * as Engine from '@aio/engine';
import type { ComponentInfo } from '@aio/engine';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stage = {
  components: vi.fn<(layerId: string) => ComponentInfo[]>(() => []),
  setNodeVisible: vi.fn<(layerId: string, node: string, visible: boolean) => boolean>(() => true),
};
vi.mock('@aio/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof Engine>()),
  getActiveStage: () => stage,
}));

const { ComponentList, LayerComponents, componentVisibility } = await import('./ComponentList');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  componentVisibility.setState({ hidden: {} });
  stage.components.mockReset();
  stage.setNodeVisible.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const components: ComponentInfo[] = [
  { id: 'flue-1', name: 'Flue 1', category: 'Structure', description: 'Steel flue.' },
  { id: 'flue-2', name: 'Flue 2', category: 'Structure', tag: 'F-2' },
  {
    id: 'light-l1-1',
    name: 'Warning light 1',
    category: 'Lighting',
    parent: 'flue-1',
    description: 'Red lens facing north.',
  },
  {
    id: 'light-l1-2',
    name: 'Warning light 2',
    category: 'Lighting',
    parent: 'flue-1',
    description: 'Red lens facing south.',
  },
];

const rows = () =>
  [...host.querySelectorAll<HTMLElement>('[data-testid="component-row"]')].map((r) => r.dataset.id);
const row = (id: string) => {
  const r = host.querySelector<HTMLElement>(`[data-testid="component-row"][data-id="${id}"]`);
  if (!r) throw new Error(`no row ${id}`);
  return r;
};
const typeSearch = (text: string) => {
  const input = host.querySelector<HTMLInputElement>('[data-testid="component-search"]');
  if (!input) throw new Error('no search');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('ComponentList', () => {
  function show(hidden: ReadonlySet<string> = new Set(), selected?: string) {
    const onSelect = vi.fn<(id: string) => void>();
    const onToggle = vi.fn<(id: string, visible: boolean) => void>();
    act(() =>
      root?.render(
        <ComponentList
          layerId="chimney"
          components={components}
          hidden={hidden}
          selected={selected}
          onSelect={onSelect}
          onToggle={onToggle}
        />,
      ),
    );
    return { onSelect, onToggle };
  }

  it('groups components by category, each mounted part under its parent', () => {
    show();
    const groups = [...host.querySelectorAll('[data-testid="component-group"] h3')].map(
      (h) => h.textContent,
    );
    expect(groups).toEqual(['Lighting', 'Structure']);
    expect(rows()).toEqual(['light-l1-1', 'light-l1-2', 'flue-1', 'flue-2']);
    expect(host.textContent).toContain('4 components');
  });

  it('finds warning lights by their description, and by tag or id', () => {
    show();
    typeSearch('lens');
    expect(rows()).toEqual(['light-l1-1', 'light-l1-2']);
    typeSearch('F-2');
    expect(rows()).toEqual(['flue-2']);
    typeSearch('light-l1-2');
    expect(rows()).toEqual(['light-l1-2']);
    typeSearch('nothing like it');
    expect(rows()).toEqual([]);
    expect(host.textContent).toContain('No component matches "nothing like it"');
  });

  it('selects with a click or tap on the row button and toggles visibility', () => {
    const { onSelect, onToggle } = show(new Set(['flue-2']), 'flue-1');
    const pick = row('light-l1-2').querySelector<HTMLButtonElement>('button.cl-name');
    expect(pick?.tagName).toBe('BUTTON');
    act(() => pick?.click());
    expect(onSelect).toHaveBeenCalledWith('light-l1-2');
    expect(row('flue-1').querySelector('[aria-current="true"]')).not.toBeNull();
    const eye = (id: string) => row(id).querySelector<HTMLButtonElement>('button.cl-eye');
    expect(eye('flue-1')?.getAttribute('aria-pressed')).toBe('true');
    expect(eye('flue-1')?.getAttribute('aria-label')).toBe('Hide Flue 1');
    act(() => eye('flue-1')?.click());
    expect(onToggle).toHaveBeenLastCalledWith('flue-1', false);
    expect(eye('flue-2')?.getAttribute('aria-label')).toBe('Show Flue 2');
    act(() => eye('flue-2')?.click());
    expect(onToggle).toHaveBeenLastCalledWith('flue-2', true);
  });
});

describe('LayerComponents', () => {
  it('lists the components of a loaded layer and hides them in the 3D view', () => {
    stage.components.mockReturnValue(components);
    act(() => root?.render(<LayerComponents layerId="chimney" />));
    expect(rows()).toHaveLength(4);
    const eye = row('flue-2').querySelector<HTMLButtonElement>('button.cl-eye');
    act(() => eye?.click());
    expect(stage.setNodeVisible).toHaveBeenCalledWith('chimney', 'flue-2', false);
    expect(componentVisibility.getState().hidden.chimney).toEqual(['flue-2']);
    expect(eye?.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows nothing for a layer without components', () => {
    stage.components.mockReturnValue([]);
    act(() => root?.render(<LayerComponents layerId="plant" />));
    expect(host.querySelector('[data-testid="component-list"]')).toBeNull();
  });
});
