/**
 * Which survey measurements a view draws. A view is the 3D view or the map, or one side of a
 * split that shows one survey date: each reads the survey dates on its own screen.
 */
import {
  shiftEN,
  type DateShift,
  type MeasurementScope,
  type ProjectManifest,
  type SitePoint,
  type SurveyMeasurement,
} from '@aio/schema';
import { captureShift, scopeOnScreen, type Workspace } from '@aio/workspace';
import type { MeasureState } from './measureStore';

/** What decides which survey dates are on screen: the capture index and the layer switches. */
export type DatesOnScreen = Pick<Workspace, 'dates' | 'hidden'>;

/**
 * The measurements a view draws: the site-wide ones, and a survey's own while that survey is on
 * screen there (hide the date's layers and its measurements go with them; a side of a split that
 * shows another date leaves them to the side that shows theirs). The one being edited stays.
 */
export function measurementsOn(
  s: Pick<MeasureState, 'file' | 'editing' | 'focus' | 'measurementsVisible'> &
    Partial<Pick<MeasureState, 'hiddenMeasurements'>>,
  ws: DatesOnScreen,
): SurveyMeasurement[] {
  if (!s.measurementsVisible) return [];
  // a measurement hidden by its own eye stays hidden, unless it is the one being edited
  const off = new Set(s.hiddenMeasurements ?? []);
  return s.file.measurements.filter(
    (m) =>
      (s.editing !== null && m.id === s.focus) ||
      (!off.has(m.id) && scopeOnScreen(m.scope, ws.dates, ws.hidden)),
  );
}

type Dated = Pick<ProjectManifest, 'captures' | 'layers'>;

/**
 * The date shift a measurement's scope carries: that of its survey date. Site-wide measurements
 * (and a project with no open manifest) never move.
 */
export function scopeShift(scope: MeasurementScope, manifest: Dated | null): DateShift | null {
  return scope.kind === 'survey' && manifest ? captureShift(manifest, scope.capture) : null;
}

/** A measurement's points where they are drawn: the date's shift added to the stored ones. */
export function drawnPoints(
  m: Pick<SurveyMeasurement, 'points' | 'scope'>,
  manifest: Dated | null,
): SitePoint[] {
  const s = scopeShift(m.scope, manifest);
  return s ? m.points.map((p) => shiftEN(p, s)) : [...m.points];
}

/** Drawn points back to what is saved for a scope: the date's shift subtracted. */
export function storedPoints(
  drawn: readonly SitePoint[],
  scope: MeasurementScope,
  manifest: Dated | null,
): SitePoint[] {
  const s = scopeShift(scope, manifest);
  return s ? drawn.map((p) => shiftEN(p, s, -1)) : [...drawn];
}
