/**
 * The one measurement colour palette (volumetric parity W2): the right-click swatches, the panel's
 * colour picker, the card's swatch name and the views' default colour all read it. Pure, with no
 * store, so the card's model and the report can import it.
 */
import type { MessageKey } from '@aio/ui';

export interface MeasureColour {
  id: string;
  hex: string;
  label: MessageKey;
}

/** The preset colours of a measurement (not the draft or snap colours the tools draw with). */
export const MEASURE_COLOURS: readonly MeasureColour[] = [
  { id: 'yellow', hex: '#ffd166', label: 'actions.measure.colour.yellow' },
  { id: 'red', hex: '#ef476f', label: 'actions.measure.colour.red' },
  { id: 'green', hex: '#06d6a0', label: 'actions.measure.colour.green' },
  { id: 'blue', hex: '#118ab2', label: 'actions.measure.colour.blue' },
  { id: 'purple', hex: '#9b5de5', label: 'actions.measure.colour.purple' },
  { id: 'orange', hex: '#f78c40', label: 'actions.measure.colour.orange' },
  { id: 'white', hex: '#ffffff', label: 'actions.measure.colour.white' },
  { id: 'grey', hex: '#94a3b8', label: 'actions.measure.colour.grey' },
];

/** A measurement's colour when its style names none: the first preset. */
export const DEFAULT_MEASURE_COLOUR: string = MEASURE_COLOURS[0]?.hex ?? '';

/** A polygon's fill opacity when its style names none (the map, the 3D view and the panel). */
export const DEFAULT_FILL_OPACITY = 0.18;

/** A line's width in pixels when its style names none. */
export const DEFAULT_BORDER_WIDTH = 2;

/** The preset with this hex (any case), if it is one. */
export function presetOf(hex: string): MeasureColour | undefined {
  const h = hex.toLowerCase();
  return MEASURE_COLOURS.find((c) => c.hex === h);
}
