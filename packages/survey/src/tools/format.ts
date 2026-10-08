import type {
  AreaUnit,
  DensityUnit,
  DistanceUnit,
  GradeStyle,
  MassUnit,
  SurveyPrecision,
  SurveyUnits,
  UnitsOverride,
  VolumeUnit,
} from '@aio/schema';

/**
 * Units at the edges (data-conventions section 25): a small local formatter for the measurement
 * tools, written to be swapped for G1's `formatQuantity` in `@aio/geo` (`units.ts`) when it lands.
 * Same signature and the same exact factors: the international foot is 0.3048 m, the US survey
 * foot 1200/3937 m, and they never share a label.
 *
 * Stored values are SI: metres, square metres, cubic metres, kilograms (mass), tonnes per cubic
 * metre (density) and a grade as rise over run (a ratio, 0.05 is 5 %).
 */

const FT = 0.3048;
const US_FT = 1200 / 3937;
const YD = 3 * FT;
const LB = 0.45359237;
const ACRE = 43_560 * FT * FT;

/** Metres per unit. */
export const DISTANCE_FACTORS: Record<DistanceUnit, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  km: 1000,
  ft: FT,
  'us-ft': US_FT,
  in: 0.0254,
  yd: YD,
  mi: 5280 * FT,
  'us-mi': 5280 * US_FT,
};

/** Square metres per unit. */
export const AREA_FACTORS: Record<AreaUnit, number> = {
  m2: 1,
  ha: 10_000,
  km2: 1_000_000,
  ft2: FT * FT,
  'us-ft2': US_FT * US_FT,
  yd2: YD * YD,
  acre: ACRE,
  mi2: 5280 * FT * (5280 * FT),
};

/** Cubic metres per unit. */
export const VOLUME_FACTORS: Record<VolumeUnit, number> = {
  m3: 1,
  L: 0.001,
  ft3: FT * FT * FT,
  yd3: YD * YD * YD,
  'us-gal': 231 * 0.0254 ** 3,
  'acre-ft': ACRE * FT,
};

/** Tonnes per cubic metre per unit. */
export const DENSITY_FACTORS: Record<DensityUnit, number> = {
  't/m3': 1,
  'kg/m3': 0.001,
  'lb/ft3': LB / 1000 / (FT * FT * FT),
  'lb/yd3': LB / 1000 / (YD * YD * YD),
  'ston/yd3': (2000 * LB) / 1000 / (YD * YD * YD),
};

/** Kilograms per unit. */
export const MASS_FACTORS: Record<MassUnit, number> = {
  kg: 1,
  t: 1000,
  ston: 2000 * LB,
  lb: LB,
};

/** Short labels for readouts: "ft" is the international foot, "US ft" the survey foot. */
export const UNIT_LABELS: Record<string, string> = {
  mm: 'mm',
  cm: 'cm',
  m: 'm',
  km: 'km',
  ft: 'ft',
  'us-ft': 'US ft',
  in: 'in',
  yd: 'yd',
  mi: 'mi',
  'us-mi': 'US mi',
  m2: 'm²',
  ha: 'ha',
  km2: 'km²',
  ft2: 'ft²',
  'us-ft2': 'US ft²',
  yd2: 'yd²',
  acre: 'ac',
  mi2: 'mi²',
  m3: 'm³',
  L: 'L',
  ft3: 'ft³',
  yd3: 'yd³',
  'us-gal': 'US gal',
  'acre-ft': 'ac-ft',
  't/m3': 't/m³',
  'kg/m3': 'kg/m³',
  'lb/ft3': 'lb/ft³',
  'lb/yd3': 'lb/yd³',
  'ston/yd3': 'short tons/yd³',
  kg: 'kg',
  t: 't',
  ston: 'short tons',
  lb: 'lb',
};

/** Long names for unit pickers, where both feet are offered side by side. */
export const UNIT_NAMES: Record<string, string> = {
  mm: 'Millimetres',
  cm: 'Centimetres',
  m: 'Metres',
  km: 'Kilometres',
  ft: 'Feet (international, 0.3048 m)',
  'us-ft': 'US survey feet (1200/3937 m)',
  in: 'Inches',
  yd: 'Yards',
  mi: 'Miles',
  'us-mi': 'US survey miles',
  m2: 'Square metres',
  ha: 'Hectares',
  km2: 'Square kilometres',
  ft2: 'Square feet (international)',
  'us-ft2': 'Square US survey feet',
  yd2: 'Square yards',
  acre: 'Acres',
  mi2: 'Square miles',
  m3: 'Cubic metres',
  L: 'Litres',
  ft3: 'Cubic feet',
  yd3: 'Cubic yards',
  'us-gal': 'US gallons',
  'acre-ft': 'Acre-feet',
  't/m3': 'Tonnes per cubic metre',
  'kg/m3': 'Kilograms per cubic metre',
  'lb/ft3': 'Pounds per cubic foot',
  'lb/yd3': 'Pounds per cubic yard',
  'ston/yd3': 'Short tons per cubic yard',
  kg: 'Kilograms',
  t: 'Tonnes',
  ston: 'Short tons',
  lb: 'Pounds',
  percent: 'Percent',
  degrees: 'Degrees',
  'ratio-1-n': 'Ratio 1:n (rise to run)',
  'ratio-n-1': 'Ratio n:1 (run to rise)',
};

export type Quantity = 'distance' | 'area' | 'volume' | 'density' | 'mass' | 'grade' | 'coordinate';

const FACTORS = {
  distance: DISTANCE_FACTORS,
  area: AREA_FACTORS,
  volume: VOLUME_FACTORS,
  density: DENSITY_FACTORS,
  mass: MASS_FACTORS,
} as const;

/** An SI value in `unit` (a coordinate converts with the distance unit). */
export function fromSi(value: number, quantity: Exclude<Quantity, 'grade'>, unit: string): number {
  const table: Record<string, number> = FACTORS[quantity === 'coordinate' ? 'distance' : quantity];
  const f = table[unit];
  if (f === undefined) throw new RangeError(`Unknown ${quantity} unit "${unit}".`);
  return value / f;
}

/** A value in `unit` back to SI. */
export function toSi(value: number, quantity: Exclude<Quantity, 'grade'>, unit: string): number {
  const table: Record<string, number> = FACTORS[quantity === 'coordinate' ? 'distance' : quantity];
  const f = table[unit];
  if (f === undefined) throw new RangeError(`Unknown ${quantity} unit "${unit}".`);
  return value * f;
}

/** Thousands grouping: metric with a narrow no-break space, imperial with a comma. */
export type NumberLocale = 'metric' | 'imperial';

const IMPERIAL_DISTANCE = new Set(['ft', 'us-ft', 'in', 'yd', 'mi', 'us-mi']);

/** The locale a unit system implies when the site does not say. */
export const localeOf = (units: SurveyUnits): NumberLocale =>
  IMPERIAL_DISTANCE.has(units.distance) ? 'imperial' : 'metric';

/** A fixed-decimals number with grouped thousands; never "-0". */
export function formatNumber(value: number, decimals: number, locale: NumberLocale): string {
  if (!Number.isFinite(value)) return '-';
  const fixed = Math.abs(value).toFixed(decimals);
  const [int = '0', frac] = fixed.split('.');
  const sep = locale === 'imperial' ? ',' : ' ';
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const negative = value < 0 && Number(fixed) !== 0;
  return `${negative ? '-' : ''}${grouped}${frac !== undefined ? `.${frac}` : ''}`;
}

/** A grade (rise over run) in the chosen style. */
export function formatGrade(
  riseOverRun: number,
  style: GradeStyle,
  decimals: number,
  locale: NumberLocale = 'metric',
): string {
  if (!Number.isFinite(riseOverRun)) return 'vertical';
  switch (style) {
    case 'percent':
      return `${formatNumber(riseOverRun * 100, decimals, locale)} %`;
    case 'degrees':
      return `${formatNumber((Math.atan(riseOverRun) * 180) / Math.PI, decimals, locale)}°`;
    case 'ratio-1-n':
    case 'ratio-n-1': {
      if (riseOverRun === 0) return 'flat';
      const n = formatNumber(1 / Math.abs(riseOverRun), decimals, locale);
      const sign = riseOverRun < 0 ? '-' : '';
      return style === 'ratio-1-n' ? `${sign}1:${n}` : `${sign}${n}:1`;
    }
  }
}

/** The units a measurement shows: the site units with its own overrides on top. */
export function effectiveUnits(site: SurveyUnits, override?: UnitsOverride): SurveyUnits {
  const out: SurveyUnits = { ...site };
  if (!override) return out;
  if (override.distance) out.distance = override.distance;
  if (override.area) out.area = override.area;
  if (override.volume) out.volume = override.volume;
  if (override.density) out.density = override.density;
  if (override.mass) out.mass = override.mass;
  if (override.grade) out.grade = override.grade;
  return out;
}

/**
 * One readout, label or export cell: `value` is SI (see the module comment), formatted in the
 * quantity's unit with the site's decimals. Same signature as G1's `formatQuantity`.
 */
export function formatQuantity(
  value: number,
  quantity: Quantity,
  units: SurveyUnits,
  precision: SurveyPrecision,
  locale: NumberLocale = localeOf(units),
): string {
  switch (quantity) {
    case 'grade':
      return formatGrade(value, units.grade, precision.grade, locale);
    case 'coordinate':
      return `${formatNumber(fromSi(value, 'distance', units.distance), precision.coordinate, locale)} ${UNIT_LABELS[units.distance] ?? units.distance}`;
    case 'distance':
      return `${formatNumber(fromSi(value, 'distance', units.distance), precision.distance, locale)} ${UNIT_LABELS[units.distance] ?? units.distance}`;
    case 'area':
      return `${formatNumber(fromSi(value, 'area', units.area), precision.area, locale)} ${UNIT_LABELS[units.area] ?? units.area}`;
    case 'volume':
      return `${formatNumber(fromSi(value, 'volume', units.volume), precision.volume, locale)} ${UNIT_LABELS[units.volume] ?? units.volume}`;
    case 'density':
      return `${formatNumber(fromSi(value, 'density', units.density), 3, locale)} ${UNIT_LABELS[units.density] ?? units.density}`;
    case 'mass':
      return `${formatNumber(fromSi(value, 'mass', units.mass), precision.volume, locale)} ${UNIT_LABELS[units.mass] ?? units.mass}`;
  }
}
