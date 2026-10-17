import type { AntennasFile, AntennaUnit, AntennaValue } from '@aio/schema';
import { trueAzimuth } from './antennaFormat';

/** The columns of the antenna inventory CSV, in order. */
export const CSV_COLUMNS: readonly string[] = [
  'id',
  'name',
  'kind',
  'kindBasis',
  'status',
  'azimuthTrueDeg',
  'azimuthGridDeg',
  'convergenceDeg',
  'azimuthBasis',
  'downtiltDeg',
  'downtiltBasis',
  'plumbDeg',
  'plumbBasis',
  'elevationDeg',
  'diameterM',
  'widthM',
  'heightM',
  'depthM',
  'depthBasis',
  'centreE',
  'centreN',
  'altitudeM',
  'residualMm',
  'support',
  'model',
  'weightKg',
  'frequencies',
  'active',
  'bestPhoto',
  'notFoundInLatest',
  'runId',
];

/** A number with at most `digits` decimals and no trailing zeros; empty when absent. */
const num = (v: number | undefined, digits: number): string =>
  v === undefined ? '' : String(Number(v.toFixed(digits)));
const deg = (v: AntennaValue | undefined): string => num(v?.value, 2);
const basis = (v: AntennaValue | undefined): string => v?.basis ?? '';

/** Quote a field when it holds a comma, quote or line break; double the quotes. */
function field(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Text a person typed: a leading =, +, - or @ would run as a formula in a spreadsheet. */
const typed = (text: string | undefined): string =>
  field(text !== undefined && /^[=+\-@\t\r]/.test(text) ? `'${text}` : (text ?? ''));

function row(u: AntennaUnit): string {
  const residual = (u.azimuthGridDeg ?? u.widthM).quality.residualM;
  const photo = u.photos[0];
  const cells = [
    field(u.id),
    typed(u.name),
    u.kind,
    u.kindBasis,
    u.status,
    u.azimuthGridDeg && u.convergenceDeg !== null
      ? num(trueAzimuth(u.azimuthGridDeg.value, u.convergenceDeg), 2)
      : '',
    deg(u.azimuthGridDeg),
    num(u.convergenceDeg ?? undefined, 4),
    basis(u.azimuthGridDeg),
    deg(u.downtiltDeg),
    basis(u.downtiltDeg),
    deg(u.plumbDeg),
    basis(u.plumbDeg),
    deg(u.elevationDeg),
    num(u.diameterM?.value, 3),
    num(u.widthM.value, 3),
    num(u.heightM.value, 3),
    num(u.depthM.value, 3),
    basis(u.depthM),
    num(u.box.centre[0], 3),
    num(u.box.centre[1], 3),
    num(u.box.centre[2], 3),
    num(residual === undefined ? undefined : residual * 1000, 1),
    String(u.support),
    typed(u.user.model),
    num(u.user.weightKg, 2),
    typed(u.user.frequencies),
    u.user.active === undefined ? '' : String(u.user.active),
    photo ? field(`${photo.layer}/${photo.id}`) : '',
    u.notFoundInLatest ? 'true' : '',
    field(u.runId),
  ];
  return cells.join(',');
}

/**
 * The inventory as CSV (RFC 4180, CRLF). Accepted units always; drafts when asked; rejected units
 * never. Azimuth in true north is empty when the project has no CRS (no convergence).
 */
export function antennasToCsv(file: AntennasFile, opts: { includeDrafts: boolean }): string {
  const units = file.units.filter(
    (u) => u.status === 'accepted' || (opts.includeDrafts && u.status === 'draft'),
  );
  return [CSV_COLUMNS.join(','), ...units.map(row)].join('\r\n') + '\r\n';
}
