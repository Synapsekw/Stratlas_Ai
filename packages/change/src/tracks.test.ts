import type { AntennasFile, AntennaUnit, ChangeSet, Layer } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  acrossDates,
  antennaTracks,
  groundSampleM,
  hotspotTracks,
  linkTracks,
  regionTracks,
  trackOf,
  type HotspotDetection,
  type TrackObservation,
} from './tracks';
import { photosAt } from './testing';

const CAPTURES = [
  { id: 'c1', date: '2026-02-01' },
  { id: 'c2', date: '2026-06-01' },
  { id: 'c3', date: '2026-10-01' },
];

const v = (value: number) => ({
  value,
  basis: 'measured' as const,
  quality: { basis: 'measured' as const },
});

function unit(id: string, centre: [number, number, number], az: number, tilt: number): AntennaUnit {
  return {
    id,
    name: id.toUpperCase().slice(-2),
    kind: 'panel',
    kindBasis: 'geometry',
    status: 'accepted',
    box: {
      centre,
      axes: [
        [1, 0, 0],
        [0, 0, 1],
        [0, 1, 0],
      ],
      extents: [0.3, 1.4, 0.15],
    },
    support: 100,
    azimuthGridDeg: v(az),
    downtiltDeg: v(tilt),
    widthM: v(0.3),
    heightM: v(1.4),
    depthM: v(0.15),
    convergenceDeg: null,
    photos: [],
    user: {},
    runId: 'run-a',
    createdAt: '2026-02-01T00:00:00Z',
  } as unknown as AntennaUnit;
}

const inventory = (capture: string, units: AntennaUnit[]): AntennasFile =>
  ({
    schema: 'aio.antennas/1',
    run: { id: `run-${capture}`, captureId: capture },
    units,
  }) as unknown as AntennasFile;

const obs = (
  capture: string,
  ref: string,
  at: [number, number, number],
  extra: Partial<TrackObservation> = {},
): TrackObservation => ({
  capture,
  date: CAPTURES.find((c) => c.id === capture)?.date ?? '',
  ref,
  at,
  draft: false,
  values: {},
  class: 'x',
  radiusM: 0.5,
  ...extra,
});

describe('linkTracks', () => {
  it('links the nearest within the radius, each once, and starts a track for the rest', () => {
    const tracks = linkTracks(
      'hotspot',
      [
        obs('c1', 'a', [0, 0, 0]),
        obs('c1', 'b', [3, 0, 0]),
        obs('c2', 'a2', [0.2, 0, 0]),
        obs('c2', 'far', [10, 0, 0]),
      ],
      CAPTURES,
    );
    expect(tracks.map((t) => [t.id, t.sightings.map((s) => s.ref)])).toEqual([
      ['hotspot:c1:a', ['a', 'a2']],
      ['hotspot:c1:b', ['b']],
      ['hotspot:c2:far', ['far']],
    ]);
  });

  it('needs the same class unless the key is the same', () => {
    const t = linkTracks(
      'antenna',
      [
        obs('c1', 'a', [0, 0, 0], { class: 'panel' }),
        obs('c2', 'b', [0, 0, 0], { class: 'dish' }),
        obs('c1', 'k', [5, 0, 0], { class: 'panel', key: 'K' }),
        obs('c2', 'k', [9, 0, 0], { class: 'other', key: 'K' }),
      ],
      CAPTURES,
    );
    expect(acrossDates(t).map((x) => x.sightings.map((s) => s.ref))).toEqual([['k', 'k']]);
  });

  it('skips a date and still links to the last sighting', () => {
    const t = linkTracks(
      'hotspot',
      [obs('c1', 'a', [0, 0, 0]), obs('c3', 'b', [0.1, 0, 0])],
      CAPTURES,
    );
    expect(t).toHaveLength(1);
    expect(t[0]?.sightings.map((s) => s.capture)).toEqual(['c1', 'c3']);
  });

  it('is the same whatever order the observations come in', () => {
    const list = [
      obs('c1', 'a', [0, 0, 0]),
      obs('c1', 'b', [0.6, 0, 0]),
      obs('c2', 'x', [0.3, 0, 0]),
      obs('c2', 'y', [0.65, 0, 0]),
    ];
    const one = linkTracks('hotspot', list, CAPTURES);
    const two = linkTracks('hotspot', [...list].reverse(), CAPTURES);
    expect(two).toEqual(one);
  });
});

describe('antennaTracks', () => {
  it('follows a unit across dates with its azimuth and downtilt trend, lined up', () => {
    const files = [
      inventory('c1', [unit('ant-a-1', [100, 200, 30], 358, 4)]),
      inventory('c2', [unit('ant-b-9', [104, 196.5, 30], 6, 6)]),
    ];
    // c2 is lined up 4 m west and 3.5 m north of its own frame: the same place as c1
    const tracks = antennaTracks(files, null, CAPTURES, (c) =>
      c === 'c2' ? { eastM: -4, northM: 3.5 } : null,
    );
    expect(tracks).toHaveLength(1);
    const [t] = tracks;
    expect(t?.sightings.map((s) => s.ref)).toEqual(['ant-a-1', 'ant-b-9']);
    expect(t?.trends.find((x) => x.metric === 'azimuthDeg')?.lastChange).toBeCloseTo(8);
    expect(t?.trends.find((x) => x.metric === 'downtiltDeg')?.totalChange).toBeCloseTo(2);
    expect(trackOf(tracks, 'ant-b-9')?.id).toBe('antenna:c1:ant-a-1');
  });

  it('prefers the live inventory for its date and leaves rejected units out', () => {
    const live = inventory('c2', [
      { ...unit('ant-a-1', [100, 200, 30], 10, 4), status: 'rejected' },
    ]);
    const tracks = antennaTracks(
      [
        inventory('c1', [unit('ant-a-1', [100, 200, 30], 0, 4)]),
        inventory('c2', [unit('ant-a-1', [100, 200, 30], 0, 4)]),
      ],
      live,
      CAPTURES,
      () => null,
    );
    expect(tracks.map((t) => t.sightings.length)).toEqual([1]);
  });
});

describe('regionTracks', () => {
  const region = (id: string, x: number, size: number, area: number) => ({
    kind: 'region' as const,
    id,
    verdict: 'changed' as const,
    at: [x, 0, 0] as [number, number, number],
    areaM2: area,
    outlineLocal: [
      [x - size, 0, -size],
      [x + size, 0, -size],
      [x + size, 0, size],
      [x - size, 0, size],
    ] as [number, number, number][],
  });
  const set = (from: string, to: string, items: unknown[]): ChangeSet =>
    ({
      schema: 'aio.change/1',
      id: `${from}-${to}-raster`,
      from,
      to,
      producer: 'change.raster',
      createdAt: '2026-10-01T00:00:00Z',
      items,
      layers: [],
      stats: {},
    }) as unknown as ChangeSet;

  it('chains the regions of consecutive pairs by overlap and reads the area trend', () => {
    const tracks = regionTracks(
      [
        set('c1', 'c2', [region('r1', 0, 2, 16)]),
        set('c2', 'c3', [region('r7', 1, 3, 36)]),
        set('c1', 'c3', [region('skip', 0, 2, 16)]),
      ],
      CAPTURES,
    );
    const across = acrossDates(tracks);
    expect(across).toHaveLength(1);
    expect(across[0]?.sightings.map((s) => s.ref)).toEqual(['c1-c2-raster/r1', 'c2-c3-raster/r7']);
    expect(across[0]?.trends.find((t) => t.metric === 'areaM2')?.lastChange).toBe(20);
    expect(tracks.some((t) => t.sightings.some((s) => s.ref.includes('skip')))).toBe(false);
  });
});

describe('hotspotTracks', () => {
  const layers: Layer[] = [photosAt('th1', 'c1', [0]), photosAt('th2', 'c2', [0])];
  const spot = (
    layer: string,
    id: string,
    x: number,
    peak: number,
    status: 'draft' | 'rejected' = 'draft',
  ): HotspotDetection => ({
    id,
    layer,
    photo: `${layer}-0`,
    status,
    widthPx: 640,
    fields: [{ key: 'peak_c', value: peak }],
    point: [x, 0, 0],
  });
  const index = { captures: CAPTURES, of: { th1: 'c1', th2: 'c2' } };

  it('links placed hot spots across dates with the peak trend', () => {
    const tracks = hotspotTracks(
      { layers },
      index,
      [spot('th1', 'h1', 0, 61.5), spot('th2', 'h2', 0.4, 70)],
      () => null,
    );
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.trends[0]).toMatchObject({ metric: 'peakC', lastChange: 8.5 });
    expect(tracks[0]?.sightings.every((s) => s.draft)).toBe(true);
  });

  it('leaves rejected and unplaced hot spots out', () => {
    const tracks = hotspotTracks(
      { layers },
      index,
      [spot('th1', 'h1', 0, 61.5), spot('th2', 'h2', 0.4, 70, 'rejected')],
      () => null,
    );
    expect(tracks.map((t) => t.sightings.length)).toEqual([1]);
  });

  it('scales the radius with ground sample distance', () => {
    const photo = (layers[0] as Extract<Layer, { kind: 'photos' }>).items[0];
    // 50 m away, 80 degrees over 640 px: 50 * 2 tan 40 / 640 = 0.131 m per pixel
    expect(groundSampleM(photo, [0, 0, 0], 640)).toBeCloseTo(0.1311, 3);
    expect(groundSampleM(undefined, [0, 0, 0], 640)).toBe(0);
  });
});
