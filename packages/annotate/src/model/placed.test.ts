import type { Sighting } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { LATER, makeIssue, meshSighting, photoSighting, videoSighting } from '../testing';
import {
  dropFrom,
  hasPlacedArea,
  isAutoPin,
  isPlacedArea,
  keepSightings,
  placedFrom,
  shiftFrom,
  withPlacedArea,
} from './placed';

const ring: [number, number, number][] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 0, 1],
];
const autoPin = (layer: string, from: number): Sighting => ({
  on: 'mesh',
  layer,
  geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] },
  from: { sighting: from },
});
const outline = (layer: string, from: number): Sighting => ({
  on: 'mesh',
  layer,
  geom: { type: 'spolygon', points: ring },
  from: { sighting: from },
});

describe('placed areas', () => {
  it('tells automatic pins and placed areas from hand-made sightings', () => {
    expect(isAutoPin(autoPin('m', 0))).toBe(true);
    expect(isAutoPin(meshSighting)).toBe(false);
    expect(isPlacedArea(outline('m', 0))).toBe(true);
    expect(isPlacedArea({ on: 'mesh', layer: 'm', geom: { type: 'spolygon', points: ring } })).toBe(
      false,
    );
    expect(
      isPlacedArea({
        on: 'pointcloud',
        layer: 'c',
        geom: { type: 'selection', src: { path: 's.sel' }, count: 3 },
        from: { sighting: 0 },
      }),
    ).toBe(true);
    expect(isPlacedArea(photoSighting)).toBe(false);
  });

  it('finds the photo a placed area came from, ignoring a stale index', () => {
    const issue = makeIssue({ sightings: [videoSighting, photoSighting, outline('m', 1)] });
    expect(hasPlacedArea(issue)).toBe(true);
    expect(placedFrom(issue)).toBe(1);
    expect(placedFrom(makeIssue({ sightings: [photoSighting, outline('m', 7)] }))).toBeNull();
    expect(placedFrom(makeIssue({ sightings: [photoSighting] }))).toBeNull();
  });

  it('keeps from pointing at the same sighting when others go, and drops it when its sighting goes', () => {
    const list = [meshSighting, photoSighting, outline('m', 1)];
    expect(keepSightings(list, (_, i) => i !== 0)).toEqual([photoSighting, outline('m', 0)]);
    expect(keepSightings(list, (_, i) => i !== 1)).toEqual([
      meshSighting,
      { on: 'mesh', layer: 'm', geom: { type: 'spolygon', points: ring } },
    ]);
    expect(shiftFrom([outline('m', 0), photoSighting], 3)).toEqual([
      outline('m', 3),
      photoSighting,
    ]);
    expect(dropFrom(outline('m', 2))).toEqual({
      on: 'mesh',
      layer: 'm',
      geom: { type: 'spolygon', points: ring },
    });
  });

  it('replaces the automatic pin on the placed layer only', () => {
    const issue = makeIssue({
      sightings: [photoSighting, autoPin('m', 0), autoPin('other', 0), meshSighting],
    });
    const next = withPlacedArea(issue, 'm', [outline('m', 0)], LATER);
    expect(next.sightings).toEqual([
      photoSighting,
      autoPin('other', 0),
      meshSighting,
      outline('m', 0),
    ]);
    expect(next.updatedAt).toBe(LATER);
  });

  it('replaces an earlier area on the same layer, and renumbers from after the removals', () => {
    const issue = makeIssue({ sightings: [autoPin('m', 1), photoSighting, outline('m', 1)] });
    const next = withPlacedArea(issue, 'm', [outline('m', 1)], LATER);
    // the pin and the old outline went: the photo is now sighting 0
    expect(next.sightings).toEqual([photoSighting, outline('m', 0)]);
  });
});
