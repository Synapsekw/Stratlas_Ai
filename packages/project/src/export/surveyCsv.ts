// Survey reports and CSVs (M11 G9, PRD SRV-13): the data the house report's survey sections and
// the survey CSV exports print, with the arithmetic that needs no survey engine (inventory totals
// by material, the change since the last survey, earthworks progress, compaction per lift) and the
// CSV writers. Every value is SI (metres, square metres, cubic metres, tonnes and tonnes per cubic
// metre); units are the site's display choice, written beside the SI value. The engine's results
// are computed by the caller (the report page, `reportPage/house/surveyData.ts`). Pure and renderer
// safe.
import { formatQuantity, fromSI, gradeIn, unitLabel, type AnyUnit, type Quantity } from '@aio/geo';
import type {
  ReportSectionId,
  ComparisonResult,
  ProjectManifest,
  MeasurementFamily,
  MeasurementTool,
  SiteCalibration,
  SiteMaterial,
  SurveyPrecision,
  SurveySettings,
  SurveyUnits,
} from '@aio/schema';
import { noDashes } from './facts';

/** The house report's survey sections, in print order (each prints only with data). */
export const SURVEY_SECTIONS = [
  'measurements',
  'earthworks',
  'stockpiles',
  'landfill',
] as const satisfies readonly ReportSectionId[];

/**
 * Sections drawn from the site's runs rather than its measurements: haul-road compliance
 * (`aio.haul-run/1`) and hydrology (`aio.hydro-run/1`). They follow the survey sections and print
 * only when the project has runs of their kind.
 */
export const RUN_SECTIONS = ['haul', 'hydrology'] as const satisfies readonly ReportSectionId[];

// ---------------------------------------------------------------- basis

/** What every survey number was computed and shown with (each section and CSV states it). */
export interface SurveyBasis {
  /** The display CRS: `EPSG:32639`, or `WKT` for a custom definition. */
  crs: string;
  /** `project`, `ellipsoidal`, `geoid` or `calibration` (data-conventions section 25). */
  verticalDatum: SurveySettings['verticalDatum']['kind'];
  /** The geoid pack heights go through (`verticalDatum` `geoid`), else null. */
  geoid: string | null;
  /** The vertical CRS of the geoid heights (`EPSG:5773`), when the settings name one. */
  verticalCrs: string | null;
  /** The applied site calibration, else null. */
  calibration: { id: string; name: string; rmsH: number | null; rmsV: number | null } | null;
  distances: SurveySettings['distances'];
  units: SurveyUnits;
  precision: SurveyPrecision;
}

const crsText = (crs: ProjectManifest['crs']): string =>
  'epsg' in crs ? `EPSG:${String(crs.epsg)}` : 'WKT';

/**
 * The basis of a site's numbers: the display CRS (the manifest's when the settings name none), the
 * vertical datum and geoid, the calibration (only when it is the one the settings apply and a
 * person applied it) and the units.
 */
export function surveyBasis(
  settings: SurveySettings,
  manifestCrs: ProjectManifest['crs'],
  calibration: SiteCalibration | null,
): SurveyBasis {
  const vd = settings.verticalDatum;
  const cal =
    calibration && settings.calibration === calibration.id && calibration.appliedAt
      ? {
          id: calibration.id,
          name: noDashes(calibration.name),
          rmsH: calibration.rmsH ?? null,
          rmsV: calibration.rmsV ?? null,
        }
      : null;
  return {
    crs: crsText(settings.crs ?? manifestCrs),
    verticalDatum: vd.kind,
    geoid: vd.kind === 'geoid' ? vd.geoid : null,
    verticalCrs: vd.kind === 'geoid' && vd.epsg !== undefined ? `EPSG:${String(vd.epsg)}` : null,
    calibration: cal,
    distances: settings.distances,
    units: settings.units,
    precision: settings.precision,
  };
}

// ---------------------------------------------------------------- the report data

/** How a readout value is shown: a quantity in the site's units, or a bearing, count or text. */
export type SurveyValueKind = Quantity | 'bearing' | 'count' | 'text';

/** One readout of a measurement, as the panel shows it (`display`) and in SI (`si`). */
export interface SurveyValue {
  key: string;
  label: string;
  /** SI value, or null when it cannot be computed (no surface under it). */
  si: number | null;
  kind: SurveyValueKind;
  /** The text the app shows (units, precision, locale), or the reason it is missing. */
  display: string;
}

/** One comparison item of a measurement on the survey it is reported for. */
export interface ComparisonReport {
  item: string;
  label: string;
  /** The engine's result; null when the item could not be computed (`reason` says why). */
  result: ComparisonResult | null;
  reason: string;
}

export interface CaptureRef {
  id: string;
  label: string;
  date: string;
}

/** A saved survey measurement as the reports list it. */
export interface MeasurementReport {
  /** Reference label on the plan and in the tables: M1, M2 ... in list order. */
  ref: string;
  id: string;
  label: string;
  folder: string | null;
  template: string | null;
  family: MeasurementFamily;
  tool: MeasurementTool;
  /** The survey a survey-scoped measurement belongs to; null for the whole site. */
  scope: string | null;
  /** The survey its numbers are for (the latest with a surface, or its own); null without one. */
  capture: CaptureRef | null;
  material: SiteMaterial | null;
  /** The measurement's units (the site's with its own overrides). */
  units: SurveyUnits;
  values: SurveyValue[];
  comparisons: ComparisonReport[];
  /** Custom field values by field name, in the template's order. */
  fields: { name: string; value: string }[];
  /** Vertices (E, N) in the project CRS, for the plan. */
  outline: [number, number][];
}

/** A pile's volume on one survey. */
export interface PileVolume {
  capture: CaptureRef;
  /** Bank volume (the stockpile item's net, as the panel's calculators read it), m³. */
  volumeM3: number | null;
  status: ComparisonResult['status'] | 'missing';
  reason: string;
}

export interface StockpileReport {
  ref: string;
  id: string;
  label: string;
  material: SiteMaterial | null;
  /** How the base was taken (smart, fit plane ...), as the result names it. */
  base: string;
  /** The pile on every survey it was computed for, in date order. */
  volumes: PileVolume[];
}

export interface StockpileRow extends StockpileReport {
  /** On the latest survey and the one before it ("month end": the change since the last). */
  current: PileVolume | null;
  previous: PileVolume | null;
  currentM3: number | null;
  previousM3: number | null;
  changeM3: number | null;
  densityTPerM3: number | null;
  tonnes: number | null;
  previousTonnes: number | null;
  changeTonnes: number | null;
}

export interface InventoryTotal {
  /** The material's id, or null for the piles without one (and for the grand total). */
  material: string | null;
  name: string;
  piles: number;
  currentM3: number;
  previousM3: number | null;
  changeM3: number | null;
  /** Null when a pile of it has no density (its tonnes cannot be added). */
  tonnes: number | null;
  changeTonnes: number | null;
}

export interface StockpileInventory {
  captures: CaptureRef[];
  current: CaptureRef | null;
  previous: CaptureRef | null;
  rows: StockpileRow[];
  /** Totals per material (the materials summary), in the order the materials first appear. */
  byMaterial: InventoryTotal[];
  total: InventoryTotal;
}

/** Cut and fill to a design, progress since the first survey and the in-tolerance share. */
export interface EarthworksReport {
  ref: string;
  id: string;
  label: string;
  item: string;
  /** The design side, in words. */
  design: string;
  toleranceM: number;
  first: { capture: CaptureRef; result: ComparisonResult } | null;
  current: { capture: CaptureRef; result: ComparisonResult } | null;
  reason: string;
  /** Share of the volume to move at the first survey that is done now (0 to 1), or null. */
  progress: number | null;
  /** In-tolerance share of the covered area on the current survey. */
  tolerance: {
    share: number;
    areaM2: number;
    inToleranceM2: number;
    cutM2: number;
    fillM2: number;
  } | null;
}

export interface SectionReport {
  ref: string;
  label: string;
  lengthM: number;
  profiles: { label: string; chainage: number[]; z: (number | null)[] }[];
}

export interface LiftReport {
  capture: CaptureRef;
  volumeM3: number | null;
  /** Weighbridge tonnes for the lift (the survey's date), else null. */
  tonnes: number | null;
  /** Achieved density, tonnes over volume (the weight calculator), t/m³. */
  densityTPerM3: number | null;
  status: ComparisonResult['status'] | 'missing';
  reason: string;
}

export interface LandfillReport {
  ref: string;
  id: string;
  label: string;
  /** The design the airspace is measured to, in words. */
  design: string;
  /** Airspace remaining to the design on the latest survey (the fill still possible), m³. */
  airspace: { capture: CaptureRef; remainingM3: number; result: ComparisonResult } | null;
  airspaceReason: string;
  lifts: LiftReport[];
  usedM3: number;
  tonnes: number | null;
}

/** Everything the survey sections and CSVs print. */
export interface SurveyReportData {
  basis: SurveyBasis;
  /** Surveys in date order; `current` the latest with a prepared surface. */
  captures: CaptureRef[];
  current: CaptureRef | null;
  /** Prepared surfaces were found (else the stored results are reported as saved). */
  computed: boolean;
  /** Saved measurements in the project (`measurements` may list fewer: the report's cap). */
  measurementCount: number;
  measurements: MeasurementReport[];
  stockpiles: StockpileInventory;
  earthworks: EarthworksReport[];
  sections: SectionReport[];
  landfill: LandfillReport[];
}

// ---------------------------------------------------------------- arithmetic

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** The volume of an ok or partial result (refused and stale results are never added). */
export const usableVolume = (r: ComparisonResult | null | undefined): number | null =>
  r && (r.status === 'ok' || r.status === 'partial') ? Math.abs(r.netM3) : null;

/**
 * The inventory: each pile on the latest survey and the one before (the change since the last
 * survey), tonnes from its material, and totals per material and in all. A pile without a volume
 * on a survey is listed and never added; a pile without a density has no tonnes.
 */
export function stockpileInventory(
  piles: readonly StockpileReport[],
  captures: readonly CaptureRef[],
): StockpileInventory {
  const dated = captures.filter((c) =>
    piles.some((p) => p.volumes.some((v) => v.capture.id === c.id)),
  );
  const current = dated.at(-1) ?? null;
  const previous = dated.length > 1 ? (dated.at(-2) ?? null) : null;
  const on = (p: StockpileReport, c: CaptureRef | null) =>
    c ? (p.volumes.find((v) => v.capture.id === c.id) ?? null) : null;
  const rows: StockpileRow[] = piles.map((p) => {
    const cur = on(p, current);
    const prev = on(p, previous);
    const currentM3 = cur?.volumeM3 ?? null;
    const previousM3 = prev?.volumeM3 ?? null;
    const density = p.material?.densityTPerM3 ?? null;
    const t = (v: number | null) => (v !== null && density !== null ? v * density : null);
    const changeM3 = currentM3 !== null && previousM3 !== null ? currentM3 - previousM3 : null;
    return {
      ...p,
      current: cur,
      previous: prev,
      currentM3,
      previousM3,
      changeM3,
      densityTPerM3: density,
      tonnes: t(currentM3),
      previousTonnes: t(previousM3),
      changeTonnes: t(changeM3),
    };
  });
  const total = (list: readonly StockpileRow[], material: string | null, name: string) => {
    const counted = list.filter((r) => r.currentM3 !== null);
    const both = list.filter((r) => r.changeM3 !== null);
    const allTonnes = counted.every((r) => r.tonnes !== null);
    return {
      material,
      name,
      piles: list.length,
      currentM3: sum(counted.map((r) => r.currentM3 ?? 0)),
      previousM3: previous ? sum(list.map((r) => r.previousM3 ?? 0)) : null,
      changeM3: previous && both.length > 0 ? sum(both.map((r) => r.changeM3 ?? 0)) : null,
      tonnes: counted.length > 0 && allTonnes ? sum(counted.map((r) => r.tonnes ?? 0)) : null,
      changeTonnes:
        previous && both.length > 0 && both.every((r) => r.changeTonnes !== null)
          ? sum(both.map((r) => r.changeTonnes ?? 0))
          : null,
    } satisfies InventoryTotal;
  };
  const order: (string | null)[] = [];
  for (const r of rows) {
    const id = r.material?.id ?? null;
    if (!order.includes(id)) order.push(id);
  }
  const byMaterial = order.map((id) => {
    const list = rows.filter((r) => (r.material?.id ?? null) === id);
    const name = list[0]?.material?.name ?? '';
    return total(list, id, name);
  });
  return { captures: dated, current, previous, rows, byMaterial, total: total(rows, null, '') };
}

/** Share of the work done since the first survey: 1 - remaining / first (both totals moved). */
export function earthworksProgress(firstTotalM3: number, currentTotalM3: number): number | null {
  if (!(firstTotalM3 > 0) || !Number.isFinite(currentTotalM3)) return null;
  return Math.min(1, Math.max(0, 1 - currentTotalM3 / firstTotalM3));
}

/** Achieved density of a lift: weighbridge tonnes over the lift's volume, or null. */
export function compaction(tonnes: number | null, volumeM3: number | null): number | null {
  if (tonnes === null || volumeM3 === null || !(volumeM3 > 0)) return null;
  return tonnes / volumeM3;
}

/** One weighbridge entry: tonnes received up to a survey date. */
export interface WeighbridgeEntry {
  date: string;
  tonnes: number;
}

/**
 * A weighbridge log (`survey/weighbridge.csv`: a header naming a `date` column, ISO dates, and a
 * `tonnes` column; comma, semicolon or tab separated; other columns ignored). Tonnes on the same
 * date add up. Lines that do not parse are left out.
 */
export function parseWeighbridge(text: string): WeighbridgeEntry[] {
  const lines = text
    .replace(BOM_START, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  const head = lines[0];
  if (!head) return [];
  const sep = head.includes(';') ? ';' : head.includes('\t') ? '\t' : ',';
  const cols = head.split(sep).map((c) => c.trim().toLowerCase());
  const di = cols.findIndex((c) => c === 'date');
  const ti = cols.findIndex((c) => c === 'tonnes' || c === 't' || c === 'tonnage');
  if (di < 0 || ti < 0) return [];
  const byDate = new Map<string, number>();
  for (const line of lines.slice(1)) {
    const cells = line.split(sep).map((c) => c.trim());
    const date = cells[di] ?? '';
    const tonnes = Number(cells[ti]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(tonnes) || tonnes < 0) continue;
    byDate.set(date, (byDate.get(date) ?? 0) + tonnes);
  }
  return [...byDate]
    .map(([date, tonnes]) => ({ date, tonnes }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ---------------------------------------------------------------- units

const SI_UNIT: Record<Quantity, string> = {
  distance: 'm',
  coordinate: 'm',
  area: 'm2',
  volume: 'm3',
  density: 't/m3',
  mass: 'kg',
  grade: 'rise/run',
};

const QUANTITIES: readonly string[] = Object.keys(SI_UNIT);
const isQuantity = (k: SurveyValueKind): k is Quantity => QUANTITIES.includes(k);

/** The site unit a quantity is shown in. */
export function displayUnit(quantity: Quantity, units: SurveyUnits): AnyUnit {
  return units[quantity === 'coordinate' ? 'distance' : quantity];
}

/** A value in the display unit (no grouping), with that unit's label; SI for other kinds. */
export function inDisplayUnit(
  si: number,
  kind: SurveyValueKind,
  units: SurveyUnits,
): { value: number; unit: string } {
  if (!isQuantity(kind)) return { value: si, unit: kind === 'bearing' ? 'deg' : '' };
  const unit = displayUnit(kind, units);
  if (kind === 'grade') return { value: gradeIn(si, units.grade), unit: unitLabel(unit) };
  const q = kind === 'coordinate' ? 'distance' : kind;
  return { value: fromSI(si, q, unit), unit: unitLabel(unit) };
}

// ---------------------------------------------------------------- CSV

const BOM = String.fromCharCode(0xfeff);
const BOM_START = new RegExp(`^${BOM}`);

function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(round(v)) : '';
  // a person's text that a spreadsheet would run as a formula is kept as text
  const s = /^[=+@]/.test(v) ? `'${noDashes(v)}` : noDashes(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Numbers to 9 significant decimals: float noise never reaches the file. */
const round = (v: number) => Math.round(v * 1e9) / 1e9;

const csv = (rows: readonly (readonly (string | number | null | undefined)[])[]) =>
  `${BOM}${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;

/** The basis columns every survey CSV row carries. */
const BASIS_HEAD = ['crs', 'vertical_datum', 'geoid', 'calibration', 'distances'] as const;
const basisCells = (b: SurveyBasis) => [
  b.crs,
  b.verticalDatum,
  b.geoid ?? '',
  b.calibration?.id ?? '',
  b.distances,
];

/** The measurement report CSV columns. Stable: new columns are only ever appended. */
export const MEASUREMENTS_CSV_COLUMNS = [
  'ref',
  'measurement_id',
  'label',
  'folder',
  'template',
  'tool',
  'survey_date',
  'material',
  'item',
  'item_label',
  'display',
  'value',
  'unit',
  'value_si',
  'unit_si',
  'status',
  'note',
  ...BASIS_HEAD,
] as const;

/**
 * Every item of every measurement, one row each: the readouts in the template's order, then each
 * comparison's cut, fill, net, total and area (with its status: a stale, partial or refused
 * result says so), then the custom fields. Values as displayed (the app's text, and the number in
 * the display unit) and in SI.
 */
export function measurementsCsv(data: SurveyReportData): string {
  const rows: (string | number | null)[][] = [[...MEASUREMENTS_CSV_COLUMNS]];
  const basis = basisCells(data.basis);
  for (const m of data.measurements) {
    const head = [
      m.ref,
      m.id,
      m.label,
      m.folder ?? '',
      m.template ?? '',
      m.tool,
      m.capture?.date ?? '',
      m.material?.name ?? '',
    ];
    const value = (
      key: string,
      label: string,
      si: number | null,
      kind: SurveyValueKind,
      display: string,
      status: string,
      note: string,
    ) => {
      const shown = si === null ? null : inDisplayUnit(si, kind, m.units);
      rows.push([
        ...head,
        key,
        label,
        display,
        shown?.value ?? null,
        shown?.unit ?? '',
        si,
        si === null || !isQuantity(kind) ? (kind === 'bearing' ? 'deg' : '') : SI_UNIT[kind],
        status,
        note,
        ...basis,
      ]);
    };
    for (const v of m.values)
      value(v.key, v.label, v.si, v.kind, v.display, v.si === null ? 'missing' : 'ok', '');
    for (const c of m.comparisons) {
      const r = c.result;
      const status = r?.status ?? 'missing';
      const note = r
        ? [
            r.reason ?? '',
            r.usedDeadband ? `deadband ${String(r.deadbandM)} m used` : '',
            `${r.fromLabel} to ${r.toLabel}`,
          ]
            .filter(Boolean)
            .join('; ')
        : c.reason;
      const shown = r && r.status !== 'refused';
      for (const [k, label, si, kind] of [
        ['cut', 'Cut', shown ? r.cutM3 : null, 'volume'],
        ['fill', 'Fill', shown ? r.fillM3 : null, 'volume'],
        ['net', 'Net', shown ? r.netM3 : null, 'volume'],
        ['total', 'Total moved', shown ? r.totalM3 : null, 'volume'],
        ['area', 'Area', shown ? r.areaM2 : null, 'area'],
        ['uncovered', 'Not covered', shown ? r.uncoveredM2 : null, 'area'],
      ] as const)
        value(
          `${c.item}.${k}`,
          `${c.label}: ${label}`,
          si,
          kind,
          si === null ? '' : formatQuantity(si, kind, m.units, data.basis.precision),
          status,
          note,
        );
    }
    for (const f of m.fields)
      rows.push([...head, 'field', f.name, f.value, null, '', null, '', 'ok', '', ...basis]);
  }
  return csv(rows);
}

/**
 * The stockpile inventory CSV, generalising the stockpile kit's register (`registerCsv`, which
 * stays as it is): one row per pile with its material and density, its volume and tonnes on every
 * survey it was computed for, the change since the last survey, and the latest volume and tonnes
 * in the site's display units; then the materials summary (a total row per material) and the grand
 * total. A pile without a volume on a survey has an empty cell and its status says why.
 */
export function stockpileCsv(data: SurveyReportData): string {
  const inv = data.stockpiles;
  const u = data.basis.units;
  const volUnit = unitLabel(u.volume);
  const massUnit = unitLabel(u.mass);
  const head = ['row', 'pile', 'ref', 'name', 'material', 'material_code', 'density_t_m3', 'base'];
  for (const c of inv.captures)
    head.push(`${c.date}_volume_m3`, `${c.date}_tonnes`, `${c.date}_status`);
  head.push(
    'current_date',
    'current_volume_m3',
    'current_tonnes',
    'previous_date',
    'previous_volume_m3',
    'change_m3',
    'change_tonnes',
    `current_volume_${volUnit}`,
    `current_mass_${massUnit}`,
    `change_${volUnit}`,
    ...BASIS_HEAD,
  );
  const basis = basisCells(data.basis);
  const vol = (v: number | null) => (v === null ? null : fromSI(v, 'volume', u.volume));
  const mass = (t: number | null) => (t === null ? null : fromSI(t * 1000, 'mass', u.mass));
  const rows: (string | number | null)[][] = [head];
  for (const r of inv.rows) {
    const line: (string | number | null)[] = [
      'pile',
      r.id,
      r.ref,
      r.label,
      r.material?.name ?? '',
      r.material?.code ?? '',
      r.densityTPerM3,
      r.base,
    ];
    for (const c of inv.captures) {
      const v = r.volumes.find((x) => x.capture.id === c.id);
      const d = r.densityTPerM3;
      line.push(
        v?.volumeM3 ?? null,
        v?.volumeM3 !== null && v?.volumeM3 !== undefined && d !== null ? v.volumeM3 * d : null,
        v ? (v.reason ? `${v.status}: ${v.reason}` : v.status) : '',
      );
    }
    line.push(
      inv.current?.date ?? '',
      r.currentM3,
      r.tonnes,
      inv.previous?.date ?? '',
      r.previousM3,
      r.changeM3,
      r.changeTonnes,
      vol(r.currentM3),
      mass(r.tonnes),
      vol(r.changeM3),
      ...basis,
    );
    rows.push(line);
  }
  const totalRow = (t: InventoryTotal, kind: string) => {
    const material = t.material === null && kind === 'material' ? '(no material)' : t.name;
    const line: (string | number | null)[] = [
      kind,
      '',
      '',
      `${String(t.piles)} piles`,
      material,
      '',
      null,
      '',
    ];
    for (const c of inv.captures) {
      const vs = inv.rows
        .filter((r) => kind === 'total' || (r.material?.id ?? null) === t.material)
        .map((r) => r.volumes.find((x) => x.capture.id === c.id)?.volumeM3 ?? null);
      line.push(vs.some((v) => v !== null) ? sum(vs.map((v) => v ?? 0)) : null, null, '');
    }
    line.push(
      inv.current?.date ?? '',
      t.currentM3,
      t.tonnes,
      inv.previous?.date ?? '',
      t.previousM3,
      t.changeM3,
      t.changeTonnes,
      vol(t.currentM3),
      mass(t.tonnes),
      vol(t.changeM3),
      ...basis,
    );
    rows.push(line);
  };
  for (const t of inv.byMaterial) totalRow(t, 'material');
  totalRow(inv.total, 'total');
  return csv(rows);
}
