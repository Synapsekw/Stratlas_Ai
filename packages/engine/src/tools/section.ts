import { Plane, Vector3 } from 'three';

export interface SectionState {
  enabled: boolean;
  /** Vertical cut at a compass bearing, or a horizontal cut at a height. */
  mode: 'vertical' | 'horizontal';
  /** Vertical mode: the half toward this bearing (degrees clockwise from north) is removed. */
  bearingDeg: number;
  /** Metres from the content centre along the cut direction (up for horizontal). */
  offset: number;
  /** Keep the other half. */
  flip: boolean;
}

export const DEFAULT_SECTION: SectionState = {
  enabled: false,
  mode: 'vertical',
  bearingDeg: 90,
  offset: 0,
  flip: false,
};

const DEG = Math.PI / 180;

/**
 * The clipping plane for a section. three.js discards points with negative signed distance, so
 * the normal points at the half that stays. Port of the HCl artifact's `setCut`.
 */
export function sectionPlane(s: SectionState, centre: Vector3): Plane | null {
  if (!s.enabled) return null;
  const toward =
    s.mode === 'horizontal'
      ? new Vector3(0, 1, 0)
      : new Vector3(Math.sin(s.bearingDeg * DEG), 0, -Math.cos(s.bearingDeg * DEG));
  const point = centre.clone().addScaledVector(toward, s.offset);
  const normal = toward.clone().negate();
  if (s.flip) normal.negate();
  return new Plane().setFromNormalAndCoplanarPoint(normal, point);
}

/** Write the section into the shared clipping array without replacing it. */
export function applySection(planes: Plane[], s: SectionState, centre: Vector3): void {
  const p = sectionPlane(s, centre);
  if (!p) {
    planes.length = 0;
    return;
  }
  const existing = planes[0];
  if (existing) existing.copy(p);
  else planes.push(p);
  planes.length = 1;
}
