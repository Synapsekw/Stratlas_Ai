import { ProjectManifest, type LayerPatchInput, type Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import type { MediaKey } from './pinModel';
import { createPinStore } from './pinStore';

const manifest = (): ProjectManifest =>
  ProjectManifest.parse({
    schema: 'aio.project/1',
    id: 'p',
    name: 'P',
    crs: { epsg: 32633 },
    origin: [0, 0, 0],
    captures: [],
    layers: [
      {
        kind: 'photos',
        id: 'ph',
        name: 'Photos',
        items: [
          { id: 'loose', src: { path: 'photos/loose.jpg' } },
          {
            id: 'aimed',
            src: { path: 'photos/aimed.jpg' },
            pos: [1, 1.6, 0],
            pin: { ground: [1, 0, 0], headingDeg: 30 },
          },
        ],
      },
      {
        kind: 'panoramas',
        id: 'pa',
        name: 'Panoramas',
        items: [
          { id: 'u', src: { path: 'panos/u.jpg' } },
          {
            id: 'mv',
            src: { path: 'panos/mv.jpg' },
            pos: [0, 1.6, 0],
            headingDeg: 70,
            pin: { ground: [0, 0, 0], headingDeg: 70, gps: { pos: [5, 5, 5] } },
          },
          {
            id: 'placed',
            src: { path: 'panos/placed.jpg' },
            pos: [1, 1.6, 2],
            pin: { ground: [1, 0, 2] },
          },
        ],
      },
    ],
    severityModels: [],
    classCatalogues: [],
  });

const PANO: MediaKey = { kind: 'pano', layerId: 'pa', itemId: 'u' };
const PHOTO: MediaKey = { kind: 'photo', layerId: 'ph', itemId: 'loose' };

/** A point `d` metres from `from` along compass bearing `deg`. */
const along = (from: Vec3, deg: number, d = 10): Vec3 => {
  const r = (deg * Math.PI) / 180;
  return [from[0] + d * Math.sin(r), from[1], from[2] - d * Math.cos(r)];
};

function setup() {
  const saved: { layerId: string; patch: LayerPatchInput }[] = [];
  const opened: [string, string][] = [];
  const env = {
    m: manifest() as ProjectManifest | null,
    fail: null as string | null,
    /** Saves wait here until `release()` while set. */
    defer: false,
  };
  const waiting: (() => void)[] = [];
  /** Lets the waiting saves resolve, one by one, until none waits. */
  const release = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      waiting.shift()?.();
    }
  };
  const store = createPinStore({
    manifest: () => env.m,
    save: (layerId, patch) => {
      saved.push({ layerId, patch });
      const result = env.fail;
      if (!env.defer) return Promise.resolve(result);
      return new Promise((resolve) => {
        waiting.push(() => {
          resolve(result);
        });
      });
    },
    openPanoBeside: (layerId, panoId) => opened.push([layerId, panoId]),
  });
  const pinOf = (i = saved.length - 1) => {
    const p = saved[i]?.patch;
    return p && 'mediaPin' in p ? p.mediaPin.pin : undefined;
  };
  return { store, saved, opened, env, pinOf, release, s: () => store.getState() };
}

describe('pinStore', () => {
  it('places a 360: pick, save the ground, open the 360 beside', async () => {
    const { s, saved, opened } = setup();
    s().begin(PANO, 'place');
    expect(s()).toMatchObject({ target: PANO, mode: 'place', step: 'pick', eyeM: 1.6 });
    await s().pickSurface([1, 0, 2], true);
    expect(saved).toEqual([
      {
        layerId: 'pa',
        patch: { mediaPin: { itemId: 'u', pin: { ground: [1, 0, 2], eyeM: 1.6 } } },
      },
    ]);
    expect(opened).toEqual([['pa', 'u']]);
    expect(s()).toMatchObject({
      step: 'pano',
      ground: [1, 0, 2],
      heightUnknown: false,
      note: null,
    });
  });

  it('says when the height is not known (a map pick with no model)', async () => {
    const { s } = setup();
    s().begin(PANO, 'place');
    await s().pickSurface([1, 0, 2], false);
    expect(s()).toMatchObject({ heightUnknown: true, note: 'pin.strip.heightUnknown' });
  });

  it('aims a photo, and Done without an aim saves no heading', async () => {
    const { s, pinOf, saved } = setup();
    s().begin(PHOTO, 'place');
    await s().pickSurface([1, 0, 0], true);
    expect(s().step).toBe('aim');
    await s().aim([1, 0, -10]);
    expect(pinOf()).toMatchObject({ ground: [1, 0, 0], headingDeg: 0 });

    const b = setup();
    b.s().begin(PHOTO, 'place');
    await b.s().pickSurface([1, 0, 0], true);
    b.s().done();
    expect(b.s().target).toBeNull();
    expect(b.saved).toHaveLength(1);
    expect(b.pinOf()?.headingDeg).toBeUndefined();
    expect(saved).toHaveLength(2);
  });

  it('lines up a 360 with two landmark pairs and averages them', async () => {
    const { s, pinOf, saved } = setup();
    s().begin(PANO, 'place');
    await s().pickSurface([1, 0, 2], true);
    s().pickPano(0);
    expect(s().step).toBe('scene');
    await s().pickLandmark([11, 0, 2]);
    expect(pinOf()?.headingDeg).toBeCloseTo(90);
    expect(s().step).toBe('more');
    expect(s().pairs).toHaveLength(1);
    s().pickPano(0);
    await s().pickLandmark(along([1, 0, 2], 100));
    expect(pinOf()?.headingDeg).toBeCloseTo(95);
    expect(saved).toHaveLength(3);
    expect(s().target).toBeNull();
    s().begin(PANO, 'direction');
    expect(s().pairs).toEqual([]);
  });

  it('averages a second pair 20 degrees off the first', async () => {
    const { s, pinOf } = setup();
    s().begin(PANO, 'place');
    await s().pickSurface([1, 0, 2], true);
    s().pickPano(10);
    await s().pickLandmark(along([1, 0, 2], 50));
    expect(pinOf()?.headingDeg).toBeCloseTo(40);
    s().pickPano(10);
    await s().pickLandmark(along([1, 0, 2], 70));
    expect(pinOf()?.headingDeg).toBeCloseTo(50);
    expect(s().target).toBeNull();
  });

  it('ignores a landmark on top of the pin', async () => {
    const { s, saved } = setup();
    s().begin(PANO, 'place');
    await s().pickSurface([1, 0, 2], true);
    s().pickPano(0);
    await s().pickLandmark([1.2, 0, 2.2]);
    expect(s()).toMatchObject({ step: 'scene', note: 'pin.strip.tooClose', pairs: [] });
    expect(saved).toHaveLength(1);
  });

  it('keeps the first pair when the second is opposite (10 and 190)', async () => {
    const { s, pinOf, saved } = setup();
    s().begin(PANO, 'place');
    await s().pickSurface([1, 0, 2], true);
    s().pickPano(0);
    await s().pickLandmark(along([1, 0, 2], 10));
    s().pickPano(0);
    await s().pickLandmark(along([1, 0, 2], 190));
    expect(s()).toMatchObject({ step: 'more', note: 'pin.strip.disagree' });
    expect(s().pairs).toHaveLength(1);
    expect(saved).toHaveLength(2);
    expect(pinOf()?.headingDeg).toBeCloseTo(10);
  });

  it('keeps the first pair when the second is 60 degrees off', async () => {
    const { s, pinOf, saved } = setup();
    s().begin(PANO, 'place');
    await s().pickSurface([1, 0, 2], true);
    s().pickPano(0);
    await s().pickLandmark(along([1, 0, 2], 10));
    s().pickPano(0);
    await s().pickLandmark(along([1, 0, 2], 70));
    expect(s()).toMatchObject({ step: 'more', note: 'pin.strip.disagree' });
    expect(s().pairs).toHaveLength(1);
    expect(saved).toHaveLength(2);
    expect(pinOf()?.headingDeg).toBeCloseTo(10);
  });

  it('re-saves the pin with a new eye height, clamped to 0..10', async () => {
    const { s, pinOf } = setup();
    s().begin(PANO, 'place');
    await s().pickSurface([1, 0, 2], true);
    await s().setEyeM(2);
    expect(pinOf()).toEqual({ ground: [1, 0, 2], eyeM: 2 });
    await s().setEyeM(12);
    expect(pinOf()?.eyeM).toBe(10);
    await s().setEyeM(-1);
    expect(pinOf()?.eyeM).toBe(0);
    expect(s().eyeM).toBe(0);
  });

  it('a move keeps the heading and leaves the GPS place to the writer', async () => {
    const { s, pinOf } = setup();
    s().begin({ kind: 'pano', layerId: 'pa', itemId: 'mv' }, 'move');
    expect(s().step).toBe('pick');
    await s().pickSurface([4, 0, 4], true);
    expect(pinOf()).toEqual({ ground: [4, 0, 4], eyeM: 1.6, headingDeg: 70 });
  });

  it('a fresh Place of a lined-up 360 keeps the heading it has', async () => {
    const { s, pinOf } = setup();
    s().begin({ kind: 'pano', layerId: 'pa', itemId: 'mv' }, 'place');
    await s().pickSurface([4, 0, 4], true);
    expect(pinOf()).toEqual({ ground: [4, 0, 4], eyeM: 1.6, headingDeg: 70 });
  });

  it('a heading set while a move saves lands with the new ground', async () => {
    const { s, env, pinOf, release } = setup();
    env.defer = true;
    s().begin({ kind: 'pano', layerId: 'pa', itemId: 'mv' }, 'move');
    const pick = s().pickSurface([4, 0, 4], true);
    const turn = s().setHeading(10);
    await release();
    await Promise.all([pick, turn]);
    expect(pinOf()).toEqual({ ground: [4, 0, 4], eyeM: 1.6, headingDeg: 10 });
    expect(s()).toMatchObject({ step: 'pano', saving: false });
  });

  it('an eye height set while the first place saves lands on disk', async () => {
    const { s, env, saved, pinOf, release } = setup();
    env.defer = true;
    s().begin(PANO, 'place');
    const pick = s().pickSurface([1, 0, 2], true);
    await Promise.resolve();
    const eye = s().setEyeM(2.5);
    await release();
    await Promise.all([pick, eye]);
    expect(pinOf()).toEqual({ ground: [1, 0, 2], eyeM: 2.5 });
    expect(saved.length).toBeGreaterThanOrEqual(1);
    expect(s()).toMatchObject({ eyeM: 2.5, step: 'pano', saving: false });
  });

  it('an eye height then an aim keeps the new eye height', async () => {
    const { s, env, pinOf, release } = setup();
    s().begin(PHOTO, 'place');
    await s().pickSurface([1, 0, 0], true);
    env.defer = true;
    const eye = s().setEyeM(3);
    const aim = s().aim([1, 0, -10]);
    await release();
    await Promise.all([eye, aim]);
    expect(pinOf()).toEqual({ ground: [1, 0, 0], eyeM: 3, headingDeg: 0 });
  });

  it('a double click on a landmark stores one pair', async () => {
    const { s, env, saved, release } = setup();
    s().begin(PANO, 'place');
    await s().pickSurface([1, 0, 2], true);
    s().pickPano(0);
    env.defer = true;
    const a = s().pickLandmark([11, 0, 2]);
    const b = s().pickLandmark([11, 0, 2]);
    await release();
    await Promise.all([a, b]);
    expect(s()).toMatchObject({ step: 'more' });
    expect(s().pairs).toHaveLength(1);
    expect(saved).toHaveLength(2);
  });

  it('a failed eye height save shows what is on disk again', async () => {
    const { s, env } = setup();
    s().begin(PANO, 'place');
    await s().pickSurface([1, 0, 2], true);
    env.fail = 'disk full';
    await s().setEyeM(4);
    expect(s()).toMatchObject({ eyeM: 1.6, ground: [1, 0, 2], error: 'disk full' });
    env.fail = null;
    await s().setHeading(20);
    expect(s().error).toBeNull();
  });

  it('Set direction starts at the 360 or at the aim, without a surface pick', async () => {
    const { s, opened, pinOf } = setup();
    s().begin({ kind: 'pano', layerId: 'pa', itemId: 'placed' }, 'direction');
    expect(s()).toMatchObject({ step: 'pano', ground: [1, 0, 2] });
    expect(opened).toEqual([['pa', 'placed']]);
    s().begin({ kind: 'photo', layerId: 'ph', itemId: 'aimed' }, 'direction');
    expect(s()).toMatchObject({ step: 'aim', ground: [1, 0, 0] });
    await s().aim(along([1, 0, 0], 270));
    expect(pinOf()).toMatchObject({ ground: [1, 0, 0], headingDeg: 270 });
  });

  it('sets a dragged heading', async () => {
    const { s, pinOf } = setup();
    s().begin({ kind: 'photo', layerId: 'ph', itemId: 'aimed' }, 'direction');
    await s().setHeading(-30);
    expect(pinOf()?.headingDeg).toBeCloseTo(330);
  });

  it('a failed save sets the error and keeps the step; cancel saves nothing', async () => {
    const { s, env, saved } = setup();
    s().begin(PANO, 'place');
    env.fail = 'disk full';
    await s().pickSurface([1, 0, 2], true);
    expect(s()).toMatchObject({ step: 'pick', error: 'disk full', saving: false });
    s().cancel();
    expect(s()).toMatchObject({ target: null, step: 'pick', error: null });
    expect(saved).toHaveLength(1);
  });

  it('ends the session when the item goes from the manifest', async () => {
    const { s, env, saved } = setup();
    s().begin(PANO, 'place');
    const m = manifest();
    const pa = m.layers.find((l) => l.id === 'pa');
    if (pa?.kind === 'panoramas') pa.items = pa.items.filter((i) => i.id !== 'u');
    env.m = m;
    await s().pickSurface([1, 0, 2], true);
    expect(s().target).toBeNull();
    expect(saved).toHaveLength(0);
  });
});
