// @vitest-environment jsdom
import type { Layer, ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquirePlayer, releasePlayer } from './player';
import { configureVideo } from './runtime';

const START = 1_776_000_000_000;
const layer: Extract<Layer, { kind: 'video' }> = {
  kind: 'video',
  id: 'v1',
  name: 'clip',
  visible: true,
  src: { path: 'video/v1.mp4' },
  flight: { src: { path: 'flights/a.json' }, startUtcMs: START },
  lens: { model: 'ftheta', hfovDeg: 114, aspect: 1.7778 },
  offsetMs: 0,
};

/** jsdom has no media playback: a video that plays and pauses as asked, and fires the events. */
function fakeMedia() {
  const paused = new WeakMap<HTMLMediaElement, boolean>();
  const plays = vi.fn();
  const proto = HTMLMediaElement.prototype;
  vi.spyOn(proto, 'paused', 'get').mockImplementation(function (this: HTMLMediaElement) {
    return paused.get(this) ?? true;
  });
  vi.spyOn(proto, 'readyState', 'get').mockReturnValue(4);
  vi.spyOn(proto, 'duration', 'get').mockReturnValue(30);
  vi.spyOn(proto, 'play').mockImplementation(function (this: HTMLMediaElement) {
    plays();
    paused.set(this, false);
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  vi.spyOn(proto, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    if (paused.get(this) ?? true) return;
    paused.set(this, true);
    this.dispatchEvent(new Event('pause'));
  });
  vi.spyOn(proto, 'load').mockImplementation(() => undefined);
  /** What the browser does when a playing video leaves the page. */
  const pauseByBrowser = (v: HTMLMediaElement) => {
    paused.set(v, true);
    v.dispatchEvent(new Event('pause'));
  };
  return { plays, pauseByBrowser };
}

describe('the clip player', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('plays on when the browser pauses the clock video, while the workspace plays', () => {
    const media = fakeMedia();
    const store = createWorkspace();
    store.getState().openProject({
      id: 'p',
      root: 'x',
      manifest: { layers: [layer] } as unknown as ProjectManifest,
    });
    store.getState().setActiveClip('v1');
    store.getState().setTime(START + 2000);
    configureVideo({ store, resolveUrl: (_p, ref) => ('path' in ref ? ref.path : ref.hash) });
    const player = acquirePlayer('v1');
    store.getState().play();
    expect(player.video.paused).toBe(false);
    const asked = media.plays.mock.calls.length;

    // taken out of the page (the video window closed, the Scene screen left with its 3D view
    // kept): it is still the clock, so it plays on
    media.pauseByBrowser(player.video);
    expect(media.plays.mock.calls.length).toBe(asked + 1);
    expect(player.video.paused).toBe(false);

    // a pause the workspace asks for stays
    store.getState().pause();
    expect(player.video.paused).toBe(true);
    expect(media.plays.mock.calls.length).toBe(asked + 1);
    releasePlayer('v1');
  });
});
