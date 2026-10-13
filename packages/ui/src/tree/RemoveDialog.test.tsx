// @vitest-environment jsdom
import { emptyRemovalPlan } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoveDialog, type RemoveDialogProps } from './RemoveDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let shown: RemoveDialogProps | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  shown = null;
});
/** The open dialog again with some props changed (a plan coming back, a Delete ending). */
const update = (p: Partial<RemoveDialogProps>) => {
  if (!shown) throw new Error('nothing shown');
  const next: RemoveDialogProps = { ...shown, ...p };
  shown = next;
  act(() => root?.render(<RemoveDialog {...next} />));
};
const escape = () => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
};
const refusedPlan = {
  ...emptyRemovalPlan(),
  refused: 'Creating maps for run r3 is still running. Cancel it first.',
};
const show = (p: Partial<RemoveDialogProps>) => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const props: RemoveDialogProps = {
    targets: [{ run: 'r3' }],
    plan: { ...emptyRemovalPlan(), runs: [{ id: 'r3', status: 'failed', why: 'asked' }] },
    busy: false,
    error: null,
    dateLabel: (id) => id,
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...p,
  };
  shown = props;
  act(() => root?.render(<RemoveDialog {...props} />));
  return props;
};
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('RemoveDialog', () => {
  it('is an alertdialog with Cancel focused first, and Delete confirms', () => {
    const p = show({});
    expect(q('remove-dialog')?.getAttribute('role')).toBe('alertdialog');
    expect(q('remove-dialog-title')?.textContent).toBe('Delete run r3?');
    expect(document.activeElement).toBe(q('remove-dialog-cancel'));
    act(() => q('remove-dialog-confirm')?.click());
    expect(p.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows the loading line once and no Delete while the plan is worked out', () => {
    show({ plan: null });
    const text = q('remove-dialog')?.textContent ?? '';
    expect(text.match(/Working out what goes with it/g)).toHaveLength(1);
    expect(q('remove-dialog-confirm')).toBeNull();
  });

  it('a refused plan shows its reason and only Close', () => {
    const p = show({ plan: refusedPlan });
    expect(q('remove-dialog-refused')?.textContent).toContain('still running');
    expect(q('remove-dialog-confirm')).toBeNull();
    act(() => q('remove-dialog-close')?.click());
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows why the last Delete failed', () => {
    show({
      error: 'photos/p1.jpg could not be moved to the project trash (busy). Nothing was removed.',
    });
    const text = q('remove-dialog-error')?.textContent ?? '';
    expect(text).toContain('Delete did not go through.');
    // one "Nothing was" phrase: main's own
    expect(text.match(/Nothing was/g)).toHaveLength(1);
  });

  it('a plan that comes back refused: focus on Close, and Escape closes', () => {
    const p = show({ plan: null });
    expect(document.activeElement).toBe(q('remove-dialog-cancel'));
    update({ plan: refusedPlan });
    expect(document.activeElement).toBe(q('remove-dialog-close'));
    escape();
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  it('Escape does nothing while Delete is busy, and cancels after a failed Delete', () => {
    const p = show({});
    act(() => q('remove-dialog-confirm')?.focus());
    // Chromium drops focus from a button that goes disabled; jsdom does not, so drop it here
    act(() => q('remove-dialog-confirm')?.blur());
    update({ busy: true });
    expect(document.activeElement).toBe(document.body);
    escape();
    expect(p.onCancel).not.toHaveBeenCalled();
    update({ busy: false, error: 'photos/p1.jpg is held open. Nothing was removed.' });
    expect(document.activeElement).toBe(q('remove-dialog-cancel'));
    escape();
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  it('a plan that could not be worked out: says so once, with the error and Close', () => {
    const p = show({ plan: null, error: 'The project folder could not be read.' });
    expect(q('remove-dialog-title')?.textContent).toBe('This cannot be deleted now');
    expect(q('remove-dialog')?.textContent).not.toContain('Working out what goes with it');
    expect(q('remove-dialog-error')?.textContent).toContain('could not be read');
    expect(q('remove-dialog-cancel')).toBeNull();
    expect(document.activeElement).toBe(q('remove-dialog-close'));
    act(() => q('remove-dialog-close')?.click());
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  it('two marked layers of the same name are both listed', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    show({
      targets: [{ layer: 'a' }, { layer: 'b' }],
      plan: {
        ...emptyRemovalPlan(),
        layers: [
          { id: 'a', name: 'Photos', kind: 'photos', why: 'asked' },
          { id: 'b', name: 'Photos', kind: 'photos', why: 'asked' },
        ],
      },
    });
    expect(q('remove-dialog-asked')?.querySelectorAll('li')).toHaveLength(2);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
