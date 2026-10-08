// What the client-data check (check-no-client-data.mjs) reads from M11 survey files (stream G13):
// LandXML, DXF, 12da, Trimble JobXML and .dc, CSV points and aio.tin/1 surfaces. Coordinates must
// lie in a fictional site once placed in their CRS (the file's own, else the project's), and job
// and project names must say they are synthetic (no real job numbers). Pure functions: the check
// walks the folder and calls them.
import { distanceKm, utmToLonLat } from './check-no-client-data.mjs';
import { fictionalSite } from './check-m10.mjs';

/** The US survey foot in metres, exactly. */
export const US_FT = 1200 / 3937;

/**
 * Fictional sites of the M11 survey fixtures (python/tests/survey_synth.py FIXTURE_CRS): [lon,
 * lat] and a radius in km. The desert site of the survey demos lies in the photo demo's site
 * (check-m10.mjs) as well.
 */
export const M11_FICTIONAL_SITES = [
  { name: 'survey demo site (Rub al Khali)', ll: [51.49291, 21.08288], km: 15 },
  { name: 'survey fixture site (central Nevada, NAD83(2011) ftUS)', ll: [-116.55, 38.95], km: 10 },
  { name: 'survey fixture site (open moorland, British National Grid)', ll: [-4.7, 56.62], km: 10 },
];

/** The fictional site a [lon, lat] lies in (M10 or M11 lists), or null. */
export function surveySite(ll) {
  return fictionalSite(ll) ?? M11_FICTIONAL_SITES.find((s) => distanceKm(ll, s.ll) <= s.km) ?? null;
}

const GRS80 = { a: 6378137, f: 1 / 298.257222101 };
const WGS84 = { a: 6378137, f: 1 / 298.257223563 };
const AIRY = { a: 6377563.396, f: 1 / 299.3249646 };

/**
 * Transverse Mercator CRSs this check can place besides WGS 84 / UTM: the fixture CRSs of
 * survey_synth.py. `fe` and `fn` are metres; `unit` converts the CRS's unit to metres.
 */
export const TM_CRS = {
  27700: { ...AIRY, lat0: 49, lon0: -2, k0: 0.9996012717, fe: 400000, fn: -100000, unit: 1 },
  // NAD83 and NAD83(2011) / Nevada Central (ftUS)
  3422: {
    ...GRS80,
    lat0: 34.75,
    lon0: -116 - 2 / 3,
    k0: 0.9999,
    fe: 500000.00001016,
    fn: 6000000,
    unit: US_FT,
  },
  6519: {
    ...GRS80,
    lat0: 34.75,
    lon0: -116 - 2 / 3,
    k0: 0.9999,
    fe: 500000.00001016,
    fn: 6000000,
    unit: US_FT,
  },
  6518: { ...GRS80, lat0: 34.75, lon0: -116 - 2 / 3, k0: 0.9999, fe: 500000, fn: 6000000, unit: 1 },
};

/** Inverse transverse Mercator (Snyder's series), [lon, lat] degrees. */
export function tmInverse(p, x, y) {
  const { a, f, lat0 = 0, lon0, k0, fe = 0, fn = 0, unit = 1 } = p;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const r = Math.PI / 180;
  const M = (phi) =>
    a *
    ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * e2 * e2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const X = x * unit - fe;
  const m = M(lat0 * r) + (y * unit - fn) / k0;
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
  const d = X / (n1 * k0);
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
  return [lon0 + lon / r, lat / r];
}

/**
 * [lon, lat] of (x, y) in a CRS: `{ epsg }` (WGS 84 geographic, UTM, or a TM_CRS code) or
 * `{ tm }` (transverse Mercator parameters, as a JobXML states them); null when unknown.
 */
export function lonLatIn(crs, x, y) {
  if (!crs) return null;
  if (crs.tm) return tmInverse(crs.tm, x, y);
  const epsg = crs.epsg;
  if (epsg === 4326 || epsg === 4979) return [x, y];
  if (TM_CRS[epsg]) return tmInverse(TM_CRS[epsg], x, y);
  return utmToLonLat(epsg, x, y);
}

/** The corners and centre of the bounding box of [x, y] pairs (enough to place a site). */
export function bboxProbe(xy) {
  if (!xy.length) return [];
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of xy) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [(x0 + x1) / 2, (y0 + y1) / 2],
  ];
}

const nums = (s) => s.trim().split(/\s+/).map(Number);
const finite = (p) => p.every(Number.isFinite);
/** A job or project name that says it is not real. */
export const SYNTHETIC_NAME = /synthetic|fictional|demo|test|example/i;

/** LandXML: its EPSG code, its points as [E, N] (LandXML lists northing first) and its names. */
export function landxmlInfo(text) {
  const epsg = /<CoordinateSystem\b[^>]*\bepsgCode="(\d+)"/.exec(text)?.[1];
  const xy = [];
  const tag = /<(P|CgPoint|Start|End|Center|PI)\b[^>]*>([^<]*)<\/\1>/g;
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    const v = nums(m[2]);
    if (v.length >= 2 && finite(v.slice(0, 2))) xy.push([v[1], v[0]]);
  }
  const list = /<(PntList3D|PntList2D)>([^<]*)<\/\1>/g;
  for (let m = list.exec(text); m; m = list.exec(text)) {
    const v = nums(m[2]);
    const k = m[1] === 'PntList3D' ? 3 : 2;
    for (let i = 0; i + 1 < v.length; i += k)
      if (Number.isFinite(v[i]) && Number.isFinite(v[i + 1])) xy.push([v[i + 1], v[i]]);
  }
  const names = [];
  const pn = /<Project\b[^>]*\bname="([^"]*)"/.exec(text);
  if (pn) names.push(pn[1]);
  return { crs: epsg ? { epsg: Number(epsg) } : null, xy, names };
}

/** ASCII DXF: [x, y] of every point coordinate (group codes 10-18 with 20-28), (0, 0) skipped. */
export function dxfXY(text) {
  const lines = text.split(/\r?\n/);
  const xy = [];
  let x = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    const v = Number(lines[i + 1].trim());
    if (code >= 10 && code <= 18) x = v;
    else if (code >= 20 && code <= 28 && x !== null) {
      if (Number.isFinite(x) && Number.isFinite(v) && (x !== 0 || v !== 0)) xy.push([x, v]);
      x = null;
    }
  }
  return xy;
}

/** 12da: [x, y] of every data row of three numbers (x y z), and the project comment's name. */
export function twelveDaInfo(text) {
  const xy = [];
  const row =
    /(?:^|[{\s])(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?=\s*(?:$|}))/gm;
  for (let m = row.exec(text); m; m = row.exec(text)) xy.push([Number(m[1]), Number(m[2])]);
  const names = [];
  const p = /^\/\/\s*project\s+"([^"]*)"/m.exec(text);
  if (p) names.push(p[1]);
  return { xy, names };
}

const tagNum = (text, name) => {
  const m = new RegExp(`<${name}>\\s*(-?[\\d.eE+-]+)\\s*</${name}>`).exec(text);
  return m ? Number(m[1]) : null;
};

/**
 * Trimble JobXML: the job name, the transverse Mercator projection it states (if any), its WGS 84
 * positions as [lon, lat] and its grid positions as [E, N].
 */
export function jobxmlInfo(text) {
  const names = [];
  const job = /<JOBFile\b[^>]*\bjobName="([^"]*)"/.exec(text);
  if (job) names.push(job[1]);
  let tm = null;
  const proj = /<Projection>([\s\S]*?)<\/Projection>/.exec(text)?.[1];
  if (proj && /TransverseMercator/i.test(proj)) {
    const radius = tagNum(text, 'EarthRadius') ?? 6378137;
    const flat = tagNum(text, 'Flattening') ?? WGS84.f;
    tm = {
      a: radius,
      f: flat,
      lat0: tagNum(proj, 'OriginLatitude') ?? 0,
      lon0: tagNum(proj, 'CentralMeridian') ?? 0,
      k0: tagNum(proj, 'Scale') ?? 1,
      fe: tagNum(proj, 'FalseEasting') ?? 0,
      fn: tagNum(proj, 'FalseNorthing') ?? 0,
      unit: 1,
    };
  }
  const lonLat = [];
  const w = /<WGS84>([\s\S]*?)<\/WGS84>/g;
  for (let m = w.exec(text); m; m = w.exec(text)) {
    const la = tagNum(m[1], 'Latitude');
    const lo = tagNum(m[1], 'Longitude');
    if (la !== null && lo !== null) lonLat.push([lo, la]);
  }
  const xy = [];
  const g = /<Grid>([\s\S]*?)<\/Grid>/g;
  for (let m = g.exec(text); m; m = g.exec(text)) {
    const n = tagNum(m[1], 'North');
    const e = tagNum(m[1], 'East');
    if (n !== null && e !== null) xy.push([e, n]);
  }
  return { names, tm, lonLat, xy };
}

/** Trimble .dc: the job name (record 10) and keyed-in grid points (record 08) as [E, N]. */
export function dcInfo(text) {
  const names = [];
  const xy = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('10')) names.push(line.slice(4, 20).trim());
    if (line.startsWith('08')) {
      const n = Number(line.slice(20, 36));
      const e = Number(line.slice(36, 52));
      if (Number.isFinite(n) && Number.isFinite(e)) xy.push([e, n]);
    }
  }
  return { names, xy };
}

/** CSV points with projected columns (easting and northing, e and n, or x and y): [E, N]. */
export function csvXY(text) {
  const lines = text
    .replace(/^\s+/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0].split(/[,;\t]/).map((h) => h.trim().toLowerCase());
  const pick = (names) => head.findIndex((h) => names.includes(h));
  const ie = pick(['easting', 'east', 'e', 'x']);
  const inn = pick(['northing', 'north', 'n', 'y']);
  if (ie < 0 || inn < 0) return [];
  const xy = [];
  for (const l of lines.slice(1)) {
    const c = l.split(/[,;\t]/);
    const p = [Number(c[ie]), Number(c[inn])];
    if (finite(p)) xy.push(p);
  }
  return xy;
}

/** An aio.tin/1 file's JSON header (or null): its CRS and bounds. */
export function tinHeader(buf) {
  if (buf.length < 8) return null;
  const n = buf.readUInt32LE(0);
  if (n > 1e6 || 4 + n > buf.length) return null;
  try {
    const h = JSON.parse(buf.toString('utf8', 4, 4 + n));
    return h && h.schema === 'aio.tin/1' ? h : null;
  } catch {
    return null;
  }
}

/**
 * M11 JSON side files with coordinates: measurements (E, N, Z vertices), alignments (element
 * points), calibrations (WGS 84 pairs) and the CRS they state. Null for other JSON.
 */
export function surveyJson(j, text = '') {
  if (!j || typeof j !== 'object') return null;
  const xy = [];
  const lonLat = [];
  if (j.schema === 'aio.measurements/1' && Array.isArray(j.measurements)) {
    for (const m of j.measurements)
      for (const p of m?.points ?? []) if (finite([p?.[0], p?.[1]])) xy.push([p[0], p[1]]);
  } else if (j.schema === 'aio.alignment/1' && Array.isArray(j.elements)) {
    for (const e of j.elements)
      for (const k of ['start', 'end', 'center'])
        if (Array.isArray(e?.[k]) && finite(e[k])) xy.push([e[k][0], e[k][1]]);
  } else if (j.schema === 'aio.site-calibration/1' && Array.isArray(j.pairs)) {
    for (const p of j.pairs)
      if (Array.isArray(p?.wgs84) && finite(p.wgs84)) lonLat.push([p.wgs84[1], p.wgs84[0]]);
  } else return null;
  const crs = j.crs?.epsg ? { epsg: j.crs.epsg } : null;
  return { xy, lonLat, names: [], crs, text };
}

/**
 * The M11 survey content of a file, for the check: `xy` coordinates with the `crs` to place them
 * in (null: the project's), `lonLat` positions, the `names` that must say synthetic, and `text`
 * to scan for words. Returns null for files that are not survey files.
 * @param {string} ext lower-case extension
 * @param {Buffer} buf
 * @param {{ sibling?: (ext: string) => string | null }} [o] the text of a file beside it with the
 *   same name and another extension (a .dc borrows its JobXML's projection)
 */
export function surveyContent(ext, buf, o = {}) {
  if (ext === '.tin') {
    const h = tinHeader(buf);
    if (!h)
      return { xy: [], lonLat: [], names: [], crs: null, text: '', bad: 'not an aio.tin/1 file' };
    const b = h.bounds ?? [];
    return {
      xy:
        b.length === 6
          ? [
              [b[0], b[1]],
              [b[3], b[4]],
            ]
          : [],
      lonLat: [],
      names: [],
      crs: h.crs?.epsg ? { epsg: h.crs.epsg } : null,
      text: JSON.stringify(h),
    };
  }
  const text = buf.toString('utf8');
  if (ext === '.json') {
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      return null;
    }
    return surveyJson(j, text);
  }
  if ((ext === '.xml' || ext === '.landxml') && /<LandXML\b/.test(text)) {
    const i = landxmlInfo(text);
    return { xy: i.xy, lonLat: [], names: i.names, crs: i.crs, text };
  }
  if (ext === '.jxl' || (ext === '.xml' && /<JOBFile\b/.test(text))) {
    const i = jobxmlInfo(text);
    return { xy: i.xy, lonLat: i.lonLat, names: i.names, crs: i.tm ? { tm: i.tm } : null, text };
  }
  if (ext === '.dc') {
    const i = dcInfo(text);
    const jx = o.sibling?.('.jxl');
    const tm = jx ? jobxmlInfo(jx).tm : null;
    return { xy: i.xy, lonLat: [], names: i.names, crs: tm ? { tm } : null, text };
  }
  if (ext === '.12da') {
    const i = twelveDaInfo(text);
    return { xy: i.xy, lonLat: [], names: i.names, crs: null, text };
  }
  if (ext === '.dxf') return { xy: dxfXY(text), lonLat: [], names: [], crs: null, text };
  if (ext === '.csv') return { xy: csvXY(text), lonLat: [], names: [], crs: null, text };
  return null;
}

/**
 * Findings for one survey file: names not marked synthetic, coordinates that cannot be placed,
 * and positions outside every fictional site (one finding each, the first offending place).
 * `projectCrs` is the enclosing project's manifest `crs`. `near(ll, where)` lets the caller run
 * its real-site distance check on every placed position.
 */
export function surveyFindings(rel, content, projectCrs, near = () => undefined) {
  const findings = [];
  for (const n of content.names)
    if (!SYNTHETIC_NAME.test(n))
      findings.push(`${rel}: a job or project name that is not marked synthetic ("${n}")`);
  if (content.bad) findings.push(`${rel}: ${content.bad}`);
  const crs = content.crs ?? projectCrs ?? null;
  const places = [...content.lonLat];
  if (content.xy.length) {
    const probe = bboxProbe(content.xy);
    const placedAll = probe.map(([x, y]) => lonLatIn(crs, x, y));
    if (placedAll.some((ll) => !ll || !ll.every(Number.isFinite)))
      findings.push(
        `${rel}: coordinates in a CRS this check cannot place (${JSON.stringify(crs)}); give the file or its project a known CRS`,
      );
    else places.push(...placedAll);
  }
  let outside = false;
  for (const ll of places) {
    near(ll, rel);
    if (!outside && !surveySite(ll)) {
      outside = true;
      findings.push(
        `${rel}: a survey coordinate at ${ll[1].toFixed(4)}, ${ll[0].toFixed(4)} is outside the fictional sites`,
      );
    }
  }
  return { findings, points: places.length };
}
