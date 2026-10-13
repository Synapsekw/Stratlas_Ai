// @vitest-environment jsdom
import type { Layer, ProjectManifest } from '@aio/schema';
import type { Flight } from '@aio/video';
import { workspace } from '@aio/workspace';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PlaceWalk from '../../walks/placeWalk';
import { LENS, lookQuat } from './__fixtures__/spotPoses';
import type * as Entries from './spotEntries';
import { cachedSamples, useSpotEntries } from './useSpotEntries';

const spy = vi.hoisted(() => ({ entries: 0, walkFits: [] as boolean[] }));
vi.mock('./spotEntries', async (orig) => {
  const real = await orig<typeof Entries>();
  return {
    ...real,
    spotEntries: (...args: Parameters<typeof real.spotEntries>) => {
      spy.entries++;
      return real.spotEntries(...args);
    },
  };
});
vi.mock('../../walks/placeWalk', async (orig) => {
  const real = await orig<typeof PlaceWalk>();
  return {
    ...real,
    usePlacedWalkFits: (active?: boolean) => {
      spy.walkFits.push(active ?? true);
      return { fits: [], inputsOf: () => undefined };
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clip = {
  kind: 'video',
  id: 'clip-d1',
  name: 'clip',
  visible: true,
  capture: 'd1',
  src: { path: 'v.mp4' },
  flight: { src: { path: 'f.json' }, startUtcMs: 1000 },
  lens: LENS,
  offsetMs: 0,
} as unknown as Extract<Layer, { kind: 'video' }>;
const flight: Flight = {
  schema: 'aio.flight/1',
  startUtcMs: 1000,
  durationMs: 2000,
  lens: LENS,
  samples: Array.from({ length: 3 }, (_, i) => ({
    t: i * 1000,
    pos: [i, 30, 0] as [number, number, number],
    q: lookQuat(0, -90),
  })),
};

describe('cachedSamples', () => {
  it('reuses the samples of the same clip and makes new ones when the lens changes', () => {
    const a = cachedSamples('p', clip, flight, null);
    expect(cachedSamples('p', clip, flight, null)).toBe(a);
    const lens = { model: 'pinhole', hfovDeg: 90, aspect: 1.5 } as const;
    const b = cachedSamples('p', { ...clip, lens }, flight, null);
    expect(b).not.toBe(a);
    expect(b[0]?.pose.lens).toEqual(lens);
    // one entry per clip: going back to the old lens samples again rather than keeping both
    expect(cachedSamples('p', clip, flight, null)).not.toBe(a);
  });
});

describe('useSpotEntries', () => {
  let host: HTMLDivElement;
  let root: Root | undefined;
  const seen: { entries: number }[] = [];
  function Probe(p: { active: boolean }) {
    seen.push({ entries: useSpotEntries(p.active).entries.length });
    return null;
  }
  const render = (active: boolean) => {
    root ??= createRoot(host);
    act(() => root?.render(createElement(Probe, { active })));
  };
  beforeEach(() => {
    spy.entries = 0;
    spy.walkFits = [];
    seen.length = 0;
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    host = document.createElement('div');
    document.body.append(host);
    workspace.getState().openProject({
      id: 'p',
      root: '/p',
      manifest: {
        schema: 'aio.project/1',
        id: 'p',
        name: 'P',
        crs: { epsg: 32640 },
        origin: [0, 0, 0],
        captures: [{ id: 'd1', label: 'd1', date: '2025-01-01' }],
        layers: [
          {
            kind: 'photos',
            id: 'photos-d1',
            name: 'photos',
            visible: true,
            capture: 'd1',
            items: [{ id: 'a', src: { path: 'a.jpg' }, pos: [0, 1.6, 0] }],
          },
        ],
      } as unknown as ProjectManifest,
    });
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    workspace.getState().closeProject();
    vi.unstubAllGlobals();
  });

  it('computes nothing while inactive: no entries and no walk fits', () => {
    render(false);
    expect(spy.entries).toBe(0);
    expect(seen.at(-1)?.entries).toBe(0);
    expect(spy.walkFits.every((a) => !a)).toBe(true);
    render(true);
    expect(spy.entries).toBeGreaterThan(0);
    expect(seen.at(-1)?.entries).toBe(1);
    expect(spy.walkFits.at(-1)).toBe(true);
  });
});
