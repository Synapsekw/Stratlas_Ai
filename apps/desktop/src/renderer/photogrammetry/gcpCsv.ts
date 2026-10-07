/**
 * Ground control files in (plan "Ground control points, checkpoints and accuracy"): CSV or TXT with
 * `id, x, y, z` or `id, lat, lon, h`, with or without a header, comma, semicolon, tab or space
 * separated; Pix4D's GCP lists (no header) and ODM's `gcp_list.txt` (a CRS line, then one image
 * observation per line) are read too. The person maps the columns and picks the EPSG code; nothing
 * here guesses silently: every change (a swapped latitude and longitude, a missing id) is a warning.
 */
import type { GcpFile, GcpMark, GcpPoint, GcpRole } from '@aio/schema';

export type Column = 'id' | 'x' | 'y' | 'z' | 'lat' | 'lon' | 'role' | 'accH' | 'accV' | 'skip';

export const COLUMN_LABELS: Readonly<Record<Column, string>> = {
  id: 'Point id',
  x: 'Easting (x)',
  y: 'Northing (y)',
  z: 'Height (z)',
  lat: 'Latitude',
  lon: 'Longitude',
  role: 'Role',
  accH: 'Accuracy, horizontal (m)',
  accV: 'Accuracy, vertical (m)',
  skip: 'Not used',
};

export interface GcpTable {
  /** Column names when the first line is a header. */
  header: string[] | null;
  rows: string[][];
  separator: ',' | ';' | '\t' | ' ';
  /** ODM `gcp_list.txt`: its CRS line, and the image observations it carries. */
  odm?: { crs: string; epsg: number | null };
}

const SEPARATORS = [',', ';', '\t'] as const;
const isNum = (s: string | undefined) =>
  s !== undefined && s.trim() !== '' && Number.isFinite(Number(s.trim()));

function split(line: string, sep: GcpTable['separator']): string[] {
  if (sep === ' ') return line.trim().split(/\s+/);
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === sep && !quoted) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** An EPSG code in an ODM CRS line (`EPSG:32639`, `WGS84 UTM 39N`, a proj string). */
export function epsgFromCrsLine(line: string): number | null {
  const t = line.trim();
  const code = /^epsg:\s*(\d{4,5})$/i.exec(t);
  if (code) return Number(code[1]);
  const utm = /^wgs84 utm (\d{1,2})([ns])$/i.exec(t);
  if (utm) return (utm[2]?.toLowerCase() === 's' ? 32700 : 32600) + Number(utm[1]);
  if (t.includes('+proj=utm') && /\+(datum|ellps)=WGS84/i.test(t)) {
    const z = /\+zone=(\d{1,2})/.exec(t);
    if (z) return (t.includes('+south') ? 32700 : 32600) + Number(z[1]);
  }
  if (/\+proj=(longlat|latlong)/.test(t)) return 4326;
  return null;
}

/** Read the text of a GCP file into rows; throws with a readable reason. */
export function readTable(text: string): GcpTable {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  if (!lines.length) throw new Error('The file is empty.');
  const first = lines[0] ?? '';
  // ODM gcp_list.txt: the first line is the CRS, then "x y z px py image [name]"
  if (lines.length > 1 && !/[,;\t]/.test(first) && /epsg:|\+proj=|^wgs84 utm/i.test(first)) {
    const rows = lines.slice(1).map((l) => split(l, ' '));
    return {
      header: null,
      rows,
      separator: ' ',
      odm: { crs: first, epsg: epsgFromCrsLine(first) },
    };
  }
  const counts = SEPARATORS.map((s) => first.split(s).length - 1);
  const best = Math.max(...counts);
  const separator: GcpTable['separator'] =
    best > 0 ? (SEPARATORS[counts.indexOf(best)] ?? ',') : ' ';
  const all = lines.map((l) => split(l, separator));
  const head = all[0] ?? [];
  // a header has no numbers where the data rows have them
  const header =
    all.length > 1 && head.filter(isNum).length === 0 && (all[1] ?? []).some(isNum) ? head : null;
  return { header, rows: header ? all.slice(1) : all, separator };
}

const NAMES: readonly [RegExp, Column][] = [
  [/^(id|name|label|point|gcp|pt|point ?id|gcp ?(id|name))$/i, 'id'],
  [/^(lat|latitude|phi)$/i, 'lat'],
  [/^(lon|long|lng|longitude|lambda)$/i, 'lon'],
  [/^(x|e|east|easting)$/i, 'x'],
  [/^(y|n|north|northing)$/i, 'y'],
  [/^(z|h|height|elev|elevation|alt|altitude|ellipsoidal height|orthometric height)$/i, 'z'],
  [/^(role|type|kind|use)$/i, 'role'],
  [/^(acc|accuracy|acc ?h|accuracy ?h(orizontal)?|sh|sigma ?h|horizontal accuracy)$/i, 'accH'],
  [/^(acc ?v|accuracy ?v(ertical)?|sv|sigma ?v|vertical accuracy)$/i, 'accV'],
];

const looksLikeDegrees = (rows: string[][], i: number, max: number) =>
  rows.length > 0 &&
  rows.every((r) => isNum(r[i]) && Math.abs(Number(r[i])) <= max && /\.\d{4,}/.test(r[i] ?? ''));

/** The column mapping a person starts from: by header name, else by shape. */
export function guessMapping(t: GcpTable): Column[] {
  const width = Math.max(0, ...t.rows.map((r) => r.length), t.header?.length ?? 0);
  if (t.odm) {
    // x y z px py image [name]
    return Array.from({ length: width }, (_, i) =>
      i === 0 ? 'x' : i === 1 ? 'y' : i === 2 ? 'z' : i === 6 ? 'id' : 'skip',
    );
  }
  if (t.header) {
    const used = new Set<Column>();
    return t.header.map((h) => {
      const name = h.trim().replace(/[_-]+/g, ' ');
      const hit = NAMES.find(([re, c]) => re.test(name) && !used.has(c))?.[1] ?? 'skip';
      if (hit !== 'skip') used.add(hit);
      return hit;
    });
  }
  // no header: an id first when the first column is not a number, then three coordinates
  const idFirst = t.rows.some((r) => !isNum(r[0]));
  const c0 = idFirst ? 1 : 0;
  const degrees = looksLikeDegrees(t.rows, c0, 90) && looksLikeDegrees(t.rows, c0 + 1, 180);
  const coords: Column[] = degrees ? ['lat', 'lon', 'z'] : ['x', 'y', 'z'];
  return Array.from({ length: width }, (_, i) => {
    if (idFirst && i === 0) return 'id';
    return coords[i - c0] ?? 'skip';
  });
}

/** True when the mapping reads degrees (the file's CRS is then WGS84, EPSG:4326). */
export const mapsDegrees = (m: readonly Column[]) => m.includes('lat') && m.includes('lon');

/** What a mapping still lacks, in words, or null when it can be imported. */
export function mappingProblem(m: readonly Column[]): string | null {
  const twice = (['id', 'x', 'y', 'z', 'lat', 'lon', 'role', 'accH', 'accV'] as const).find(
    (c) => m.filter((x) => x === c).length > 1,
  );
  if (twice) return `${COLUMN_LABELS[twice]} is chosen for two columns.`;
  const degrees = m.includes('lat') || m.includes('lon');
  const metres = m.includes('x') || m.includes('y');
  if (degrees && metres) return 'Choose either latitude and longitude, or easting and northing.';
  if (degrees ? !mapsDegrees(m) : !(m.includes('x') && m.includes('y')))
    return degrees
      ? 'Choose both the latitude and the longitude column.'
      : 'Choose the easting and the northing column.';
  if (!m.includes('z')) return 'Choose the height column.';
  return null;
}

const ROLE_WORDS: readonly [RegExp, GcpRole][] = [
  [/^(check|checkpoint|check point|cp|chk|ck|verification)$/i, 'check'],
  [/^(control|gcp|gc|control point|ctrl|c)$/i, 'control'],
];

export interface GcpImportOptions {
  /** The EPSG code of the file's coordinates (forced to 4326 for latitude and longitude). */
  epsg: number;
  accuracy: { horizontalM: number; verticalM: number };
  fileName: string;
  now: Date;
}

export interface GcpImport {
  file: GcpFile | null;
  warnings: string[];
  errors: string[];
}

/** The rows as ground control points in the file's CRS, ready for `photo:writeGcp`. */
export function toGcpFile(t: GcpTable, m: readonly Column[], o: GcpImportOptions): GcpImport {
  const warnings: string[] = [];
  const errors: string[] = [];
  const mapProblem = mappingProblem(m);
  if (mapProblem) return { file: null, warnings, errors: [mapProblem] };
  const col = (c: Column) => m.indexOf(c);
  const degrees = mapsDegrees(m);
  const epsg = degrees ? 4326 : o.epsg;
  if (degrees && o.epsg !== 4326)
    warnings.push('The coordinates are latitude and longitude, so the file is read as WGS 84.');
  let latI = col('lat');
  let lonI = col('lon');
  if (degrees) {
    const outside = (i: number, max: number) =>
      t.rows.every((r) => isNum(r[i]) && Math.abs(Number(r[i])) > max);
    if (outside(latI, 90) && !outside(lonI, 90)) {
      [latI, lonI] = [lonI, latI];
      warnings.push(
        'Latitude and longitude looked swapped (latitudes over 90); they were read the other way round.',
      );
    }
  }
  const header = t.header ? 2 : t.odm ? 2 : 1;
  const at = o.now.toISOString();
  const byId = new Map<string, GcpPoint>();
  let unnamed = 0;
  t.rows.forEach((r, i) => {
    const line = i + header;
    const num = (c: number, what: string): number | null => {
      const v = r[c];
      if (!isNum(v)) {
        errors.push(`Line ${String(line)}: the ${what} "${v ?? ''}" is not a number.`);
        return null;
      }
      return Number(v);
    };
    const xs = degrees
      ? [num(lonI, 'longitude'), num(latI, 'latitude')]
      : [num(col('x'), 'easting'), num(col('y'), 'northing')];
    const z = num(col('z'), 'height');
    const [x, y] = xs;
    if (x === null || x === undefined || y === null || y === undefined || z === null) return;
    if (degrees && (Math.abs(y) > 90 || Math.abs(x) > 180)) {
      errors.push(
        `Line ${String(line)}: ${String(y)}, ${String(x)} is not a latitude and longitude.`,
      );
      return;
    }
    let id = col('id') >= 0 ? (r[col('id')] ?? '').trim() : '';
    if (!id && t.odm) id = `${String(x)} ${String(y)} ${String(z)}`;
    if (!id) {
      unnamed++;
      id = `GCP${String(i + 1)}`;
    }
    id = id.slice(0, 64);
    const roleText = col('role') >= 0 ? (r[col('role')] ?? '').trim() : '';
    const role = ROLE_WORDS.find(([re]) => re.test(roleText))?.[1] ?? 'control';
    if (roleText && !ROLE_WORDS.some(([re]) => re.test(roleText)))
      warnings.push(`Line ${String(line)}: role "${roleText}" read as control.`);
    const acc = (c: Column, fallback: number) => {
      const v = col(c) >= 0 ? Number(r[col(c)]) : Number.NaN;
      return Number.isFinite(v) && v > 0 ? v : fallback;
    };
    const known = byId.get(id);
    if (known && !t.odm) {
      errors.push(`Line ${String(line)}: point "${id}" is listed twice.`);
      return;
    }
    const point: GcpPoint = known ?? {
      id,
      role,
      xyz: [x, y, z],
      accuracy: {
        horizontalM: acc('accH', o.accuracy.horizontalM),
        verticalM: acc('accV', o.accuracy.verticalM),
      },
      marks: [],
    };
    if (t.odm) {
      // an image observation: pixel x, pixel y, image name
      const px = Number(r[3]);
      const py = Number(r[4]);
      const photo = (r[5] ?? '').trim();
      if (photo && Number.isFinite(px) && Number.isFinite(py)) {
        const mark: GcpMark = { photo, px: [px, py], by: 'import', at, state: 'confirmed' };
        point.marks.push(mark);
      }
    }
    byId.set(id, point);
  });
  if (unnamed)
    warnings.push(
      `${String(unnamed)} ${unnamed === 1 ? 'point has' : 'points have'} no id; named by line.`,
    );
  const points = [...byId.values()];
  if (!points.length && !errors.length) errors.push('No points were found in the file.');
  if (points.length > 1000) errors.push('A GCP file holds at most 1000 points.');
  if (errors.length) return { file: null, warnings, errors };
  return {
    file: {
      schema: 'aio.gcp/1',
      crs: { epsg },
      importedFrom: o.fileName.replace(/^.*[\\/]/, '').slice(0, 260),
      points,
    },
    warnings,
    errors,
  };
}
