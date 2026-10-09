/**
 * **Compute from point pairs** (M11 G1 gap): the rows a person types or imports from a CSV, each a
 * global position (WGS84 latitude, longitude and ellipsoidal height, or grid N, E, Z in the site's
 * base projection) beside the same point's local N, E, Z, with whether it holds the horizontal
 * (H) and the vertical (V) adjustment. `pairsRequest` turns them into `geo.calibration`'s
 * `pairs`; the pipeline solves the model by least squares and reports the residuals.
 */
import type { CalibrationPair } from '@aio/schema';

/** What the global columns of the table hold. */
export type PairGlobal = 'wgs84' | 'grid';

/** One row as typed: text fields so a half-typed number stays as it is. */
export interface PairRow {
  name: string;
  /** Latitude or grid N. */
  a: string;
  /** Longitude or grid E. */
  b: string;
  /** Ellipsoidal height or grid Z. */
  c: string;
  localN: string;
  localE: string;
  localZ: string;
  useH: boolean;
  useV: boolean;
}

export const emptyRow = (n: number): PairRow => ({
  name: `P${String(n)}`,
  a: '',
  b: '',
  c: '',
  localN: '',
  localE: '',
  localZ: '',
  useH: true,
  useV: true,
});

/** The column titles of the global position. */
export function globalColumns(kind: PairGlobal): [string, string, string] {
  return kind === 'wgs84'
    ? ['Latitude', 'Longitude', 'Height (ellipsoid)']
    : ['Grid N', 'Grid E', 'Grid Z'];
}

const YES = new Set(['1', 'y', 'yes', 'true', 'x']);
const NO = new Set(['0', 'n', 'no', 'false', '-']);

/** A H or V column: true, false, null when empty (the default, used), 'bad' otherwise. */
function flag(text: string | undefined): boolean | null | 'bad' {
  const t = (text ?? '').trim().toLowerCase();
  if (t === '') return null;
  if (YES.has(t)) return true;
  if (NO.has(t)) return false;
  return 'bad';
}

function splitLine(line: string): string[] {
  const sep = line.includes('\t') ? '\t' : line.includes(';') && !line.includes(',') ? ';' : ',';
  return line.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
}

const isNum = (s: string | undefined) => s !== undefined && s !== '' && Number.isFinite(Number(s));

/**
 * Rows from a CSV: `name, N or latitude, E or longitude, Z or height, local N, local E, local Z`
 * and optionally `H` and `V` (1 or 0, yes or no). A header line is skipped; a header naming
 * `lat` or `latitude` sets the global columns to WGS84, `grid` or `northing` to grid.
 */
export function parsePairsCsv(text: string): {
  rows: PairRow[];
  kind: PairGlobal | null;
  error: string | null;
} {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const rows: PairRow[] = [];
  let kind: PairGlobal | null = null;
  for (const [i, line] of lines.entries()) {
    const c = splitLine(line);
    const coords = c.slice(1, 7);
    if (i === 0 && !coords.every(isNum)) {
      const head = line.toLowerCase();
      if (/\blat(itude)?\b/.test(head)) kind = 'wgs84';
      else if (/\b(grid|northing)\b/.test(head)) kind = 'grid';
      continue;
    }
    if (c.length < 7 || !coords.every(isNum)) {
      return {
        rows: [],
        kind,
        error: `Line ${String(i + 1)}: a pair is a name and six numbers (global N or latitude, E or longitude, Z or height, then local N, E, Z).`,
      };
    }
    const h = flag(c[7]);
    const v = flag(c[8]);
    if (h === 'bad' || v === 'bad') {
      return {
        rows: [],
        kind,
        error: `Line ${String(i + 1)}: H and V are 1 or 0 (yes or no).`,
      };
    }
    rows.push({
      name: (c[0] ?? '').slice(0, 120) || `P${String(rows.length + 1)}`,
      a: coords[0] ?? '',
      b: coords[1] ?? '',
      c: coords[2] ?? '',
      localN: coords[3] ?? '',
      localE: coords[4] ?? '',
      localZ: coords[5] ?? '',
      useH: h ?? true,
      useV: v ?? true,
    });
  }
  if (rows.length > 500) return { rows: [], kind, error: 'A calibration has at most 500 pairs.' };
  return { rows, kind, error: null };
}

/** The `pairs` of a `geo.calibration` job, or the first thing to fix. */
export function pairsRequest(
  rows: readonly PairRow[],
  kind: PairGlobal,
): { ok: true; pairs: CalibrationPair[] } | { ok: false; error: string } {
  if (rows.length === 0) return { ok: false, error: 'Add point pairs first.' };
  if (rows.length > 500) return { ok: false, error: 'A calibration has at most 500 pairs.' };
  const names = new Set<string>();
  const pairs: CalibrationPair[] = [];
  for (const [i, r] of rows.entries()) {
    const name = r.name.trim() || `P${String(i + 1)}`;
    if (names.has(name)) return { ok: false, error: `Two pairs are called ${name}.` };
    names.add(name);
    const nums = [r.a, r.b, r.c, r.localN, r.localE, r.localZ].map((s) =>
      s.trim() === '' ? Number.NaN : Number(s),
    );
    if (!nums.every(Number.isFinite))
      return { ok: false, error: `${name}: every coordinate needs a number.` };
    const [a = 0, b = 0, c = 0, ln = 0, le = 0, lz = 0] = nums;
    if (kind === 'wgs84' && (Math.abs(a) > 90 || Math.abs(b) > 180))
      return { ok: false, error: `${name}: latitude is -90 to 90 and longitude -180 to 180.` };
    pairs.push({
      name: name.slice(0, 120),
      local: [ln, le, lz],
      ...(kind === 'wgs84' ? { wgs84: [a, b, c] } : { grid: [a, b, c] }),
      useH: r.useH,
      useV: r.useV,
    });
  }
  const h = pairs.filter((p) => p.useH).length;
  const v = pairs.filter((p) => p.useV).length;
  if (h === 0 && v === 0)
    return { ok: false, error: 'Use at least one pair for the horizontal or the vertical.' };
  if (h === 1)
    return {
      ok: false,
      error: 'The horizontal adjustment needs two or more pairs (or none: clear H everywhere).',
    };
  return { ok: true, pairs };
}

/** The rows of a calibration's pairs, for editing them again (a draft computed from pairs). */
export function rowsOfPairs(pairs: readonly CalibrationPair[]): {
  rows: PairRow[];
  kind: PairGlobal;
} {
  const kind: PairGlobal = pairs.some((p) => p.wgs84) ? 'wgs84' : 'grid';
  const s = (v: number | undefined) => (v === undefined ? '' : String(v));
  return {
    kind,
    rows: pairs.map((p) => {
      const g = kind === 'wgs84' ? p.wgs84 : p.grid;
      return {
        name: p.name,
        a: s(g?.[0]),
        b: s(g?.[1]),
        c: s(g?.[2]),
        localN: s(p.local[0]),
        localE: s(p.local[1]),
        localZ: s(p.local[2]),
        useH: p.useH,
        useV: p.useV,
      };
    }),
  };
}
