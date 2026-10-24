// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinSession } from '../pins/placePin';
import type { PhotoFindings } from '../screens/mediaFindings';
import { mediaPicks } from '../screens/mediaSelect';
import { DEFAULT_MEDIA_VIEW, mediaView, setMediaView } from '../screens/mediaView';
import { shell } from '../shell';
import { registerPinActions } from '../shell/actions/pinActions';
import { PhotoColumn } from './PhotoColumn';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// a photo's size from its header: the wide one is 2:1
const { photoSize } = vi.hoisted(() => ({
  photoSize: vi.fn((url: string) =>
    Promise.resolve(url.includes('wide') ? ([2560, 1280] as const) : ([4000, 3000] as const)),
  ),
}));
vi.mock('../thumbs/photoSize', () => ({ photoSize }));
vi.mock('../thumbs/Thumb', () => ({ MediaThumb: () => null }));

const SEVERE_COLOR = '#c0392b';
const LOW_COLOR = '#2e9e5b';

const item = (id: string, extra: object = {}) => ({
  id,
  src: { path: `photos/${id}.jpg` },
  pos: [1, 2, 3],
  ...extra,
});

const manifest = {
  schema: 'aio.project/1',
  id: 'p1',
  name: 'Tank farm',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      id: 'set',
      kind: 'photos',
      name: 'Photos',
      visible: true,
      items: [
        item('p1'),
        item('p2'),
        item('p3'),
        item('wide', { pos: undefined }),
        item('lensed', { lens: { model: 'pinhole', hfovDeg: 80, aspect: 1.3333 } }),
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
  severityModels: [
    {
      id: 'sev',
      name: 'Severity',
      levels: [
        { value: 1, label: 'Low', color: '#2e9e5b' },
        { value: 3, label: 'High', color: SEVERE_COLOR },
      ],
    },
  ],
  classCatalogues: [],
} as unknown as ProjectManifest;

const found = (o: Partial<PhotoFindings>): PhotoFindings => ({
  issues: 0,
  detections: 0,
  drafts: 0,
  count: 0,
  rank: 3,
  levels: [3],
  color: SEVERE_COLOR,
  confirmedColor: SEVERE_COLOR,
  label: 'High',
  issueIds: [],
  shapes: [],
  ...o,
});

// p2: one confirmed issue and one waiting draft; p3: one confirmed issue
const index = new Map<string, PhotoFindings>([
  // a worse draft than the confirmed issue: the confirmed badge keeps the issue's colour
  ['set/p2', found({ issues: 1, detections: 1, drafts: 1, count: 2, confirmedColor: LOW_COLOR })],
  ['set/p3', found({ issues: 1, count: 1 })],
]);

let host: HTMLDivElement;
let root: Root | undefined;
let off: () => void;
const onOrder = vi.fn();

beforeEach(() => {
  photoSize.mockClear();
  onOrder.mockClear();
  Element.prototype.scrollIntoView = () => undefined;
  // every tile is in view at once
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(
        private readonly cb: (e: { isIntersecting: boolean; target: Element }[]) => void,
      ) {}
      observe = (target: Element) => {
        this.cb([{ isIntersecting: true, target }]);
      };
      unobserve = () => undefined;
      disconnect = () => undefined;
    },
  );
  mediaView.setState(DEFAULT_MEDIA_VIEW);
  mediaPicks.getState().clear();
  host = document.createElement('div');
  document.body.append(host);
  off = registerPinActions();
  workspace.getState().openProject({ id: 'p1', root: 'E:/projects/p1', manifest });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  off();
  workspace.getState().closeProject();
  vi.unstubAllGlobals();
});

function render(over: Partial<Parameters<typeof PhotoColumn>[0]> = {}) {
  root = createRoot(host);
  act(() =>
    root?.render(
      <PhotoColumn
        projectId="p1"
        manifest={manifest}
        index={index}
        open={null}
        onOrder={onOrder}
        {...over}
      />,
    ),
  );
}

const tiles = () =>
  [...host.querySelectorAll<HTMLElement>('.m-card.sq[data-photo]')].map((e) => e.dataset.photo);
const tile = (id: string): HTMLElement => {
  const el = host.querySelector<HTMLElement>(`[data-photo="${id}"]`);
  if (!el) throw new Error(`no tile ${id}`);
  return el;
};
const click = (el: Element | null, init: MouseEventInit = {}) => {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  });
};
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`);

describe('the photo column', () => {
  it('counts the chips and filters to the photos with waiting suggestions', () => {
    render();
    expect(byId('inspect-chip-review')?.textContent).toBe('To review1');
    expect(byId('inspect-chip-findings')?.textContent).toBe('With findings2');
    expect(byId('inspect-chip-findings-count')?.textContent).toBe('2');
    expect(byId('inspect-chip-all')?.textContent).toBe('All5');
    click(byId('inspect-chip-review'));
    expect(tiles()).toEqual(['p2']);
    click(byId('inspect-chip-findings'));
    expect(tiles()).toEqual(['p2', 'p3']);
    click(byId('inspect-chip-all'));
    expect(tiles()).toHaveLength(5);
  });

  it('says nothing matches when To review is on and nothing waits', () => {
    render({ index: new Map() });
    click(byId('inspect-chip-review'));
    expect(tiles()).toEqual([]);
    expect(byId('media-no-match')).not.toBeNull();
  });

  it('shows an orange waiting badge and a severity coloured confirmed badge', () => {
    render();
    const t = tile('p2');
    expect(t.dataset.ai).toBe('1');
    expect(t.dataset.confirmed).toBe('1');
    expect(t.querySelector('.insp-b.ai')?.getAttribute('aria-label')).toBe(
      '1 AI suggestion waiting',
    );
    expect(t.querySelector('.insp-b.ok')?.getAttribute('aria-label')).toBe('1 confirmed finding');
    expect(t.querySelector('.insp-b.ok')?.getAttribute('style')).toContain(LOW_COLOR);
    expect(tile('p3').querySelector('.insp-b.ok')?.getAttribute('style')).toContain(SEVERE_COLOR);
    expect(tile('p3').querySelector('.insp-b.ai')).toBeNull();
    expect(tile('p1').querySelector('.insp-b')).toBeNull();
  });

  it('reports the tile order as shown', () => {
    render();
    expect(onOrder).toHaveBeenLastCalledWith(
      ['p1', 'p2', 'p3', 'wide', 'lensed'].map((photoId) => ({ layerId: 'set', photoId })),
    );
  });

  it('picks one and opens it on a click, and picks with Ctrl and Shift as Media did', () => {
    render();
    click(tile('p1'));
    expect(workspace.getState().selection).toEqual({ kind: 'photo', id: 'p1', layer: 'set' });
    expect(tile('p1').dataset.picked).toBe('true');
    click(tile('p3'), { ctrlKey: true });
    expect(mediaPicks.getState().picks.map((p) => p.photoId)).toEqual(['p1', 'p3']);
    expect(workspace.getState().selection).toEqual({ kind: 'photo', id: 'p1', layer: 'set' });
    click(tile('wide'), { shiftKey: true });
    expect(mediaPicks.getState().picks.map((p) => p.photoId)).toEqual(['p1', 'p3', 'wide']);
  });

  it('keeps the severity filter and sort under Filter', () => {
    render();
    expect(byId('media-order')).toBeNull();
    click(byId('inspect-filter'));
    expect(byId('media-order')).not.toBeNull();
    expect(byId('media-severity')).not.toBeNull();
  });

  it('shows the agent scope as a chip that clears', () => {
    act(() => {
      setMediaView({ scope: { label: 'Corrosion', ids: ['set/p3'] } });
    });
    render();
    expect(tiles()).toEqual(['p3']);
    expect(byId('media-scope-chip')?.textContent).toContain('Corrosion');
    click(byId('media-scope-chip')?.querySelector('button') ?? null);
    expect(tiles()).toHaveLength(5);
  });

  it('shows at most 600 photos of a set and says how to find the rest', () => {
    const big = {
      ...manifest,
      layers: [
        {
          id: 'set',
          kind: 'photos',
          name: 'Photos',
          visible: true,
          items: Array.from({ length: 650 }, (_, i) => item(`b${String(i)}`)),
        },
      ],
    } as unknown as ProjectManifest;
    workspace.getState().openProject({ id: 'p1', root: 'E:/projects/p1', manifest: big });
    render({ manifest: big, index: new Map() });
    expect(tiles()).toHaveLength(600);
    expect(host.textContent).toContain('Showing the first 600 of 650');
  });

  it('marks the open photo and ends with the colour key', () => {
    render({ open: { layerId: 'set', photoId: 'p3' } });
    expect(tile('p3').className).toContain('on');
    expect(byId('inspect-legend')).not.toBeNull();
  });
});

describe('the photo column and pinned media', () => {
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

  it('says Looks like a 360 on a 2:1 photo, with Treat as 360, and reads no header of a lensed one', async () => {
    render();
    await act(async () => {
      await Promise.resolve();
    });
    const wide = tile('wide').closest('.m-tile');
    expect(wide?.textContent).toContain('Looks like a 360');
    expect(wide?.querySelector('[data-testid="media-treat-360"]')?.textContent).toBe(
      'Treat as 360',
    );
    expect(tile('p1').closest('.m-tile')?.textContent ?? '').not.toContain('Looks like a 360');
    const urls = photoSize.mock.calls.map((c) => c[0]);
    expect(urls.some((u) => u.includes('lensed'))).toBe(false);
  });

  it('reads no header of a tile that has not come into view', async () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = () => undefined;
        unobserve = () => undefined;
        disconnect = () => undefined;
      },
    );
    render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(photoSize).not.toHaveBeenCalled();
  });

  it('opens the pin actions on a right-click of a tile', () => {
    render();
    act(() => {
      tile('p1').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
      );
    });
    expect(document.querySelector('[data-testid="ctx-item-media.as360"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="ctx-item-media.move"]')).toBeNull();
  });

  const clickPano = (id: string) => {
    click(host.querySelector(`[data-pano="${id}"]`));
  };

  it('starts Place on site on a click of an unplaced 360, not an empty scene', () => {
    workspace.getState().select(null);
    render();
    clickPano('free');
    expect(pinSession.getState().target).toEqual({
      kind: 'pano',
      layerId: 'panos',
      itemId: 'free',
    });
    expect(pinSession.getState().mode).toBe('place');
    expect(shell.getState().screen).toBe('scene');
    expect(workspace.getState().selection).toBeNull();
    act(() => {
      pinSession.getState().cancel();
    });
  });

  it('opens a placed 360 in the scene on a click', () => {
    render();
    clickPano('pinned');
    expect(workspace.getState().selection).toEqual({ kind: 'pano', id: 'pinned', layer: 'panos' });
    expect(pinSession.getState().target).toBeNull();
  });

  it('places nothing from a package, where the pin actions are greyed', () => {
    shell.setState({ pkg: {} as never });
    try {
      render();
      clickPano('free');
      expect(pinSession.getState().target).toBeNull();
    } finally {
      shell.setState({ pkg: null });
    }
  });
});
