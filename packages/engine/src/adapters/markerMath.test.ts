import { describe, expect, it } from 'vitest';
import { clusterSites, hitCluster, timeSpan } from './markerMath';
import { photoStations } from './photos';

describe('photo places', () => {
  it('gives photos taken within 1.5 m one place', () => {
    // Al-Zour: a hover burst of three, a lone photo 70 m off, another burst of four
    const at = (x: number, y: number, z: number) => ({
      pos: [x, y, z] as [number, number, number],
    });
    const stations = photoStations(
      [
        at(-423, 182.8, -147),
        at(-423, 182.7, -146.9),
        at(-423.05, 182.7, -146.9),
        at(-490.8, 183.1, -166.4),
        at(-882.7, 126.9, -315.6),
        at(-882.6, 126.9, -315.6),
        at(-882.5, 126.8, -315.7),
        at(-882.5, 126.8, -315.5),
      ],
      1.5,
    );
    expect(stations.map((s) => s.photos.length)).toEqual([3, 1, 4]);
  });
});

describe('clusterSites', () => {
  it('merges icons closer than the radius and adds up their counts', () => {
    const c = clusterSites(
      [
        { i: 0, x: 100, y: 100, n: 3 },
        { i: 1, x: 112, y: 104, n: 1 },
        { i: 2, x: 300, y: 100, n: 4 },
        { i: 3, x: 330, y: 100, n: 1 },
      ],
      24,
    );
    expect(c.map((k) => ({ sites: k.sites, count: k.count }))).toEqual([
      { sites: [2], count: 4 },
      { sites: [0, 1], count: 4 },
      { sites: [3], count: 1 },
    ]);
    // the icon sits on the place with the most photos, so it does not wander while zooming
    expect([c[1]?.x, c[1]?.y]).toEqual([100, 100]);
  });

  it('separates every place once zoomed in far enough', () => {
    const sites = Array.from({ length: 50 }, (_, i) => ({ i, x: i * 30, y: 0, n: 1 }));
    expect(clusterSites(sites, 24)).toHaveLength(50);
  });

  it('hits an icon within the 28 px target and picks the nearest', () => {
    const c = clusterSites(
      [
        { i: 0, x: 100, y: 100, n: 1 },
        { i: 1, x: 140, y: 100, n: 1 },
      ],
      24,
    );
    expect(hitCluster(c, 113, 100, 14)).toBe(0);
    expect(hitCluster(c, 128, 100, 14)).toBe(1);
    expect(hitCluster(c, 120, 120, 14)).toBe(-1);
  });
});

describe('timeSpan', () => {
  it('reads the time span of a place from takenAt', () => {
    expect(timeSpan(['2023-02-21T10:30:55Z', '2023-02-21T10:30:48Z'])).toEqual([
      '10:30:48',
      '10:30:55',
    ]);
    expect(timeSpan(['2024-06-05T08:24:26+04:00'])).toBe('08:24:26');
    expect(timeSpan(['2024-06-05T08:24:26+04:00', '2024-06-06T09:00:00+04:00'])).toEqual([
      '2024-06-05 08:24',
      '2024-06-06 09:00',
    ]);
    expect(timeSpan([undefined, 'not a time'])).toBeNull();
  });
});
