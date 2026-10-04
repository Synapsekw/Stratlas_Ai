import { describe, expect, it } from 'vitest';
import { readPhotoMeta } from './exif';
import { withExif } from './testing';

describe('readPhotoMeta', () => {
  it('reads camera, time, focal lengths and GPS from EXIF (little-endian)', () => {
    const m = readPhotoMeta(
      withExif({
        make: 'SONY',
        model: 'ILCE-7RM3',
        dateTimeOriginal: '2019:01:24 11:45:58',
        focalMm: 200,
        focal35: 200,
        lat: 29.02761989,
        lon: 48.135192,
        alt: 31.7,
        width: 7952,
        height: 5304,
      }),
    );
    expect(m).toMatchObject({
      make: 'SONY',
      model: 'ILCE-7RM3',
      takenAt: '2019-01-24T11:45:58',
      focalMm: 200,
      focal35: 200,
      width: 7952,
      height: 5304,
    });
    expect(m.gps?.lat).toBeCloseTo(29.02761989, 6);
    expect(m.gps?.lon).toBeCloseTo(48.135192, 6);
    expect(m.gps?.alt).toBeCloseTo(31.7, 3);
  });

  it('reads big-endian EXIF, southern and western coordinates', () => {
    const m = readPhotoMeta(withExif({ bigEndian: true, lat: -33.9, lon: -18.4, alt: -2 }));
    expect(m.gps?.lat).toBeCloseTo(-33.9, 6);
    expect(m.gps?.lon).toBeCloseTo(-18.4, 6);
    expect(m.gps?.alt).toBeCloseTo(-2, 3);
  });

  it('reads DJI gimbal angles and altitudes from XMP', () => {
    const m = readPhotoMeta(
      withExif({
        lat: 29.383333,
        lon: 47.98453,
        dji: {
          GpsLatitude: '+29.383333386',
          GpsLongitude: '+47.984530656',
          AbsoluteAltitude: '+106.699',
          RelativeAltitude: '+187.600',
          GimbalRollDegree: '+0.00',
          GimbalYawDegree: '+63.10',
          GimbalPitchDegree: '-45.40',
          FlightYawDegree: '+63.80',
        },
      }),
    );
    expect(m.dji).toEqual({
      lat: 29.383333386,
      lon: 47.984530656,
      absAlt: 106.699,
      relAlt: 187.6,
      gimbal: { yaw: 63.1, pitch: -45.4, roll: 0 },
      flightYaw: 63.8,
    });
  });

  it('takes the frame size from the JPEG when EXIF has none', () => {
    expect(readPhotoMeta(withExif({ width: 4000, height: 3000 }).slice())).toMatchObject({
      width: 4000,
      height: 3000,
    });
    const noExifSize = withExif({ make: 'X' });
    expect(readPhotoMeta(noExifSize)).toMatchObject({ width: 4000, height: 3000 });
  });

  it('rejects files that are not JPEG', () => {
    expect(() => readPhotoMeta(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(/JPEG/);
  });
});
