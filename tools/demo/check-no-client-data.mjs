#!/usr/bin/env node
/* eslint-disable no-console -- check script output */
// Fail when the demo (or any folder) carries client data. Run before every Store or release build
// (tools/release/dist.mjs, CI) and by tools/demo/build-demo.mjs.
//
//   node tools/demo/check-no-client-data.mjs [folder] [--projects <dir>] [--radius-km 100]
//                                            [--max-mb 150] [--fixtures]
//
// Checks, file by file:
//   - names: client, site and asset names (a built-in list plus the name, customer, site and
//     brand of every project manifest under --projects, by default <QUADRION_DATA or
//     E:\Stratlas Data>\projects, read only), real camera file names (DJI_0123), the NAS;
//   - places: manifest origins and GeoJSON coordinates within --radius-km of a real project
//     origin (the built-in list plus the manifests found);
//   - camera metadata: EXIF, GPS or XMP in JPEG, PNG and WebP, location atoms in MP4; a JPEG of
//     the synthetic camera (M10, python/tests/photo_synth.py) may carry EXIF and XMP, but no
//     serial number, no personal name and GPS only at a fictional site (check-m10.mjs);
//   - M11 survey files (check-m11.mjs): LandXML, DXF and CSV under survey/, 12da, Trimble JobXML
//     and .dc, aio.tin/1 surfaces: every coordinate, placed in the file's CRS (else the
//     project's), inside a fictional site, and job and project names marked synthetic (no real
//     job numbers);
//   - M10 placement: OPF geolocations, 3D Tiles transforms, raster pack metadata and PMTiles
//     bounds, PPK and gcp_list positions, and (with --fixtures, for test fixture folders)
//     GeoTIFF tags and tie points: near no real site, and camera, control and tile positions
//     inside a fictional site;
//   - paths of the build machine (C:\Users\..., /home/...) in text files;
//   - total size (--max-mb).
// Third-party fixtures with example values that look like client data (the OPF specification
// examples) are let through file by file, pinned by path and content hash (ALLOWED_FIXTURES);
// their findings are printed as allowed. The repository's test fixtures are checked by
// check-no-client-data.test.mjs (python/tests/fixtures, --fixtures mode).
// Binary payloads (compressed pixels, GLB buffers, kit grids in base64) are not scanned for words:
// only their metadata, JSON chunks and text.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  csvLonLats,
  ecefToLonLat,
  exifInfo,
  fictionalSite,
  gcpListPoints,
  geotiffInfo,
  isOpf,
  isTileset,
  opfGeographicLonLat,
  opfGeolocations,
  pmtilesInfo,
  rasterPackFindings,
  smallBboxCentre,
  tileFeatureTable,
  tilesetLonLat,
  xmpInfo,
} from './check-m10.mjs';
import { surveyContent, surveyFindings } from './check-m11.mjs';
import { m8Text, truthCoords } from './check-m8.mjs';
import { envVar } from '../../packages/brand/src/env.ts';

/** Words that must never appear (client names, assets, places of real projects). */
export const FORBIDDEN = [
  [/\bHCl\b/, 'HCl (client tank)'],
  [/\bhcl\b/i, 'hcl'],
  [/710-D-130335/i, 'tank tag 710-D-130335'],
  [/\bEBSM\b/i, 'EBSM'],
  [/\bDAMAC\b/i, 'DAMAC'],
  [/\bMasafi\b/i, 'Masafi'],
  [/\bKIPIC\b/i, 'KIPIC'],
  [/\bAl[- _]?Zour\b/i, 'Al-Zour'],
  [/\bEQUATE\b/, 'EQUATE'],
  [/\bKOC\b/, 'KOC'],
  [/\bKNPC\b/, 'KNPC'],
  [/\bMPW\b/, 'MPW'],
  [/Ministry of Public Works/i, 'Ministry of Public Works'],
  [/\bRing ?Road\b/i, 'Ring Road'],
  [/\bKuwait\b/i, 'Kuwait'],
  [/\bDubai\b/i, 'Dubai'],
  [/\bEtisalat\b/i, 'Etisalat'],
  [/(^|[^A-Za-z0-9])e&([^A-Za-z0-9]|$)/, 'e&'],
  [/\bElios\b/i, 'Elios (camera of a client survey)'],
  // DJI_0123.JPG, DJI_09572.jpg, DJI_20240314101500_0001_D.JPG
  [/\bDJI_(?:\d{14}_)?\d{4,5}(?!\d)/, 'DJI camera file name'],
  [/DanNas/i, 'NAS path'],
];

const REPO = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Third-party test fixtures whose example values look like client data but are not, let through
 * file by file. Each entry is one file at one path in the repository, pinned by the SHA-256 of
 * its text (LF line endings): a copy anywhere else, or any change to the file, is checked as usual
 * (a changed file is a finding of its own, so the pin gets reviewed). Findings in these files are
 * reported as allowed, not hidden.
 *
 * The Open Photogrammetry Format specification examples (M10, stream G5;
 * python/tests/fixtures/opf-spec-examples/README.md): Pix4D SA's example data from
 * github.com/Pix4D/opf-spec (CC-BY-4.0), with a DJI-style example photo name and example
 * geolocations in Switzerland and Italy. Not client data, not a real survey.
 */
export const ALLOWED_FIXTURES = Object.freeze(
  [
    [
      'camera-list.json',
      'ef81956faa59eeaa1865d6dd1487ea6e8f21d1b9d1a5d2784585897af8682a4d',
      'example photo URI file:///c:/data/images/DJI_09572.jpg',
    ],
    [
      'input-cameras.json',
      '9e73136484c724f6929c781241ddbdf58ab986e09a8975dd8438bf1c91a10567',
      'example camera geolocations (EPSG:4326, EPSG:4150)',
    ],
    [
      'control_points/input-control-points.json',
      '82c30dacb3ad2263e009ff2e9a9ed21de8a2cfa83e628a76f536e3a1d2032c70',
      'example control point (EPSG:4265)',
    ],
  ].map(([file, sha256, why]) =>
    Object.freeze({
      path: `python/tests/fixtures/opf-spec-examples/${file}`,
      sha256,
      why: `OPF specification example (Pix4D SA, CC-BY-4.0): ${why}`,
    }),
  ),
);

/** SHA-256 of a file's text with LF line endings (the pin of ALLOWED_FIXTURES). */
export const textSha256 = (buf) =>
  createHash('sha256')
    .update(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
    .digest('hex');

const MACHINE_PATH =
  /([A-Za-z]:[\\/]+(Users|Dev|Stratlas)[\\/])|(\/(home|Users)\/[A-Za-z0-9._-]+\/)/;

/** Real project origins (projected), kept even when the data folder is not on this machine. */
export const KNOWN_SITES = [
  { name: 'HCl tank', epsg: 32639, e: 216108, n: 3220019 },
  { name: 'Al-Zour terminal', epsg: 32639, e: 245714, n: 3179542 },
  { name: 'Masafi yard', epsg: 32639, e: 212624, n: 3201610 },
  { name: 'EBSM flare', epsg: 32639, e: 221029, n: 3214462 },
  { name: '1st Ring Road', epsg: 32638, e: 789217, n: 3252895 },
  { name: 'DAMAC tower', epsg: 32640, e: 322872, n: 2768332 },
];

const TEXT = new Set([
  '.json',
  '.geojson',
  '.js',
  '.mjs',
  '.csv',
  '.txt',
  '.md',
  '.html',
  '.htm',
  '.xml',
  '.svg',
  '.prj',
  '.yml',
  '.yaml',
  '.srt',
  // M9: journal segments (one op per line) and identity cards
  '.jsonl',
  '.aioid',
  // M10: OPF projects (JSON), glTF JSON, checksum lists
  '.opf',
  '.gltf',
  '.sha256',
  // M11: LandXML, 12d ASCII, Trimble JobXML and survey data collector files
  '.landxml',
  '.12da',
  '.jxl',
  '.dc',
]);

// ------------------------------------------------------------------ coordinates

/** UTM (WGS 84, EPSG 326zz north / 327zz south) to [lon, lat] degrees; null for other CRSs. */
export function utmToLonLat(epsg, e, n) {
  const north = epsg >= 32601 && epsg <= 32660;
  const south = epsg >= 32701 && epsg <= 32760;
  if (!north && !south) return null;
  const zone = epsg % 100;
  const a = 6378137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const k0 = 0.9996;
  const x = e - 500000;
  const y = south ? n - 10000000 : n;
  const m = y / k0;
  const mu = m / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const s1 = Math.sin(phi1);
  const c1 = Math.cos(phi1);
  const t1 = Math.tan(phi1);
  const n1 = a / Math.sqrt(1 - e2 * s1 * s1);
  const r1 = (a * (1 - e2)) / (1 - e2 * s1 * s1) ** 1.5;
  const cc = ep2 * c1 * c1;
  const tt = t1 * t1;
  const d = x / (n1 * k0);
  const lat =
    phi1 -
    ((n1 * t1) / r1) *
      ((d * d) / 2 -
        ((5 + 3 * tt + 10 * cc - 4 * cc * cc - 9 * ep2) * d ** 4) / 24 +
        ((61 + 90 * tt + 298 * cc + 45 * tt * tt - 252 * ep2 - 3 * cc * cc) * d ** 6) / 720);
  const lon =
    (d -
      ((1 + 2 * tt + cc) * d ** 3) / 6 +
      ((5 - 2 * cc + 28 * tt - 3 * cc * cc + 8 * ep2 + 24 * tt * tt) * d ** 5) / 120) /
    c1;
  return [(zone - 1) * 6 - 180 + 3 + (lon * 180) / Math.PI, (lat * 180) / Math.PI];
}

/** Great-circle distance in km. */
export function distanceKm([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function crsEpsg(crs) {
  return crs && typeof crs.epsg === 'number' ? crs.epsg : null;
}

/** Reference sites: the built-in list plus the origin of every manifest under `projectsDir`. */
export function referenceSites(projectsDir) {
  const sites = KNOWN_SITES.map((s) => ({ name: s.name, ll: utmToLonLat(s.epsg, s.e, s.n) }));
  const names = [];
  if (projectsDir && existsSync(projectsDir)) {
    for (const d of readdirSync(projectsDir)) {
      const f = join(projectsDir, d, 'manifest.json');
      if (!existsSync(f)) continue;
      let m;
      try {
        m = JSON.parse(readFileSync(f, 'utf8'));
      } catch {
        continue;
      }
      // a copy of the demo itself is not a reference
      if (
        d.startsWith('demo-') ||
        String(m.id ?? '').startsWith('demo-') ||
        String(m.customer ?? '').includes('(fictional)')
      )
        continue;
      const epsg = crsEpsg(m.crs);
      const ll =
        epsg && Array.isArray(m.origin) ? utmToLonLat(epsg, m.origin[0], m.origin[1]) : null;
      if (ll) sites.push({ name: `project ${d}`, ll });
      for (const v of [m.name, m.customer, m.site, m.brand])
        if (typeof v === 'string' && v.trim().length >= 3) names.push(v.trim());
      if (d.length >= 3) names.push(d);
    }
  }
  return { sites, names };
}

// ------------------------------------------------------------------ metadata of binaries

/** Metadata segments of a JPEG: APP1..APP15 and COM payloads. */
function jpegMeta(buf) {
  const out = [];
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return out;
  let p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) break;
    const marker = buf[p + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const len = buf.readUInt16BE(p + 2);
    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe)
      out.push({ marker, data: buf.subarray(p + 4, p + 2 + len) });
    p += 2 + len;
  }
  return out;
}

function pngMeta(buf) {
  const out = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(type))
      out.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
  }
  return out;
}

function webpMeta(buf) {
  const out = [];
  if (buf.toString('latin1', 0, 4) !== 'RIFF') return out;
  let p = 12;
  while (p + 8 <= buf.length) {
    const type = buf.toString('latin1', p, p + 4);
    const len = buf.readUInt32LE(p + 4);
    if (type === 'EXIF' || type === 'XMP ')
      out.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p += 8 + len + (len % 2);
  }
  return out;
}

/** The `moov` box of an MP4 (metadata: names, location atoms), or an empty buffer. */
function mp4Moov(buf) {
  let p = 0;
  while (p + 8 <= buf.length) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(p + 8));
    if (size < 8) break;
    if (type === 'moov') return buf.subarray(p, p + size);
    p += size;
  }
  return Buffer.alloc(0);
}

function glbJson(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) return '';
  const len = buf.readUInt32LE(12);
  return buf.toString('utf8', 20, 20 + len);
}

/** Readable text of a binary blob (runs of printable ASCII), for word checks. */
const strings = (b) => (b.toString('latin1').match(/[\x20-\x7e]{3,}/g) ?? []).join('\n');

/** Long base64 or hex runs (kit grids, data URLs) are payload, not words. */
const stripPayload = (s) => s.replace(/[A-Za-z0-9+/=]{120,}/g, ' ');

// ------------------------------------------------------------------ the check

/**
 * Check a folder. Returns { findings: string[], allowed: string[], files, bytes, points }.
 * @param {string} dir
 * @param {{ projectsDir?: string, radiusKm?: number, maxMb?: number, fixtures?: boolean,
 *   allow?: readonly { path: string, sha256: string, why: string }[], repoRoot?: string }} o
 *   `fixtures`: a test fixture folder, where GeoTIFFs are allowed (and checked) and no manifest
 *   is required. `allow` (default ALLOWED_FIXTURES) and `repoRoot` (default this repository):
 *   the pinned third-party files whose findings are `allowed` instead.
 */
export function checkFolder(dir, o = {}) {
  const radiusKm = o.radiusKm ?? 100;
  const { sites, names } = referenceSites(o.projectsDir);
  const words = [
    ...FORBIDDEN,
    ...names.map((n) => [
      new RegExp(
        `(^|[^A-Za-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`,
        'i',
      ),
      n,
    ]),
  ];
  const findings = [];
  const allowList = o.allow ?? ALLOWED_FIXTURES;
  const repoRoot = o.repoRoot ?? REPO;
  /** Folder-relative paths of pinned files whose content matched, and why each is allowed. */
  const allowedFiles = new Map();
  let files = 0;
  let bytes = 0;
  let points = 0;
  const reported = new Set();
  const near = (ll, where) => {
    points++;
    for (const s of sites) {
      if (!s.ll) continue;
      const km = distanceKm(ll, s.ll);
      const key = `${where.split(' feature ')[0]}|${s.name}`;
      if (km < radiusKm && !reported.has(key) && reported.add(key))
        findings.push(
          `${where}: ${ll[1].toFixed(4)}, ${ll[0].toFixed(4)} is ${km.toFixed(1)} km from ${s.name}`,
        );
    }
  };
  /** Camera, control and tile positions must lie in a fictional site (one finding per file). */
  const outside = new Set();
  const placed = (ll, where, what) => {
    near(ll, where);
    const file = where.split(' ')[0];
    if (!fictionalSite(ll) && !outside.has(file) && outside.add(file))
      findings.push(
        `${where}: ${what} at ${ll[1].toFixed(4)}, ${ll[0].toFixed(4)} is outside the fictional sites`,
      );
  };
  /** [lon, lat] of a projected (UTM) or geographic (x = lon, y = lat) coordinate, or null. */
  const lonLatOf = (epsg, x, y) =>
    epsg === 4326 || epsg === 4979 ? [x, y] : utmToLonLat(epsg, x, y);
  const scanText = (text, where) => {
    for (const [re, label] of words) {
      const m = re.exec(text);
      if (m) {
        const at = Math.max(0, m.index - 30);
        findings.push(
          `${where}: "${label}" in "...${text.slice(at, m.index + m[0].length + 30).replace(/\s+/g, ' ')}..."`,
        );
      }
    }
    const mp = MACHINE_PATH.exec(text);
    if (mp) findings.push(`${where}: a path of the build machine (${mp[0]})`);
  };
  const walkCoords = (g, where) => {
    if (Array.isArray(g) && g.length >= 2 && typeof g[0] === 'number' && typeof g[1] === 'number') {
      if (Math.abs(g[0]) <= 180 && Math.abs(g[1]) <= 90) near([g[0], g[1]], where);
      return;
    }
    if (Array.isArray(g)) for (const x of g) walkCoords(x, where);
  };
  const geojson = (j, where) => {
    const feats =
      j.type === 'FeatureCollection' ? (j.features ?? []) : j.type === 'Feature' ? [j] : [];
    let k = 0;
    for (const f of feats)
      if (f?.geometry) walkCoords(f.geometry.coordinates, `${where} feature ${String(k++)}`);
    if (j.coordinates) walkCoords(j.coordinates, where);
  };

  /** M11: a survey file's names and coordinates (check-m11.mjs), in the project's CRS by default. */
  const survey = (p, rel, ext, buf, crs) => {
    const sibling = (e) => {
      const f = join(dirname(p), `${basename(p, extname(p))}${e}`);
      return existsSync(f) ? readFileSync(f, 'utf8') : null;
    };
    const c = surveyContent(ext, buf, { sibling });
    if (!c) return;
    const r = surveyFindings(rel, c, crs, near);
    findings.push(...r.findings);
  };
  /** Survey CSVs and DXFs are the ones under a survey/ folder (M8 drawings are in a local frame). */
  const inSurvey = (rel) => /(^|\/)survey\//.test(rel);

  const walk = (d, parentCrs = null) => {
    let crs = parentCrs;
    const mf = join(d, 'manifest.json');
    if (existsSync(mf))
      try {
        crs = JSON.parse(readFileSync(mf, 'utf8')).crs ?? crs;
      } catch {
        // reported when the manifest itself is checked
      }
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p, crs);
        continue;
      }
      files++;
      bytes += st.size;
      const rel = relative(dir, p).replace(/\\/g, '/');
      scanText(rel, `file name ${rel}`);
      const ext = extname(name).toLowerCase();
      const buf = readFileSync(p);
      const pin = allowList.find((a) => a.path === relative(repoRoot, p).replace(/\\/g, '/'));
      if (pin) {
        const sha = textSha256(buf);
        if (sha === pin.sha256) allowedFiles.set(rel, pin.why);
        else
          findings.push(
            `${rel}: an allowed third-party fixture whose content changed (sha256 ${sha}); review it and update ALLOWED_FIXTURES`,
          );
      }
      if (TEXT.has(ext)) {
        const text = buf.toString('utf8');
        scanText(stripPayload(text), rel);
        if (ext === '.json' || ext === '.geojson') {
          let j;
          try {
            j = JSON.parse(text);
          } catch {
            findings.push(`${rel}: not valid JSON`);
            continue;
          }
          if (j && typeof j === 'object') {
            if (j.type === 'FeatureCollection' || j.type === 'Feature') geojson(j, rel);
            if (name === 'manifest.json' && Array.isArray(j.origin)) {
              const epsg = crsEpsg(j.crs);
              const ll = epsg ? utmToLonLat(epsg, j.origin[0], j.origin[1]) : null;
              if (ll) near(ll, `${rel} origin`);
              else
                findings.push(
                  `${rel}: origin in a CRS this check cannot place (${JSON.stringify(j.crs)})`,
                );
            }
            // map sightings and vector overlays inside issues keep GeoJSON in lon/lat
            if (name === 'issues.json' && Array.isArray(j.issues))
              for (const is of j.issues)
                for (const s of is.sightings ?? [])
                  if (s.on === 'map' && s.geojson) geojson(s.geojson, `${rel} ${String(is.code)}`);
            // M8: the places listed in a demo's truth.json
            if (name === 'truth.json') for (const ll of truthCoords(j)) near(ll, rel);
            // M11: measurements, alignments and calibrations under survey/ (check-m11.mjs)
            if (inSurvey(rel)) survey(p, rel, ext, buf, crs);
            // M10: OPF geolocations (EPSG:4326 lists latitude first), 3D Tiles, raster packs
            if (isOpf(j))
              for (const g of opfGeolocations(j)) {
                const ll = opfGeographicLonLat(g) ?? utmToLonLat(g.epsg, g.coords[0], g.coords[1]);
                if (ll) placed(ll, `${rel} OPF geolocation`, 'a position');
              }
            if (isTileset(j)) {
              const ll = tilesetLonLat(j);
              if (ll) placed(ll, `${rel} tileset`, 'the tileset');
            }
            if (j.schema === 'aio.raster-pack/1') {
              findings.push(...rasterPackFindings(j, rel));
              const c = smallBboxCentre(j.bbox);
              if (c) near(c, `${rel} bbox`);
            }
          }
        }
        // M10: PPK positions (lat and lon columns) and ODM gcp_list.txt (the CRS on line one)
        if (ext === '.csv')
          for (const ll of csvLonLats(text)) placed(ll, `${rel} row`, 'a position');
        if (ext === '.txt') {
          const g = gcpListPoints(text);
          for (const [x, y] of g?.pts ?? []) {
            const ll = lonLatOf(g.epsg, x, y);
            if (ll) placed(ll, `${rel} point`, 'a control point');
          }
        }
        // M11: survey text files
        if (ext !== '.csv' || inSurvey(rel)) survey(p, rel, ext, buf, crs);
        continue;
      }
      if (ext === '.jpg' || ext === '.jpeg') {
        const segs = jpegMeta(buf);
        // the synthetic camera (M10) may carry EXIF and XMP, checked field by field
        const synthetic = segs.some(
          (seg) => seg.data.toString('latin1', 0, 4) === 'Exif' && exifInfo(seg.data).synthetic,
        );
        const camera = (info, kind) => {
          for (const s of info.serials)
            findings.push(`${rel}: a camera serial number in ${kind} (${s})`);
          for (const n of info.names) findings.push(`${rel}: a personal name in ${kind} (${n})`);
          if (info.lonLat) placed(info.lonLat, `${rel} ${kind} GPS`, 'the camera');
        };
        for (const seg of segs) {
          const head = seg.data.toString('latin1', 0, 40);
          if (head.startsWith('Exif')) {
            const info = exifInfo(seg.data);
            if (info.synthetic) camera(info, 'EXIF');
            else findings.push(`${rel}: EXIF metadata (camera, GPS) in a demo photo`);
          } else if (head.includes('ns.adobe.com/xap')) {
            const info = xmpInfo(seg.data.toString('utf8'));
            if (info.synthetic || synthetic) camera(info, 'XMP');
            else findings.push(`${rel}: XMP metadata in a demo photo`);
          }
          scanText(strings(seg.data), `${rel} metadata`);
        }
        continue;
      }
      if (ext === '.png') {
        for (const c of pngMeta(buf)) {
          if (c.type === 'eXIf') findings.push(`${rel}: EXIF metadata in a demo image`);
          scanText(strings(c.data), `${rel} ${c.type}`);
        }
        continue;
      }
      if (ext === '.webp') {
        for (const c of webpMeta(buf))
          findings.push(`${rel}: ${c.type.trim()} metadata in a demo image`);
        continue;
      }
      if (ext === '.mp4' || ext === '.mov' || ext === '.m4v') {
        const moov = mp4Moov(buf);
        if (moov.includes(Buffer.from([0xa9, 0x78, 0x79, 0x7a])))
          findings.push(`${rel}: a location (©xyz) atom in the video`);
        scanText(strings(moov), `${rel} metadata`);
        continue;
      }
      if (ext === '.glb') {
        scanText(glbJson(buf), `${rel} glTF JSON`);
        continue;
      }
      if (ext === '.tif' || ext === '.tiff') {
        if (!o.fixtures) {
          findings.push(`${rel}: raw GeoTIFF in the demo (sources stay out of published projects)`);
          continue;
        }
        const g = geotiffInfo(buf);
        for (const t of g.texts) scanText(t, `${rel} tags`);
        const ll = g.epsg && g.xy ? lonLatOf(g.epsg, g.xy[0], g.xy[1]) : null;
        if (ll) placed(ll, `${rel} GeoTIFF`, 'the raster');
        else findings.push(`${rel}: a GeoTIFF this check cannot place (EPSG ${String(g.epsg)})`);
        continue;
      }
      // M10: legacy 3D Tiles content keeps a JSON feature table (RTC_CENTER in ECEF)
      if (['.b3dm', '.pnts', '.i3dm', '.cmpt', '.subtree'].includes(ext)) {
        const c = tileFeatureTable(buf)?.RTC_CENTER;
        if (Array.isArray(c) && c.length === 3 && Math.hypot(...c) > 6e6)
          placed(ecefToLonLat(c), `${rel} RTC_CENTER`, 'the tile');
        scanText(strings(buf.subarray(0, 65536)), `${rel} header`);
        continue;
      }
      // M10: a PMTiles archive's metadata (gzip) and bounds
      if (ext === '.pmtiles') {
        const pm = pmtilesInfo(buf);
        if (pm) {
          scanText(stripPayload(pm.meta), `${rel} metadata`);
          const c = smallBboxCentre(pm.bbox);
          if (c) near(c, `${rel} bounds`);
        }
      }
      // M8: DXF drawings and ONNX models (text fields only, see check-m8.mjs)
      const m8 = m8Text(ext, buf);
      if (m8 !== null) {
        scanText(m8, `${rel} text`);
        if (ext === '.dxf' && inSurvey(rel)) survey(p, rel, ext, buf, crs);
        continue;
      }
      // M11: aio.tin/1 design surfaces (the JSON header: words, CRS and bounds)
      if (ext === '.tin') {
        scanText(strings(buf.subarray(0, 65536)), `${rel} header`);
        survey(p, rel, ext, buf, crs);
        continue;
      }
      if (!['.bin', '.laz', '.las', '.pmtiles', '.pdf'].includes(ext))
        findings.push(`${rel}: file type ${ext || '(none)'} is not checked; add it to the check`);
      else scanText(strings(buf.subarray(0, 4096)), `${rel} header`);
    }
  };
  if (!existsSync(dir))
    return { findings: [`${dir} does not exist`], allowed: [], files, bytes, points };
  walk(dir);
  if (o.maxMb && bytes > o.maxMb * 1e6)
    findings.push(`total size ${(bytes / 1e6).toFixed(1)} MB is over ${o.maxMb} MB`);
  if (points === 0 && !o.fixtures)
    findings.push('no coordinates found to check (a project needs a manifest origin)');
  // findings name their file first ("<rel>: ...", "<rel> OPF geolocation: ...", "file name <rel>: ...")
  const pinnedFile = (f) =>
    [...allowedFiles.keys()].find(
      (rel) =>
        f.startsWith(`${rel}:`) || f.startsWith(`${rel} `) || f.startsWith(`file name ${rel}:`),
    );
  const allowed = [];
  const kept = [];
  for (const f of findings) {
    const rel = pinnedFile(f);
    if (rel) allowed.push(`${f} [allowed: ${allowedFiles.get(rel)}]`);
    else kept.push(f);
  }
  return { findings: kept, allowed, files, bytes, points };
}

function cli() {
  const argv = process.argv.slice(2);
  const opt = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const positional = argv.filter(
    (a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')),
  );
  const dir = resolve(positional[0] ?? join(REPO, 'apps', 'desktop', 'demo'));
  const data =
    envVar(process.env, 'DATA') ?? (process.platform === 'win32' ? 'E:\\Stratlas Data' : '');
  const projectsDir = opt('projects') ?? (data ? join(data, 'projects') : undefined);
  const r = checkFolder(dir, {
    projectsDir,
    radiusKm: Number(opt('radius-km') ?? 100),
    maxMb: Number(opt('max-mb') ?? 150),
    fixtures: argv.includes('--fixtures'),
  });
  const refs =
    projectsDir && existsSync(projectsDir)
      ? `, reference projects in ${projectsDir}`
      : ', built-in reference sites only';
  for (const a of r.allowed) console.log(`  allowed: ${a}`);
  if (r.findings.length) {
    console.error(`Client data check FAILED for ${dir} (${r.files} files${refs}):`);
    for (const f of r.findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    `Client data check passed: ${dir}, ${r.files} files, ${(r.bytes / 1e6).toFixed(1)} MB, ${r.points} coordinates${refs}${r.allowed.length ? `, ${r.allowed.length} findings in pinned third-party fixtures allowed` : ''}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
