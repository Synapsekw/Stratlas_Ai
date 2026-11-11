import type { AntennaHistoryFile, AntennasFile, ChangeSet, Layer } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  acrossDates,
  antennaTracks,
  groundSampleM,
  hotspotTracks,
  linkTracks,
  liveDateUnrecorded,
  regionTracks,
  trackOf,
  turnedAzimuth,
  type HotspotDetection,
  type TrackObservation,
} from './tracks';
import { photosAt } from './testing';

const CAPTURES = [
  { id: 'c1', date: '2026-02-01' },
  { id: 'c2', date: '2026-06-01' },
  { id: 'c3', date: '2026-10-01' },
];

type Entry = AntennaHistoryFile['units'][number];

const entry = (
  id: string,
  centre: [number, number, number],
  az: number,
  tilt: number,
  extra: Partial<Entry> = {},
): Entry => ({
  id,
  name: 'A1',
  kind: 'panel',
  status: 'accepted',
  reviewed: true,
  centre,
  extents: [0.3, 1.4, 0.15],
  azimuthGridDeg: az,
  downtiltDeg: tilt,
  ...extra,
});

const record = (captureId: string, units: Entry[]): AntennaHistoryFile => ({
  schema: 'aio.antenna-history/1',
  captureId,
  runId: `run-${captureId}`,
  at: '2026-06-01T00:00:00Z',
  units,
});

/** The live inventory: only ids and statuses matter to the tracks. */
const inventory = (capture: string, units: { id: string; status: string }[]): AntennasFile =>
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
    const records = [
      record('c1', [entry('ant-a-1', [100, 200, 30], 358, 4)]),
      record('c2', [entry('ant-b-9', [104, 196.5, 30], 6, 6)]),
    ];
    // c2 is lined up 4 m west and 3.5 m north of its own frame: the same place as c1
    const tracks = antennaTracks(records, null, CAPTURES, (c) =>
      c === 'c2' ? { eastM: -4, northM: 3.5 } : null,
    );
    expect(tracks).toHaveLength(1);
    const [t] = tracks;
    expect(t?.sightings.map((s) => s.ref)).toEqual(['ant-a-1', 'ant-b-9']);
    expect(t?.trends.find((x) => x.metric === 'azimuthDeg')?.lastChange).toBeCloseTo(8);
    expect(t?.trends.find((x) => x.metric === 'downtiltDeg')?.totalChange).toBeCloseTo(2);
    expect(t?.trends.some((x) => x.metric === 'centreHeightM')).toBe(false);
    expect(trackOf(tracks, 'ant-b-9')?.id).toBe('antenna:c1:ant-a-1');
  });

  it("takes the person's later decision on the live date, and drops units gone from it", () => {
    const records = [
      record('c1', [entry('ant-a-1', [0, 0, 30], 0, 4), entry('ant-a-2', [5, 0, 30], 0, 4)]),
      record('c2', [
        entry('ant-a-1', [0, 0, 30], 10, 4, { reviewed: false }),
        entry('ant-a-2', [5, 0, 30], 0, 4, { reviewed: false }),
      ]),
    ];
    const live = inventory('c2', [{ id: 'ant-a-1', status: 'rejected' }]);
    expect(
      antennaTracks(records, live, CAPTURES, () => null).map((t) => t.sightings.length),
    ).toEqual([1, 1]);
    // the live status wins: accepted counts, draft stays a draft
    const kept = inventory('c2', [
      { id: 'ant-a-1', status: 'accepted' },
      { id: 'ant-a-2', status: 'draft' },
    ]);
    const tracks = antennaTracks(records, kept, CAPTURES, () => null);
    expect(tracks.map((t) => t.sightings.map((s) => s.draft))).toEqual([
      [false, false],
      [false, true],
    ]);
  });

  it("turns azimuths with the date's line-up turn", () => {
    const turn = {
      eastM: 0,
      northM: 0,
      turn: { rotationDeg: 10, scale: 1, pivotE: 0, pivotN: 0, pivotX: 0, pivotZ: 0 },
    };
    expect(turnedAzimuth(90, turn)).toBeCloseTo(80);
    expect(turnedAzimuth(5, turn)).toBeCloseTo(355);
    expect(turnedAzimuth(90, null)).toBe(90);
    const [t] = antennaTracks(
      [
        record('c1', [entry('ant-a-1', [0, 0, 30], 80, 4)]),
        record('c2', [entry('ant-a-1', [0, 0, 30], 90, 4)]),
      ],
      null,
      CAPTURES,
      (c) => (c === 'c2' ? turn : null),
    );
    expect(t?.trends.find((x) => x.metric === 'azimuthDeg')?.lastChange).toBeCloseTo(0);
  });

  it('knows whether the live date lacks a record', () => {
    expect(liveDateUnrecorded([record('c1', [])], inventory('c2', []))).toBe(true);
    expect(liveDateUnrecorded([record('c2', [])], inventory('c2', []))).toBe(false);
    expect(liveDateUnrecorded([], null)).toBe(false);
    // a date id the pipeline does not file a record under
    expect(liveDateUnrecorded([], inventory('a b', []))).toBe(false);
  });

  it('counts an accepted unit carried over and measured again as confirmed', () => {
    const records = [
      record('c1', [entry('ant-a-1', [0, 0, 30], 10, 4)]),
      record('c2', [entry('ant-a-1', [0, 0, 30], 20, 4, { reviewed: false })]),
      record('c3', [entry('ant-a-1', [0, 0, 30], 25, 4, { status: 'draft', reviewed: false })]),
    ];
    const [t] = antennaTracks(records, null, CAPTURES, () => null);
    expect(t?.sightings.map((s) => s.draft)).toEqual([false, false, true]);
  });
});

describe('trends', () => {
  it('shows no change since the date before for a value the latest date lacks', () => {
    const [t] = linkTracks(
      'antenna',
      [
        obs('c1', 'a', [0, 0, 0], { values: { azimuthDeg: 1, downtiltDeg: 2 } }),
        obs('c2', 'b', [0, 0, 0], { values: { azimuthDeg: 3, downtiltDeg: 4 } }),
        obs('c3', 'c', [0, 0, 0], { values: { azimuthDeg: 5 } }),
      ],
      CAPTURES,
    );
    expect(t?.trends.find((x) => x.metric === 'azimuthDeg')?.lastChange).toBe(2);
    expect(t?.trends.find((x) => x.metric === 'downtiltDeg')?.lastChange).toBeNull();
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

  it('reads one set per pair and producer: the newest whole-site one that is not out of date', () => {
    const later = {
      ...set('c2', 'c3', [region('new', 1, 3, 36)]),
      createdAt: '2026-10-02T00:00:00Z',
    };
    const stale = {
      ...set('c2', 'c3', [region('stale', 1, 3, 99)]),
      id: 'c2-c3-raster-old',
      createdAt: '2026-10-03T00:00:00Z',
    };
    const area = {
      ...set('c2', 'c3', [region('area', 1, 3, 40)]),
      id: 'c2-c3-raster-yard',
      scope: { id: 'yard', name: 'Yard' },
    };
    const older = set('c2', 'c3', [region('older', 1, 3, 30)]);
    const tracks = regionTracks(
      [set('c1', 'c2', [region('r1', 0, 2, 16)]), older, later, stale, area],
      CAPTURES,
      (s) => s.id === 'c2-c3-raster-old',
    );
    const refs = tracks.flatMap((t) => t.sightings.map((s) => s.ref));
    expect(refs).toEqual(['c1-c2-raster/r1', 'c2-c3-raster/new']);
    // without a whole-site set, the area's own set is read
    const only = regionTracks([set('c1', 'c2', [region('r1', 0, 2, 16)]), area], CAPTURES);
    expect(only.flatMap((t) => t.sightings.map((s) => s.ref))).toContain('c2-c3-raster-yard/area');
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
