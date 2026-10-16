// @vitest-environment jsdom
import { emptyOrientation, type ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlignToNotice } from './AlignToNotice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saves: unknown[] = [];
let root: Root | undefined;
let host: HTMLElement;
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

vi.mock('./orientationFile', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    retryOrientation: vi.fn(),
    saveOrientationEdit: vi.fn((edit: (f: ReturnType<typeof emptyOrientation>) => never) => {
      const next = edit(workspace.getState().orientation ?? emptyOrientation());
      saves.push(next);
      workspace.getState().setOrientation(next);
      return Promise.resolve(null);
    }),
  };
});
vi.mock('../shell/layerBounds', () => ({
  boundsOf: () => Promise.resolve({ min: [-1, 0, -1], max: [1, 2, 1] }),
  groundAt: () => Promise.resolve(null),
}));
vi.mock('../shell/appBounds', () => ({ appBoundsDeps: () => ({}) }));

const manifest = {
  layers: [
    {
      kind: 'photos',
      id: 'ph',
      name: 'Flight',
      visible: true,
      items: [{ id: 'a', src: { path: 'a' }, pos: [91000, 40, 2000] }],
    },
    { kind: 'mesh', id: 'm', name: 'Site model', visible: true, src: { path: 'm' }, transform: [] },
  ],
} as unknown as ProjectManifest;

const press = (init: KeyboardEventInit) => {
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });
};

describe('AlignToNotice', () => {
  beforeEach(() => {
    saves.length = 0;
    host = document.body.appendChild(document.createElement('div'));
    workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest });
    workspace.getState().setOrientation(emptyOrientation());
  });
  afterEach(async () => {
    const { alignTo } = await import('./alignSession');
    alignTo.getState().dismiss();
    act(() => root?.unmount());
    root = undefined;
    host.remove();
  });

  it('shows the text and Undo; Ctrl+Z undoes and is stopped, Ctrl+Y redoes', async () => {
    const { alignTo } = await import('./alignSession');
    root = createRoot(host);
    act(() => root?.render(<AlignToNotice />));
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    await act(async () => {
      await alignTo.getState().alignTo({ layerIds: ['ph'] }, 'm');
    });
    expect(byId('align-to-text')?.textContent).toContain('Aligned 1 photo');
    expect(byId('align-to-undo')).not.toBeNull();

    // a key typed in an input is left alone
    const input = document.body.appendChild(document.createElement('input'));
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(saves).toHaveLength(1);
    input.remove();

    spy.mockClear();
    await act(async () => {
      press({ key: 'z', ctrlKey: true });
      await Promise.resolve();
    });
    expect(spy).not.toHaveBeenCalled();
    expect(saves).toHaveLength(2);
    expect(byId('align-to-redo')).not.toBeNull();

    await act(async () => {
      press({ key: 'y', ctrlKey: true });
      await Promise.resolve();
    });
    expect(saves).toHaveLength(3);

    act(() => {
      alignTo.getState().dismiss();
    });
    press({ key: 'z', ctrlKey: true });
    expect(spy).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', spy);
  });
});
