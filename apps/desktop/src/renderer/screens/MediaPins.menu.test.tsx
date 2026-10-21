// @vitest-environment jsdom
import { emptyOrientation, type ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act, useEffect, type MouseEvent as ReactMouseEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerSidebarActions } from '../shell/actions';
import { mediaPicks } from './mediaSelect';
import { useTileMenu } from './MediaPins';
import type { MediaKey } from '../pins/pinModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest = {
  captures: [],
  origin: [0, 0, 0],
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
} as unknown as ProjectManifest;

let opener: ((k: MediaKey) => void) | null = null;
function Host() {
  const m = useTileMenu();
  const { open } = m;
  useEffect(() => {
    opener = (k) => {
      open(
        { clientX: 10, clientY: 10, preventDefault: () => undefined } as unknown as ReactMouseEvent,
        k,
      );
    };
  }, [open]);
  return m.menu;
}

let root: Root | undefined;
let host: HTMLElement;
const menu = () => document.querySelector<HTMLElement>('[data-testid="ctx-menu"]');

beforeEach(() => {
  registerSidebarActions();
  workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest });
  workspace.getState().setOrientation(emptyOrientation());
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  act(() => root?.render(<Host />));
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  mediaPicks.getState().clear();
});

const rightClick = (itemId: string) => {
  act(() => {
    opener?.({ kind: 'photo', layerId: 'ph', itemId });
  });
};

describe('the Media tile menu', () => {
  it('heads the menu of several picked tiles with their count, and lists Edit position', () => {
    mediaPicks.getState().reset('p', [
      { layerId: 'ph', photoId: 'a' },
      { layerId: 'ph', photoId: 'b' },
    ]);
    rightClick('b');
    expect(menu()?.getAttribute('aria-label')).toBe('2 photos');
    expect(menu()?.textContent).toContain('2 photos');
    expect(menu()?.querySelector('[data-testid="ctx-item-photos.editPosition"]')).not.toBeNull();
  });

  it('names the one tile it opened on when it is not among the picks', () => {
    rightClick('a');
    expect(menu()?.getAttribute('aria-label')).not.toBe('1 photo');
    expect(menu()?.textContent).not.toContain('2 photos');
    expect(menu()?.querySelector('[data-testid="ctx-item-photos.editPosition"]')).not.toBeNull();
  });
});
