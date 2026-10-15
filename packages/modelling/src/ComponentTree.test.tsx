// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComponentTree, type ComponentTreeProps } from './ComponentTree';
import { assembleStack, must, withStatus } from './engineer/assemble/testAssemble';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
});

const model = assembleStack().model;
const html = () => must(host, 'host');

function render(over: Partial<ComponentTreeProps> = {}) {
  const fns = {
    onSelect: vi.fn(),
    onToggle: vi.fn(),
    onStatus: vi.fn(),
    onRemove: vi.fn(),
    onAdd: vi.fn(),
  };
  const props: ComponentTreeProps = { model, selected: null, hidden: [], ...fns, ...over };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<ComponentTree {...props} />);
  });
  return fns;
}

const rows = () => [...html().querySelectorAll<HTMLButtonElement>('.mb-cmp-row')];
const press = (el: Element, key: string, init: KeyboardEventInit = {}) => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });
};
const click = (el: Element) => {
  act(() => {
    (el as HTMLElement).click();
  });
};
const byText = (text: string) =>
  must(
    [...html().querySelectorAll('button')].find((b) => b.textContent.includes(text)),
    text,
  );
const search = (value: string) => {
  const input = must(html().querySelector<HTMLInputElement>('input[type="search"]'));
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('ComponentTree', () => {
  it('groups components by category with counts', () => {
    render();
    const groups = [...html().querySelectorAll('.mb-cmp-group')];
    const names = groups.map((g) => g.getAttribute('aria-label'));
    expect(names).toEqual(expect.arrayContaining(['Flues', 'Lights', 'Shaft']));
    const flues = must(groups.find((g) => g.getAttribute('aria-label') === 'Flues'));
    expect(flues.querySelector('h4')?.textContent).toContain('3');
    expect(flues.querySelectorAll('.mb-cmp-row')).toHaveLength(3);
    expect(html().textContent).toMatch(/0 accepted, \d+ drafts/);
  });

  it('nests a child under its parent in the same category', () => {
    const m = {
      ...model,
      assemblies: model.assemblies.map((a) => (a.id === 'flue-2' ? { ...a, parent: 'flue-1' } : a)),
    };
    render({ model: m });
    const depths = rows()
      .filter((r) => r.dataset.component?.startsWith('flue-'))
      .map((r) => [r.dataset.component, r.dataset.depth]);
    expect(depths).toEqual([
      ['flue-1', '0'],
      ['flue-2', '1'],
      ['flue-3', '0'],
    ]);
  });

  it('filters by search over name, tag, id and kind', () => {
    render();
    search('flue-2');
    expect(rows().map((r) => r.dataset.component)).toEqual(['flue-2']);
    search('zzzz');
    expect(rows()).toHaveLength(0);
    expect(html().textContent).toContain('No component matches.');
  });

  it('moves with the arrows (selection follows focus) and acts with A, R, D, H', () => {
    const p = render({ selected: 'shaft-1' });
    const all = rows();
    const first = must(all[0]);
    act(() => {
      first.focus();
    });
    press(first, 'ArrowDown');
    expect(document.activeElement).toBe(all[1]);
    expect(p.onSelect).toHaveBeenLastCalledWith(all[1]?.dataset.component);
    press(first, 'End');
    expect(document.activeElement).toBe(all.at(-1));
    // the keys act on the selected component
    press(first, 'a');
    expect(p.onStatus).toHaveBeenLastCalledWith(['shaft-1'], 'accepted');
    press(first, 'r');
    expect(p.onStatus).toHaveBeenLastCalledWith(['shaft-1'], 'rejected');
    press(first, 'd');
    expect(p.onStatus).toHaveBeenLastCalledWith(['shaft-1'], 'draft');
    press(first, 'h');
    expect(p.onToggle).toHaveBeenCalledWith('shaft-1');
    press(first, 'A', { shiftKey: true });
    const drafts = model.assemblies.filter((a) => a.status === 'draft').map((a) => a.id);
    expect(p.onStatus).toHaveBeenLastCalledWith(drafts, 'accepted');
  });

  it('removes a draft at once and asks inline before removing an accepted component', () => {
    const accepted = withStatus(model, 'flue-1', 'accepted');
    const p = render({ model: accepted, selected: 'flue-3' });
    click(byText('Remove'));
    expect(p.onRemove).toHaveBeenCalledWith('flue-3');
    act(() => {
      root?.unmount();
    });
    html().remove();
    const p2 = render({ model: accepted, selected: 'flue-1' });
    click(byText('Remove'));
    expect(p2.onRemove).not.toHaveBeenCalled();
    expect(html().textContent).toMatch(/Remove .+\? You accepted it\./);
    // the question is in the panel, not a browser dialog
    click(byText('Keep'));
    expect(p2.onRemove).not.toHaveBeenCalled();
    expect(html().textContent).not.toContain('You accepted it');
    click(byText('Remove'));
    click(must(html().querySelector('.mb-cmp-confirm button')));
    expect(p2.onRemove).toHaveBeenCalledWith('flue-1');
  });

  it('adds a component by kind and accepts every draft', () => {
    const p = render();
    const select = must(html().querySelector('select'));
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(
        select,
        'ringPlatform',
      );
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    click(byText('Add component'));
    expect(p.onAdd).toHaveBeenCalledWith('ringPlatform');
    click(byText('Accept all drafts'));
    const drafts = model.assemblies.filter((a) => a.status === 'draft').map((a) => a.id);
    expect(p.onStatus).toHaveBeenCalledWith(drafts, 'accepted');
  });

  it('shows what is hidden and offers Show instead of Hide, and is inert when locked', () => {
    const p = render({ hidden: ['flue-1'], selected: 'flue-1', locked: true });
    expect(
      must(html().querySelector('[data-component="flue-1"]')).getAttribute('data-hidden'),
    ).toBe('true');
    expect(html().textContent).toContain('Hidden in the view');
    click(byText('Show Flue'));
    expect(p.onToggle).toHaveBeenCalledWith('flue-1');
    expect(byText('Add component').hasAttribute('disabled')).toBe(true);
    expect(byText('Accept all drafts').hasAttribute('disabled')).toBe(true);
    press(must(rows()[0]), 'a');
    expect(p.onStatus).not.toHaveBeenCalled();
  });
});
