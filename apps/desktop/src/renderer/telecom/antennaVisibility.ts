/**
 * The antenna review's shared rules, kept apart from the store and the scene so both read the
 * same ones: which units are drawn, and the labels the 3D view places.
 */
import type { AntennaKind, AntennaUnit, Vec3 } from '@aio/schema';

export type AntennaFilter = 'draft' | 'accepted' | 'rejected' | 'all';

/**
 * Which labels the 3D view shows. The selected unit's full labels show in every mode; 'all' adds
 * a numbered pin on every other drawn unit, 'off' and 'selected' show no pin.
 */
export type AntennaLabelMode = 'off' | 'selected' | 'all';

/** What decides whether a unit is drawn in the 3D view. */
export interface AntennaVisibility {
  selected: string | null;
  hidden: Record<string, true>;
  /** Only this kind is drawn (the selected unit aside); null: every kind. */
  solo: AntennaKind | null;
}

/**
 * The selected unit is always drawn, so a walk through hidden units shows one at a time; any other
 * unit is drawn when its kind is not soloed out and the person has not hidden it.
 */
export function isAntennaDrawn(s: AntennaVisibility, unit: AntennaUnit): boolean {
  if (unit.id === s.selected) return true;
  if (s.solo !== null && unit.kind !== s.solo) return false;
  return s.hidden[unit.id] !== true;
}

/** A label the 3D view places over a point of the local frame. */
export interface AntennaLabelSpot {
  key: string;
  text: string;
  /** Local frame (x east, y up, z south). */
  at: Vec3;
  /** 'pin': the small numbered marker of a unit that is not selected. */
  kind: 'name' | 'dim' | 'angle' | 'pin';
  selected: boolean;
  /** The unit a pin stands for (a click on it picks that unit). */
  unitId?: string;
  /** A pin's fill, the unit's kind colour. */
  colour?: string;
  /** A pin's hover text: the unit's name, kind and status. */
  title?: string;
}
