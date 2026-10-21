/**
 * Test helpers: synthetic DJI Zenmuse XT2 style JPEG heads (thermal and visual), built by hand so
 * the GPS altitude type and bits are exact and the DJI XMP packet can sit inside the Exif APP1 as
 * the XT2 writes it. Not used by the app; no real photo goes into them.
 */

export interface Xt2Exif {
  make?: string;
  /** "YYYY:MM:DD HH:MM:SS" */
  dateTimeOriginal?: string;
  lat?: number;
  lon?: number;
  /** GPSAltitude as a raw rational: type 5 (unsigned) or 10 (signed), with its ref byte. */
  alt?: { type: 5 | 10; num: number; den: number; ref?: number };
  /** An XMP packet placed inside the Exif payload, after the TIFF data (XT2 style). */
  xmpInExif?: string;
  /** A standalone XMP APP1 segment. */
  xmpSegment?: string;
  /** SOF0 size; default 4000 x 3000. */
  width?: number;
  height?: number;
}

/** A DJI XMP packet in element form (`<drone-dji:AbsoluteAltitude>-31.5</...>`), as the XT2 writes. */
export function djiXmpPacket(fields: Record<string, string>): string {
  return (
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ' +
    'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description ' +
    'xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/">' +
    Object.entries(fields)
      .map(([k, v]) => `<drone-dji:${k}>${v}</drone-dji:${k}>`)
      .join('') +
    '</rdf:Description></rdf:RDF></x:xmpmeta>'
  );
}

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** BYTE/ASCII: bytes; LONG: values; RATIONAL/SRATIONAL: numerator, denominator pairs. */
  data: number[];
}

const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8 };

const ascii = (s: string): number[] => [...new TextEncoder().encode(`${s}\0`)];

const dmsRational = (d: number): number[] => {
  const deg = Math.floor(d);
  const minF = (d - deg) * 60;
  const min = Math.floor(minF);
  const sec = Math.round((minF - min) * 60 * 1e6);
  return [deg, 1, min, 1, sec, 1e6];
};

/** A header-only JPEG (SOI, Exif APP1 with optional XMP inside, optional XMP APP1, SOF0, EOI). */
export function xt2Jpeg(o: Xt2Exif): Uint8Array {
  const ifd0: Entry[] = [];
  const exif: Entry[] = [];
  const gps: Entry[] = [];
  if (o.make) {
    const d = ascii(o.make);
    ifd0.push({ tag: 0x010f, type: 2, count: d.length, data: d });
  }
  if (o.dateTimeOriginal) {
    const d = ascii(o.dateTimeOriginal);
    exif.push({ tag: 0x9003, type: 2, count: d.length, data: d });
  }
  if (o.lat !== undefined) {
    gps.push({ tag: 1, type: 2, count: 2, data: [o.lat < 0 ? 0x53 : 0x4e, 0] });
    gps.push({ tag: 2, type: 5, count: 3, data: dmsRational(Math.abs(o.lat)) });
  }
  if (o.lon !== undefined) {
    gps.push({ tag: 3, type: 2, count: 2, data: [o.lon < 0 ? 0x57 : 0x45, 0] });
    gps.push({ tag: 4, type: 5, count: 3, data: dmsRational(Math.abs(o.lon)) });
  }
  if (o.alt) {
    gps.push({ tag: 5, type: 1, count: 1, data: [o.alt.ref ?? 0] });
    gps.push({ tag: 6, type: o.alt.type, count: 1, data: [o.alt.num, o.alt.den] });
  }
  const ifdSize = (n: number) => 2 + n * 12 + 4;
  const bytes = (e: Entry) => e.count * (SIZE[e.type] ?? 1);
  const extra = (list: Entry[]) =>
    list.reduce((n, e) => n + (bytes(e) > 4 ? bytes(e) + (bytes(e) % 2) : 0), 0);
  const n0 = ifd0.length + (exif.length ? 1 : 0) + (gps.length ? 1 : 0);
  const exifAt = 8 + ifdSize(n0) + extra(ifd0);
  const gpsAt = exifAt + (exif.length ? ifdSize(exif.length) + extra(exif) : 0);
  if (exif.length) ifd0.push({ tag: 0x8769, type: 4, count: 1, data: [exifAt] });
  if (gps.length) ifd0.push({ tag: 0x8825, type: 4, count: 1, data: [gpsAt] });
  const end = gpsAt + (gps.length ? ifdSize(gps.length) + extra(gps) : 0);
  const tiff = new Uint8Array(end);
  const v = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49]);
  v.setUint16(2, 42, true);
  v.setUint32(4, 8, true);
  const put = (e: Entry, at: number) => {
    e.data.forEach((x, k) => {
      if (e.type === 4) v.setUint32(at + k * 4, x >>> 0, true);
      else if (e.type === 3) v.setUint16(at + k * 2, x, true);
      else if (e.type === 10) v.setInt32(at + k * 4, x, true);
      else if (e.type === 5) v.setUint32(at + k * 4, x >>> 0, true);
      else v.setUint8(at + k, x);
    });
  };
  const write = (list: Entry[], at: number) => {
    list.sort((a, b) => a.tag - b.tag);
    v.setUint16(at, list.length, true);
    let dataAt = at + ifdSize(list.length);
    list.forEach((e, i) => {
      const p = at + 2 + i * 12;
      v.setUint16(p, e.tag, true);
      v.setUint16(p + 2, e.type, true);
      v.setUint32(p + 4, e.count, true);
      if (bytes(e) <= 4) put(e, p + 8);
      else {
        v.setUint32(p + 8, dataAt, true);
        put(e, dataAt);
        dataAt += bytes(e) + (bytes(e) % 2);
      }
    });
  };
  write(ifd0, 8);
  if (exif.length) write(exif, exifAt);
  if (gps.length) write(gps, gpsAt);
  const enc = new TextEncoder();
  const xmp = enc.encode(o.xmpInExif ?? '');
  const app1 = new Uint8Array(6 + tiff.length + xmp.length);
  app1.set(enc.encode('Exif\0\0'));
  app1.set(tiff, 6);
  app1.set(xmp, 6 + tiff.length);
  const seg = (marker: number, payload: Uint8Array): number[] => [
    0xff,
    marker,
    (payload.length + 2) >> 8,
    (payload.length + 2) & 0xff,
    ...payload,
  ];
  const w = o.width ?? 4000;
  const h = o.height ?? 3000;
  const sof = new Uint8Array([8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const parts = [0xff, 0xd8, ...seg(0xe1, app1)];
  if (o.xmpSegment)
    parts.push(...seg(0xe1, enc.encode(`http://ns.adobe.com/xap/1.0/\0${o.xmpSegment}`)));
  parts.push(...seg(0xc0, sof), 0xff, 0xd9);
  return new Uint8Array(parts);
}

/**
 * An XT2 visual photo as DJI writes it: Make `DJI`, signed GPSAltitude (type 10), and the DJI XMP
 * (absolute and relative altitude, gimbal angles) inside the Exif block.
 */
export function xt2Visual(o: {
  dateTimeOriginal: string;
  lat: number;
  lon: number;
  /** GPSAltitude and AbsoluteAltitude, metres (may be negative). */
  absAlt: number;
  relAlt: number;
  gimbal?: { yaw: number; pitch: number; roll: number };
}): Uint8Array {
  const g = o.gimbal ?? { yaw: 63.1, pitch: -90, roll: 0 };
  const sign = (x: number, d: number) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;
  return xt2Jpeg({
    make: 'DJI',
    dateTimeOriginal: o.dateTimeOriginal,
    lat: o.lat,
    lon: o.lon,
    alt: { type: 10, num: Math.round(o.absAlt * 1000), den: 1000 },
    xmpInExif: djiXmpPacket({
      AbsoluteAltitude: sign(o.absAlt, 6),
      RelativeAltitude: sign(o.relAlt, 6),
      GimbalYawDegree: sign(g.yaw, 2),
      GimbalPitchDegree: sign(g.pitch, 2),
      GimbalRollDegree: sign(g.roll, 2),
    }),
  });
}

/**
 * An XT2 thermal photo written by the FLIR core: no DJI XMP and an unsigned GPSAltitude (type 5);
 * a negative altitude is written as unsigned (top bit set), the "wrapped" case.
 */
export function xt2Thermal(o: {
  dateTimeOriginal?: string;
  lat?: number;
  lon?: number;
  /** Metres; negative values are written as unsigned 32-bit (wrapped). Absent: no altitude. */
  alt?: number;
}): Uint8Array {
  return xt2Jpeg({
    make: 'FLIR Systems',
    ...(o.dateTimeOriginal ? { dateTimeOriginal: o.dateTimeOriginal } : {}),
    ...(o.lat !== undefined ? { lat: o.lat } : {}),
    ...(o.lon !== undefined ? { lon: o.lon } : {}),
    ...(o.alt !== undefined
      ? { alt: { type: 5 as const, num: Math.round(o.alt * 1000) >>> 0, den: 1000 } }
      : {}),
    width: 640,
    height: 512,
  });
}
