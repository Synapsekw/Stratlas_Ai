// @vitest-environment jsdom
import type { PanoLook } from '@aio/engine';
import type { Layer } from '@aio/schema';
import { assetUrl } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLookLink } from '../lookLink';
import { SpotMatchView } from './SpotMatchView';
import type { SpotItem, SpotMatch } from './spotTypes';

interface FakeView {
  host: HTMLElement;
  images: { url: string | null; heading: number }[];
  looks: PanoLook[];
}
const views: FakeView[] = [];
vi.mock('../panoView', () => ({
  createPanoImageView: (host: HTMLElement, look: PanoLook) => {
    const v: FakeView = { host, images: [], looks: [look] };
    views.push(v);
    return {
      status: 'ready',
      setImage(url: string | null, heading: number) {
        v.images.push({ url, heading });
      },
      setLook(l: PanoLook) {
        v.looks.push(l);
      },
      dispose() {
        v.images.push({ url: 'disposed', heading: 0 });
      },
    };
  },
}));
interface FakeVideoView {
  video: HTMLVideoElement;
  looks: PanoLook[];
}
const videoViews: FakeVideoView[] = [];
vi.mock('@aio/video', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createPanoVideoView: (_host: HTMLElement, video: HTMLVideoElement, look: PanoLook) => {
    const v: FakeVideoView = { video, looks: [look] };
    videoViews.push(v);
    return {
      canvas: document.createElement('canvas'),
      setLook(l: PanoLook) {
        v.looks.push(l);
      },
      invalidate: () => undefined,
      dispose: () => undefined,
    };
  },
  FrameImage: ({ src, kind, t }: { src: string; kind: string; t?: number }) => (
    <i data-src={src} data-kind={kind} data-t={t} />
  ),
}));

const layers = [
  {
    kind: 'photos',
    id: 'photos-d1',
    name: 'Photos',
    visible: true,
    items: [{ id: 'a', src: { path: 'photos/a.jpg' } }],
  },
  {
    kind: 'panoramas',
    id: 'pano-d1',
    name: 'Panos',
    visible: true,
    items: [{ id: 'p', src: { path: 'p/p.jpg' }, pos: [0, 0, 0], headingDeg: 30 }],
  },
  {
    kind: 'video',
    id: 'clip-d1',
    name: 'Clip',
    visible: true,
    src: { path: 'clips/c.mp4', location: 'workspace' },
  },
  {
    kind: 'walk',
    id: 'walk-d1',
    name: 'Walk',
    visible: true,
    src: { path: 'walks/w/play.mp4' },
    record: { path: 'walks/w/walk.json' },
    durationS: 60,
  },
] as unknown as Layer[];

const match = (item: SpotItem, o: Partial<SpotMatch> = {}): SpotMatch => ({
  capture: 'd1',
  kind: 'photo',
  item,
  distanceM: 1,
  angleDeg: null,
  score: 0,
  aerial: false,
  ...o,
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
const render = (ui: React.ReactNode) => {
  root ??= createRoot(host);
  act(() => root?.render(ui));
};
const q = (sel: string) => host.querySelector<HTMLElement>(sel);
function only<T>(v: T | undefined | null, what = 'element'): T {
  if (v === undefined || v === null) throw new Error(`missing ${what}`);
  return v;
}

beforeEach(() => {
  views.length = 0;
  videoViews.length = 0;
  // jsdom has no media playback: a walk frame pauses and unloads its video
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SpotMatchView', () => {
  it('shows a photo', () => {
    render(
      <SpotMatchView
        projectId="p"
        layers={layers}
        match={match({ kind: 'photo', layer: 'photos-d1', photo: 'a' })}
      />,
    );
    expect(only(q('[data-testid="spot-view"]')).getAttribute('data-kind')).toBe('photo');
    const img = only(q('i'));
    expect(img.dataset.kind).toBe('photo');
    expect(img.dataset.src).toBe(assetUrl('p', { path: 'photos/a.jpg' }));
  });

  it('shows a drone photo the same way', () => {
    render(
      <SpotMatchView
        projectId="p"
        layers={layers}
        match={match({ kind: 'photo', layer: 'photos-d1', photo: 'a' }, { kind: 'drone' })}
      />,
    );
    expect(only(q('[data-testid="spot-view"]')).getAttribute('data-kind')).toBe('drone');
    expect(only(q('i')).dataset.kind).toBe('photo');
  });

  it('shows a video frame, or a paused clip with controls when playable', () => {
    const m = match({ kind: 'video', layer: 'clip-d1', t: 4.5 }, { kind: 'video' });
    render(<SpotMatchView projectId="p" layers={layers} match={m} />);
    const frame = only(q('i'));
    expect(frame.dataset.kind).toBe('video');
    expect(frame.dataset.t).toBe('4.5');
    expect(q('video')).toBeNull();

    render(<SpotMatchView projectId="p" layers={layers} match={m} playable />);
    const video = only(host.querySelector('video'));
    expect(video.controls).toBe(true);
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => undefined);
    act(() => {
      video.dispatchEvent(new Event('loadedmetadata'));
    });
    expect(video.currentTime).toBe(4.5);
    expect(pause).toHaveBeenCalled();
  });

  it('turns a 360 towards the spot', () => {
    render(
      <SpotMatchView
        projectId="p"
        layers={layers}
        match={match({ kind: 'pano', layer: 'pano-d1', pano: 'p' }, { kind: 'pano', lookDeg: 200 })}
      />,
    );
    expect(views).toHaveLength(1);
    expect(only(views[0]?.looks[0]).yawDeg).toBe(200);
    expect(views[0]?.images.at(-1)).toEqual({
      url: assetUrl('p', { path: 'p/p.jpg' }),
      heading: 30,
    });
  });

  it('turns two 360s together through a shared look', () => {
    const look = createLookLink({ yawDeg: 0, pitchDeg: 0, fovDeg: 70 });
    const m = match({ kind: 'pano', layer: 'pano-d1', pano: 'p' }, { kind: 'pano' });
    render(
      <>
        <SpotMatchView projectId="p" layers={layers} match={m} look={look} />
        <SpotMatchView projectId="p" layers={layers} match={m} look={look} />
      </>,
    );
    expect(views).toHaveLength(2);
    act(() => {
      look.getState().set({ yawDeg: 123, pitchDeg: 0, fovDeg: 70 });
    });
    for (const v of views) expect(only(v.looks.at(-1)).yawDeg).toBe(123);
  });

  it('leaves the arrow keys alone on a 360', () => {
    const look = createLookLink({ yawDeg: 10, pitchDeg: 0, fovDeg: 70 });
    const seen = vi.fn();
    host.addEventListener('keydown', seen);
    render(
      <SpotMatchView
        projectId="p"
        layers={layers}
        match={match({ kind: 'pano', layer: 'pano-d1', pano: 'p' }, { kind: 'pano' })}
        look={look}
      />,
    );
    const surface = only(q('[role="img"]'));
    act(() => {
      surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(look.getState().look.yawDeg).toBe(10);
    expect(seen).toHaveBeenCalled();
  });

  it('shows a walk frame at its moment, turned from its picture centre to the spot', () => {
    render(
      <SpotMatchView
        projectId="p"
        layers={layers}
        match={match(
          { kind: 'walk', layer: 'walk-d1', t: 12.5 },
          { kind: 'walk', lookDeg: 100, centreDeg: 30 },
        )}
      />,
    );
    expect(videoViews).toHaveLength(1);
    const v = only(videoViews[0]);
    expect(only(v.looks[0]).yawDeg).toBe(70);
    expect(v.video.src).toBe(assetUrl('p', { path: 'walks/w/play.mp4' }));
    const pause = vi.spyOn(v.video, 'pause').mockImplementation(() => undefined);
    act(() => {
      v.video.dispatchEvent(new Event('loadedmetadata'));
    });
    expect(v.video.currentTime).toBe(12.5);
    expect(pause).toHaveBeenCalled();
  });

  it('turns a walk frame with a shared look of compass bearings', () => {
    const look = createLookLink({ yawDeg: 100, pitchDeg: 0, fovDeg: 70 });
    render(
      <SpotMatchView
        projectId="p"
        layers={layers}
        match={match(
          { kind: 'walk', layer: 'walk-d1', t: 3 },
          { kind: 'walk', lookDeg: 100, centreDeg: 30 },
        )}
        look={look}
      />,
    );
    const v = only(videoViews[0]);
    expect(only(v.looks[0]).yawDeg).toBe(70);
    act(() => {
      look.getState().set({ yawDeg: 200, pitchDeg: 5, fovDeg: 60 });
    });
    expect(v.looks.at(-1)).toEqual({ yawDeg: 170, pitchDeg: 5, fovDeg: 60 });
    const surface = only(q('[data-testid="spot-walk"]'));
    act(() => {
      surface.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    });
    // the frame writes back in compass terms: its own yaw plus its picture centre
    expect(look.getState().look.yawDeg).toBe(200);
    expect(look.getState().look.fovDeg).toBeLessThan(60);
  });

  it('says so when the item is gone', () => {
    render(
      <SpotMatchView
        projectId="p"
        layers={layers}
        match={match({ kind: 'photo', layer: 'gone', photo: 'a' })}
      />,
    );
    expect(host.textContent).toContain('This image could not be loaded');
  });
});
