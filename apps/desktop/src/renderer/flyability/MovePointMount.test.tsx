// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pick = vi.hoisted(() => ({ armed: [] as boolean[] }));
vi.mock('../builder/pick', () => ({
  hitLayer: () => null,
  useStagePick: (armed: boolean) => {
    pick.armed.push(armed);
  },
}));
const screens = vi.hoisted(() => ({
  set: vi.fn<(screen: string) => void>(),
}));
vi.mock('../shell', async () => {
  const { createStore: create, useStore: use } = await import('zustand');
  const store = create<{ screen: string }>()(() => ({ screen: 'scene' }));
  screens.set = (screen) => {
    store.setState({ screen });
  };
  return { useShell: <T,>(sel: (s: { screen: string }) => T) => use(store, sel) };
});

const { MovePointMount } = await import('./MovePointMount');
const { cancelMovePoint, moveSession, startMovePoint } = await import('./movePoint');
const { clearToasts, toastQueue } = await import('@aio/ui');

let root: Root | undefined;
let host: HTMLElement;
let pane: HTMLElement;

beforeEach(() => {
  pick.armed.length = 0;
  screens.set('scene');
  pane = document.createElement('div');
  pane.className = 'pane-3d';
  document.body.append(pane);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(<MovePointMount />);
  });
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host.remove();
  pane.remove();
  cancelMovePoint();
  clearToasts();
});

describe('MovePointMount', () => {
  it('arms the pick once the 3D pane exists', async () => {
    act(() => {
      startMovePoint('i1');
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(pick.armed.at(-1)).toBe(true);
  });

  it('Escape cancels the move', () => {
    act(() => {
      startMovePoint('i1');
    });
    expect(toastQueue().some((x) => x.id === 'fly-move-prompt')).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(moveSession.getState().issueId).toBeNull();
    expect(pick.armed.at(-1)).toBe(false);
    expect(toastQueue().some((x) => x.id === 'fly-move-prompt')).toBe(false);
  });

  it('leaving the Scene screen cancels the move', () => {
    act(() => {
      startMovePoint('i1');
    });
    act(() => {
      screens.set('issues');
    });
    expect(moveSession.getState().issueId).toBeNull();
  });

  it('unmounting cancels the move', () => {
    act(() => {
      startMovePoint('i1');
    });
    act(() => {
      root?.unmount();
    });
    root = undefined;
    expect(moveSession.getState().issueId).toBeNull();
  });
});
