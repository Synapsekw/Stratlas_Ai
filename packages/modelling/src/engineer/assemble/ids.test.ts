import { describe, expect, it } from 'vitest';
import { assignIds, azimuthDeg } from './ids';

describe('azimuthDeg', () => {
  it('is a compass bearing: north (-z) 0, east (+x) 90, south 180, west 270', () => {
    expect(azimuthDeg(0, -1)).toBeCloseTo(0, 9);
    expect(azimuthDeg(1, 0)).toBeCloseTo(90, 9);
    expect(azimuthDeg(0, 1)).toBeCloseTo(180, 9);
    expect(azimuthDeg(-1, 0)).toBeCloseTo(270, 9);
  });
});

describe('assignIds', () => {
  it('orders by azimuth clockwise from north, then height', () => {
    // north = -Z => azimuth 0; east = +X => 90
    expect(
      assignIds('flue', [{ azimuthDeg: 200 }, { azimuthDeg: 10 }, { azimuthDeg: 95 }]),
    ).toEqual(['flue-3', 'flue-1', 'flue-2']);
  });

  it('orders items at one azimuth by height, and items without one by height alone', () => {
    expect(
      assignIds('light', [
        { azimuthDeg: 90, y: 80 },
        { azimuthDeg: 90, y: 40 },
        { azimuthDeg: 0, y: 120 },
      ]),
    ).toEqual(['light-3', 'light-2', 'light-1']);
    expect(assignIds('band', [{ y: 108 }, { y: 100 }])).toEqual(['band-2', 'band-1']);
  });

  it('keeps the ids of items matched to the previous ones and numbers new ones after them', () => {
    const previous = [
      { id: 'flue-1', azimuthDeg: 0 },
      { id: 'flue-2', azimuthDeg: 120 },
      { id: 'flue-3', azimuthDeg: 240 },
    ];
    // four evenly spaced: 0, 90, 180, 270; 90 and 270 are nearest 120 and 240
    expect(
      assignIds(
        'flue',
        [0, 90, 180, 270].map((a) => ({ azimuthDeg: a })),
        previous,
      ),
    ).toEqual(['flue-1', 'flue-2', 'flue-4', 'flue-3']);
  });

  it('does not match an item turned far from every previous one', () => {
    expect(
      assignIds(
        'flue',
        [{ azimuthDeg: 0 }, { azimuthDeg: 180 }],
        [
          { id: 'flue-1', azimuthDeg: 0 },
          { id: 'flue-2', azimuthDeg: 20 },
          { id: 'flue-3', azimuthDeg: 40 },
        ],
      ),
    ).toEqual(['flue-1', 'flue-4']);
  });

  it('ignores previous ids of other roles', () => {
    expect(
      assignIds('light-l1', [{ azimuthDeg: 0 }], [{ id: 'light-l12-1', azimuthDeg: 0 }]),
    ).toEqual(['light-l1-1']);
  });
});
