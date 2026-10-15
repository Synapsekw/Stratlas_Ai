// @vitest-environment jsdom
import type * as Engine from '@aio/engine';
import type { ComponentInfo } from '@aio/engine';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeComponentStage } from './__fixtures__/fakeComponentStage';

const stage = fakeComponentStage();
vi.mock('@aio/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof Engine>()),
  getActiveStage: () => stage,
}));

const { ComponentList, LayerComponents } = await import('./ComponentList');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  stage.reset();
  stage.byLayer = {};
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

describe('ComponentList keyboard', () => {
  it('is one Tab stop: arrows, Home and End move between rows, Right to the toggle', () => {
    const onSelect = vi.fn<(id: string) => void>();
    act(() =>
      root?.render(
        <ComponentList
          layerId="chimney"
          components={components}
          hidden={new Set()}
          selected="flue-1"
          onSelect={onSelect}
          onToggle={() => undefined}
        />,
      ),
    );
    const names = [...host.querySelectorAll<HTMLButtonElement>('button.cl-name')];
    // only the selected row takes Tab; the toggles never do
    expect(names.filter((b) => b.tabIndex === 0).map((b) => b.closest('li')?.dataset.id)).toEqual([
      'flue-1',
    ]);
    expect(
      [...host.querySelectorAll<HTMLButtonElement>('button.cl-eye')].every(
        (b) => b.tabIndex === -1,
      ),
    ).toBe(true);
    const key = (k: string) => {
      act(() => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: k, bubbles: true }),
        );
      });
    };
    act(() => row('flue-1').querySelector<HTMLButtonElement>('.cl-name')?.focus());
    key('ArrowDown');
    expect(document.activeElement?.closest('li')?.dataset.id).toBe('flue-2');
    key('Home');
    expect(document.activeElement?.closest('li')?.dataset.id).toBe('light-l1-1');
    key('End');
    expect(document.activeElement?.closest('li')?.dataset.id).toBe('flue-2');
    key('ArrowUp');
    expect(document.activeElement?.closest('li')?.dataset.id).toBe('flue-1');
    key('ArrowRight');
    expect(document.activeElement?.classList.contains('cl-eye')).toBe(true);
    key('ArrowLeft');
    expect(document.activeElement?.classList.contains('cl-name')).toBe(true);
    // the focused row is now the Tab stop
    expect(names.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    expect(row('flue-1').querySelector<HTMLButtonElement>('.cl-name')?.tabIndex).toBe(0);
  });
});

describe('LayerComponents', () => {
  it('lists the components of a loaded layer and shows what the engine hides', () => {
    stage.byLayer = { chimney: components };
    act(() => root?.render(<LayerComponents layerId="chimney" />));
    expect(rows()).toHaveLength(4);
    const eye = row('flue-2').querySelector<HTMLButtonElement>('button.cl-eye');
    act(() => eye?.click());
    expect(stage.setNodeVisible).toHaveBeenCalledWith('chimney', 'flue-2', false);
    expect(eye?.getAttribute('aria-pressed')).toBe('false');
    // hidden elsewhere (the card, another view): the list follows the engine
    act(() => {
      stage.setNodeVisible('chimney', 'flue-1', false);
    });
    expect(row('flue-1').querySelector('button.cl-eye')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('asks a loaded layer without components once, and looks again while one loads', () => {
    vi.useFakeTimers();
    try {
      act(() => root?.render(<LayerComponents layerId="plant" />));
      expect(host.querySelector('[data-testid="component-list"]')).toBeNull();
      const asked = stage.components.mock.calls.length;
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(stage.components.mock.calls.length).toBe(asked);
      stage.loaded = false;
      act(() => root?.render(<LayerComponents layerId="chimney" />));
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      stage.byLayer = { chimney: components };
      stage.loaded = true;
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(rows()).toHaveLength(4);
      const calls = stage.components.mock.calls.length;
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(stage.components.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
