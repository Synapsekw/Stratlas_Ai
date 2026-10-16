// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { splitPrefs } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaScreen } from './Media';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// the viewer and the card draw images and canvases jsdom has not got: their place is enough here
vi.mock('@aio/annotate', async (load) => ({
  ...(await load<object>()),
  PhotoViewer: () => <div data-testid="photo-viewer" />,
}));
vi.mock('../issueCard/IssueCard', () => ({ IssueCard: () => <div data-testid="issue-card" /> }));

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
