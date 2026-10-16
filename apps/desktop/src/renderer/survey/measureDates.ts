/**
 * Which survey measurements a view draws. A view is the 3D view or the map, or one side of a
 * split that shows one survey date: each reads the survey dates on its own screen.
 */
import type { SurveyMeasurement } from '@aio/schema';
import { scopeOnScreen, type Workspace } from '@aio/workspace';
import type { MeasureState } from './measureStore';

/** What decides which survey dates are on screen: the capture index and the layer switches. */
export type DatesOnScreen = Pick<Workspace, 'dates' | 'hidden'>;

/**
 * The measurements a view draws: the site-wide ones, and a survey's own while that survey is on
 * screen there (hide the date's layers and its measurements go with them; a side of a split that
 * shows another date leaves them to the side that shows theirs). The one being edited stays.
 */
export function measurementsOn(
  s: Pick<MeasureState, 'file' | 'editing' | 'focus' | 'measurementsVisible'>,
  ws: DatesOnScreen,
): SurveyMeasurement[] {
  if (!s.measurementsVisible) return [];
  return s.file.measurements.filter(
    (m) => (s.editing !== null && m.id === s.focus) || scopeOnScreen(m.scope, ws.dates, ws.hidden),
  );
}
