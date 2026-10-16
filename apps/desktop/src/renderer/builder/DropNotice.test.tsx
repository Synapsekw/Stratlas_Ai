// @vitest-environment jsdom
import type { LayerPatch, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from '../shell';
import { DropNotice } from './DropNotice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saves: { layerIds: readonly string[]; patch: LayerPatch }[] = [];
let root: Root | undefined;
let host: HTMLElement;
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

vi.mock('@aio/engine', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveScene: () => ({}),
}));
vi.mock('@aio/pointcloud', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  cloudLowHeight: () => 31.2,
}));
vi.mock('./state', () => ({
  builder: {
    getState: () => ({
      saveLayers: (layerIds: readonly string[], patch: LayerPatch) => {
        saves.push({ layerIds, patch });
        return Promise.resolve(null);
      },
    }),
  },
}));
vi.mock('../shell/layerBounds', () => ({
  boundsOf: () => Promise.resolve({ min: [-1, 0, -1], max: [1, 2, 1] }),
}));
vi.mock('../shell/appBounds', () => ({
  appBoundsDeps: () => ({ manifest: { layers: [] }, rayDown: () => null }),
}));

const manifest = {
  crs: { epsg: 32639 },
  origin: [500000, 4000000, 10],
  layers: [
    {
      kind: 'pointcloud',
      id: 'c',
      name: 'Cloud',
      visible: true,
      src: { path: 'c.copc.laz' },
      format: 'copc',
    },
  ],
} as unknown as ProjectManifest;

const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });
};
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe('DropNotice', () => {
  beforeEach(() => {
    saves.length = 0;
    host = document.body.appendChild(document.createElement('div'));
    workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest });
    shell.setState({ screen: 'scene' });
  });
  afterEach(async () => {
    const { dropToGround } = await import('./dropSession');
    dropToGround.getState().dismiss();
    act(() => root?.unmount());
    root = undefined;
    host.remove();
  });

  it('shows the text and undoes on Ctrl+Z', async () => {
    const { dropToGround } = await import('./dropSession');
    root = createRoot(host);
    act(() => root?.render(<DropNotice />));
    await act(async () => {
      await dropToGround.getState().drop(['c']);
    });
    expect(saves).toEqual([{ layerIds: ['c'], patch: { heightOffsetM: -31.2 } }]);
    expect(byId('drop-notice')).not.toBeNull();
    expect(byId('drop-text')?.textContent).toBe(
      'Lowered Cloud 31.2 m (to the project ground level).',
    );
    expect(byId('drop-undo')).not.toBeNull();
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    press({ key: 'z', ctrlKey: true });
    window.removeEventListener('keydown', spy);
    await flush();
    expect(spy).not.toHaveBeenCalled();
    expect(saves.at(-1)).toEqual({ layerIds: ['c'], patch: { heightOffsetM: null } });
    expect(byId('drop-text')?.textContent).toBe('Drop undone.');
    expect(byId('drop-redo')).not.toBeNull();
    press({ key: 'y', ctrlKey: true });
    await flush();
    expect(saves.at(-1)).toEqual({ layerIds: ['c'], patch: { heightOffsetM: -31.2 } });
    expect(byId('drop-text')?.textContent).toBe('Dropped again.');
  });

  it('leaves Ctrl+Z to a field', async () => {
    const { dropToGround } = await import('./dropSession');
    root = createRoot(host);
    act(() => root?.render(<DropNotice />));
    await act(async () => {
      await dropToGround.getState().drop(['c']);
    });
    const input = host.appendChild(document.createElement('input'));
    press({ key: 'z', ctrlKey: true }, input);
    await flush();
    expect(saves).toHaveLength(1);
    expect(byId('drop-undo')).not.toBeNull();
  });
});
