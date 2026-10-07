// What the client-data check (check-no-client-data.mjs) reads from M10 files: camera metadata in
// synthetic photos (EXIF and XMP: no serial, no personal name, GPS only at a fictional site),
// GeoTIFF tags and placement, OPF geolocations, 3D Tiles placement, raster pack metadata and
// PMTiles headers, and lat/lon columns of position files (PPK CSV, ODM gcp_list.txt).
//
// A demo photo may carry EXIF and XMP only when it names the synthetic camera (Make "Stratlas
// Synthetic", tools/demo and python/tests/photo_synth.py); any other camera metadata stays a
// finding, as before M10.
import { gunzipSync } from 'node:zlib';

/** The synthetic camera of the photogrammetry set (python/tests/photo_synth.py). */
export const SYNTHETIC_MAKE = 'Stratlas Synthetic';

/**
 * Fictional sites of the demos and fixtures: [lon, lat] and a radius in km. Camera positions,
 * control points, tiles and GeoTIFFs must fall inside one of them.
 */
export const FICTIONAL_SITES = [
  // tools/demo/build-demo.mjs (Tanezrouft, open desert): the tank farm and the access road
  { name: 'demo desert site (Tanezrouft)', ll: [1.2047, 23.4012], km: 30 },
  // python/tests/photo_synth.py SITE: UTM 39N 550000 E 2330000 N (Rub' al Khali)
  { name: 'photo demo site (Rub al Khali)', ll: [51.48132, 21.07027], km: 15 },
];

/** Great-circle distance in km. */
function km([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The fictional site a [lon, lat] lies in, or null. */
export function fictionalSite(ll) {
  return FICTIONAL_SITES.find((s) => km(ll, s.ll) <= s.km) ?? null;
}

// ------------------------------------------------------------------ TIFF (EXIF payloads, GeoTIFF)

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/**
 * The tags of a classic TIFF structure (II or MM) at `base`: Map tag -> number[] or string, and
 * the EXIF (0x8769) and GPS (0x8825) sub-IFDs as `exif` and `gps`. Unknown or broken parts are
 * skipped; never throws.
 */
export function tiffTags(buf, base = 0) {
  const out = { ifd0: new Map(), exif: new Map(), gps: new Map() };
  if (buf.length < base + 8) return out;
  const order = buf.toString('latin1', base, base + 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return out;
  const u16 = (p) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
  const u32 = (p) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
  const i32 = (p) => (le ? buf.readInt32LE(p) : buf.readInt32BE(p));
  const f64 = (p) => (le ? buf.readDoubleLE(p) : buf.readDoubleBE(p));
  if (u16(base + 2) !== 42) return out;
  const readIfd = (off, into) => {
    const p0 = base + off;
    if (off === 0 || p0 + 2 > buf.length) return;
    const n = u16(p0);
    for (let i = 0; i < n; i++) {
      const e = p0 + 2 + i * 12;
      if (e + 12 > buf.length) return;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 1) * count;
      if (size > 16 * 1024 * 1024) continue;
      const at = size <= 4 ? e + 8 : base + u32(e + 8);
      if (at + size > buf.length) continue;
      let v;
      if (type === 2) v = buf.toString('latin1', at, at + count).replace(/\0+$/, '');
      else if (type === 1 || type === 7 || type === 6) v = [...buf.subarray(at, at + count)];
      else {
        v = [];
        for (let k = 0; k < Math.min(count, 100000); k++) {
          if (type === 3 || type === 8) v.push(u16(at + 2 * k));
          else if (type === 4) v.push(u32(at + 4 * k));
          else if (type === 9) v.push(i32(at + 4 * k));
          else if (type === 5) v.push(u32(at + 8 * k) / (u32(at + 8 * k + 4) || 1));
          else if (type === 10) v.push(i32(at + 8 * k) / (i32(at + 8 * k + 4) || 1));
          else if (type === 12) v.push(f64(at + 8 * k));
        }
      }
      into.set(tag, v);
    }
  };
  try {
    readIfd(u32(base + 4), out.ifd0);
    const exif = out.ifd0.get(0x8769);
    if (Array.isArray(exif)) readIfd(exif[0], out.exif);
    const gps = out.ifd0.get(0x8825);
    if (Array.isArray(gps)) readIfd(gps[0], out.gps);
  } catch {
    // a broken IFD: what was read stays
  }
  return out;
}

const text = (v) =>
  typeof v === 'string'
    ? v.trim()
    : Array.isArray(v)
      ? Buffer.from(v).toString('latin1').replace(/\0+$/, '').trim()
      : '';

/** XPAuthor and friends are UCS-2 byte arrays. */
const ucs2 = (v) =>
  Array.isArray(v) ? Buffer.from(v).toString('utf16le').replace(/\0+$/, '').trim() : '';

const SERIAL_TAGS = [
  [0xa431, 'exif', 'BodySerialNumber'],
  [0xa435, 'exif', 'LensSerialNumber'],
  [0xc62f, 'ifd0', 'CameraSerialNumber'],
];
const NAME_TAGS = [
  [0x013b, 'ifd0', 'Artist', text],
  [0x8298, 'ifd0', 'Copyright', text],
  [0x9c9d, 'ifd0', 'XPAuthor', ucs2],
  [0xa430, 'exif', 'CameraOwnerName', text],
];

/** [lon, lat] of an EXIF GPS IFD, or null. */
function gpsLonLat(gps) {
  const lat = gps.get(2);
  const lon = gps.get(4);
  if (!Array.isArray(lat) || !Array.isArray(lon) || lat.length < 3 || lon.length < 3) return null;
  const dms = (v) => v[0] + v[1] / 60 + v[2] / 3600;
  const la = dms(lat) * (text(gps.get(1)) === 'S' ? -1 : 1);
  const lo = dms(lon) * (text(gps.get(3)) === 'W' ? -1 : 1);
  return Number.isFinite(la) && Number.isFinite(lo) ? [lo, la] : null;
}

/**
 * What the EXIF payload of a JPEG APP1 segment (starting with "Exif\0\0") says: the camera make,
 * whether it is the synthetic camera, serial numbers, personal names and the GPS position.
 */
export function exifInfo(payload) {
  const t = tiffTags(payload, 6);
  const make = text(t.ifd0.get(0x010f));
  const serials = [];
  for (const [tag, ifd, label] of SERIAL_TAGS) {
    const v = text(t[ifd].get(tag));
    if (v) serials.push(`${label} "${v}"`);
  }
  const names = [];
  for (const [tag, ifd, label, read] of NAME_TAGS) {
    const v = read(t[ifd].get(tag));
    if (v) names.push(`${label} "${v}"`);
  }
  return {
    make,
    synthetic: make === SYNTHETIC_MAKE,
    serials,
    names,
    lonLat: gpsLonLat(t.gps),
  };
}

const XMP_NAME_KEYS = [
  'dc:creator',
  'dc:rights',
  'xmp:Author',
  'tiff:Artist',
  'exif:Artist',
  'photoshop:Author',
  'photoshop:AuthorsPosition',
  'photoshop:Credit',
  'xmpRights:Owner',
  'aux:OwnerName',
  'Iptc4xmpCore:CreatorContactInfo',
];

/** What an XMP packet says: synthetic camera, serial numbers, personal names, GPS position. */
export function xmpInfo(xmp) {
  const attr = (k) => {
    const m =
      new RegExp(`${k}\\s*=\\s*"([^"]*)"`).exec(xmp) ??
      new RegExp(`<${k}>\\s*([^<]*?)\\s*</${k}>`).exec(xmp);
    return m ? m[1].trim() : null;
  };
  const serials = [];
  for (const m of xmp.matchAll(/([A-Za-z-]+:[A-Za-z]*Serial[A-Za-z]*)\s*=\s*"([^"]+)"/g))
    serials.push(`${m[1]} "${m[2]}"`);
  for (const m of xmp.matchAll(/<([A-Za-z-]+:[A-Za-z]*Serial[A-Za-z]*)>\s*([^<\s][^<]*)</g))
    serials.push(`${m[1]} "${m[2].trim()}"`);
  const names = [];
  for (const k of XMP_NAME_KEYS) {
    const a = attr(k);
    if (a) names.push(`${k} "${a}"`);
    else {
      // dc:creator and friends are usually an rdf:Seq or rdf:Alt of rdf:li
      const block = new RegExp(`<${k}>([\\s\\S]*?)</${k}>`).exec(xmp);
      const li = block ? /<rdf:li[^>]*>\s*([^<]+?)\s*<\/rdf:li>/.exec(block[1]) : null;
      if (li) names.push(`${k} "${li[1]}"`);
    }
  }
  const lat = Number(attr('drone-dji:GpsLatitude') ?? NaN);
  const lon = Number(attr('drone-dji:GpsLongitude') ?? attr('drone-dji:GpsLongtitude') ?? NaN);
  return {
    synthetic: new RegExp(`tiff:Make\\s*=\\s*"${SYNTHETIC_MAKE}"`).test(xmp),
    serials,
    names,
    lonLat:
      Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0) ? [lon, lat] : null,
  };
}

// ------------------------------------------------------------------ GeoTIFF

/**
 * Text tags and the placement of a GeoTIFF: `{ texts, epsg, xy }` where `xy` is the model
 * coordinate of the raster's first tie point (or the transformation's origin).
 */
export function geotiffInfo(buf) {
  const t = tiffTags(buf, 0).ifd0;
  const texts = [270, 305, 315, 33432, 42112, 42113]
    .map((k) => text(t.get(k)))
    .filter((s) => s.length > 0);
  let epsg = null;
  const keys = t.get(34735);
  if (Array.isArray(keys) && keys.length >= 4) {
    for (let i = 4; i + 3 < keys.length; i += 4) {
      const [id, loc, , value] = keys.slice(i, i + 4);
      if ((id === 3072 || id === 2048) && loc === 0 && value !== 32767) epsg = value;
    }
  }
  let xy = null;
  const tie = t.get(33922);
  const mt = t.get(34264);
  if (Array.isArray(tie) && tie.length >= 6) xy = [tie[3], tie[4]];
  else if (Array.isArray(mt) && mt.length >= 16) xy = [mt[3], mt[7]];
  return { texts, epsg, xy };
}

// ------------------------------------------------------------------ OPF, 3D Tiles, packs

/** EPSG code of an OPF CRS definition ("EPSG:4326+5773", "EPSG:32639"), or null. */
function opfEpsg(def) {
  const m = /EPSG:(\d+)/i.exec(String(def ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * Every geolocation of an OPF file (`{ crs: { definition }, coordinates: [...] }` anywhere in it,
 * as input cameras and control points carry them): `{ epsg, coords }`.
 */
export function opfGeolocations(j) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (!v || typeof v !== 'object') return;
    if (v.crs && typeof v.crs === 'object' && Array.isArray(v.coordinates)) {
      const epsg = opfEpsg(v.crs.definition);
      if (epsg && v.coordinates.length >= 2) out.push({ epsg, coords: v.coordinates });
    }
    for (const x of Object.values(v)) walk(x);
  };
  walk(j);
  return out;
}

/**
 * [lon, lat] of an OPF geolocation in a geographic CRS (EPSG 4000 to 4999: WGS 84, ETRS89, Monte
 * Mario, CH1903+ and the like; OPF lists latitude first), or null for any other CRS. Datum shifts
 * between geographic CRSs are a few hundred metres at most, far inside the check's radius.
 */
export function opfGeographicLonLat({ epsg, coords }) {
  if (!(epsg >= 4000 && epsg < 5000)) return null;
  const [lat, lon] = coords;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : null;
}

export const isOpf = (j) =>
  j &&
  typeof j === 'object' &&
  typeof j.format === 'string' &&
  j.format.startsWith('application/opf');

/** ECEF metres to [lon, lat] degrees (WGS 84). */
export function ecefToLonLat([x, y, z]) {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 6; i++) {
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    lat = Math.atan2(z + e2 * n * Math.sin(lat), p);
  }
  return [(Math.atan2(y, x) * 180) / Math.PI, (lat * 180) / Math.PI];
}

/** Where a 3D Tiles `tileset.json` sits: its root transform's origin or region centre. */
export function tilesetLonLat(j) {
  const root = j?.root;
  if (!root || typeof root !== 'object') return null;
  const m = root.transform;
  if (Array.isArray(m) && m.length === 16) {
    const o = [m[12], m[13], m[14]];
    if (Math.hypot(...o) > 6e6) return ecefToLonLat(o);
  }
  const r = root.boundingVolume?.region;
  if (Array.isArray(r) && r.length >= 4)
    return [(((r[0] + r[2]) / 2) * 180) / Math.PI, (((r[1] + r[3]) / 2) * 180) / Math.PI];
  const b = root.boundingVolume?.box;
  if (Array.isArray(b) && b.length >= 3 && Math.hypot(b[0], b[1], b[2]) > 6e6)
    return ecefToLonLat([b[0], b[1], b[2]]);
  return null;
}

export const isTileset = (j) => j && typeof j === 'object' && j.asset && j.root;

/** The feature table JSON of a legacy 3D Tiles binary (b3dm, i3dm, pnts), or null. */
export function tileFeatureTable(buf) {
  const magic = buf.toString('latin1', 0, 4);
  const header = { b3dm: 28, pnts: 28, i3dm: 32 }[magic];
  if (!header || buf.length < header) return null;
  const len = buf.readUInt32LE(12);
  try {
    return JSON.parse(buf.toString('utf8', header, header + len).trim() || '{}');
  } catch {
    return null;
  }
}

/** Findings of an `aio.raster-pack/1` metadata file (besides the word and place checks). */
export function rasterPackFindings(j, where) {
  const out = [];
  if (j.customerLicence === true)
    out.push(`${where}: customer imagery (customerLicence) in the demo or fixtures`);
  if (typeof j.licence !== 'string' || !j.licence.trim())
    out.push(`${where}: a raster pack without a licence`);
  if (typeof j.attribution !== 'string' || !j.attribution.trim())
    out.push(`${where}: a raster pack without an attribution`);
  return out;
}

/** Centre of a small bbox [w, s, e, n] (under 2 degrees each way), or null for a large one. */
export function smallBboxCentre(b) {
  if (!Array.isArray(b) || b.length < 4 || !b.every((v) => typeof v === 'number')) return null;
  if (b[2] - b[0] > 2 || b[3] - b[1] > 2) return null;
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

/** Header bounds and metadata text of a PMTiles v3 archive, or null. */
export function pmtilesInfo(buf) {
  if (buf.length < 127 || buf.toString('latin1', 0, 7) !== 'PMTiles') return null;
  const e7 = (p) => buf.readInt32LE(p) / 1e7;
  const bbox = [e7(102), e7(106), e7(110), e7(114)];
  let meta = '';
  try {
    const off = Number(buf.readBigUInt64LE(24));
    const len = Number(buf.readBigUInt64LE(32));
    if (len > 0 && len < 16 * 1024 * 1024 && off + len <= buf.length) {
      const raw = buf.subarray(off, off + len);
      meta = (buf[97] === 2 ? gunzipSync(raw) : raw).toString('utf8');
    }
  } catch {
    meta = '';
  }
  return { bbox, meta };
}

// ------------------------------------------------------------------ position files

/** [lon, lat] rows of a CSV with lat and lon columns (a PPK file), else []. */
export function csvLonLats(textContent) {
  const lines = textContent.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0].split(/[,;\t]/).map((h) => h.trim().toLowerCase());
  const la = head.findIndex((h) => h === 'lat' || h === 'latitude');
  const lo = head.findIndex((h) => h === 'lon' || h === 'lng' || h === 'longitude');
  if (la < 0 || lo < 0) return [];
  const out = [];
  for (const l of lines.slice(1)) {
    const c = l.split(/[,;\t]/);
    const p = [Number(c[lo]), Number(c[la])];
    if (
      Number.isFinite(p[0]) &&
      Number.isFinite(p[1]) &&
      Math.abs(p[0]) <= 180 &&
      Math.abs(p[1]) <= 90
    )
      out.push(p);
  }
  return out;
}

/** The EPSG and x, y of an ODM `gcp_list.txt` (first line the CRS), else null. */
export function gcpListPoints(textContent) {
  const lines = textContent.split(/\r?\n/).filter((l) => l.trim());
  const m = /^EPSG:(\d+)$/i.exec(lines[0]?.trim() ?? '');
  if (!m) return null;
  const pts = [];
  for (const l of lines.slice(1)) {
    const c = l.trim().split(/\s+/);
    const p = [Number(c[0]), Number(c[1])];
    if (Number.isFinite(p[0]) && Number.isFinite(p[1])) pts.push(p);
  }
  return { epsg: Number(m[1]), pts };
}
