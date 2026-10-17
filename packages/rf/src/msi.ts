/**
 * MSI / Planet antenna pattern files (spec D11): `NAME`, `MAKE`, `FREQUENCY`, `GAIN`, `TILT`,
 * `HORIZONTAL 360`, `VERTICAL 360`, each cut as 360 lines of `angle attenuation` separated by
 * spaces, tabs or commas.
 *
 * Conventions assumed (the common Planet one), converted to the convention of pattern.ts:
 * - Values are attenuation in dB below the peak gain, >= 0.
 * - Horizontal angle in the file increases counter-clockwise seen from above, 0 at boresight.
 *   The engine measures clockwise, so internal[k] = file[(360 - k) mod 360].
 * - Vertical angle in the file is 0 at the horizon, 90 straight down, 270 straight up. That is
 *   already the engine convention, so the cut is kept as it is.
 * - A GAIN with no unit is dBd (the MSI default); dBd converts to dBi with +2.15.
 */

import { makeTwoCutPattern, type TwoCutPattern } from './pattern';

export const DBD_TO_DBI = 2.15;

export interface MsiPattern {
  name?: string;
  make?: string;
  frequencyMhz: number;
  gainDbi: number;
  /** Electrical tilt when the file gives a number; absent for the bare keyword. */
  etiltDeg?: number;
  /** 360 attenuations, clockwise from boresight (engine convention). */
  horizontalDb: number[];
  /** 360 attenuations below boresight: 90 down, 270 up. */
  verticalDb: number[];
}

const NUM = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const tokens = (line: string): string[] =>
  line
    .trim()
    .split(/[\s,]+/)
    .filter((t) => t !== '');

function readCut(lines: string[], start: number, name: string): { values: number[]; end: number } {
  const first = tokens(lines[start] ?? '');
  if (Number(first[1]) !== 360)
    throw new Error(
      `MSI: ${name} must say 360 (one value per degree), found "${(lines[start] ?? '').trim()}"`,
    );
  const values = new Array<number>(360).fill(Number.NaN);
  let i = start + 1;
  let got = 0;
  for (; i < lines.length && got < 360; i++) {
    const t = tokens(lines[i] ?? '');
    if (t.length === 0) continue;
    const [a, v] = t;
    if (t.length < 2 || a === undefined || v === undefined || !NUM.test(a) || !NUM.test(v)) break;
    const angle = Number(a);
    if (!Number.isInteger(angle) || angle < 0 || angle > 359)
      throw new Error(`MSI: ${name} angle "${a}" is not a whole degree from 0 to 359`);
    if (Number.isFinite(values[angle])) throw new Error(`MSI: ${name} angle ${a} appears twice`);
    values[angle] = Number(v);
    got++;
  }
  if (got !== 360) throw new Error(`MSI: ${name} has ${got} values, 360 needed`);
  return { values, end: i };
}

/** Parse an MSI / Planet file. Throws an Error in plain words when the file is unusable. */
export function parseMsi(text: string): MsiPattern {
  const lines = text.split(/\r?\n/);
  const head = new Map<string, string>();
  let horizontalFile: number[] | undefined;
  let verticalFile: number[] | undefined;
  for (let i = 0; i < lines.length;) {
    const raw = lines[i] ?? '';
    const t = tokens(raw);
    const key = (t[0] ?? '').toUpperCase();
    if (key === 'HORIZONTAL' || key === 'VERTICAL') {
      if ((key === 'HORIZONTAL' ? horizontalFile : verticalFile) !== undefined)
        throw new Error(`MSI: ${key} appears twice`);
      const cut = readCut(lines, i, key);
      if (key === 'HORIZONTAL') horizontalFile = cut.values;
      else verticalFile = cut.values;
      i = cut.end;
      continue;
    }
    if (key !== '' && !head.has(key))
      head.set(
        key,
        raw
          .trim()
          .slice((t[0] ?? '').length)
          .trim(),
      );
    i++;
  }
  if (!horizontalFile) throw new Error('MSI: the HORIZONTAL 360 cut is missing');
  if (!verticalFile) throw new Error('MSI: the VERTICAL 360 cut is missing');

  const freq = head.get('FREQUENCY');
  const frequencyMhz = freq === undefined ? Number.NaN : Number(tokens(freq)[0]);
  if (!(frequencyMhz > 0)) throw new Error('MSI: FREQUENCY (MHz) is missing or not a number');

  const gainText = head.get('GAIN');
  const gm = gainText === undefined ? null : /^([+-]?\d*\.?\d+)\s*(dBi|dBd)?/i.exec(gainText);
  if (!gm?.[1]) throw new Error('MSI: GAIN is missing or not a number');
  const gainDbi = Number(gm[1]) + ((gm[2] ?? 'dBd').toLowerCase() === 'dbi' ? 0 : DBD_TO_DBI);

  const tiltText = head.get('TILT') ?? head.get('ELECTRICAL_TILT');
  const tiltToken = tiltText === undefined ? undefined : tokens(tiltText).find((x) => NUM.test(x));
  const fileH = horizontalFile;
  const horizontalDb = fileH.map((_, k) => fileH[(360 - k) % 360] ?? Number.NaN);

  const out: MsiPattern = { frequencyMhz, gainDbi, horizontalDb, verticalDb: verticalFile };
  const name = head.get('NAME');
  const make = head.get('MAKE');
  if (name) out.name = name;
  if (make) out.make = make;
  if (tiltToken !== undefined) out.etiltDeg = Number(tiltToken);
  return out;
}

/** The engine two-cut pattern from a parsed file, capped at the front-to-back ratio. */
export function msiToTwoCut(p: MsiPattern, frontToBackDb: number): TwoCutPattern {
  return makeTwoCutPattern(p.horizontalDb, p.verticalDb, frontToBackDb);
}

interface Pickable {
  frequencyMhz: number;
  etiltDeg: number;
}

export interface PatternPick<T extends Pickable> {
  ref: T;
  /** True when the file e-tilt is not the one asked for (the UI says so). */
  etiltSnapped: boolean;
  /** File e-tilt minus the asked e-tilt, degrees. */
  etiltDeltaDeg: number;
}

/**
 * The pattern file for a frequency and e-tilt: nearest frequency first, then the nearest e-tilt
 * step among the files of that frequency. Ties go to the lower e-tilt.
 */
export function pickNearestPattern<T extends Pickable>(
  refs: readonly T[],
  frequencyMhz: number,
  etiltDeg: number,
): PatternPick<T> | undefined {
  if (refs.length === 0) return undefined;
  const bestF = Math.min(...refs.map((r) => Math.abs(r.frequencyMhz - frequencyMhz)));
  const sameF = refs.filter(
    (r) => Math.abs(Math.abs(r.frequencyMhz - frequencyMhz) - bestF) < 1e-9,
  );
  let best: T | undefined;
  for (const r of sameF) {
    if (!best) best = r;
    else {
      const d = Math.abs(r.etiltDeg - etiltDeg);
      const bd = Math.abs(best.etiltDeg - etiltDeg);
      if (d < bd - 1e-9 || (Math.abs(d - bd) < 1e-9 && r.etiltDeg < best.etiltDeg)) best = r;
    }
  }
  if (!best) return undefined;
  const delta = best.etiltDeg - etiltDeg;
  return { ref: best, etiltSnapped: Math.abs(delta) > 1e-9, etiltDeltaDeg: delta };
}
