import type {
  AreaUnit,
  CoordinateOrder,
  DensityUnit,
  DistanceUnit,
  GradeStyle,
  MassUnit,
  SurveyPrecision,
  SurveyUnits,
  VolumeUnit,
} from '@aio/schema';

/**
 * Units at the edges (M11 G1, data-conventions section 25, ADR 0010 decision 7).
 *
 * Every stored value is SI: metres, square metres, cubic metres, tonnes per cubic metre and
 * kilograms; a grade is stored as rise over run (metres per metre). This module converts and
 * formats them for display and export, and parses what a person types back to SI.
 *
 * The international foot (`ft`, exactly 0.3048 m) and the US survey foot (`us-ft`, exactly
 * 1200/3937 m) are distinct units with distinct labels ("ft" and "US ft"), never both "ft". Every
 * factor below is written from its definition so it is exact to the double it rounds to.
 */

/** What a number measures. `coordinate` is a distance shown with the coordinate precision. */
export type Quantity = 'distance' | 'area' | 'volume' | 'density' | 'mass' | 'grade' | 'coordinate';

export type AnyUnit = DistanceUnit | AreaUnit | VolumeUnit | DensityUnit | MassUnit | GradeStyle;

/** Thousands grouping: `metric` a space (1 234.5), `imperial` a comma (1,234.5). */
export type NumberLocale = 'metric' | 'imperial';

const FT = 0.3048;
const US_FT = 1200 / 3937;
const IN = 0.0254;
const YD = 0.9144;
const MI = 1609.344;
const US_MI = 5280 * US_FT;
const LB = 0.45359237;
const FT3 = FT * FT * FT;
const YD3 = YD * YD * YD;

/** Metres per unit. */
export const DISTANCE_FACTORS: Readonly<Record<DistanceUnit, number>> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  km: 1000,
  ft: FT,
  'us-ft': US_FT,
  in: IN,
  yd: YD,
  mi: MI,
  'us-mi': US_MI,
};

/** Square metres per unit. The acre is the international acre (43 560 ft², 4 046.856 422 4 m²). */
export const AREA_FACTORS: Readonly<Record<AreaUnit, number>> = {
  m2: 1,
  ha: 10_000,
  km2: 1_000_000,
  ft2: FT * FT,
  'us-ft2': US_FT * US_FT,
  yd2: YD * YD,
  acre: 43_560 * FT * FT,
  mi2: MI * MI,
};

/** Cubic metres per unit. US gallon: 231 cubic inches; acre-foot: 43 560 ft³. */
export const VOLUME_FACTORS: Readonly<Record<VolumeUnit, number>> = {
  m3: 1,
  L: 0.001,
  ft3: FT3,
  yd3: YD3,
  'us-gal': 231 * IN * IN * IN,
  'acre-ft': 43_560 * FT3,
};

/** Tonnes per cubic metre per unit. A short ton is 2 000 lb. */
export const DENSITY_FACTORS: Readonly<Record<DensityUnit, number>> = {
  't/m3': 1,
  'kg/m3': 0.001,
  'lb/ft3': LB / 1000 / FT3,
  'lb/yd3': LB / 1000 / YD3,
  'ston/yd3': (2000 * LB) / 1000 / YD3,
};

/** Kilograms per unit. */
export const MASS_FACTORS: Readonly<Record<MassUnit, number>> = {
  kg: 1,
  t: 1000,
  ston: 2000 * LB,
  lb: LB,
};

export const DISTANCE_UNITS = Object.keys(DISTANCE_FACTORS) as DistanceUnit[];
export const AREA_UNITS = Object.keys(AREA_FACTORS) as AreaUnit[];
export const VOLUME_UNITS = Object.keys(VOLUME_FACTORS) as VolumeUnit[];
export const DENSITY_UNITS = Object.keys(DENSITY_FACTORS) as DensityUnit[];
export const MASS_UNITS = Object.keys(MASS_FACTORS) as MassUnit[];
export const GRADE_STYLES: readonly GradeStyle[] = ['percent', 'degrees', 'ratio-1-n', 'ratio-n-1'];

type LinearQuantity = 'distance' | 'area' | 'volume' | 'density' | 'mass';
const FACTORS: Record<LinearQuantity, Readonly<Record<string, number>>> = {
  distance: DISTANCE_FACTORS,
  area: AREA_FACTORS,
  volume: VOLUME_FACTORS,
  density: DENSITY_FACTORS,
  mass: MASS_FACTORS,
};

/** Short labels for readouts. `ft` and `us-ft` never share one. */
const SHORT: Readonly<Record<AnyUnit, string>> = {
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
  'ston/yd3': 'sh tn/yd³',
  kg: 'kg',
  t: 't',
  ston: 'sh tn',
  lb: 'lb',
  percent: '%',
  degrees: '°',
  'ratio-1-n': '1:n',
  'ratio-n-1': 'n:1',
};

/** Long names for unit pickers, where the two feet are offered side by side. */
const LONG: Partial<Readonly<Record<AnyUnit, string>>> = {
  mm: 'millimetres',
  cm: 'centimetres',
  m: 'metres',
  km: 'kilometres',
  ft: 'ft (international)',
  'us-ft': 'US survey ft',
  in: 'inches',
  yd: 'yards',
  mi: 'miles (international)',
  'us-mi': 'US survey miles',
  m2: 'square metres',
  ha: 'hectares',
  km2: 'square kilometres',
  ft2: 'ft² (international)',
  'us-ft2': 'US survey ft²',
  yd2: 'square yards',
  acre: 'acres',
  mi2: 'square miles',
  m3: 'cubic metres',
  L: 'litres',
  ft3: 'cubic feet',
  yd3: 'cubic yards',
  'us-gal': 'US gallons',
  'acre-ft': 'acre-feet',
  't/m3': 'tonnes per m³',
  'kg/m3': 'kg per m³',
  'lb/ft3': 'lb per ft³',
  'lb/yd3': 'lb per yd³',
  'ston/yd3': 'short tons per yd³',
  kg: 'kilograms',
  t: 'tonnes',
  ston: 'short tons',
  lb: 'pounds',
  percent: 'percent',
  degrees: 'degrees',
  'ratio-1-n': 'ratio 1:n (rise to run)',
  'ratio-n-1': 'ratio n:1 (run to rise)',
};

/** The short label of a unit ("US ft", "m²"). */
export function unitLabel(unit: AnyUnit): string {
  return SHORT[unit];
}

/** The long name of a unit for pickers ("ft (international)", "US survey ft"). */
export function unitName(unit: AnyUnit): string {
  return LONG[unit] ?? SHORT[unit];
}

/** SI value per one of `unit` (metres, m², m³, t/m³ or kg). */
export function unitFactor(quantity: LinearQuantity, unit: string): number {
  const f = FACTORS[quantity][unit];
  if (f === undefined) throw new Error(`${unit} is not a ${quantity} unit`);
  return f;
}

/** An SI value in `unit`. */
export function fromSI(value: number, quantity: LinearQuantity, unit: string): number {
  const f = unitFactor(quantity, unit);
  // mm, cm, L and kg/m3: multiply by the exact inverse so 0.0125 m is 12.5 mm, not 12.4999...
  const inv = 1 / f;
  return f < 1 && Number.isInteger(inv) ? value * inv : value / f;
}

/** A value in `unit` to SI. */
export function toSI(value: number, quantity: LinearQuantity, unit: string): number {
  return value * unitFactor(quantity, unit);
}

/** A value from one unit to another of the same quantity. */
export function convert(value: number, quantity: LinearQuantity, from: string, to: string): number {
  if (from === to) return value;
  return (value * unitFactor(quantity, from)) / unitFactor(quantity, to);
}

/** The system a distance unit belongs to (for the default thousands grouping). */
export function localeOf(distance: DistanceUnit): NumberLocale {
  return distance === 'mm' || distance === 'cm' || distance === 'm' || distance === 'km'
    ? 'metric'
    : 'imperial';
}

/** Group thousands and fix decimals: `1 234.50` (metric) or `1,234.50` (imperial). */
export function formatNumber(
  value: number,
  decimals: number,
  locale: NumberLocale = 'metric',
): string {
  if (!Number.isFinite(value)) return value > 0 ? '∞' : value < 0 ? '-∞' : 'n/a';
  const d = Math.max(0, Math.min(10, Math.round(decimals)));
  const [int = '0', frac] = Math.abs(value).toFixed(d).split('.');
  const sep = locale === 'imperial' ? ',' : ' ';
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  // a value that rounds to zero shows no sign
  const neg = value < 0 && /[1-9]/.test(`${int}${frac ?? ''}`);
  return `${neg ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

// ---------------------------------------------------------------- grades

/** Grade (rise over run) to its display number in a style: 5 (%), 2.862 (°) or 20 (1:20). */
export function gradeIn(grade: number, style: GradeStyle): number {
  switch (style) {
    case 'percent':
      return grade * 100;
    case 'degrees':
      return (Math.atan(grade) * 180) / Math.PI;
    case 'ratio-1-n':
    case 'ratio-n-1':
      return grade === 0 ? Infinity : 1 / Math.abs(grade);
  }
}

/** A display number in a style back to a grade (rise over run); ratios are unsigned. */
export function gradeFrom(value: number, style: GradeStyle): number {
  switch (style) {
    case 'percent':
      return value / 100;
    case 'degrees':
      return Math.tan((value * Math.PI) / 180);
    case 'ratio-1-n':
    case 'ratio-n-1':
      return value === Infinity ? 0 : 1 / value;
  }
}

function formatGrade(grade: number, style: GradeStyle, decimals: number, locale: NumberLocale) {
  const v = gradeIn(grade, style);
  if (style === 'percent') return `${formatNumber(v, decimals, locale)} %`;
  if (style === 'degrees') return `${formatNumber(v, decimals, locale)}°`;
  const sign = grade < 0 ? '-' : '';
  const n = Number.isFinite(v) ? formatNumber(v, decimals, locale) : '∞';
  return style === 'ratio-1-n' ? `${sign}1:${n}` : `${sign}${n}:1`;
}

// ---------------------------------------------------------------- the formatter

/** The unit a quantity is shown in: the site units, or one unit given directly. */
export type UnitChoice = Partial<SurveyUnits> | AnyUnit;

/** Decimal places: the site precision, or a number. */
export type PrecisionChoice = Partial<SurveyPrecision> | number;

const DEFAULT_UNITS: SurveyUnits = {
  distance: 'm',
  area: 'm2',
  volume: 'm3',
  density: 't/m3',
  mass: 't',
  grade: 'percent',
};
const DEFAULT_PRECISION: SurveyPrecision = {
  coordinate: 3,
  distance: 3,
  area: 2,
  volume: 1,
  grade: 1,
};

function unitFor(quantity: Quantity, units: UnitChoice): AnyUnit {
  if (typeof units === 'string') return units;
  const key = quantity === 'coordinate' ? 'distance' : quantity;
  return units[key] ?? DEFAULT_UNITS[key];
}

function decimalsFor(quantity: Quantity, precision: PrecisionChoice): number {
  if (typeof precision === 'number') return precision;
  // density and mass have no precision of their own in the site settings
  if (quantity === 'density') return 2;
  const key: keyof SurveyPrecision = quantity === 'mass' ? 'volume' : quantity;
  return precision[key] ?? DEFAULT_PRECISION[key];
}

/**
 * Format an SI value for a person: `formatQuantity(12.3456, 'distance', { distance: 'us-ft' }, 2)`
 * is "40.50 US ft". `units` are the site units (merged with a measurement's override) or one unit;
 * `precision` the site precision or a number of decimals; `locale` the thousands grouping (default
 * from the distance unit's system). Coordinates have no unit suffix.
 */
export function formatQuantity(
  value: number,
  quantity: Quantity,
  units: UnitChoice,
  precision: PrecisionChoice,
  locale?: NumberLocale,
): string {
  const unit = unitFor(quantity, units);
  const decimals = decimalsFor(quantity, precision);
  const loc =
    locale ??
    (typeof units === 'string'
      ? localeOf(isDistance(unit) ? unit : imperialUnit(unit) ? 'ft' : 'm')
      : localeOf(units.distance ?? 'm'));
  if (quantity === 'grade') return formatGrade(value, unit as GradeStyle, decimals, loc);
  const q: LinearQuantity = quantity === 'coordinate' ? 'distance' : quantity;
  const n = formatNumber(fromSI(value, q, unit), decimals, loc);
  return quantity === 'coordinate' ? n : `${n} ${unitLabel(unit)}`;
}

function isDistance(u: AnyUnit): u is DistanceUnit {
  return u in DISTANCE_FACTORS;
}

const IMPERIAL = new Set<string>([
  'ft',
  'us-ft',
  'in',
  'yd',
  'mi',
  'us-mi',
  'ft2',
  'us-ft2',
  'yd2',
  'acre',
  'mi2',
  'ft3',
  'yd3',
  'us-gal',
  'acre-ft',
  'lb/ft3',
  'lb/yd3',
  'ston/yd3',
  'ston',
  'lb',
]);
function imperialUnit(u: AnyUnit): boolean {
  return IMPERIAL.has(u);
}

/** Display settings for coordinates: the site's order, units, precision and locale. */
export interface CoordinateStyle {
  order: CoordinateOrder;
  units: Partial<SurveyUnits>;
  precision: Partial<SurveyPrecision>;
  locale?: NumberLocale;
}

/**
 * "N 3 179 597.120  E 245 884.940  Z 12.300 m" (NEZ) or "E ... N ... Z ..." (ENZ), in the site's
 * distance unit. `z` is omitted when null.
 */
export function formatCoordinate(e: number, n: number, z: number | null, style: CoordinateStyle) {
  const fmt = (v: number) =>
    formatQuantity(v, 'coordinate', style.units, style.precision, style.locale);
  const en = style.order === 'NEZ' ? `N ${fmt(n)}  E ${fmt(e)}` : `E ${fmt(e)}  N ${fmt(n)}`;
  if (z === null) return en;
  const unit = unitLabel(style.units.distance ?? 'm');
  return `${en}  Z ${fmt(z)} ${unit}`;
}

// ---------------------------------------------------------------- parsing

/** The result of parsing a typed value: SI, and the unit the person typed (or the default). */
export type Parsed = { ok: true; value: number; unit: AnyUnit } | { ok: false; error: string };

const ALIASES: Record<LinearQuantity, Record<string, string>> = {
  distance: {
    mm: 'mm',
    millimetre: 'mm',
    millimetres: 'mm',
    millimeter: 'mm',
    millimeters: 'mm',
    cm: 'cm',
    centimetre: 'cm',
    centimetres: 'cm',
    centimeter: 'cm',
    centimeters: 'cm',
    m: 'm',
    metre: 'm',
    metres: 'm',
    meter: 'm',
    meters: 'm',
    km: 'km',
    kilometre: 'km',
    kilometres: 'km',
    kilometer: 'km',
    kilometers: 'km',
    ft: 'ft',
    feet: 'ft',
    foot: 'ft',
    "'": 'ft',
    ift: 'ft',
    'ft (international)': 'ft',
    'us-ft': 'us-ft',
    'us ft': 'us-ft',
    usft: 'us-ft',
    sft: 'us-ft',
    'survey ft': 'us-ft',
    'us survey ft': 'us-ft',
    'us survey foot': 'us-ft',
    'us survey feet': 'us-ft',
    in: 'in',
    inch: 'in',
    inches: 'in',
    '"': 'in',
    yd: 'yd',
    yard: 'yd',
    yards: 'yd',
    mi: 'mi',
    mile: 'mi',
    miles: 'mi',
    'us-mi': 'us-mi',
    'us mi': 'us-mi',
  },
  area: {
    m2: 'm2',
    'm²': 'm2',
    'sq m': 'm2',
    ha: 'ha',
    hectare: 'ha',
    hectares: 'ha',
    km2: 'km2',
    'km²': 'km2',
    ft2: 'ft2',
    'ft²': 'ft2',
    'sq ft': 'ft2',
    'us-ft2': 'us-ft2',
    'us ft2': 'us-ft2',
    'us ft²': 'us-ft2',
    yd2: 'yd2',
    'yd²': 'yd2',
    'sq yd': 'yd2',
    acre: 'acre',
    acres: 'acre',
    ac: 'acre',
    mi2: 'mi2',
    'mi²': 'mi2',
    'sq mi': 'mi2',
  },
  volume: {
    m3: 'm3',
    'm³': 'm3',
    'cu m': 'm3',
    l: 'L',
    litre: 'L',
    litres: 'L',
    liter: 'L',
    liters: 'L',
    ft3: 'ft3',
    'ft³': 'ft3',
    'cu ft': 'ft3',
    yd3: 'yd3',
    'yd³': 'yd3',
    'cu yd': 'yd3',
    'us-gal': 'us-gal',
    'us gal': 'us-gal',
    gal: 'us-gal',
    'acre-ft': 'acre-ft',
    'ac-ft': 'acre-ft',
    'acre ft': 'acre-ft',
  },
  density: {
    't/m3': 't/m3',
    't/m³': 't/m3',
    'kg/m3': 'kg/m3',
    'kg/m³': 'kg/m3',
    'lb/ft3': 'lb/ft3',
    'lb/ft³': 'lb/ft3',
    'lb/yd3': 'lb/yd3',
    'lb/yd³': 'lb/yd3',
    'ston/yd3': 'ston/yd3',
    'sh tn/yd3': 'ston/yd3',
    'sh tn/yd³': 'ston/yd3',
  },
  mass: {
    kg: 'kg',
    t: 't',
    tonne: 't',
    tonnes: 't',
    ston: 'ston',
    'sh tn': 'ston',
    'short ton': 'ston',
    'short tons': 'ston',
    lb: 'lb',
    lbs: 'lb',
  },
};

/** A typed number: digits with optional thousands groups (space, comma, apostrophe) and a point. */
function parseNumber(text: string): number | null {
  const t = text.replace(/[\s]/g, '').replace(/,(?=\d{3}(\D|$))/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/**
 * Parse what a person typed into SI: "12.5 ft", "12' 6\"", "1,234.5 m2", "40 US ft", "5 %",
 * "2.5°", "1:20" (rise to run with `ratio-1-n`, run to rise with `ratio-n-1`). A bare number is in
 * `defaultUnit`. Errors are sentences a field can show.
 */
export function parseQuantity(text: string, quantity: Quantity, defaultUnit: AnyUnit): Parsed {
  const raw = text.trim();
  if (!raw) return { ok: false, error: 'Type a value.' };
  if (quantity === 'grade') return parseGrade(raw, defaultUnit as GradeStyle);
  const q: LinearQuantity = quantity === 'coordinate' ? 'distance' : quantity;
  if (q === 'distance') {
    // feet and inches: 12' 6"
    const fi = /^([-+]?\d+(?:\.\d+)?)\s*'\s*(\d+(?:\.\d+)?)\s*(?:"|in)?$/.exec(raw);
    if (fi) {
      const ftUnit = defaultUnit === 'us-ft' ? 'us-ft' : 'ft';
      const feet = Number(fi[1]);
      const inches = Number(fi[2]) * (feet < 0 ? -1 : 1);
      return { ok: true, value: toSI(feet + inches / 12, 'distance', ftUnit), unit: ftUnit };
    }
  }
  const m = /^([-+]?(?:\d[\d\s,]*)?(?:\.\d+)?(?:e[-+]?\d+)?)\s*(.*)$/i.exec(raw);
  const numText = m?.[1] ?? raw;
  const unitText = (m?.[2] ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const value = parseNumber(numText);
  if (value === null) return { ok: false, error: `"${raw}" is not a number.` };
  let unit = defaultUnit as string;
  if (unitText) {
    const found = ALIASES[q][unitText];
    if (!found) return { ok: false, error: `"${unitText}" is not a ${q} unit.` };
    unit = found;
  }
  return { ok: true, value: toSI(value, q, unit), unit: unit as AnyUnit };
}

function parseGrade(raw: string, style: GradeStyle): Parsed {
  const ratio = /^([-+]?)\s*(\d+(?:\.\d+)?|∞)\s*:\s*(\d+(?:\.\d+)?|∞)$/.exec(raw);
  if (ratio) {
    const sign = ratio[1] === '-' ? -1 : 1;
    const a = ratio[2] === '∞' ? Infinity : Number(ratio[2]);
    const b = ratio[3] === '∞' ? Infinity : Number(ratio[3]);
    // ratio-n-1 reads run:rise; every other style reads rise:run
    const [rise, run] = style === 'ratio-n-1' ? [b, a] : [a, b];
    if (run === 0) return { ok: false, error: 'A vertical grade has no ratio.' };
    const g = rise === Infinity ? Infinity : run === Infinity ? 0 : rise / run;
    if (!Number.isFinite(g)) return { ok: false, error: 'A vertical grade has no ratio.' };
    return { ok: true, value: sign * g, unit: style };
  }
  const m = /^(.*?)\s*(%|°|deg|degrees|percent)?$/i.exec(raw);
  const value = parseNumber(m?.[1] ?? raw);
  if (value === null) return { ok: false, error: `"${raw}" is not a grade.` };
  const suffix = (m?.[2] ?? '').toLowerCase();
  const as: GradeStyle =
    suffix === '%' || suffix === 'percent'
      ? 'percent'
      : suffix
        ? 'degrees'
        : style === 'ratio-1-n' || style === 'ratio-n-1'
          ? 'percent'
          : style;
  if (as === 'degrees' && Math.abs(value) >= 90)
    return { ok: false, error: 'A grade is less than 90°.' };
  return { ok: true, value: gradeFrom(value, as), unit: as };
}

// ---------------------------------------------------------------- defaults from the CRS

/**
 * A new site's units from its CRS's linear unit (decision 12): US survey feet for a CRS in US
 * survey feet, international feet for one in feet, metric otherwise.
 */
export function unitsForCrsUnit(crsUnit: string | undefined): SurveyUnits {
  const u = (crsUnit ?? '').toLowerCase();
  if (u.includes('us survey foot') || u === 'us-ft' || u === 'ftus') {
    return {
      distance: 'us-ft',
      area: 'acre',
      volume: 'yd3',
      density: 'ston/yd3',
      mass: 'ston',
      grade: 'percent',
    };
  }
  if (u === 'foot' || u === 'ft' || u.startsWith('foot (international)')) {
    return {
      distance: 'ft',
      area: 'acre',
      volume: 'yd3',
      density: 'ston/yd3',
      mass: 'ston',
      grade: 'percent',
    };
  }
  return { ...DEFAULT_UNITS };
}
