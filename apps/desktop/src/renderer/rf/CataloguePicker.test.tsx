// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AAU_ENTRY, ANTENNA_ENTRY, RADIO_ENTRY } from './__fixtures__/rfData';
import { CataloguePicker, type CataloguePickerProps } from './CataloguePicker';
import { resetRf, rfStore } from './rfStore';

vi.mock('../shell', () => ({ bridge: { call: vi.fn() }, jobs: {} }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
const byTest = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const render = (props: Partial<CataloguePickerProps> = {}) => {
  const onPick = vi.fn();
  const onClose = vi.fn();
  root = createRoot(host);
  act(() =>
    root?.render(
      <CataloguePicker
        kinds={['radio', 'aau']}
        initialKind="aau"
        band="n78"
        context="A1 · 3500 MHz (n78)"
        opener={null}
        onPick={onPick}
        onClose={onClose}
        {...props}
      />,
    ),
  );
  return { onPick, onClose };
};
const type = (text: string) => {
  const input = document.body.querySelector<HTMLInputElement>('.rf-cat-search');
  if (!input) throw new Error('no search');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

beforeEach(() => {
  resetRf();
  rfStore.setState({
    catalogue: [ANTENNA_ENTRY, RADIO_ENTRY, AAU_ENTRY].map((entry) => ({
      origin: 'builtin' as const,
      entry,
    })),
  });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('CataloguePicker', () => {
  it('lists the entries of the open kind that support the band, with power and a verified mark', () => {
    render();
    const row = byTest('rf-cat-aau-x');
    expect(row?.textContent).toContain('Maker A1');
    expect(row?.textContent).toContain('200 W total');
    expect(row?.textContent).toContain('verified');
    expect(row?.textContent).toContain('n78');
    // a radio is another tab
    expect(byTest('rf-cat-rru-x')).toBeNull();
  });

  it('shows the EmptyState when nothing matches, and Clear filters brings the list back', () => {
    render();
    type('nothing like this');
    expect(byTest('rf-cat-aau-x')).toBeNull();
    const empty = document.body.querySelector('.empty-state');
    expect(empty?.textContent).toContain('No equipment matches');
    act(() => empty?.querySelector('button')?.click());
    expect(byTest('rf-cat-aau-x')).not.toBeNull();
  });

  it('hides entries outside the band until the band filter is off', () => {
    render({ kinds: ['radio'], initialKind: 'radio' });
    // the radio covers 1710 to 2690 MHz, not n78
    expect(byTest('rf-cat-rru-x')).toBeNull();
    expect(document.body.querySelector('.empty-state')).not.toBeNull();
    const supports = [
      ...document.body.querySelectorAll<HTMLElement>('.rf-cat-filters button'),
    ].find((b) => b.textContent === 'Supports n78');
    act(() => supports?.click());
    expect(byTest('rf-cat-rru-x')?.textContent).toContain('4T4R');
  });

  it('uses the chosen entry, and refuses one the field cannot take', () => {
    const { onPick } = render({
      kinds: ['radio'],
      initialKind: 'radio',
      band: null,
      blockedReason: (k) => (k === 'radio' ? 'Choose the antenna first' : undefined),
    });
    act(() => byTest('rf-cat-rru-x')?.click());
    const use = byTest('rf-cat-use');
    expect(use?.getAttribute('aria-disabled')).toBe('true');
    expect(use?.textContent).toContain('Choose the antenna first');
    act(() => use?.click());
    expect(onPick).not.toHaveBeenCalled();
    act(() => root?.unmount());
    const second = render({ kinds: ['aau'], initialKind: 'aau' });
    act(() => byTest('rf-cat-aau-x')?.click());
    act(() => byTest('rf-cat-use')?.click());
    expect(second.onPick).toHaveBeenCalledWith(AAU_ENTRY);
  });

  it('filters by vendor and closes on Esc', () => {
    const { onClose } = render();
    const vendor = [...document.body.querySelectorAll<HTMLElement>('.rf-cat-filters button')].find(
      (b) => b.textContent === 'Maker',
    );
    act(() => vendor?.click());
    expect(vendor?.getAttribute('aria-pressed')).toBe('true');
    expect(byTest('rf-cat-aau-x')).not.toBeNull();
    act(() => {
      byTest('rf-catalogue')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalled();
  });
});
