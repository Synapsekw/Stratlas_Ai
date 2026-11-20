/**
 * Which pile the main 3D view draws as the glass box, on which survey date, with which outline
 * and how its top is coloured (`pileLookScene` draws what this says). Pure, so the rule is tested
 * without a scene.
 *
 * Two cases. The opened pile: the focused pile while it is on screen, on the date in focus, in
 * the mode the person chose. A pinned pile (`pileLookState.pinned`, the report's pictures): that
 * pile on that date, whatever is focused, selected or on screen, always Solid.
 */
import type { ProjectManifest, SitePoint, SurveyMeasurement } from '@aio/schema';
import { drawnPoints, measurementsOn, type DatesOnScreen } from '../measureDates';
import { editedOutline } from '../measureMove';
import { captureInFocus } from '../measureRows';
import type { MeasureState } from '../measureStore';
import { isPile } from './openPile';
import type { PileSurfaceMode } from './pileLook';
import type { PinnedPile } from './pileLookState';

type Dated = Pick<ProjectManifest, 'captures' | 'layers' | 'origin'>;

export interface LookTarget {
  m: SurveyMeasurement;
  /** The date whose surface the pile is sampled on; null when there is none to name. */
  capture: string | null;
  /** The pile's boundary as drawn on that date. */
  ring: SitePoint[];
  mode: PileSurfaceMode;
  /** Drawn for the report: no cut and fill colours, no legend. */
  pinned: boolean;
}

/**
 * A pile's boundary as drawn on a survey date: that date's own outline when the pile has one,
 * else its stored points, moved by the shift of the date the pile is filed under.
 */
export function outlineOn(
  m: Pick<SurveyMeasurement, 'points' | 'outlines' | 'scope'>,
  capture: string | null,
  manifest: Dated | null,
): SitePoint[] {
  return drawnPoints({ scope: m.scope, points: [...editedOutline(m, capture)] }, manifest);
}

/**
 * The pile the box is for, or null for none.
 *
 * `focus` is the survey date in focus (the timeline's), `mode` the person's Solid or Height
 * choice. A pinned pile must still be a pile and must not be under edit; a pin that cannot be
 * drawn gives null, never the opened pile in its place.
 */
export function lookTarget(
  s: Pick<MeasureState, 'file' | 'editing' | 'focus' | 'draw'> &
    Partial<Pick<MeasureState, 'hiddenMeasurements'>>,
  ws: DatesOnScreen,
  focus: string | null,
  manifest: Dated | null,
  pinned: PinnedPile | null,
  mode: PileSurfaceMode,
): LookTarget | null {
  if (pinned) {
    const m = s.file.measurements.find((x) => x.id === pinned.id);
    if (!m || !isPile(m)) return null;
    if (s.editing && s.focus === m.id) return null;
    return {
      m,
      capture: pinned.capture,
      ring: outlineOn(m, pinned.capture, manifest),
      mode: 'solid',
      pinned: true,
    };
  }
  // the opened pile: the focused pile on screen, not being edited or drawn
  if (!s.focus || s.editing || s.draw) return null;
  const m = s.file.measurements.find((x) => x.id === s.focus);
  if (!m || !isPile(m)) return null;
  if (!measurementsOn(s, ws).some((x) => x.id === m.id)) return null;
  return {
    m,
    // the date in focus, else the pile's own
    capture:
      captureInFocus(focus, manifest) ?? (m.scope.kind === 'survey' ? m.scope.capture : null),
    ring: outlineOn(m, focus, manifest),
    mode,
    pinned: false,
  };
}
