// @vitest-environment jsdom
import type { SceneHandle } from '@aio/engine';
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from '../shell';
import { registerSidebarActions } from '../shell/actions';
import { PhotoMenu } from './PhotoMenu';
import { builder } from './state';

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

describe('the photo menu and pins', () => {
  it('lists Move pin, Set direction and Remove pin on a pinned photo, beside Open', () => {
    open(PINNED);
    rightClick();
    expect(byId('photo-menu-open')).not.toBeNull();
    expect(byId('ctx-item-media.move')?.textContent).toContain('Move pin');
    expect(byId('ctx-item-media.direction')?.textContent).toContain('Set direction');
    expect(byId('ctx-item-media.remove')?.textContent).toContain('Remove pin');
    expect(byId('ctx-item-media.place')).toBeNull();
  });

  it('lists Place on site on a photo with no place', () => {
    open({});
    rightClick();
    expect(byId('ctx-item-media.place')?.textContent).toContain('Place on site');
    expect(byId('ctx-item-media.remove')).toBeNull();
  });

  it('lists no pin items in a package', () => {
    shell.setState({ pkg: {} as never });
    open(PINNED);
    rightClick();
    expect(byId('photo-menu-open')).not.toBeNull();
    expect(byId('ctx-item-media.move')).toBeNull();
  });

  it('Remove pin saves a null pin and closes the menu', () => {
    const saveLayers = vi.fn(() => Promise.resolve(null));
    builder.setState({ saveLayers } as never);
    open(PINNED);
    rightClick();
    act(() => {
      byId('ctx-item-media.remove')?.click();
    });
    expect(saveLayers).toHaveBeenCalledWith(['ph'], { mediaPin: { itemId: 'a', pin: null } });
    expect(byId('photo-menu')).toBeNull();
  });
});
