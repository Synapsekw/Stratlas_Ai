import { fromWgs84 } from '@aio/geo';
import type { ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import { siteOffset, usesLanes } from './lanes';

describe('usesLanes', () => {
  const index = { captures: threeDates.captures };
  it('is true for a project with video and dates', () => {
    expect(usesLanes(threeDates, index)).toBe(true);
  });
  it('is false without video, without dates or without an index', () => {
    const noVideo = { layers: threeDates.layers.filter((l) => l.kind !== 'video') };
    expect(usesLanes(noVideo, index)).toBe(false);
    expect(usesLanes(threeDates, { captures: [] })).toBe(false);
    expect(usesLanes(threeDates, null)).toBe(false);
  });
});

describe('siteOffset', () => {
  it('reads the site clock from the origin and the EPSG code', () => {
    const origin = fromWgs84([48.1, 29.0, 0], 32639);
    expect(siteOffset({ crs: { epsg: 32639 }, origin })).toBe(180);
  });
  it('is null for a WKT CRS', () => {
    const m = { crs: { wkt: 'LOCAL_CS["site"]' }, origin: [0, 0, 0] } as Pick<
      ProjectManifest,
      'crs' | 'origin'
    >;
    expect(siteOffset(m)).toBeNull();
  });
});
