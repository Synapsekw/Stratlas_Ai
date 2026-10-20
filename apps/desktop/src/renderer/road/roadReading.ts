/**
 * The road map measure on the survey tools' maths (volumetric parity W2): the points clicked on
 * the map become a transient `distance` or `area` measurement, and `lineMetrics`, `polygonAreas`,
 * `primaryRow` and `formatRow` read it, so a road reading is worded and rounded the way a saved
 * measurement is. Pure: no store.
 */
import type { MapLngLat } from '@aio/maps';
import type { SitePoint, SurveyMeasurement, SurveySettings } from '@aio/schema';
import { formatRow, primaryRow } from '@aio/survey';
import { t } from '@aio/ui';
import { cardModel, type CardModel } from '../survey/card/cardModel';
import type { MeasureMode } from './store';

const A = 6_378_137;
const E2 = 0.006_694_379_990_14;
const RAD = Math.PI / 180;

/**
 * Metres east and north of the first point (a local tangent plane on the WGS84 ellipsoid; the map
 * gives longitude and latitude, and a road measure spans a few kilometres at most).
 */
function tangentPlane(vertices: readonly MapLngLat[]): (p: MapLngLat) => SitePoint {
  const [lon0, lat0] = vertices[0] ?? [0, 0];
  const s = Math.sin(lat0 * RAD);
  const w = Math.sqrt(1 - E2 * s * s);
  const n = A / w;
  const m = (A * (1 - E2)) / (w * w * w);
  return ([lon, lat]) => [(lon - lon0) * RAD * n * Math.cos(lat0 * RAD), (lat - lat0) * RAD * m, 0];
}

/** The tool a road measure mode saves as. */
export const ROAD_TOOL = { line: 'distance', polygon: 'area' } as const;

/** The measurement for the clicked points; `toPoint` places each in the project frame. */
export function roadMeasurement(
  mode: MeasureMode,
  vertices: readonly MapLngLat[],
  toPoint: (p: MapLngLat) => SitePoint = tangentPlane(vertices),
  id = 'road-live',
): SurveyMeasurement {
  return {
    id,
    family: mode === 'line' ? 'line' : 'polygon',
    tool: ROAD_TOOL[mode],
    label: t(mode === 'line' ? 'road.measure.distance' : 'road.measure.area'),
    scope: { kind: 'site' },
    points: vertices.map(toPoint),
    items: [],
    results: [],
    createdAt: new Date(0).toISOString(),
  };
}

const enough = (mode: MeasureMode, n: number) => n >= (mode === 'line' ? 2 : 3);

/** The live card's model, or null with too few points. A road has no heights: plan figures only. */
export function roadCardModel(
  mode: MeasureMode,
  vertices: readonly MapLngLat[],
  settings: SurveySettings,
): CardModel | null {
  if (!enough(mode, vertices.length)) return null;
  const m = roadMeasurement(mode, vertices);
  const model = cardModel(m, { settings, templates: [], captures: [] });
  if (mode === 'polygon') return model;
  // a flat line: the horizontal length is the figure, the slope rows would repeat it
  const row = primaryRow(m, {}, ['horizontal']);
  return {
    ...model,
    primary: row
      ? {
          label: row.label,
          text: formatRow(row, settings.units, settings.precision, undefined, settings.angles),
        }
      : null,
    secondary: '',
  };
}

/**
 * The reading of the current measure as the survey tools word it: the headline value, and the
 * compact line under it ("" when there is none). Null with too few points.
 */
export function roadReading(
  mode: MeasureMode,
  vertices: readonly MapLngLat[],
  settings: SurveySettings,
): { primary: string; secondary: string } | null {
  const model = roadCardModel(mode, vertices, settings);
  if (!model?.primary) return null;
  return { primary: model.primary.text, secondary: model.secondary };
}
