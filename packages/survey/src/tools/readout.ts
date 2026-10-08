import type {
  ComparisonItem,
  ComparisonResult,
  MeasurementFamily,
  MeasurementTool,
  SitePoint,
  SurveyMeasurement,
  SurveyPrecision,
  SurveyUnits,
} from '@aio/schema';
import { formatNumber, formatQuantity, localeOf, type NumberLocale, type Quantity } from './format';
import { sampleProfile, type HeightSampler } from './geometry';
import { bermCheck, components, elevationDifference, lineMetrics, polygonAreas } from './measure';

/**
 * What each tool shows: readout rows in SI, ordered by the template's `items` when it names them.
 * The panel, the 3D and map labels and (G9) the reports format the same rows.
 */

export type ReadoutKind = Quantity | 'bearing' | 'count' | 'text';

export interface ReadoutRow {
  key: string;
  label: string;
  /** SI value (see `format.ts`), or null when it cannot be computed (no surface, no data). */
  value: number | null;
  kind: ReadoutKind;
  /** Why the value is missing, or a qualifier ("68 % covered"). */
  note?: string;
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
  area: ['area', 'terrain-area', 'slope-area', 'perimeter'],
  volume: ['cut', 'fill', 'net', 'total', 'area'],
  freehand: ['vertices'],
};

export interface ReadoutContext {
  /** The surface for terrain lengths, areas, berm profiles and elevation differences. */
  surface?: HeightSampler | undefined;
  /** Sample step, metres (default 0.25 for lines, 0.5 for areas). */
  stepM?: number | undefined;
}

type Geometry = Pick<SurveyMeasurement, 'tool' | 'points'> &
  Partial<Pick<SurveyMeasurement, 'results' | 'items'>>;

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
    const r = m.results?.[0];
    const stale = r?.status === 'stale' ? 'Stale, recompute' : undefined;
    out.push(row('cut', r ? r.cutM3 : null, 'volume', r ? stale : 'Not computed yet'));
    out.push(row('fill', r ? r.fillM3 : null, 'volume', r ? stale : 'Not computed yet'));
    out.push(row('net', r ? r.netM3 : null, 'volume', r ? stale : 'Not computed yet'));
    out.push(row('total', r ? r.totalM3 : null, 'volume', r ? stale : 'Not computed yet'));
    if (r) out.push(row('uncovered', r.uncoveredM2, 'area'));
  }
  return out;
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

/** Grid bearing as degrees, minutes and seconds: 045°30'00". */
export function formatBearing(deg: number): string {
  let total = Math.round((((deg % 360) + 360) % 360) * 3600);
  if (total >= 360 * 3600) total -= 360 * 3600;
  const d = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(d).padStart(3, '0')}°${String(m).padStart(2, '0')}'${String(s).padStart(2, '0')}"`;
}

/** One row as text in the measurement's units. */
export function formatRow(
  r: ReadoutRow,
  units: SurveyUnits,
  precision: SurveyPrecision,
  locale: NumberLocale = localeOf(units),
): string {
  if (r.value === null) return r.note ?? '-';
  let text: string;
  switch (r.kind) {
    case 'bearing':
      text = formatBearing(r.value);
      break;
    case 'count':
      text = String(r.value);
      break;
    case 'text':
      text = `${formatNumber(r.value, 2, locale)}°`;
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
