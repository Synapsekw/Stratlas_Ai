/**
 * What the shared measurement card shows (volumetric parity W2), worked out once from the
 * measurement and the site settings: the tool's icon, the name, the scope chip, the colour, the
 * primary value, the compact secondary line and the full readout under "More". Pure: no store, so
 * the report renders the same card with `renderToStaticMarkup`.
 */
import {
  DEFAULT_ANGLES,
  type MeasurementTool,
  type SurveyMeasurement,
  type SurveySettings,
  type SurveyTemplate,
} from '@aio/schema';
import { localeOf } from '@aio/geo';
import {
  effectiveUnits,
  formatRow,
  measurementReadout,
  primaryRow,
  secondaryRows,
  TOOL_LABELS,
  type ReadoutContext,
  type ReadoutRow,
} from '@aio/survey';
import { t, type IconName, type MessageKey } from '@aio/ui';

/**
 * A measurement's colour when its style names none: `MEASURE_COLOR` (`measureScene`), repeated
 * here so the card's model loads no store (a test holds the two together).
 */
export const DEFAULT_MEASURE_COLOUR = '#ffd166';

/**
 * The names of the preset colours (`MEASURE_COLOURS`, `measureActions`), by hex, repeated here for
 * the same reason; a test holds the two together. Any other colour is named by its hex.
 */
export const COLOUR_NAMES: Readonly<Record<string, MessageKey>> = {
  '#ffd166': 'actions.measure.colour.yellow',
  '#ef476f': 'actions.measure.colour.red',
  '#06d6a0': 'actions.measure.colour.green',
  '#118ab2': 'actions.measure.colour.blue',
  '#9b5de5': 'actions.measure.colour.purple',
  '#f78c40': 'actions.measure.colour.orange',
  '#ffffff': 'actions.measure.colour.white',
  '#94a3b8': 'actions.measure.colour.grey',
};

/** A colour as people read it: its preset name, or its hex. */
export function colourName(hex: string): string {
  const key = COLOUR_NAMES[hex.toLowerCase()];
  return key ? t(key) : hex;
}

/** One glyph per tool (not per family): the card header, the Measure bench rows and the tree. */
export const TOOL_ICON: Record<MeasurementTool, IconName> = {
  elevation: 'point',
  'elevation-difference': 'target',
  'elevation-history': 'history',
  annotation: 'anno',
  distance: 'ruler',
  grade: 'telemetry',
  'vertex-table': 'grip',
  'berm-check': 'path',
  section: 'section',
  azimuth: 'follow',
  'antenna-tilt': 'updown',
  clearance: 'crosshair',
  area: 'polygon',
  volume: 'pile',
  freehand: 'brush',
};

export interface CardModel {
  icon: IconName;
  name: string;
  /** The tool's name, for the icon's accessible label. */
  tool: string;
  /** The survey date a survey-scoped measurement belongs to; null for a site-wide one. */
  scope: { label: string; capture?: string } | null;
  colour: string;
  /** The colour's name ("Yellow"), or its hex when it is not a preset. */
  colourName: string;
  primary: { label: string; text: string } | null;
  /**
   * The compact line under the primary value, joined with " · "; "" when there is none. It never
   * repeats the primary row.
   */
  secondary: string;
  /** Every readout row (the template's, or the tool's default), for "More". */
  more: { label: string; text: string }[];
}

export interface CardContext {
  settings: SurveySettings;
  templates: readonly SurveyTemplate[];
  captures: readonly { id: string; label: string }[];
  /** The surface under the measurement, for terrain lengths, areas and heights above it. */
  surface?: ReadoutContext['surface'];
}

export function cardModel(m: SurveyMeasurement, ctx: CardContext): CardModel {
  const units = effectiveUnits(ctx.settings.units, m.units);
  const locale = ctx.settings.locale ?? localeOf(units.distance);
  const angles = ctx.settings.angles ?? DEFAULT_ANGLES;
  const text = (r: ReadoutRow) => formatRow(r, units, ctx.settings.precision, locale, angles);
  const readout: ReadoutContext = ctx.surface ? { surface: ctx.surface } : {};
  const items = m.template ? ctx.templates.find((x) => x.id === m.template)?.items : undefined;
  const primary = primaryRow(m, readout, items);
  const scope = m.scope;
  const colour = m.style?.color ?? DEFAULT_MEASURE_COLOUR;
  return {
    icon: TOOL_ICON[m.tool],
    name: m.label,
    tool: TOOL_LABELS[m.tool],
    scope:
      scope.kind === 'survey'
        ? {
            label: ctx.captures.find((c) => c.id === scope.capture)?.label ?? scope.capture,
            capture: scope.capture,
          }
        : null,
    colour,
    colourName: colourName(colour),
    primary: primary ? { label: primary.label, text: text(primary) } : null,
    secondary: secondaryRows(m, readout)
      .filter((r) => r.key !== primary?.key)
      .map((r) => `${r.label} ${text(r)}`)
      .join(' · '),
    more: measurementReadout(m, readout, items).map((r) => ({ label: r.label, text: text(r) })),
  };
}

/**
 * A formatted value split into its number and the rest ("142.6 m" into "142.6" and "m"), so the
 * card sets the number large and the unit small. A value with no space (15°12'00") is all number.
 */
export function splitValue(text: string): { value: string; unit: string } {
  const at = /^(\S*\d\S*)\s+(.+)$/.exec(text);
  return at ? { value: at[1] ?? text, unit: at[2] ?? '' } : { value: text, unit: '' };
}
