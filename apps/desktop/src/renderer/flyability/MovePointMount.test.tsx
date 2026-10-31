// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pick = vi.hoisted(() => ({ armed: [] as boolean[] }));
vi.mock('../builder/pick', () => ({
  hitLayer: () => null,
  useStagePick: (armed: boolean) => {
    pick.armed.push(armed);
  },
}));
vi.mock('./IssueMenuMount', () => ({ IssueMenuMount: () => null }));

const { MovePointMount } = await import('./MovePointMount');
const { cancelMovePoint, moveSession, startMovePoint } = await import('./movePoint');
const { clearToasts, toastQueue } = await import('@aio/ui');

let root: Root | undefined;
let host: HTMLElement;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host.remove();
  cancelMovePoint();
  clearToasts();
});

describe('MovePointMount', () => {
  it('Escape cancels the move', () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root?.render(<MovePointMount />);
    });
    act(() => {
      startMovePoint('i1');
    });
    expect(pick.armed.at(-1)).toBe(true);
    expect(toastQueue().some((x) => x.id === 'fly-move-prompt')).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(moveSession.getState().issueId).toBeNull();
    expect(pick.armed.at(-1)).toBe(false);
    expect(toastQueue().some((x) => x.id === 'fly-move-prompt')).toBe(false);
  });
});
