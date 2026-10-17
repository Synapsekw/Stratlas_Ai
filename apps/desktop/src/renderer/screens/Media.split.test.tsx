// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { splitPrefs } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPinActions } from '../shell/actions/pinActions';
import { MediaScreen } from './Media';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// the viewer and the card draw images and canvases jsdom has not got: their place is enough here
vi.mock('@aio/annotate', async (load) => ({
  ...(await load<object>()),
  PhotoViewer: () => <div data-testid="photo-viewer" />,
}));
vi.mock('../issueCard/IssueCard', () => ({ IssueCard: () => <div data-testid="issue-card" /> }));
// a photo's size from its header: the wide one is 2:1
vi.mock('../thumbs/photoSize', () => ({
  photoSize: (url: string) =>
    Promise.resolve(url.includes('wide') ? ([2560, 1280] as const) : ([4000, 3000] as const)),
}));

const manifest = {
  schema: 'aio.project/1',
  id: 'p1',
  name: 'Tank farm',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      id: 'photos',
      kind: 'photos',
      name: 'Photos',
      items: [{ id: 'DJI_0001', file: 'photos/DJI_0001.jpg', position: [0, 0, 0] }],
    },
  ],
  severityModels: [],
  classCatalogues: [],
} as unknown as ProjectManifest;

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  // the screen is 1000 px wide, so a fraction reads as px
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 600,
    width: 1000,
    height: 600,
    toJSON: () => ({}),
  });
  Element.prototype.scrollIntoView = () => undefined;
  // the thumbnails load as they scroll into view
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe = () => undefined;
      unobserve = () => undefined;
      disconnect = () => undefined;
    },
  );
  splitPrefs.setState({ byId: {} });
  host = document.createElement('div');
  document.body.append(host);
  workspace.getState().openProject({ id: 'p1', root: 'E:/projects/p1', manifest });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render() {
  root = createRoot(host);
  act(() => root?.render(<MediaScreen />));
}

const separator = () => host.querySelector<HTMLElement>('[role="separator"]');

describe('Media on a split', () => {
  it('puts a handle between the library and an open photo, the photo at 54%', () => {
    workspace.getState().select({ kind: 'photo', id: 'DJI_0001', layer: 'photos' });
    render();
    const handle = separator();
    expect(handle?.getAttribute('aria-label')).toBe('Resize the library');
    expect(handle?.getAttribute('aria-valuenow')).toBe('540');
    const viewer = host.querySelector('.media-viewer');
    expect(handle?.getAttribute('aria-controls')).toBe(viewer?.id);
    expect(
      host.querySelector<HTMLElement>('.media-split')?.style.getPropertyValue('--split-size'),
    ).toBe('54%');
  });

  it('gives the library room in a narrow screen, says what is drawn and keeps the saved size', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 488,
      bottom: 600,
      width: 488,
      height: 600,
      toJSON: () => ({}),
    });
    workspace.getState().select({ kind: 'photo', id: 'DJI_0001', layer: 'photos' });
    render();
    const handle = separator();
    // the viewer gives way to 60% so the library keeps its tiles
    expect(handle?.getAttribute('aria-valuenow')).toBe('293');
    act(() => {
      handle?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      handle?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(splitPrefs.getState().byId['media.viewer']).toBeUndefined();
  });

  it('has no handle while no photo is open', () => {
    render();
    expect(host.querySelector('.media-main')).not.toBeNull();
    expect(separator()).toBeNull();
  });

  it('keeps the library in place when a photo opens', () => {
    render();
    const main = host.querySelector('.media-main');
    act(() => {
      workspace.getState().select({ kind: 'photo', id: 'DJI_0001', layer: 'photos' });
    });
    expect(separator()).not.toBeNull();
    expect(host.querySelector('.media-main')).toBe(main);
  });
});

describe('Media and pinned media', () => {
  const placing = {
    ...manifest,
    layers: [
      {
        id: 'set',
        kind: 'photos',
        name: 'Photos',
        visible: true,
        items: [
          { id: 'wide', src: { path: 'photos/wide.jpg' } },
          { id: 'gps', src: { path: 'photos/gps.jpg' }, pos: [1, 2, 3] },
        ],
      },
      {
        id: 'panos',
        kind: 'panoramas',
        name: '360s',
        visible: true,
        items: [
          { id: 'free', src: { path: 'panos/free.jpg' }, headingDeg: 0 },
          {
            id: 'pinned',
            src: { path: 'panos/pinned.jpg' },
            headingDeg: 0,
            pos: [0, 1.6, 0],
            pin: { ground: [0, 0, 0], eyeM: 1.6 },
          },
        ],
      },
    ],
  } as unknown as ProjectManifest;

  let off: () => void;
  beforeEach(() => {
    off = registerPinActions();
    workspace.getState().openProject({ id: 'p1', root: 'E:/projects/p1', manifest: placing });
  });
  afterEach(() => {
    off();
  });

  const notPlaced = () =>
    [...host.querySelectorAll<HTMLElement>('[data-testid="media-not-placed"]')].map(
      (e) => e.dataset.item,
    );

  it('says Not placed on an unplaced 360 and photo, and Not lined up yet on a pin without heading', () => {
    render();
    expect(notPlaced().sort()).toEqual(['free', 'wide']);
    expect(host.textContent).toContain('Not placed');
    expect(host.textContent).toContain('Not lined up yet');
  });

  it('says Looks like a 360 on a 2:1 photo, with Treat as 360', async () => {
    render();
    await act(async () => {
      await Promise.resolve();
    });
    const tile = host.querySelector('[data-photo="wide"]')?.closest('.m-tile');
    expect(tile?.textContent).toContain('Looks like a 360');
    expect(tile?.querySelector('[data-testid="media-treat-360"]')?.textContent).toBe(
      'Treat as 360',
    );
    const other = host.querySelector('[data-photo="gps"]')?.closest('.m-tile');
    expect(other?.textContent ?? '').not.toContain('Looks like a 360');
  });

  it('opens the pin actions on a right-click of a tile', () => {
    render();
    const tile = host.querySelector<HTMLElement>('[data-photo="gps"]');
    act(() => {
      tile?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
      );
    });
    expect(document.querySelector('[data-testid="ctx-item-media.move"]')).not.toBeNull();
  });
});
