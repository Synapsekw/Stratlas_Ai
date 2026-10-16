// @vitest-environment jsdom
import type { SceneHandle } from '@aio/engine';
import type { Layer, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotoPicksNotice } from '../exports/Toasts';
import { shell } from '../shell';
import { registerSidebarActions } from '../shell/actions';
import { PhotoMenu } from './PhotoMenu';
import { PhotoPickInput, prunePicks } from './PhotoPickInput';
import { photoPicks } from './photoPicks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const photos = (items: string[]): Layer =>
  ({
    kind: 'photos',
    id: 'ph',
    name: 'Flight',
    visible: true,
    items: items.map((id) => ({ id, src: { path: id }, pos: [1, 2, 3] })),
  }) as unknown as Layer;
const model = {
  kind: 'mesh',
  id: 'm',
  name: 'Model',
  visible: true,
  src: { path: 'm' },
  transform: [],
} as unknown as Layer;
const open = (id: string, layers: Layer[]) => {
  workspace.getState().openProject({
    id,
    root: 'C:/p',
    manifest: { layers, captures: [] } as unknown as ProjectManifest,
  });
};
const a = { layerId: 'ph', photoId: 'a' };
const b = { layerId: 'ph', photoId: 'b' };

let root: Root | undefined;
let host: HTMLElement;
let pane: HTMLElement;
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (el: HTMLElement | null) => {
  act(() => {
    el?.click();
  });
};

describe('picked photos', () => {
  beforeEach(() => {
    registerSidebarActions();
    host = document.body.appendChild(document.createElement('div'));
    pane = document.body.appendChild(document.createElement('div'));
    pane.className = 'pane-3d';
    root = createRoot(host);
    open('p', [photos(['a', 'b']), model]);
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    photoPicks.getState().clear();
    shell.setState({ pkg: null });
    host.remove();
    pane.remove();
  });

  const rightClickA = () => {
    act(() => {
      pane.dispatchEvent(
        new PointerEvent('pointerdown', { button: 2, clientX: 5, clientY: 5, bubbles: true }),
      );
      pane.dispatchEvent(
        new MouseEvent('contextmenu', { clientX: 5, clientY: 5, bubbles: true, cancelable: true }),
      );
    });
  };

  it('the menu of a picked photo acts on the picks, with a count header', () => {
    photoPicks.getState().add([a, b]);
    act(() => root?.render(<PhotoMenu />));
    rightClickA();
    const menu = byId('photo-menu');
    expect(menu?.textContent).toContain('2 photos picked');
    expect(byId('photo-menu-alignTo')?.textContent).toContain('Align to...');
    expect(byId('photo-menu-alignTo')?.hasAttribute('disabled')).toBe(false);
    expect(byId('photo-menu-open')).toBeNull();
    click(byId('photo-menu-clearPicks'));
    expect(photoPicks.getState().picks).toEqual([]);
    expect(byId('photo-menu')).toBeNull();
  });

  it('Align to... opens the submenu for the picks', () => {
    photoPicks.getState().add([a, b]);
    act(() => root?.render(<PhotoMenu />));
    rightClickA();
    click(byId('photo-menu-alignTo'));
    expect(byId('photo-menu')).toBeNull();
    expect(byId('ctx-menu')).not.toBeNull();
    expect(byId('ctx-menu')?.textContent).toContain('Model');
  });

  it('is greyed when the project is read-only', () => {
    shell.setState({ pkg: {} as never });
    photoPicks.getState().add([a, b]);
    act(() => root?.render(<PhotoMenu />));
    rightClickA();
    expect(byId('photo-menu-alignTo')?.hasAttribute('disabled')).toBe(true);
  });

  it('a photo that is not picked keeps its own menu, with Align to...', () => {
    act(() => root?.render(<PhotoMenu />));
    rightClickA();
    expect(byId('photo-menu-open')).not.toBeNull();
    expect(byId('photo-menu-alignTo')).not.toBeNull();
  });

  it('the notice shows the count and Clear empties the picks', () => {
    act(() => root?.render(<PhotoPicksNotice />));
    expect(byId('photo-picks')).toBeNull();
    act(() => {
      photoPicks.getState().add([a, b]);
    });
    expect(byId('photo-picks')?.textContent).toContain('2 photos picked');
    click(byId('photo-picks')?.querySelector('button') ?? null);
    expect(photoPicks.getState().picks).toEqual([]);
    expect(byId('photo-picks')).toBeNull();
  });

  it('picks go when a photo or its set is deleted, the project changes, Escape is pressed or the scene unmounts', () => {
    act(() => root?.render(<PhotoPickInput />));
    photoPicks.getState().add([a, b]);
    act(() => {
      open('p', [photos(['a']), model]);
    });
    expect(photoPicks.getState().picks).toEqual([a]);
    act(() => {
      open('p', [model]);
    });
    expect(photoPicks.getState().picks).toEqual([]);

    open('p', [photos(['a', 'b']), model]);
    photoPicks.getState().add([a]);
    act(() => {
      open('q', [photos(['a', 'b']), model]);
    });
    expect(photoPicks.getState().picks).toEqual([]);

    photoPicks.getState().add([a]);
    const input = document.body.appendChild(document.createElement('input'));
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(photoPicks.getState().picks).toEqual([a]);
    input.remove();
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(photoPicks.getState().picks).toEqual([]);

    photoPicks.getState().add([a]);
    act(() => root?.unmount());
    root = createRoot(host);
    expect(photoPicks.getState().picks).toEqual([]);
  });

  it('prunePicks keeps only picks that still exist', () => {
    expect(prunePicks([a, b], [photos(['b'])])).toEqual([b]);
  });
});
