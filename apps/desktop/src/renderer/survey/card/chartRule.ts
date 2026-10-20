import type { SurveyMeasurement } from '@aio/schema';

/**
 * The tools whose card draws a chart (spec W2, the chart slot): lines a profile, points their
 * elevation over time, volumes their volume over time. Area, azimuth, tilt, clearance and
 * freehand draw none. The one rule for the card, its PNG export and its report entry.
 */
const CHART_TOOLS: ReadonlySet<SurveyMeasurement['tool']> = new Set([
  'elevation',
  'elevation-difference',
  'elevation-history',
  'annotation',
  'distance',
  'grade',
  'vertex-table',
  'berm-check',
  'section',
  'volume',
]);

/** Whether a measurement's card draws a chart (so it exports a PNG and reports its chart). */
export function measurementHasChart(m: Pick<SurveyMeasurement, 'tool'>): boolean {
  return CHART_TOOLS.has(m.tool);
}
