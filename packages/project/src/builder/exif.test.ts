import { fromWgs84 } from '@aio/geo';
import { describe, expect, it } from 'vitest';
import { orientationQuarters, readPhotoMeta } from './exif';
import { photoHeight, photoRef } from './photos';
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

  it('reads Orientation 6 as one clockwise quarter turn', () => {
    expect(readPhotoMeta(withExif({ orientation: 6 })).orientation).toBe(6);
    expect(orientationQuarters(6)).toBe(1);
    expect(orientationQuarters(3)).toBe(2);
    expect(orientationQuarters(8)).toBe(3);
    expect(orientationQuarters(2)).toBe(0);
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

describe('readPhotoMeta and GPano', () => {
  const gpanoSegment = (projection: string) => {
    const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" GPano:ProjectionType="${projection}"/></rdf:RDF></x:xmpmeta>`;
    const head = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0');
    const body = new TextEncoder().encode(xml);
    const payload = new Uint8Array(head.length + body.length);
    payload.set(head);
    payload.set(body, head.length);
    const seg = new Uint8Array(4 + payload.length);
    seg.set([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
    seg.set(payload, 4);
    return seg;
  };
  const jpegWith = (seg: Uint8Array) => {
    const base = withExif({ width: 1400, height: 700 });
    return new Uint8Array([...base.subarray(0, 2), ...seg, ...base.subarray(2)]);
  };

  it('reads an equirectangular projection', () => {
    expect(readPhotoMeta(jpegWith(gpanoSegment('equirectangular'))).gpano).toEqual({
      projection: 'equirectangular',
    });
  });

  it('leaves it out when the XMP has none', () => {
    expect(readPhotoMeta(withExif({ dji: { GimbalYawDegree: '10' } })).gpano).toBeUndefined();
  });
});

/** XT2-style raw parts: an Exif APP1 built by hand, so the GPS altitude type and bits are exact. */
interface RawExif {
  lat?: number;
  lon?: number;
  /** GPSAltitude as a raw rational: type 5 (unsigned) or 10 (signed). */
  alt?: { type: 5 | 10; num: number; den: number; ref?: number };
  /** An XMP packet placed inside the Exif payload, after the TIFF data. */
  xmpInExif?: string;
  /** A standalone XMP APP1 segment. */
  xmpSegment?: string;
}

const djiXmp = (fields: Record<string, string>): string =>
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ' +
  'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description ' +
  'xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/">' +
  Object.entries(fields)
    .map(([k, v]) => `<drone-dji:${k}>${v}</drone-dji:${k}>`)
    .join('') +
  '</rdf:Description></rdf:RDF></x:xmpmeta>';

interface GpsEntry {
  tag: number;
  type: number;
  count: number;
  data: number[];
}

const isRational = (type: number) => type === 5 || type === 10;

/** A header-only JPEG (SOI, Exif APP1, optional XMP APP1, SOF0, EOI) from {@link RawExif}. */
function rawExifJpeg(o: RawExif): Uint8Array {
  const enc = new TextEncoder();
  const dmsRational = (d: number): number[] => {
    const deg = Math.floor(d);
    const minF = (d - deg) * 60;
    const min = Math.floor(minF);
    const sec = Math.round((minF - min) * 60 * 1e6);
    return [deg, 1, min, 1, sec, 1e6];
  };
  const gps: GpsEntry[] = [];
  if (o.lat !== undefined) {
    gps.push({ tag: 1, type: 2, count: 2, data: [o.lat < 0 ? 0x53 : 0x4e] });
    gps.push({ tag: 2, type: 5, count: 3, data: dmsRational(Math.abs(o.lat)) });
  }
  if (o.lon !== undefined) {
    gps.push({ tag: 3, type: 2, count: 2, data: [o.lon < 0 ? 0x57 : 0x45] });
    gps.push({ tag: 4, type: 5, count: 3, data: dmsRational(Math.abs(o.lon)) });
  }
  if (o.alt) {
    gps.push({ tag: 5, type: 1, count: 1, data: [o.alt.ref ?? 0] });
    gps.push({ tag: 6, type: o.alt.type, count: 1, data: [o.alt.num, o.alt.den] });
  }
  // TIFF, little-endian: IFD0 at 8 with one entry (the GPS pointer), then the GPS IFD and its data.
  const ifd0At = 8;
  const gpsAt = ifd0At + 2 + 12 + 4;
  let dataAt = gpsAt + 2 + gps.length * 12 + 4;
  const extra = gps.reduce((n, e) => n + (isRational(e.type) ? e.data.length * 4 : 0), 0);
  const tiff = new Uint8Array(dataAt + extra);
  const v = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49]);
  v.setUint16(2, 42, true);
  v.setUint32(4, ifd0At, true);
  v.setUint16(ifd0At, 1, true);
  v.setUint16(ifd0At + 2, 0x8825, true);
  v.setUint16(ifd0At + 4, 4, true);
  v.setUint32(ifd0At + 6, 1, true);
  v.setUint32(ifd0At + 10, gpsAt, true);
  v.setUint16(gpsAt, gps.length, true);
  gps.forEach((g, i) => {
    const e = gpsAt + 2 + i * 12;
    v.setUint16(e, g.tag, true);
    v.setUint16(e + 2, g.type, true);
    v.setUint32(e + 4, g.count, true);
    if (isRational(g.type)) {
      v.setUint32(e + 8, dataAt, true);
      g.data.forEach((x, k) => {
        if (g.type === 10) v.setInt32(dataAt + k * 4, x, true);
        else v.setUint32(dataAt + k * 4, x >>> 0, true);
      });
      dataAt += g.data.length * 4;
    } else {
      g.data.forEach((x, k) => {
        v.setUint8(e + 8 + k, x);
      });
    }
  });
  const xmp = enc.encode(o.xmpInExif ?? '');
  const exif = new Uint8Array(6 + tiff.length + xmp.length);
  exif.set(enc.encode('Exif\0\0'));
  exif.set(tiff, 6);
  exif.set(xmp, 6 + tiff.length);
  const seg = (marker: number, payload: Uint8Array): number[] => [
    0xff,
    marker,
    (payload.length + 2) >> 8,
    (payload.length + 2) & 0xff,
    ...payload,
  ];
  // SOF0: 8 bits, 3000 x 4000, 3 components
  const sof = new Uint8Array([8, 0x0b, 0xb8, 0x0f, 0xa0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const parts = [0xff, 0xd8, ...seg(0xe1, exif)];
  if (o.xmpSegment)
    parts.push(...seg(0xe1, enc.encode(`http://ns.adobe.com/xap/1.0/\0${o.xmpSegment}`)));
  parts.push(...seg(0xc0, sof), 0xff, 0xd9);
  return new Uint8Array(parts);
}

describe('readPhotoMeta and XT2-style files', () => {
  const xt2 = djiXmp({
    AbsoluteAltitude: '-31.501320',
    RelativeAltitude: '+14.700000',
    GimbalYawDegree: '+63.10',
    GimbalPitchDegree: '-90.00',
    GimbalRollDegree: '+0.00',
  });

  it('reads a DJI XMP packet placed inside the Exif block', () => {
    const m = readPhotoMeta(rawExifJpeg({ lat: 29.38, lon: 47.98, xmpInExif: xt2 }));
    expect(m.dji).toEqual({
      absAlt: -31.50132,
      relAlt: 14.7,
      gimbal: { yaw: 63.1, pitch: -90, roll: 0 },
    });
    expect(m.width).toBe(4000);
  });

  it('lets a standalone XMP segment win over a packet inside Exif', () => {
    const m = readPhotoMeta(
      rawExifJpeg({
        xmpInExif: xt2,
        xmpSegment: djiXmp({ AbsoluteAltitude: '+100.0', RelativeAltitude: '+50.0' }),
      }),
    );
    expect(m.dji).toEqual({ absAlt: 100, relAlt: 50 });
  });

  it('reads a type-5 GPS altitude with the top bit set as signed and flags it', () => {
    const m = readPhotoMeta(
      rawExifJpeg({ lat: 29.38, lon: 47.98, alt: { type: 5, num: 0xffffee6a, den: 1000 } }),
    );
    expect(m.gps?.alt).toBeCloseTo(-4.502, 6);
    expect(m.gps?.altWrapped).toBe(true);
    expect(m.gps?.altDropped).toBeUndefined();
  });

  it('keeps a signed type-10 negative altitude with ref 0 as it is', () => {
    const m = readPhotoMeta(
      rawExifJpeg({ lat: 29.38, lon: 47.98, alt: { type: 10, num: -31501, den: 1000 } }),
    );
    expect(m.gps?.alt).toBeCloseTo(-31.501, 6);
    expect(m.gps?.altWrapped).toBeUndefined();
  });

  it('keeps an ordinary type-5 altitude unflagged', () => {
    const m = readPhotoMeta(
      rawExifJpeg({ lat: 29.38, lon: 47.98, alt: { type: 5, num: 28700, den: 1000 } }),
    );
    expect(m.gps?.alt).toBeCloseTo(28.7, 6);
    expect(m.gps?.altWrapped).toBeUndefined();
    expect(m.gps?.altDropped).toBeUndefined();
  });

  it('drops an altitude over 20 km as unreadable and keeps lat/lon', () => {
    const m = readPhotoMeta(
      rawExifJpeg({ lat: 29.38, lon: 47.98, alt: { type: 5, num: 25000000, den: 1000 } }),
    );
    expect(m.gps?.alt).toBeUndefined();
    expect(m.gps?.altDropped).toBe(true);
    expect(m.gps?.lat).toBeCloseTo(29.38, 6);
    expect(m.gps?.lon).toBeCloseTo(47.98, 6);
  });

  it('places the XT2 photo at take-off plus its relative altitude, with a view direction', () => {
    const m = readPhotoMeta(
      rawExifJpeg({
        lat: 29.38,
        lon: 47.98,
        alt: { type: 10, num: -31501, den: 1000 },
        xmpInExif: xt2,
      }),
    );
    const p = fromWgs84([47.98, 29.38, 0], 32639);
    const frame = {
      epsg: 32639,
      origin: [p[0], p[1], 10] as [number, number, number],
      utcOffsetMin: 180,
      heights: { prefer: 'relative' as const, absOffsetM: 0, takeoffH: 12 },
    };
    const h = photoHeight(m, frame);
    expect(h.source).toBe('relative');
    expect(h.h).toBeCloseTo(26.7, 6);
    const r = photoRef('x', 'x.jpg', m, frame);
    // take-off 12 + relative 14.7 - origin 10
    expect(r.pos?.[1]).toBeCloseTo(16.7, 6);
    expect(r.q).toBeDefined();
  });
});
