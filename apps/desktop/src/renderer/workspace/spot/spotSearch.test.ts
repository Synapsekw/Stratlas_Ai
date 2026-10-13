import { describe, expect, it } from 'vitest';
import { overflight, panoAt, photoAt } from './__fixtures__/spotPoses';
import { historyFor, sameItem, searchSpot } from './spotSearch';
import type { Spot, SpotEntry } from './spotTypes';

const spot: Spot = { camera: [0, 1.6, 0], bearingDeg: 0, target: [0, 0, -15], aerial: false };
const captures = ['d1', 'd2', 'd3'];
const d1 = (id: string, x: number) =>
  photoAt(id, [x, 1.6, 0], 0, { capture: 'd1', layer: 'photos-d1' });

describe('searchSpot', () => {
  const entries: SpotEntry[] = [
    d1('self', 0),
    d1('near', 2),
    photoAt('far-angle', [10, 1.6, 0], 30),
    photoAt('straight', [12, 1.6, 0], 0),
    photoAt('drone', [0, 40, -15], 0, { pitchDeg: -90 }),
    photoAt('nogps', undefined, 0, { capture: 'd3', layer: 'photos-d3' }),
    { kind: 'video', layer: 'clip-d3', capture: 'd3', samples: null },
    photoAt('undated', [1, 1.6, 0], 0, { capture: undefined, layer: 'photos-any' }),
  ];
  const h = searchSpot({
    spot,
    entries,
    captures,
    origin: { item: { kind: 'photo', layer: 'photos-d1', photo: 'self' }, capture: 'd1' },
  });

  it('lists every survey date, oldest first, gaps included', () => {
    expect(h.dates.map((d) => d.capture)).toEqual(captures);
    expect(h.dates[2]?.matches).toEqual([]);
  });
  it('counts what cannot match on its date', () => {
    expect(h.dates[2]?.skipped).toBe(2);
    expect(h.dates[1]?.skipped).toBe(0);
  });
  it('ranks within a date: the spot class first, then the score', () => {
    expect(h.dates[1]?.matches.map((m) => (m.item.kind === 'photo' ? m.item.photo : ''))).toEqual([
      'straight',
      'far-angle',
      'drone',
    ]);
  });
  it('makes the clicked item the match of its own date, once', () => {
    const own = h.dates[0]?.matches ?? [];
    expect(own[0]?.item).toEqual({ kind: 'photo', layer: 'photos-d1', photo: 'self' });
    expect(own[0]?.distanceM).toBe(0);
    expect(own.filter((m) => m.item.kind === 'photo' && m.item.photo === 'self')).toHaveLength(1);
    expect(own[1]?.item).toEqual({ kind: 'photo', layer: 'photos-d1', photo: 'near' });
  });
  it('leaves undated layers out of every slot', () => {
    for (const d of h.dates)
      expect(d.matches.some((m) => m.item.kind === 'photo' && m.item.photo === 'undated')).toBe(
        false,
      );
  });
  it('ties keep entry order', () => {
    const tie = searchSpot({
      spot,
      captures: ['d2'],
      entries: [photoAt('m', [0, 1.6, 0], null), photoAt('n', [0, 1.6, 0], null)],
    });
    expect(tie.dates[0]?.matches.map((m) => (m.item.kind === 'photo' ? m.item.photo : ''))).toEqual(
      ['m', 'n'],
    );
  });
  it('an undated origin gets no slot of its own', () => {
    const u = searchSpot({
      spot,
      entries,
      captures,
      origin: {
        item: { kind: 'photo', layer: 'photos-any', photo: 'undated' },
        capture: undefined,
      },
    });
    const ids = (c: number) =>
      u.dates[c]?.matches.map((m) => (m.item.kind === 'photo' ? m.item.photo : ''));
    expect(ids(0)).toEqual(['self', 'near']);
    expect(ids(1)).toEqual(['straight', 'far-angle', 'drone']);
  });
  it('replaces a clip of the clicked video by the clicked moment', () => {
    const v = searchSpot({
      spot,
      captures: ['d2'],
      entries: [{ kind: 'video', layer: 'clip', capture: 'd2', samples: overflight() }],
      origin: { item: { kind: 'video', layer: 'clip', t: 3.2 }, capture: 'd2' },
    });
    expect(v.dates[0]?.matches.map((m) => m.item)).toEqual([
      { kind: 'video', layer: 'clip', t: 3.2 },
    ]);
  });
  it('searches 10,000 photos over 20 dates quickly', () => {
    const dates = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const many: SpotEntry[] = [];
    for (let i = 0; i < 10_000; i++) {
      const c = dates[i % 20];
      many.push(
        photoAt(`p${i}`, [(i % 50) - 25, 1.6, 0], (i * 7) % 360, { capture: c, layer: `l-${c}` }),
      );
    }
    const t0 = performance.now();
    const r = searchSpot({ spot, entries: many, captures: dates });
    const ms = performance.now() - t0;
    expect(r.dates).toHaveLength(20);
    // The spec's budget is 100 ms on a workstation; the bound is loose for a busy runner.
    expect(ms).toBeLessThan(250);
  });
});

describe('historyFor', () => {
  const index = { captures: [{ id: 'd1' }, { id: 'd2' }] } as unknown as Parameters<
    typeof historyFor
  >[2];
  it('says when the clicked item has no position', () => {
    const e = [photoAt('x', undefined, 0, { capture: 'd1', layer: 'photos-d1' })];
    expect(
      historyFor({ item: { kind: 'photo', layer: 'photos-d1', photo: 'x' } }, e, index),
    ).toEqual({ error: 'noPosition' });
  });
  it('searches from a panorama', () => {
    const e = [panoAt('a', [0, 1.6, 0], 'd1'), panoAt('b', [3, 1.6, 0], 'd2')];
    const r = historyFor({ item: { kind: 'pano', layer: 'pano-d1', pano: 'a' } }, e, index);
    expect('history' in r && r.history.dates[1]?.matches[0]?.item).toEqual({
      kind: 'pano',
      layer: 'pano-d2',
      pano: 'b',
    });
  });
  it("opens a walk frame turned by the origin sample's picture centre", () => {
    const e: SpotEntry[] = [
      {
        kind: 'walk',
        layer: 'walk-d1',
        capture: 'd1',
        samples: [
          { t: 4, pos: [0, 1.7, 0], groundY: 0, bearingDeg: 30 },
          { t: 5, pos: [1, 1.7, 0], groundY: 0, bearingDeg: 40 },
        ],
      },
    ];
    const r = historyFor(
      { item: { kind: 'walk', layer: 'walk-d1', t: 4.9 }, lookDeg: 100 },
      e,
      index,
    );
    const self = 'history' in r ? r.history.dates[0]?.matches[0] : undefined;
    expect(self?.item).toEqual({ kind: 'walk', layer: 'walk-d1', t: 4.9 });
    expect(self?.lookDeg).toBe(100);
    expect(self?.centreDeg).toBe(40);
  });
  it('compares items by identity', () => {
    expect(sameItem({ kind: 'walk', layer: 'w', t: 1 }, { kind: 'walk', layer: 'w', t: 9 })).toBe(
      true,
    );
    expect(
      sameItem({ kind: 'pano', layer: 'p', pano: 'a' }, { kind: 'pano', layer: 'p', pano: 'b' }),
    ).toBe(false);
  });
});
