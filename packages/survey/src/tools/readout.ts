import {
  DEFAULT_ANGLES,
  type AngleSettings,
  type ComparisonItem,
  type ComparisonResult,
  type MeasurementFamily,
  type MeasurementTool,
  type SitePoint,
  type SurveyMeasurement,
  type SurveyPrecision,
  type SurveyUnits,
} from '@aio/schema';
import { formatNumber, formatQuantity, localeOf, type NumberLocale, type Quantity } from '@aio/geo';
import { sampleProfile, type HeightSampler } from './geometry';
import { bermCheck, components, elevationDifference, lineMetrics, polygonAreas } from './measure';
import { antennaAzimuth, antennaTilt, clearance, isTelecomTool } from './telecom';
import { figureStatus, resultOn, type PileFigureStatus } from '../calc/figures';

/**
 * What each tool shows: readout rows in SI, ordered by the template's `items` when it names them.
 * The panel, the 3D and map labels and (G9) the reports format the same rows.
 */

export type ReadoutKind = Quantity | 'bearing' | 'angle' | 'count' | 'text';

export interface ReadoutRow {
  key: string;
  label: string;
  /** SI value (`@aio/geo` units), or null when it cannot be computed (no surface, no data). */
  value: number | null;
  kind: ReadoutKind;
  /** Why the value is missing, or a qualifier ("68 % covered"). */
  note?: string;
  /** A volume row's figure status (cut, fill, net, total), when there is a figure. */
  status?: PileFigureStatus;
}

/** Which family each tool belongs to. */
export const TOOL_FAMILY: Record<MeasurementTool, MeasurementFamily> = {
  elevation: 'point',
  'elevation-difference': 'point',
  'elevation-history': 'point',
  annotation: 'point',
  distance: 'line',
  grade: 'line',
  'vertex-table': 'line',
  'berm-check': 'line',
  section: 'line',
  azimuth: 'line',
  'antenna-tilt': 'line',
  clearance: 'line',
  area: 'polygon',
  volume: 'polygon',
  freehand: 'markup',
};

export const TOOL_LABELS: Record<MeasurementTool, string> = {
  elevation: 'Elevation',
  'elevation-difference': 'Elevation difference',
  'elevation-history': 'Elevation history',
  annotation: 'Annotation',
  distance: 'Distance',
  grade: 'Grade and slope',
  'vertex-table': 'Vertex differences',
  'berm-check': 'Berm check',
  section: 'Cross-section',
  azimuth: 'Azimuth',
  'antenna-tilt': 'Antenna tilt',
  clearance: 'Clearance',
  area: 'Area',
  volume: 'Volume',
  freehand: 'Freehand markup',
};

export const FAMILY_LABELS: Record<MeasurementFamily, string> = {
  point: 'Point',
  line: 'Line',
  polygon: 'Polygon',
  markup: 'Markup',
};

/** The fewest vertices a tool's geometry needs. */
export const MIN_POINTS: Record<MeasurementFamily, number> = {
  point: 1,
  line: 2,
  polygon: 3,
  markup: 2,
};

/** Result rows a template can list, by key, with their labels. */
export const ITEM_LABELS: Record<string, string> = {
  e: 'Easting',
  n: 'Northing',
  z: 'Elevation',
  'surface-z': 'Surface elevation',
  dz: 'Height above surface',
  horizontal: 'Horizontal length',
  'slope-length': 'Slope length',
  'terrain-length': 'Terrain length',
  'height-change': 'Height change',
  grade: 'Grade',
  'max-grade': 'Steepest segment',
  bearing: 'Bearing',
  'vertical-angle': 'Vertical angle',
  'crest-z': 'Crest elevation',
  'crest-width': 'Crest width',
  'base-width': 'Base width',
  'height-left': 'Height (left toe)',
  'height-right': 'Height (right toe)',
  area: 'Horizontal area',
  'terrain-area': 'Terrain area',
  'slope-area': 'Slope area',
  perimeter: 'Perimeter',
  cut: 'Cut',
  fill: 'Fill',
  net: 'Net',
  total: 'Total moved',
  uncovered: 'Not covered',
  vertices: 'Vertices',
  azimuth: 'Azimuth from project/grid north (clockwise)',
  inclination: 'Physical inclination from vertical',
  'direct-gap': 'Direct 3D distance',
  'horizontal-gap': 'Horizontal separation',
  'vertical-gap': 'Absolute vertical gap',
};

/** The rows each tool shows when its template does not choose. */
export const DEFAULT_ITEMS: Record<MeasurementTool, string[]> = {
  elevation: ['n', 'e', 'z'],
  'elevation-difference': ['z', 'surface-z', 'dz'],
  'elevation-history': ['n', 'e', 'z'],
  annotation: ['n', 'e', 'z'],
  distance: ['horizontal', 'slope-length', 'terrain-length', 'height-change'],
  grade: ['grade', 'max-grade', 'height-change', 'horizontal'],
  'vertex-table': ['horizontal', 'slope-length', 'height-change', 'vertices'],
  'berm-check': ['crest-z', 'crest-width', 'base-width', 'height-left', 'height-right'],
  section: ['horizontal', 'bearing'],
  azimuth: ['azimuth'],
  'antenna-tilt': ['inclination'],
  clearance: ['direct-gap', 'horizontal-gap', 'vertical-gap'],
  area: ['area', 'terrain-area', 'slope-area', 'perimeter'],
  volume: ['cut', 'fill', 'net', 'total', 'area'],
  freehand: ['vertices'],
};

export interface ReadoutContext {
  /** The surface for terrain lengths, areas, berm profiles and elevation differences. */
  surface?: HeightSampler | undefined;
  /** Sample step, metres (default 0.25 for lines, 0.5 for areas). */
  stepM?: number | undefined;
  /**
   * The survey date whose volume figures to show (`resultOn`): the stored result when it is that
   * date's, else the per-date row. Without it, the stored result whatever its date.
   */
  capture?: string | undefined;
}

/**
 * The one row the card, tree, labels and island show for each tool. Points show elevation,
 * lines their slope length, polygons the plan area, volumes the net; the rest their first row.
 */
export const PRIMARY_KEY: Record<MeasurementTool, string> = {
  elevation: 'z',
  'elevation-difference': 'z',
  'elevation-history': 'z',
  annotation: 'z',
  distance: 'slope-length',
  grade: 'grade',
  'vertex-table': 'slope-length',
  'berm-check': 'crest-z',
  section: 'slope-length',
  azimuth: 'azimuth',
  'antenna-tilt': 'inclination',
  clearance: 'direct-gap',
  area: 'area',
  volume: 'net',
  freehand: 'vertices',
};

/** The compact second line under the primary value (at most three). */
export const SECONDARY_KEYS: Record<MeasurementTool, readonly string[]> = {
  elevation: ['n', 'e'],
  'elevation-difference': ['surface-z', 'dz'],
  'elevation-history': ['n', 'e'],
  annotation: ['n', 'e'],
  distance: ['horizontal', 'height-change', 'grade'],
  grade: ['max-grade', 'height-change', 'horizontal'],
  'vertex-table': ['horizontal', 'height-change', 'vertices'],
  'berm-check': ['crest-width', 'base-width', 'height-left'],
  section: ['horizontal', 'bearing'],
  azimuth: [],
  'antenna-tilt': [],
  clearance: ['horizontal-gap', 'vertical-gap'],
  area: ['perimeter', 'terrain-area'],
  volume: ['cut', 'fill', 'area'],
  freehand: [],
};

type Geometry = Pick<SurveyMeasurement, 'tool' | 'points'> &
  Partial<Pick<SurveyMeasurement, 'results' | 'items' | 'series'>>;

const row = (key: string, value: number | null, kind: ReadoutKind, note?: string): ReadoutRow => ({
  key,
  label: ITEM_LABELS[key] ?? key,
  value,
  kind,
  ...(note ? { note } : {}),
});

const NO_SURFACE = 'No surface under it';

/** Every row a measurement can show, computed from its geometry (and stored results). */
export function allRows(m: Geometry, ctx: ReadoutContext = {}): ReadoutRow[] {
  const pts: readonly SitePoint[] = m.points;
  const family = TOOL_FAMILY[m.tool];
  const out: ReadoutRow[] = [row('vertices', pts.length, 'count')];
  const first = pts[0];
  if (isTelecomTool(m.tool)) {
    if (m.tool === 'azimuth') {
      const a = antennaAzimuth(pts);
      out.push(row('azimuth', a.ok ? a.bearingDeg : null, 'angle', a.ok ? undefined : a.message));
    } else if (m.tool === 'antenna-tilt') {
      const a = antennaTilt(pts);
      out.push(row('inclination', a.ok ? a.angleDeg : null, 'angle', a.ok ? undefined : a.message));
    } else {
      const gap = clearance(pts);
      for (const [key, value] of [
        ['direct-gap', gap.ok ? gap.directM : null],
        ['horizontal-gap', gap.ok ? gap.horizontalM : null],
        ['vertical-gap', gap.ok ? gap.verticalM : null],
      ] as const)
        out.push(row(key, value, 'distance', gap.ok ? undefined : gap.message));
    }
    return out;
  }
  if (family === 'point' && first) {
    out.push(row('e', first[0], 'coordinate'), row('n', first[1], 'coordinate'));
    out.push(row('z', first[2], 'coordinate'));
    if (ctx.surface) {
      const d = elevationDifference(first, ctx.surface);
      out.push(
        row('surface-z', d.surfaceZ, 'coordinate', d.surfaceZ === null ? NO_SURFACE : undefined),
      );
      out.push(row('dz', d.dz, 'distance', d.dz === null ? NO_SURFACE : undefined));
    } else {
      out.push(row('surface-z', null, 'coordinate', 'Choose a surface'));
      out.push(row('dz', null, 'distance', 'Choose a surface'));
    }
  }
  if ((family === 'line' || family === 'markup') && pts.length > 1) {
    const l = lineMetrics(pts, ctx.surface, ctx.stepM ?? 0.25);
    const c = components(pts);
    out.push(row('horizontal', l.horizontalM, 'distance'));
    out.push(row('slope-length', l.slopeM, 'distance'));
    const covered =
      l.terrainM !== null && l.terrainCoverage < 0.999
        ? `${String(Math.round(l.terrainCoverage * 100))} % covered`
        : undefined;
    out.push(
      row('terrain-length', l.terrainM, 'distance', l.terrainM === null ? NO_SURFACE : covered),
    );
    out.push(row('height-change', l.dzM, 'distance'));
    out.push(row('grade', Number.isFinite(l.grade) ? l.grade : null, 'grade'));
    out.push(row('max-grade', Number.isFinite(l.maxGrade) ? l.maxGrade : null, 'grade'));
    out.push(row('bearing', c.bearingDeg, 'bearing'));
    out.push(row('vertical-angle', c.angleDeg, 'text'));
    if (m.tool === 'berm-check') {
      const profile = ctx.surface
        ? sampleProfile(pts, ctx.surface, ctx.stepM ?? 0.05)
        : profileOfVertices(pts);
      const b = bermCheck(profile);
      const why = b ? undefined : 'No berm along the line';
      out.push(row('crest-z', b?.crestZ ?? null, 'coordinate', why));
      out.push(row('crest-width', b?.crestWidthM ?? null, 'distance', why));
      out.push(row('base-width', b?.baseWidthM ?? null, 'distance', why));
      out.push(row('height-left', b?.left.heightM ?? null, 'distance', why));
      out.push(row('height-right', b?.right.heightM ?? null, 'distance', why));
    }
  }
  if (family === 'polygon' && pts.length > 2) {
    const a = polygonAreas(pts, ctx.surface, ctx.stepM ?? 0.5);
    out.push(row('area', a.horizontalM2, 'area'));
    out.push(
      row('terrain-area', a.terrainM2, 'area', a.terrainM2 === null ? NO_SURFACE : undefined),
    );
    out.push(row('slope-area', a.slopeM2, 'area'));
    out.push(row('perimeter', a.perimeterM, 'distance'));
    out.push(...volumeRows(m, ctx.capture));
  }
  return out;
}

const VOLUME_KEYS = new Set(['cut', 'fill', 'net', 'total']);

/**
 * The volume rows (cut, fill, net, total, uncovered) of the stored result, or of the figure on
 * `capture`. A figure never shows without its status: a stale one says so on every row, a refused
 * one shows its refusal instead of numbers, and the headline (net) of a carried or partial one
 * names it.
 */
function volumeRows(m: Geometry, capture: string | undefined): ReadoutRow[] {
  const r = capture !== undefined ? resultOn(m, capture) : (m.results?.[0] ?? null);
  if (!r) {
    const why = capture !== undefined ? 'No figure for this date' : 'Not computed yet';
    return ['cut', 'fill', 'net', 'total'].map((k) => row(k, null, 'volume', why));
  }
  const status = figureStatus(r);
  const withStatus = (x: ReadoutRow): ReadoutRow => ({ ...x, status });
  if (status === 'refused') {
    const why = `Not computed: ${r.reason ?? 'the survey does not cover it'}`;
    return ['cut', 'fill', 'net', 'total'].map((k) => withStatus(row(k, null, 'volume', why)));
  }
  const all = status === 'stale' ? 'Stale, recompute' : undefined;
  const headline =
    status === 'carried'
      ? 'From an earlier version'
      : status === 'partial'
        ? r.reason
          ? `Partly outside the survey: ${r.reason}`
          : 'Partly outside the survey'
        : all;
  return [
    withStatus(row('cut', r.cutM3, 'volume', all)),
    withStatus(row('fill', r.fillM3, 'volume', all)),
    withStatus(row('net', r.netM3, 'volume', headline)),
    withStatus(row('total', r.totalM3, 'volume', all)),
    row('uncovered', r.uncoveredM2, 'area'),
  ];
}

/** The vertices' own heights as a profile (a berm drawn by clicking on the crest and toes). */
function profileOfVertices(pts: readonly SitePoint[]) {
  const chainage: number[] = [];
  const z: number[] = [];
  let c = 0;
  pts.forEach((p, i) => {
    const prev = pts[i - 1];
    if (prev) c += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    chainage.push(c);
    z.push(p[2]);
  });
  return { chainage, z };
}

/** The rows to show, in the template's order (or the tool's default order). */
export function measurementReadout(
  m: Geometry,
  ctx: ReadoutContext = {},
  items?: readonly string[],
): ReadoutRow[] {
  const rows = allRows(m, ctx);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const wanted = items && items.length > 0 ? items : DEFAULT_ITEMS[m.tool];
  return wanted.map((k) => byKey.get(k)).filter((r): r is ReadoutRow => r !== undefined);
}

/**
 * The row to headline: the tool's primary key, or when that has no value (or the template
 * leaves it out) the first row of the template's items that has one. Null when none has.
 */
export function primaryRow(
  m: Geometry,
  ctx: ReadoutContext = {},
  items?: readonly string[],
): ReadoutRow | null {
  const rows = allRows(m, ctx);
  const key = PRIMARY_KEY[m.tool];
  const order = items && items.length > 0 ? items : DEFAULT_ITEMS[m.tool];
  if (!items || items.length === 0 || items.includes(key)) {
    const r = rows.find((x) => x.key === key);
    if (r && r.value !== null) return r;
    // a refused figure, or no figure on the date asked for, is the headline: never another row
    // standing in for the volume
    if (r && VOLUME_KEYS.has(key) && (r.status === 'refused' || ctx.capture !== undefined))
      return r;
  }
  for (const k of order) {
    const r = rows.find((x) => x.key === k);
    if (r && r.value !== null) return r;
  }
  return null;
}

/** The compact line's rows: the tool's secondary keys that have a value. */
export function secondaryRows(m: Geometry, ctx: ReadoutContext = {}): ReadoutRow[] {
  const rows = allRows(m, ctx);
  return SECONDARY_KEYS[m.tool]
    .map((k) => rows.find((x) => x.key === k))
    .filter((r): r is ReadoutRow => r !== undefined && r.value !== null);
}

/** Grid bearing as degrees, minutes and seconds: 045°30'00". */
export function formatBearing(deg: number): string {
  let total = Math.round((((deg % 360) + 360) % 360) * 3600);
  if (total >= 360 * 3600) total -= 360 * 3600;
  const d = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(d).padStart(3, '0')}°${String(m).padStart(2, '0')}'${String(s).padStart(2, '0')}"`;
}

/** An angle in the site's angle unit: 15.20° or 15°12'00" (seconds round, no decimals). */
export function formatAngle(
  deg: number,
  a: AngleSettings,
  locale: NumberLocale = 'metric',
): string {
  if (a.angle === 'dms') {
    const sign = deg < 0 ? '-' : '';
    const total = Math.round(Math.abs(deg) * 3600);
    const d = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${sign}${String(d)}°${String(m).padStart(2, '0')}'${String(s).padStart(2, '0')}"`;
  }
  return `${formatNumber(deg, a.precision, locale)}°`;
}

/** A bearing in the site's bearing unit: 045°30'00" or 045.50°. */
export function formatBearingAs(
  deg: number,
  a: AngleSettings,
  locale: NumberLocale = 'metric',
): string {
  if (a.bearing === 'dms') return formatBearing(deg);
  const step = 10 ** a.precision;
  const rounded = Math.round((((deg % 360) + 360) % 360) * step) / step;
  const wrapped = rounded >= 360 ? 0 : rounded;
  const text = formatNumber(wrapped, a.precision, locale);
  const whole = (text.split('.')[0] ?? text).length;
  return `${'0'.repeat(Math.max(0, 3 - whole))}${text}°`;
}

/** One row as text in the measurement's units. */
export function formatRow(
  r: ReadoutRow,
  units: SurveyUnits,
  precision: SurveyPrecision,
  locale: NumberLocale = localeOf(units.distance),
  angles: AngleSettings = DEFAULT_ANGLES,
): string {
  if (r.value === null) return r.note ?? '-';
  let text: string;
  switch (r.kind) {
    case 'bearing':
      text = formatBearingAs(r.value, angles, locale);
      break;
    case 'count':
      text = String(r.value);
      break;
    case 'angle':
    case 'text':
      text = formatAngle(r.value, angles, locale);
      break;
    default:
      text = formatQuantity(r.value, r.kind, units, precision, locale);
  }
  return r.note ? `${text} (${r.note})` : text;
}

/**
 * Volumes come from the survey engine (G2) through this seam; the UI wires it to the engine's
 * worker when it lands, and G4 builds the comparison UI on it. The tools never compute volumes.
 */
export interface ComparisonRunner {
  run(ring: readonly SitePoint[], item: ComparisonItem): Promise<ComparisonResult>;
}
