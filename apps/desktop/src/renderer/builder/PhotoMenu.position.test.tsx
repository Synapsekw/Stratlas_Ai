// @vitest-environment jsdom
import type { SceneHandle } from '@aio/engine';
import { emptyOrientation, type ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from '../shell';
import { registerSidebarActions } from '../shell/actions';
import { PhotoMenu } from './PhotoMenu';
import { positionEdit } from './alignSession';
import { photoPicks } from './photoPicks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// photo `a` is under every right-click in 3D
const fake = {
  scene: {
    children: [
      {
        visible: true,
        userData: { photosLayer: 'ph', photoIdsAt: () => ['a'] },
        children: [],
        getObjectByName: () => undefined,
      },
    ],
  },
  camera: {},
  requestRender: () => undefined,
} as unknown as SceneHandle;

vi.mock('@aio/engine', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveScene: () => fake,
  onActiveScene: () => () => undefined,
}));

const open = (a: Record<string, unknown>) => {
  workspace.getState().openProject({
    id: 'p',
    root: 'C:/p',
    manifest: {
      layers: [
        {
          kind: 'photos',
          id: 'ph',
          name: 'Flight',
          visible: true,
          items: [{ id: 'a', src: { path: 'a.jpg' }, ...a }],
        },
      ],
      captures: [],
      origin: [0, 0, 10],
    } as unknown as ProjectManifest,
  });
};
const PINNED = { pos: [1, 1.6, 3], pin: { ground: [1, 0, 3], eyeM: 1.6 } };

let root: Root | undefined;
let host: HTMLElement;
let pane: HTMLElement;
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  registerSidebarActions();
  host = document.body.appendChild(document.createElement('div'));
  pane = document.body.appendChild(document.createElement('div'));
  pane.className = 'pane-3d';
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  shell.setState({ pkg: null });
  host.remove();
  pane.remove();
  vi.restoreAllMocks();
});

const rightClick = () => {
  act(() => root?.render(<PhotoMenu />));
  act(() => {
    pane.dispatchEvent(
      new PointerEvent('pointerdown', { button: 2, clientX: 5, clientY: 5, bubbles: true }),
    );
    pane.dispatchEvent(
      new MouseEvent('contextmenu', { clientX: 5, clientY: 5, bubbles: true, cancelable: true }),
    );
  });
};

describe('the photo menu and Edit position', () => {
  afterEach(() => {
    positionEdit.setState({ panel: null, notice: null });
    photoPicks.getState().clear();
  });

  it('lists Edit position on a GPS photo; it opens the panel at the menu point', () => {
    open({ pos: [1, 2, 3] });
    workspace.getState().setOrientation(emptyOrientation());
    rightClick();
    expect(byId('ctx-item-photos.editPosition')?.textContent).toContain('Edit position');
    expect(byId('ctx-item-photos.resetPosition')).toBeNull();
    act(() => {
      byId('ctx-item-photos.editPosition')?.click();
    });
    expect(byId('photo-menu')).toBeNull();
    const p = positionEdit.getState().panel;
    expect(p?.mode).toBe('one');
    expect(p?.at).toEqual({ x: 5, y: 5 });
  });

  it('lists Reset to original on an edited photo', () => {
    open({ pos: [1, 2, 3] });
    workspace.getState().setOrientation({
      ...emptyOrientation(),
      photos: { ph: { a: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [0, 5, 0] } } },
    });
    rightClick();
    expect(byId('ctx-item-photos.resetPosition')?.textContent).toContain('Reset to original');
  });

  it('greys Edit position on a pinned photo and says to use Move pin', () => {
    open(PINNED);
    rightClick();
    const it1 = byId('ctx-item-photos.editPosition') as HTMLButtonElement | null;
    expect(it1?.disabled).toBe(true);
    expect(it1?.textContent).toContain('Pinned: use Move pin.');
  });

  it('lists Edit position in the menu of several picked photos', () => {
    workspace.getState().openProject({
      id: 'p',
      root: 'C:/p',
      manifest: {
        layers: [
          {
            kind: 'photos',
            id: 'ph',
            name: 'Flight',
            visible: true,
            items: [
              { id: 'a', src: { path: 'a.jpg' }, pos: [1, 2, 3] },
              { id: 'b', src: { path: 'b.jpg' }, pos: [4, 5, 6] },
            ],
          },
        ],
        captures: [],
      } as unknown as ProjectManifest,
    });
    workspace.getState().setOrientation(emptyOrientation());
    photoPicks.setState({
      picks: [
        { layerId: 'ph', photoId: 'a' },
        { layerId: 'ph', photoId: 'b' },
      ],
    });
    rightClick();
    expect(byId('photo-menu')?.textContent).toContain('2 photos');
    act(() => {
      byId('ctx-item-photos.editPosition')?.click();
    });
    const p = positionEdit.getState().panel;
    expect(p?.mode === 'many' ? p.count : 0).toBe(2);
  });
});
