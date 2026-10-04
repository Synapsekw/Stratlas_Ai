import { fromWgs84 } from '@aio/geo';
import type { Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { photoAltitude, photoHeight, photoRef, photoLens } from './photos';

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

describe('photo heights (data-conventions 3a)', () => {
  const o = origin(47.98, 29.38, 100);
  const frame = { epsg: 32639, origin: o, utcOffsetMin: 180 };
  // a DJI photo of Al-Zour flight 1: 113.7 m above take-off, absolute = relative + 41.9
  const meta = {
    gps: { lat: 29.38, lon: 47.98, alt: 155.6 },
    dji: { lat: 29.38, lon: 47.98, absAlt: 155.6, relAlt: 113.7 },
  };

  it('XMP absolute altitude plus the project datum offset', () => {
    const f = {
      ...frame,
      heights: { prefer: 'absolute' as const, absOffsetM: 100, takeoffH: 100 },
    };
    expect(photoHeight(meta, f).source).toBe('absolute');
    expect(photoRef('a', 'a.jpg', meta, f).pos?.[1]).toBeCloseTo(155.6, 6);
  });

  it('XMP relative altitude plus the take-off height', () => {
    const f = {
      ...frame,
      heights: { prefer: 'relative' as const, absOffsetM: 0, takeoffH: 141.9 },
    };
    expect(photoHeight(meta, f).source).toBe('relative');
    // take-off at EL 141.9: 141.9 + 113.7 - origin 100
    expect(photoRef('a', 'a.jpg', meta, f).pos?.[1]).toBeCloseTo(155.6, 6);
  });

  it('EXIF GPS altitude counts as absolute; missing altitudes fall back', () => {
    expect(photoAltitude({ gps: { lat: 1, lon: 2, alt: 31.7 } })).toEqual({
      abs: 31.7,
      rel: undefined,
    });
    const rel = {
      ...frame,
      heights: { prefer: 'relative' as const, absOffsetM: 0, takeoffH: 100 },
    };
    expect(photoHeight({ gps: { lat: 29.38, lon: 47.98, alt: 31.7 } }, rel)).toEqual({
      h: 31.7,
      source: 'absolute',
    });
    expect(photoHeight({ dji: { relAlt: 20 } }, frame)).toEqual({ h: 120, source: 'relative' });
    const none = photoRef('n', 'n.jpg', { gps: { lat: 29.38, lon: 47.98 } }, rel);
    expect(none.pos?.[1]).toBeCloseTo(0, 6);
    expect(photoHeight({ gps: { lat: 29.38, lon: 47.98 } }, rel).source).toBe('none');
  });
});

describe('photoLens', () => {
  it('uses the image aspect for non-DJI cameras and needs a focal length', () => {
    expect(photoLens({ focal35: 50, width: 6000, height: 4000 })?.aspect).toBeCloseTo(1.5, 4);
    expect(photoLens({ width: 6000, height: 4000 })).toBeUndefined();
  });
});
