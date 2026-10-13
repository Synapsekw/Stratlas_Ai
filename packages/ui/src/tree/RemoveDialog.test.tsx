// @vitest-environment jsdom
import { emptyRemovalPlan } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoveDialog, type RemoveDialogProps } from './RemoveDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
});
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

  it('shows the loading line and no Delete while the plan is worked out', () => {
    show({ plan: null });
    expect(q('remove-dialog')?.textContent).toContain('Working out what goes with it');
    expect(q('remove-dialog-confirm')).toBeNull();
  });

  it('a refused plan shows its reason and only Close', () => {
    const p = show({
      plan: {
        ...emptyRemovalPlan(),
        refused: 'Creating maps for run r3 is still running. Cancel it first.',
      },
    });
    expect(q('remove-dialog-refused')?.textContent).toContain('still running');
    expect(q('remove-dialog-confirm')).toBeNull();
    act(() => q('remove-dialog-close')?.click());
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows why the last Delete failed', () => {
    show({
      error: 'photos/p1.jpg could not be moved to the project trash (busy). Nothing was removed.',
    });
    expect(q('remove-dialog-error')?.textContent).toContain('Nothing was deleted.');
  });
});
