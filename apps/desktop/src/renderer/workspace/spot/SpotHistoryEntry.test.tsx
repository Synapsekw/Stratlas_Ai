// @vitest-environment jsdom
import type { Layer, ProjectManifest } from '@aio/schema';
import { captureIndex, workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { timeline } from '../timeline';
import { photoAt } from './__fixtures__/spotPoses';
import { InlineSpotStrip, SpotHistoryButton } from './SpotHistoryEntry';
import type { SpotEntry, SpotOpen } from './spotTypes';
import { spotViewer } from './spotViewerStore';

let entries: SpotEntry[] = [];
const activeArgs = vi.hoisted(() => [] as boolean[]);
vi.mock('./useSpotEntries', () => ({
  useSpotEntries: (active: boolean) => {
    activeArgs.push(active);
    return { entries, reading: false };
  },
}));
vi.mock('./SpotThumb', () => ({ SpotThumb: () => <i /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const photos = (id: string, capture: string, items: string[]) =>
  ({
    kind: 'photos',
    id,
    name: id,
    visible: true,
    capture,
    items: items.map((p) => ({ id: p, src: { path: `photos/${p}.jpg` } })),
  }) as unknown as Layer;

function manifest(captures: string[]): ProjectManifest {
  return {
    schema: 'aio.project/1',
    id: 'p',
    name: 'P',
    crs: { epsg: 32640 },
    origin: [0, 0, 0],
    captures: captures.map((id, i) => ({ id, label: id, date: `2025-0${String(i + 1)}-01` })),
    layers: [photos('photos-d1', 'd1', ['a', 'nogps']), photos('photos-d2', 'd2', ['b'])],
  } as unknown as ProjectManifest;
}

const openA: SpotOpen = { item: { kind: 'photo', layer: 'photos-d1', photo: 'a' } };
const openNoGps: SpotOpen = { item: { kind: 'photo', layer: 'photos-d1', photo: 'nogps' } };

let host: HTMLDivElement;
let root: Root | undefined;
const load = (captures: string[]) => {
  const m = manifest(captures);
  workspace.getState().openProject({ id: 'p', root: '/p', manifest: m });
  timeline.getState().attach('p', captureIndex(m));
};
const render = (node: React.ReactNode) => {
  root ??= createRoot(host);
  act(() => root?.render(node));
};
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (el: Element | null) => {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

beforeEach(() => {
  entries = [
    photoAt('a', [0, 1.6, 0], 0, { layer: 'photos-d1', capture: 'd1' }),
    photoAt('nogps', undefined, null, { layer: 'photos-d1', capture: 'd1' }),
    photoAt('b', [1, 1.6, 0], 0),
  ];
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => {
    spotViewer.getState().close();
  });
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  timeline.getState().attach(null, null);
  workspace.getState().closeProject();
  vi.restoreAllMocks();
});

describe('other dates entry', () => {
  it('the button opens the viewer on its item and changes nothing else', () => {
    load(['d1', 'd2']);
    act(() => {
      workspace.getState().select({ kind: 'layer', id: 'photos-d1' });
    });
    const sel = workspace.getState().selection;
    const show = vi.spyOn(spotViewer.getState(), 'show');
    render(<SpotHistoryButton open={openA} />);
    click(q('spot-history-open'));
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(openA, undefined);
    expect(workspace.getState().selection).toBe(sel);
  });

  it('shows neither the button nor the strip with one survey date', () => {
    load(['d1']);
    render(
      <>
        <SpotHistoryButton open={openA} />
        <InlineSpotStrip open={openA} />
      </>,
    );
    expect(q('spot-history-open')).toBeNull();
    expect(q('spot-inline')).toBeNull();
    expect(q('spot-no-position')).toBeNull();
  });

  it('reads no flight logs for the inline strip with one survey date', () => {
    load(['d1']);
    activeArgs.length = 0;
    render(<InlineSpotStrip open={openA} />);
    expect(activeArgs.length).toBeGreaterThan(0);
    expect(activeArgs.every((a) => !a)).toBe(true);
    act(() => root?.unmount());
    root = undefined;
    load(['d1', 'd2']);
    activeArgs.length = 0;
    render(<InlineSpotStrip open={openA} />);
    expect(activeArgs.every((a) => a)).toBe(true);
  });

  it('the inline strip shows the dates and a slot opens the viewer there', () => {
    load(['d1', 'd2']);
    const show = vi.spyOn(spotViewer.getState(), 'show');
    render(<InlineSpotStrip open={openA} />);
    expect(q('spot-inline')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid^="spot-slot-"]')).toHaveLength(2);
    expect(q('spot-slot-d1')?.getAttribute('aria-selected')).toBe('true');
    click(q('spot-slot-d2'));
    expect(show).toHaveBeenCalledWith(openA, { capture: 'd2', i: 0 });
  });

  it('a photo without a position says so instead of showing the strip', () => {
    load(['d1', 'd2']);
    render(<InlineSpotStrip open={openNoGps} />);
    expect(q('spot-inline')).toBeNull();
    expect(q('spot-no-position')?.textContent).toBe(
      "This photo has no position, so other dates can't be matched.",
    );
  });
});
