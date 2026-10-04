import { fromWgs84 } from '@aio/geo';
import type { Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { photoRef, photoLens } from './photos';

const origin = (lon: number, lat: number, h: number): Vec3 => {
  const p = fromWgs84([lon, lat, 0], 32639);
  return [p[0], p[1], h];
};

describe('photoRef', () => {
  it('places a GPS photo in the local frame with its capture time in UTC offset form', () => {
    const r = photoRef(
      'p001',
      'photos/p001.jpg',
      {
        takenAt: '2019-01-24T11:45:58',
        gps: { lat: 29.0276, lon: 48.1352, alt: 31.7 },
        focal35: 200,
        width: 7952,
        height: 5304,
      },
      { epsg: 32639, origin: origin(48.1352, 29.0276, 30), utcOffsetMin: 180 },
    );
    expect(r.takenAt).toBe('2019-01-24T11:45:58+03:00');
    expect(r.pos?.[0]).toBeCloseTo(0, 6);
    expect(r.pos?.[1]).toBeCloseTo(1.7, 6);
    expect(r.q).toBeUndefined();
    expect(r.lens?.hfovDeg).toBeCloseTo(10.29, 1);
  });

  it('orients a DJI photo from its gimbal angles and prefers the XMP position', () => {
    const r = photoRef(
      'd',
      'photos/d.jpg',
      {
        gps: { lat: 29.38, lon: 47.98, alt: 106 },
        focal35: 24,
        width: 5280,
        height: 2970,
        make: 'Hasselblad',
        dji: {
          lat: 29.38001,
          lon: 47.98,
          absAlt: 106.7,
          gimbal: { yaw: 90, pitch: -90, roll: 0 },
        },
      },
      { epsg: 32639, origin: origin(47.98, 29.38, 0), utcOffsetMin: 180 },
    );
    expect(r.pos?.[2]).toBeLessThan(-1); // 1.1 m north
    expect(r.pos?.[1]).toBeCloseTo(106.7, 6);
    expect(r.q).toBeDefined();
    // 16:9 photo cut from a 4:3 sensor: full sensor width
    expect(r.lens?.hfovDeg).toBeCloseTo(71.6, 1);
  });

  it('keeps photos without GPS, unplaced', () => {
    const r = photoRef(
      'x',
      'photos/x.jpg',
      {},
      { epsg: 32639, origin: [0, 0, 0], utcOffsetMin: 0 },
    );
    expect(r).toEqual({ id: 'x', src: { path: 'photos/x.jpg' } });
  });
});

describe('photoLens', () => {
  it('uses the image aspect for non-DJI cameras and needs a focal length', () => {
    expect(photoLens({ focal35: 50, width: 6000, height: 4000 })?.aspect).toBeCloseTo(1.5, 4);
    expect(photoLens({ width: 6000, height: 4000 })).toBeUndefined();
  });
});
