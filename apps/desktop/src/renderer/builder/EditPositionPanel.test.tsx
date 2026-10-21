// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { PositionEditStore, PositionPanel } from './positionEditStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { save, cancel, reset } = vi.hoisted(() => ({
  save: vi.fn<PositionEditStore['save']>(() => Promise.resolve()),
  cancel: vi.fn(),
  reset: vi.fn<PositionEditStore['reset']>(() => Promise.resolve()),
}));

vi.mock('./alignSession', async () => {
  const { useStore } = await import('zustand');
  const positionEdit = createStore<PositionEditStore>()(() => ({
    panel: null,
    notice: null,
    open: () => null,
    save,
    cancel,
    reset,
    apply: () => Promise.resolve(),
    dismiss: () => undefined,
  }));
  return {
    positionEdit,
    usePositionEdit: (sel: (x: PositionEditStore) => unknown) => useStore(positionEdit, sel),
  };
});

const { EditPositionPanel } = await import('./EditPositionPanel');
const { positionEdit } = await import('./alignSession');
const pe = () => positionEdit;

const ONE: PositionPanel = {
  mode: 'one',
  projectId: 'p',
  pick: { layerId: 'ph', photoId: 'a' },
  current: { x: 12.5, y: -3.25, z: 41 },
  original: { x: 12.5, y: -3.25, z: 36 },
  edited: true,
  skipped: 0,
  at: { x: 100, y: 100 },
};
const MANY: PositionPanel = {
  mode: 'many',
  projectId: 'p',
  picks: [
    { layerId: 'ph', photoId: 'a' },
    { layerId: 'ph', photoId: 'b' },
  ],
  count: 2,
  skipped: 0,
  at: null,
};

let root: Root | undefined;
let host: HTMLElement;
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const input = (k: 'x' | 'y' | 'z') =>
  document.querySelector<HTMLInputElement>(`[data-testid="position-input-${k}"]`);
const saveButton = () => document.querySelector<HTMLButtonElement>('[data-testid="position-save"]');

/** Type into a React-controlled input. */
function type(el: HTMLInputElement | null, value: string) {
  if (!el) throw new Error('no input');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const show = (panel: PositionPanel | null) => {
  act(() => {
    pe().setState({ panel });
  });
  act(() => root?.render(<EditPositionPanel />));
};

beforeEach(() => {
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  save.mockClear();
  cancel.mockClear();
  reset.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  pe().setState({ panel: null });
});

describe('EditPositionPanel', () => {
  it('shows nothing without a panel', () => {
    show(null);
    expect(byId('position-panel')).toBeNull();
  });

  it('shows the current X, Y, Z and the original of one photo', () => {
    show(ONE);
    expect(byId('position-panel')).not.toBeNull();
    expect(input('x')?.value).toBe('12.500');
    expect(input('y')?.value).toBe('-3.250');
    expect(input('z')?.value).toBe('41.000');
    expect(byId('position-panel')?.textContent).toContain('Original: 12.500, -3.250, 36.000');
    expect(byId('position-reset')).not.toBeNull();
  });

  it('has no Reset for a photo that is not edited', () => {
    show({ ...ONE, edited: false });
    expect(byId('position-reset')).toBeNull();
  });

  it('greys Save while a field is not a number in range', () => {
    show(ONE);
    type(input('z'), 'abc');
    expect(saveButton()?.disabled).toBe(true);
    expect(input('z')?.getAttribute('aria-invalid')).toBe('true');
    type(input('z'), '20000');
    expect(saveButton()?.disabled).toBe(true);
    type(input('z'), '45,5');
    expect(saveButton()?.disabled).toBe(false);
    expect(input('z')?.getAttribute('aria-invalid')).toBeNull();
  });

  it('saves the parsed numbers', () => {
    show(ONE);
    type(input('z'), '46.25');
    act(() => {
      byId('position-save')?.click();
    });
    expect(save).toHaveBeenCalledWith({ x: 12.5, y: -3.25, z: 46.25 });
  });

  it('saves on Enter', () => {
    show(ONE);
    act(() => {
      input('x')?.form?.requestSubmit();
    });
    expect(save).toHaveBeenCalledWith({ x: 12.5, y: -3.25, z: 41 });
  });

  it('cancels, and resets the photo', () => {
    show(ONE);
    act(() => {
      byId('position-cancel')?.click();
    });
    expect(cancel).toHaveBeenCalled();
    show(ONE);
    act(() => {
      byId('position-reset')?.click();
    });
    expect(reset).toHaveBeenCalledWith([{ layerId: 'ph', photoId: 'a' }]);
  });

  it('takes a shift for several photos, empty fields counting as zero', () => {
    show(MANY);
    expect(byId('position-panel')?.textContent).toContain('Shift 2 photos');
    expect(input('x')?.value).toBe('');
    expect(byId('position-reset')).toBeNull();
    type(input('z'), '-100');
    act(() => {
      byId('position-save')?.click();
    });
    expect(save).toHaveBeenCalledWith({ x: 0, y: 0, z: -100 });
  });
});
