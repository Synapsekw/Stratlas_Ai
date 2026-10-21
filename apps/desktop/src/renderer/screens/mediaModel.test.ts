import type { Layer, OrientationFile, PhotoRef } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  flightCards,
  flightOf,
  isNear2to1,
  isPhotoEdited,
  mediaSummary,
  panoCard,
  showsClipList,
} from './mediaModel';

const T0 = Date.UTC(2023, 10, 22, 5, 0, 0);

const clip = (
  id: string,
  flight: string,
  start: number,
  offsetMs: number,
  poster = true,
): Layer => ({
  kind: 'video',
  id,
  name: `${flight} · clip ${id}`,
  visible: true,
  src: { path: `video/${id}.mp4` },
  flight: { src: { path: `flights/${flight}.json` }, startUtcMs: start },
  lens: { model: 'ftheta', hfovDeg: 114, aspect: 1.7778 },
  offsetMs,
  ...(poster ? { poster: { path: `posters/${id}.jpg` } } : {}),
});

describe('media flight cards', () => {
  const layers: Layer[] = [
    clip('b1', 'Flight 102', T0 + 600_000, 0),
    clip('a2', 'Flight 101', T0, 60_000),
    clip('a1', 'Flight 101', T0, 0, false),
  ];

  it('groups clips by flight, in time order, with the span and a poster', () => {
    const cards = flightCards(layers, { a1: 60_000, a2: 45_000, b1: 30_000 });
    expect(cards.map((c) => c.name)).toEqual(['Flight 101 · clip a', 'Flight 102 · clip b1']);
    const [f101] = cards;
    expect(f101?.clips.map((c) => c.id)).toEqual(['a1', 'a2']);
    expect(f101?.startMs).toBe(T0);
    expect(f101?.endMs).toBe(T0 + 105_000);
    expect(f101?.estimated).toBe(false);
    expect(f101?.poster).toEqual({ path: 'posters/a2.jpg' });
  });

  it('marks spans that still use the default clip length', () => {
    const [f101] = flightCards(layers, { a1: 60_000 });
    expect(f101?.estimated).toBe(true);
    expect(f101?.endMs).toBe(T0 + 120_000);
  });

  it('finds the flight of the active clip, else the first', () => {
    const cards = flightCards(layers, {});
    expect(flightOf(cards, 'b1')?.clips[0]?.id).toBe('b1');
    expect(flightOf(cards, null)?.clips[0]?.id).toBe('a1');
    expect(flightOf([], 'b1')).toBeNull();
  });
});

describe('panoCard', () => {
  const p = { id: 'p01', src: { path: 'panoramas/l/p01/pano.jpg' }, pos: [0, 0, 0], headingDeg: 3 };
  it('shows the image of a ready-made or stitched panorama', () => {
    expect(panoCard(p as never)).toEqual({ asset: p.src, stitched: true });
    expect(panoCard({ ...p, stitch: { status: 'done' } } as never)).toEqual({
      asset: p.src,
      stitched: true,
    });
  });
  it('shows no image for a sphere not stitched yet: its pano.jpg is not there', () => {
    for (const status of ['queued', 'running', 'failed'])
      expect(panoCard({ ...p, stitch: { status } } as never)).toEqual({
        asset: undefined,
        stitched: false,
      });
  });
});

describe('media summary and clip list', () => {
  it('counts in the singular for one', () => {
    expect(mediaSummary({ clips: 1, photos: 1, panoramas: 0 })).toBe(
      '1 clip · 1 photo · 0 panoramas',
    );
    expect(mediaSummary({ clips: 2, photos: 1182, panoramas: 3 })).toBe(
      '2 clips · 1,182 photos · 3 panoramas',
    );
  });

  it('lists the clips of a flight only when it has more than one (its card is the clip)', () => {
    const cards = flightCards(
      [
        clip('a1', 'Flight 101', T0, 0),
        clip('a2', 'Flight 101', T0, 60_000),
        clip('b1', 'Flight 102', T0 + 600_000, 0),
      ],
      {},
    );
    expect(cards.map(showsClipList)).toEqual([true, false]);
    expect(showsClipList(null)).toBe(false);
  });
});

describe('isNear2to1', () => {
  it('takes a 2:1 image within the importer tolerance', () => {
    expect(isNear2to1(2560, 1280)).toBe(true);
    expect(isNear2to1(5760, 2880)).toBe(true);
    expect(isNear2to1(4000, 3000)).toBe(false);
    expect(isNear2to1(2600, 1280)).toBe(false);
    expect(isNear2to1(2560, 0)).toBe(false);
  });
});

describe('isPhotoEdited', () => {
  const photo = (id: string, extra: Partial<PhotoRef> = {}): PhotoRef => ({
    id,
    src: { path: `photos/${id}.jpg` },
    pos: [1, 2, 3],
    ...extra,
  });
  const file: OrientationFile = {
    schema: 'aio.orientation/1',
    clips: {},
    photos: {
      set: {
        moved: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [0, -100, 0] },
        turned: { yawDeg: 5, pitchDeg: 0, rollDeg: 0 },
        tiny: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [0.0001, 0, 0] },
        pinned: { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [3, 0, 0] },
      },
    },
  };

  it('marks a photo whose correction moves it', () => {
    expect(isPhotoEdited(file, 'set', photo('moved'))).toBe(true);
    expect(isPhotoEdited(file, 'other', photo('moved'))).toBe(false);
  });

  it('does not mark a turn only, an offset under 0.5 mm, no entry or no file', () => {
    expect(isPhotoEdited(file, 'set', photo('turned'))).toBe(false);
    expect(isPhotoEdited(file, 'set', photo('tiny'))).toBe(false);
    expect(isPhotoEdited(file, 'set', photo('none'))).toBe(false);
    expect(isPhotoEdited(null, 'set', photo('moved'))).toBe(false);
  });

  it('does not mark a pinned photo: its pin wins over a correction', () => {
    const pinned = photo('pinned', { pin: { ground: [0, 0, 0], eyeM: 1.6 } });
    expect(isPhotoEdited(file, 'set', pinned)).toBe(false);
  });
});
