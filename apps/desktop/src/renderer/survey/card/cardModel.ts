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
  isTelecomTool,
  measurementReadout,
  PRIMARY_KEY,
  primaryRow,
  secondaryRows,
  TOOL_LABELS,
  type ReadoutContext,
  type ReadoutRow,
} from '@aio/survey';
import { t, type IconName } from '@aio/ui';
import { DEFAULT_MEASURE_COLOUR, presetOf } from '../measureColours';
import { SURFACE_ROWS } from './terrain';

/** A colour as people read it: its preset name, or its hex. */
export function colourName(hex: string): string {
  const preset = presetOf(hex);
  return preset ? t(preset.label) : hex;
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
  /** The survey date a measurement belongs to; null for a site-wide one or a date since deleted. */
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
  /** The surface is still being read (`useCardTerrain`): its rows read "Computing". */
  terrainPending?: boolean;
  /** Reading the surface failed: its rows read "Could not read the surface". */
  terrainError?: boolean;
}

/**
 * One readout row as text: the measurement's units over the site's, the site's number locale and
 * angle units. The card, the tree, the view labels and the island all format through here.
 */
export function rowText(
  r: ReadoutRow,
  m: Pick<SurveyMeasurement, 'units'>,
  settings: SurveySettings,
): string {
  const units = effectiveUnits(settings.units, m.units);
  return formatRow(
    r,
    units,
    settings.precision,
    settings.locale ?? localeOf(units.distance),
    settings.angles ?? DEFAULT_ANGLES,
  );
}

/** The template's readout items for a measurement that has one. */
export function templateItems(
  m: Pick<SurveyMeasurement, 'template'>,
  templates: readonly Pick<SurveyTemplate, 'id' | 'items'>[],
): readonly string[] | undefined {
  return m.template ? templates.find((x) => x.id === m.template)?.items : undefined;
}

/**
 * The one primary value (R1): `primaryRow` with the template's items, formatted by `rowText`.
 * A telecom pick whose primary row has no value reads "Invalid picks"; any other measurement
 * with no value reads "". With a `capture` a volume shows its figure on that survey date
 * (`figureOn`), with the figure's status.
 */
export function primaryText(
  m: SurveyMeasurement,
  ctx: Pick<CardContext, 'settings' | 'templates' | 'surface'> & { capture?: string | undefined },
): string {
  const readout: ReadoutContext = {
    ...(ctx.surface ? { surface: ctx.surface } : {}),
    ...(ctx.capture !== undefined ? { capture: ctx.capture } : {}),
  };
  if (isTelecomTool(m.tool) && invalidPicks(m)) return t('tree.measure.invalid');
  const row = primaryRow(m, readout, templateItems(m, ctx.templates));
  return row ? rowText(row, m, ctx.settings) : '';
}

/** A telecom pick whose geometry gives its primary row no value (points on top of each other). */
export function invalidPicks(m: SurveyMeasurement): boolean {
  return measurementReadout(m, {}, [PRIMARY_KEY[m.tool]])[0]?.value === null;
}

export function cardModel(m: SurveyMeasurement, ctx: CardContext): CardModel {
  // a row of the surface still being read, or that could not be read, says so, not "No surface
  // under it"
  const terrainNote = ctx.terrainPending
    ? t('mcard.computing')
    : ctx.terrainError
      ? t('mcard.loadFailed')
      : null;
  const text = (r: ReadoutRow) =>
    rowText(
      terrainNote && r.value === null && SURFACE_ROWS.has(r.key) ? { ...r, note: terrainNote } : r,
      m,
      ctx.settings,
    );
  const readout: ReadoutContext = ctx.surface ? { surface: ctx.surface } : {};
  const items = templateItems(m, ctx.templates);
  const primary = primaryRow(m, readout, items);
  const scope = m.scope;
  // a date the project no longer has is no chip: the measurement needs a date (measurement dates)
  const dated =
    scope.kind === 'survey' ? ctx.captures.find((c) => c.id === scope.capture) : undefined;
  const colour = m.style?.color ?? DEFAULT_MEASURE_COLOUR;
  return {
    icon: TOOL_ICON[m.tool],
    name: m.label,
    tool: TOOL_LABELS[m.tool],
    scope: dated ? { label: dated.label, capture: dated.id } : null,
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
  // the number, its digit groups split by a space too ("2 714.7"), then a space and the unit
  const at = /^(\S*\d(?:\s\d{3}(?:[.,]\d+)?)*\S*)\s+(.+)$/.exec(text);
  return at ? { value: at[1] ?? text, unit: at[2] ?? '' } : { value: text, unit: '' };
}
