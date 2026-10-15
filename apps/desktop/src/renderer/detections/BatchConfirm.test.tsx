// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BatchConfirm, BatchError } from './BatchConfirm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
});

function render(ui: React.ReactElement) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(ui);
  });
  return host;
}

describe('Accept all confirm', () => {
  it('asks to accept N and says how many are skipped', () => {
    const onConfirm = vi.fn();
    const el = render(
      <BatchConfirm
        kind="accept"
        plan={{ accept: 4, skip: 2, reject: 6 }}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expect(el.textContent).toContain('Accept 4 detections as issues?');
    expect(el.textContent).toContain('2 have no class or severity and will be skipped.');
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="det-batch-ok"]')?.click();
    });
    expect(onConfirm).toHaveBeenCalled();
  });

  it('keeps Enter and other keys from the review shortcuts; Escape cancels', () => {
    const onCancel = vi.fn();
    const seen = vi.fn();
    const outer = render(
      <div onKeyDown={seen}>
        <BatchConfirm
          kind="accept"
          plan={{ accept: 1, skip: 0, reject: 1 }}
          onConfirm={vi.fn()}
          onCancel={onCancel}
        />
      </div>,
    );
    const ok = outer.querySelector<HTMLButtonElement>('[data-testid="det-batch-ok"]');
    act(() => {
      ok?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      ok?.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    });
    expect(seen).not.toHaveBeenCalled();
    act(() => {
      ok?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalled();
  });

  it('shows a refused batch or undo even with no detection current', () => {
    const el = render(<BatchError message="Moved on." />);
    expect(el.querySelector('[data-testid="det-batch-error"]')?.textContent).toBe('Moved on.');
  });

  it('says nothing about skips when there are none; Reject asks for the waiting count', () => {
    const onCancel = vi.fn();
    const el = render(
      <BatchConfirm
        kind="reject"
        plan={{ accept: 1, skip: 0, reject: 1 }}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    expect(el.textContent).toContain('Reject 1 detection?');
    expect(el.textContent).not.toContain('skipped');
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-testid="det-batch-cancel"]')?.click();
    });
    expect(onCancel).toHaveBeenCalled();
  });
});
