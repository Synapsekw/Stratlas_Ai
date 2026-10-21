/**
 * Photo metadata from the head of a JPEG: EXIF (camera, time, focal length, GPS) and DJI XMP
 * (gimbal angles, altitudes). Reads only the first segments, so callers can pass the first
 * few hundred kilobytes of a large file.
 */
export interface PhotoMeta {
  width?: number;
  height?: number;
  make?: string;
  model?: string;
  /** Local capture time `YYYY-MM-DDTHH:mm:ss` (no zone). */
  takenAt?: string;
  /** EXIF OffsetTimeOriginal, e.g. "+03:00". */
  utcOffset?: string;
  focalMm?: number;
  focal35?: number;
  gps?: {
    lat: number;
    lon: number;
    alt?: number;
    /**
     * The altitude was an unsigned RATIONAL (type 5) with the top bit set, a negative value
     * written as unsigned (FLIR-written thermals), and was read back as signed.
     */
    altWrapped?: true;
    /** The altitude was over {@link MAX_GPS_ALT_M} in magnitude and was left out as unreadable. */
    altDropped?: true;
  };
  dji?: {
    lat?: number;
    lon?: number;
    absAlt?: number;
    relAlt?: number;
    gimbal?: { yaw: number; pitch: number; roll: number };
    flightYaw?: number;
  };
  /** XMP `GPano` (a ready-made panorama): its projection, e.g. `equirectangular`. */
  gpano?: { projection: string };
  /**
   * EXIF Orientation (1 to 8). 1 is upright. 3, 6 and 8 are turns with no mirror;
   * {@link orientationQuarters} is how many clockwise quarter turns make the pixels upright.
   */
  orientation?: number;
}

/**
 * Clockwise quarter turns that make stored pixels match EXIF Orientation.
 * 6 is 90 clockwise, 3 is 180, 8 is 90 counter-clockwise. Mirrors (2, 4, 5, 7) and an
 * unknown tag stay 0: a turn alone would not match them.
 */
export function orientationQuarters(orientation: number | undefined): 0 | 1 | 2 | 3 {
  if (orientation === 6) return 1;
  if (orientation === 3) return 2;
  if (orientation === 8) return 3;
  return 0;
}

/** A GPS altitude beyond this magnitude (metres) is not a real one. */
export const MAX_GPS_ALT_M = 20_000;

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

interface Tiff {
  v: DataView;
  le: boolean;
  base: number;
}

type Value = number[] | string;

function readIfd(t: Tiff, at: number): Map<number, Value> {
  const out = new Map<number, Value>();
  const { v, le, base } = t;
  if (base + at + 2 > v.byteLength) return out;
  const n = v.getUint16(base + at, le);
  for (let i = 0; i < n; i++) {
    const e = base + at + 2 + i * 12;
    if (e + 12 > v.byteLength) break;
    const tag = v.getUint16(e, le);
    const type = v.getUint16(e + 2, le);
    const count = v.getUint32(e + 4, le);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    const dataAt = size <= 4 ? e + 8 : base + v.getUint32(e + 8, le);
    if (dataAt + size > v.byteLength) continue;
    if (type === 2) {
      let s = '';
      for (let k = 0; k < count; k++) {
        const c = v.getUint8(dataAt + k);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      out.set(tag, s.trim());
      continue;
    }
    const vals: number[] = [];
    for (let k = 0; k < count && k < 64; k++) {
      const p = dataAt + k * (TYPE_SIZE[type] ?? 1);
      if (type === 1 || type === 7) vals.push(v.getUint8(p));
      else if (type === 3) vals.push(v.getUint16(p, le));
      else if (type === 4) vals.push(v.getUint32(p, le));
      else if (type === 9) vals.push(v.getInt32(p, le));
      else if (type === 5) {
        const d = v.getUint32(p + 4, le);
        vals.push(d ? v.getUint32(p, le) / d : 0);
      } else if (type === 10) {
        const d = v.getInt32(p + 4, le);
        vals.push(d ? v.getInt32(p, le) / d : 0);
      }
    }
    out.set(tag, vals);
  }
  return out;
}

/**
 * GPSAltitude (tag 6) of the GPS IFD at `at` read as signed, when it is stored as an unsigned
 * RATIONAL (type 5) whose numerator has the top bit set: a negative altitude written as unsigned.
 * Undefined for every other case, which {@link readIfd} reads as it is.
 */
function wrappedGpsAlt(t: Tiff, at: number): number | undefined {
  const { v, le, base } = t;
  if (base + at + 2 > v.byteLength) return undefined;
  const n = v.getUint16(base + at, le);
  for (let i = 0; i < n; i++) {
    const e = base + at + 2 + i * 12;
    if (e + 12 > v.byteLength) return undefined;
    if (v.getUint16(e, le) !== 6) continue;
    if (v.getUint16(e + 2, le) !== 5 || v.getUint32(e + 4, le) < 1) return undefined;
    const p = base + v.getUint32(e + 8, le);
    if (p + 8 > v.byteLength) return undefined;
    const numerator = v.getUint32(p, le);
    const d = v.getUint32(p + 4, le);
    if (numerator < 0x80000000 || !d) return undefined;
    return v.getInt32(p, le) / d;
  }
  return undefined;
}

const num = (v: Value | undefined): number | undefined =>
  Array.isArray(v) && v.length > 0 ? v[0] : undefined;
const str = (v: Value | undefined): string | undefined =>
  typeof v === 'string' && v ? v : undefined;
const dms = (v: Value | undefined): number | undefined =>
  Array.isArray(v) && v.length >= 3
    ? (v[0] ?? 0) + (v[1] ?? 0) / 60 + (v[2] ?? 0) / 3600
    : undefined;

function parseExif(payload: Uint8Array, meta: PhotoMeta): void {
  const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const base = 6; // "Exif\0\0"
  const order = v.getUint16(base);
  if (order !== 0x4949 && order !== 0x4d4d) return;
  const t: Tiff = { v, le: order === 0x4949, base };
  const ifd0 = readIfd(t, v.getUint32(base + 4, t.le));
  const make = str(ifd0.get(0x010f));
  if (make) meta.make = make;
  const model = str(ifd0.get(0x0110));
  if (model) meta.model = model;
  const orientation = num(ifd0.get(0x0112));
  if (orientation !== undefined && orientation >= 1 && orientation <= 8)
    meta.orientation = orientation;
  const exifAt = num(ifd0.get(0x8769));
  if (exifAt !== undefined) {
    const exif = readIfd(t, exifAt);
    const dt = str(exif.get(0x9003)) ?? str(ifd0.get(0x0132));
    const m = dt ? /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(dt) : null;
    if (m)
      meta.takenAt = `${m[1] ?? ''}-${m[2] ?? ''}-${m[3] ?? ''}T${m[4] ?? ''}:${m[5] ?? ''}:${m[6] ?? ''}`;
    const off = str(exif.get(0x9011));
    if (off) meta.utcOffset = off;
    const f = num(exif.get(0x920a));
    if (f) meta.focalMm = f;
    const f35 = num(exif.get(0xa405));
    if (f35) meta.focal35 = f35;
    const w = num(exif.get(0xa002));
    const h = num(exif.get(0xa003));
    if (w && h) {
      meta.width = w;
      meta.height = h;
    }
  }
  const gpsAt = num(ifd0.get(0x8825));
  if (gpsAt !== undefined) {
    const g = readIfd(t, gpsAt);
    const lat = dms(g.get(2));
    const lon = dms(g.get(4));
    if (lat !== undefined && lon !== undefined && !(lat === 0 && lon === 0)) {
      const gps: NonNullable<PhotoMeta['gps']> = {
        lat: str(g.get(1)) === 'S' ? -lat : lat,
        lon: str(g.get(3)) === 'W' ? -lon : lon,
      };
      let alt = num(g.get(6));
      const wrapped = wrappedGpsAlt(t, gpsAt);
      if (wrapped !== undefined) {
        alt = wrapped;
        gps.altWrapped = true;
      }
      if (alt !== undefined) {
        const a = num(g.get(5)) === 1 ? -alt : alt;
        if (Math.abs(a) > MAX_GPS_ALT_M) gps.altDropped = true;
        else gps.alt = a;
      }
      meta.gps = gps;
    }
  }
}

function parseXmp(xml: string, meta: PhotoMeta): void {
  const get = (name: string): number | undefined => {
    const re = new RegExp(
      `drone-dji:${name}\\s*=\\s*"([^"]*)"|<drone-dji:${name}>([^<]*)</drone-dji:${name}>`,
    );
    const m = re.exec(xml);
    const raw = m?.[1] ?? m?.[2];
    if (raw === undefined) return undefined;
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : undefined;
  };
  const dji: NonNullable<PhotoMeta['dji']> = {};
  const lat = get('GpsLatitude') ?? get('Latitude');
  const lon = get('GpsLongitude') ?? get('GpsLongtitude') ?? get('Longitude');
  if (lat !== undefined) dji.lat = lat;
  if (lon !== undefined) dji.lon = lon;
  const abs = get('AbsoluteAltitude');
  if (abs !== undefined) dji.absAlt = abs;
  const rel = get('RelativeAltitude');
  if (rel !== undefined) dji.relAlt = rel;
  const yaw = get('GimbalYawDegree');
  const pitch = get('GimbalPitchDegree');
  if (yaw !== undefined && pitch !== undefined)
    dji.gimbal = { yaw, pitch, roll: get('GimbalRollDegree') ?? 0 };
  const fy = get('FlightYawDegree');
  if (fy !== undefined) dji.flightYaw = fy;
  if (Object.keys(dji).length) meta.dji = dji;
  const proj =
    /GPano:ProjectionType\s*=\s*"([^"]*)"|<GPano:ProjectionType>([^<]*)<\/GPano:ProjectionType>/.exec(
      xml,
    );
  const projection = (proj?.[1] ?? proj?.[2])?.trim();
  if (projection) meta.gpano = { projection };
}

const XMP_OPEN = new TextEncoder().encode('<x:xmpmeta');
const XMP_CLOSE = new TextEncoder().encode('</x:xmpmeta>');

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const last = hay.length - needle.length;
  for (let i = from; i <= last; i++) {
    let k = 0;
    while (k < needle.length && hay[i + k] === needle[k]) k++;
    if (k === needle.length) return i;
  }
  return -1;
}

/** The `<x:xmpmeta ... </x:xmpmeta>` packet inside `bytes`, decoded; undefined when there is none. */
function xmpPacketIn(bytes: Uint8Array): string | undefined {
  const dec = new TextDecoder('utf-8', { fatal: false });
  const start = indexOfBytes(bytes, XMP_OPEN, 0);
  if (start < 0) return undefined;
  const end = indexOfBytes(bytes, XMP_CLOSE, start + XMP_OPEN.length);
  if (end < 0) return undefined;
  return dec.decode(bytes.subarray(start, end + XMP_CLOSE.length));
}

/** Read EXIF, DJI XMP and the frame size from the start of a JPEG file. */
export function readPhotoMeta(bytes: Uint8Array): PhotoMeta {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not a JPEG file.');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const meta: PhotoMeta = {};
  let sof: { width: number; height: number } | null = null;
  let i = 2;
  const dec = new TextDecoder('utf-8', { fatal: false });
  let exifPayload: Uint8Array | undefined;
  let xmpSeen = false;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1] ?? 0;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    const len = v.getUint16(i + 2);
    const payload = bytes.subarray(i + 4, Math.min(bytes.length, i + 2 + len));
    if (marker === 0xe1) {
      const head = dec.decode(payload.subarray(0, 30));
      if (head.startsWith('Exif')) {
        parseExif(payload, meta);
        exifPayload ??= payload;
      } else if (head.startsWith('http://ns.adobe.com/xap/1.0/')) {
        parseXmp(dec.decode(payload), meta);
        xmpSeen = true;
      }
    } else if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc &&
      payload.length >= 5
    ) {
      sof = { height: v.getUint16(i + 5), width: v.getUint16(i + 7) };
    }
    i += 2 + len;
  }
  // Some cameras (DJI Zenmuse XT2) write the XMP packet inside the Exif APP1, after the TIFF
  // data, with no standalone XMP segment. A standalone segment wins when there is one.
  if (!xmpSeen && exifPayload) {
    const xml = xmpPacketIn(exifPayload);
    if (xml) parseXmp(xml, meta);
  }
  if (meta.width === undefined && sof) {
    meta.width = sof.width;
    meta.height = sof.height;
  }
  return meta;
}
