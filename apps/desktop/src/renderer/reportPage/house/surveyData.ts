// The survey sections' data (M11 G9, PRD SRV-13): the project's survey files read through the
// report page's fetch, and the figures the app shows. A measurement's comparisons are its stored
// results (stale when their inputs changed since, a figure carried from an earlier version as it
// is), so a pile never prints a figure its card does not show. The volumes over time and the site
// inventory are the Volumes view's (`pileSeries` and `inventorySeries`, its total rule): the dates
// it would work out are worked out here in memory with the app's engine (`EngineSession`, the
// same inputs and line-ups), nothing is written. Earthworks, sections and landfill are computed
// now by the same engine. The readouts are formatted as the panel formats them. The PDF sections
// and the CSVs are made from what this returns, so they always agree. Without prepared surfaces
// the stored results are reported as they were saved (and say so).
import {
  compaction,
  earthworksProgress,
  parseWeighbridge,
  stockpileInventory,
  surveyBasis,
  SURVEY_SECTIONS,
  type CaptureRef,
  type ComparisonReport,
  type EarthworksReport,
  type LandfillReport,
  type LiftReport,
  type MeasurementReport,
  type PileVolume,
  type SectionReport,
  type StockpileReport,
  type SurveyReportData,
  type SurveyValue,
  type WeighbridgeEntry,
} from '@aio/project/export';
import {
  BoundaryEditsFile,
  CALIBRATION_FILE,
  defaultSurveySettings,
  DESIGNS_FILE,
  DesignsFile,
  HeightTiles,
  isMeasurementEntry,
  isSurfaceSide,
  knownParts,
  MEASUREMENTS_FILE,
  MeasurementsFile,
  REPORT_TEMPLATE_FILE,
  ReportTemplateFile,
  SiteCalibration,
  SURVEY_SETTINGS_FILE,
  SURVEY_TEMPLATES_FILE,
  SurveySettings,
  SurveyTemplatesFile,
  VolumesFile,
  type ComparisonItem,
  type ComparisonResult,
  type DesignEntry,
  type MeasurementScope,
  type ProjectManifest,
  type ReportSectionId,
  type SiteMaterial,
  type SitePoint,
  type SurfaceRef,
  type SurveyMeasurement,
  type SurveyTemplate,
  type TemplatePart,
} from '@aio/schema';
import {
  allRows,
  compareItem,
  effectiveUnits,
  formatRow,
  industryTemplates,
  inventoryPiles,
  inventorySeries,
  lineLength,
  surfaceKey,
  measurementReadout,
  newShared,
  kitDensity,
  openWithKitPiles,
  pileMaterial,
  repairKitHeights,
  type KitDensity,
  type KitHeightAt,
  pileSeries,
  resolveSection,
  ringShifts,
  sampleSection,
  samplerOf,
  seriesApplies,
  seriesRequests,
  sideLabel,
  surfaceOfCapture,
  toleranceShare,
  volumeRows,
  type ChartSeries,
  type GridOut,
  type HeightSampler,
  type PointSampler,
  type Resolve,
  type SectionRef,
  type StackRow,
  type TimeRow,
} from '@aio/survey';
import { localeOf } from '@aio/geo';
import { DEFAULT_ANGLES } from '@aio/schema';
import { t, type MessageKey } from '@aio/ui';
import { baseName, kitBaseName } from '../../survey/card/baseNames';
import { cardModel, type CardModel } from '../../survey/card/cardModel';
import {
  dsmHeightAt,
  dsmOnly,
  kitDsmPath,
  kitEpochsWanted,
  kitRepairHeights,
  wantsKitHeights,
} from '../../survey/kitHeights';
import { measurementHasChart } from '../../survey/card/chartRule';
import { presample, readsSurface } from '../../survey/card/terrain';
import type { EngineContext } from '../../survey/engineProtocol';
import { EngineSession } from '../../survey/engineServe';
import { drawnShifts, onDrawnPoints } from '../../survey/dateReadout';
import { drawnPoints } from '../../survey/measureDates';
import { captureDateOf, weighRows } from '../../survey/volumes/surveyDates';
import { carriedItem, datesToRun, lineUps, seriesDate, seriesKeyOf } from '../../survey/seriesRule';

type Key = Parameters<typeof t>[0];
const tk = (key: string, vars?: Record<string, string | number>) => t(key as Key, vars);

/** Where the weighbridge log of a landfill lives (date and tonnes columns). */
export const WEIGHBRIDGE_FILE = 'survey/weighbridge.csv';

/** The report lists at most this many measurements; the measurements CSV has every one. */
export const REPORT_MEASUREMENTS_MAX = 300;

/** Project files the survey data is read from (the report page's `aio://` fetch). */
export interface SurveyReader {
  json(path: string): Promise<unknown>;
  text(path: string): Promise<string | null>;
  bytes(path: string): Promise<Uint8Array | null>;
}

/** The stockpile kit's figures, read only to carry an older project's piles over (in memory). */
export const KIT_VOLUMES_FILE = 'volumes.json';
export const KIT_EDITS_FILE = 'edits/boundaries.json';

/** The survey files of a project, parsed. */
export interface SurveyFiles {
  manifest: ProjectManifest;
  settings: SurveySettings;
  calibration: SiteCalibration | null;
  measurements: SurveyMeasurement[];
  designs: DesignEntry[];
  surfaces: HeightTiles[];
  /** The project's templates and the enabled industry sets (names, rows, fields, sets). */
  templates: SurveyTemplate[];
  weighbridge: WeighbridgeEntry[];
  /** The report template (`report/template.json`, W8): which measurements and parts print. */
  template?: ReportTemplateFile | null;
  /** The stockpile kit's density, for its piles' tonnes (`pileMaterial`); null without kit data. */
  kit?: KitDensity | null;
}

function parsed<T>(schema: { safeParse(v: unknown): { success: boolean; data?: T } }, v: unknown) {
  if (v === null || v === undefined) return null;
  const r = schema.safeParse(v);
  return r.success ? (r.data ?? null) : null;
}

/**
 * The measurements file as the app opens it (`@aio/survey` `openWithKitPiles`, the rule the
 * measure store and the assistant use too), in memory only: the kit piles not converted yet added
 * as volume measurements, their kit figures carried ("From an earlier version") only when the
 * file was never converted (`kitPilesConverted` absent: an old project, or no measurements file at
 * all). With `heightAt` (the kit's DSMs) the outlines are draped on the ground of their date.
 * Null when there is neither a file nor a kit pile.
 */
export function withKitPiles(
  file: MeasurementsFile | null,
  volumes: VolumesFile | null,
  edits: BoundaryEditsFile | null,
  manifest: ProjectManifest,
  materials: readonly SiteMaterial[],
  heightAt?: KitHeightAt,
): MeasurementsFile | null {
  if (!volumes) return file;
  let n = 0;
  return openWithKitPiles(
    file ?? { schema: 'aio.measurements/1', measurements: [] },
    { volumes, edits },
    {
      origin: manifest.origin,
      materials,
      now: new Date().toISOString(),
      newId: () => `kit-report-${String(++n)}`,
      ...(heightAt ? { heightAt } : {}),
      // nothing is written from the report: no file is marked converted
      readOnly: true,
    },
  );
}

/**
 * The kit's piles as the app opens them, with their heights: draped on the kit's DSM of their
 * date when converted here, and piles converted at Z 0 before heights repaired, in memory only.
 */
async function withKitPileHeights(
  read: SurveyReader,
  file: MeasurementsFile | null,
  volumes: VolumesFile | null,
  edits: BoundaryEditsFile | null,
  manifest: ProjectManifest,
  materials: readonly SiteMaterial[],
): Promise<MeasurementsFile | null> {
  const asIs = file ?? { schema: 'aio.measurements/1' as const, measurements: [] };
  if (!volumes || !wantsKitHeights(asIs, volumes))
    return withKitPiles(file, volumes, edits, manifest, materials);
  const heightAt = await dsmHeightAt(kitEpochsWanted(asIs, volumes, edits), (epoch) =>
    read.text(kitDsmPath(epoch, volumes)),
  );
  const opened = withKitPiles(file, volumes, edits, manifest, materials, heightAt);
  if (!opened) return opened;
  const heights = await kitRepairHeights(opened, manifest, dsmOnly(volumes, heightAt, edits));
  return repairKitHeights(opened, heights).file;
}

/**
 * Read the survey files; null when the project has no survey measurements (nor kit piles to carry
 * over). `surfaceIds` are the prepared surfaces main listed (`survey/surfaces/<id>/tiles.json`).
 */
export async function readSurveyFiles(
  read: SurveyReader,
  manifest: ProjectManifest,
  surfaceIds: readonly string[],
): Promise<SurveyFiles | null> {
  const [fileRaw, kitRaw, editsRaw, settingsRaw] = await Promise.all([
    read.json(MEASUREMENTS_FILE),
    read.json(KIT_VOLUMES_FILE),
    read.json(KIT_EDITS_FILE),
    read.json(SURVEY_SETTINGS_FILE),
  ]);
  const settings = parsed<SurveySettings>(SurveySettings, settingsRaw) ?? defaultSurveySettings();
  const kit = parsed<VolumesFile>(VolumesFile, kitRaw);
  const file = await withKitPileHeights(
    read,
    parsed<MeasurementsFile>(MeasurementsFile, fileRaw),
    kit,
    parsed<BoundaryEditsFile>(BoundaryEditsFile, editsRaw),
    manifest,
    settings.materials,
  );
  if (!file || file.measurements.length === 0) return null;
  const [calRaw, designsRaw, templatesRaw, reportRaw, weigh, ...tiles] = await Promise.all([
    read.json(CALIBRATION_FILE),
    read.json(DESIGNS_FILE),
    read.json(SURVEY_TEMPLATES_FILE),
    read.json(REPORT_TEMPLATE_FILE),
    read.text(WEIGHBRIDGE_FILE),
    ...surfaceIds.map((id) => read.json(`survey/surfaces/${id}/tiles.json`)),
  ]);
  const project = parsed<SurveyTemplatesFile>(SurveyTemplatesFile, templatesRaw);
  const surfaces = tiles
    .map((x) => parsed<HeightTiles>(HeightTiles, x))
    .filter((x): x is HeightTiles => x !== null);
  return {
    manifest,
    settings,
    calibration: parsed<SiteCalibration>(SiteCalibration, calRaw),
    measurements: file.measurements,
    designs: parsed<DesignsFile>(DesignsFile, designsRaw)?.designs ?? [],
    surfaces,
    templates: surveyTemplateList(project, settings),
    weighbridge: typeof weigh === 'string' ? parseWeighbridge(weigh) : [],
    template: parsed<ReportTemplateFile>(ReportTemplateFile, reportRaw),
    kit: kitDensity(kit),
  };
}

/**
 * The survey data a house report prints: one that cannot be worked out (a tile that will not read,
 * say) leaves the survey parts out of the report, logged, rather than failing a report that
 * prints other things too. A survey report has nothing else to print, so it fails with the reason.
 */
export async function surveyOrNone(
  build: () => Promise<ReportSurveyData>,
  surveyOnly: boolean,
): Promise<ReportSurveyData | null> {
  try {
    return await build();
  } catch (e) {
    if (surveyOnly) throw e;
    console.warn('Report: the survey volumes could not be worked out and are left out', e);
    return null;
  }
}

/** The project's templates and the enabled industry sets (a project template wins its id). */
export function surveyTemplateList(
  project: SurveyTemplatesFile | null,
  settings: SurveySettings,
): SurveyTemplate[] {
  return [
    ...(project?.templates ?? []),
    ...industryTemplates(settings.templateSets).filter(
      (x) => !project?.templates.some((p) => p.id === x.id),
    ),
  ];
}

// ---------------------------------------------------------------- what each measurement is

const isBase = (r: SurfaceRef) => !isSurfaceSide(r);
const isDesign = (r: SurfaceRef) => r.kind === 'design';
const isCurrent = (r: SurfaceRef) => r.kind === 'current';

/** A stockpile: a polygon whose first item is a base to a survey (the panel's calculator item). */
export function stockpileItem(m: SurveyMeasurement): ComparisonItem | null {
  const it = m.items[0];
  if (m.family !== 'polygon' || !it) return null;
  return isBase(it.from) && isSurfaceSide(it.to) && !isDesign(it.to) ? it : null;
}

/** An item between the survey on screen and a design (either way round). */
export const designItems = (m: SurveyMeasurement): ComparisonItem[] =>
  m.family !== 'polygon'
    ? []
    : m.items.filter(
        (it) => (isCurrent(it.from) && isDesign(it.to)) || (isDesign(it.from) && isCurrent(it.to)),
      );

interface LandfillItems {
  /** The survey before to the survey on screen (a lift). */
  lift: ComparisonItem | null;
  /** A design (the cell base) to the survey: placed so far. */
  placed: ComparisonItem | null;
  /** The survey to a design (the final cap): airspace remaining. */
  airspace: ComparisonItem | null;
}

export function landfillItems(m: SurveyMeasurement): LandfillItems {
  const find = (f: (it: ComparisonItem) => boolean) => m.items.find(f) ?? null;
  return {
    lift: find((it) => it.from.kind === 'previous' && isCurrent(it.to)),
    placed: find((it) => isDesign(it.from) && isCurrent(it.to)),
    airspace: find((it) => isCurrent(it.from) && isDesign(it.to)),
  };
}

/**
 * A landfill cell: a polygon from a landfill template, or on a site that uses the landfill set
 * (and not the construction one), with a lift, placed or airspace item.
 */
export function isLandfill(
  m: SurveyMeasurement,
  files: Pick<SurveyFiles, 'settings' | 'templates'>,
) {
  if (m.family !== 'polygon') return false;
  const items = landfillItems(m);
  if (!items.lift && !items.placed && !items.airspace) return false;
  const tpl = files.templates.find((x) => x.id === m.template);
  if (tpl?.set) return tpl.set === 'landfill';
  const sets = files.settings.templateSets;
  return sets.includes('landfill') && !sets.includes('construction');
}

export interface SurveyPlan {
  /** The volume measurements: the Volumes view's piles (`inventoryPiles`), so the totals agree. */
  stockpiles: SurveyMeasurement[];
  earthworks: SurveyMeasurement[];
  landfill: SurveyMeasurement[];
  /** Cross-section lines printed with the earthworks. */
  sections: SurveyMeasurement[];
}

export function surveyPlan(files: Pick<SurveyFiles, 'measurements' | 'settings' | 'templates'>) {
  const landfill = files.measurements.filter((m) => isLandfill(m, files));
  const lf = new Set(landfill.map((m) => m.id));
  const earthworks = files.measurements.filter((m) => !lf.has(m.id) && designItems(m).length > 0);
  return {
    stockpiles: inventoryPiles(files.measurements),
    earthworks,
    landfill,
    sections:
      earthworks.length > 0
        ? files.measurements.filter((m) => m.tool === 'section').slice(0, 12)
        : [],
  } satisfies SurveyPlan;
}

/** A volume measurement with figures on two survey dates or more (stored or per date). */
export function hasVolumeOverTime(m: SurveyMeasurement): boolean {
  if (m.tool !== 'volume' || m.family !== 'polygon') return false;
  const dated = pileSeries(m).series.filter((r) => r.status !== 'refused' && seriesDate(r) !== '');
  return new Set(dated.map(seriesDate)).size >= 2;
}

/** The survey sections that have something to print. */
export function surveySectionIds(
  files: Pick<SurveyFiles, 'measurements' | 'settings' | 'templates'>,
): ReportSectionId[] {
  const plan = surveyPlan(files);
  const has: Record<(typeof SURVEY_SECTIONS)[number], boolean> = {
    measurements: files.measurements.length > 0,
    earthworks: plan.earthworks.length > 0,
    stockpiles: plan.stockpiles.length > 0,
    landfill: plan.landfill.length > 0,
    'volume-over-time': plan.stockpiles.some(hasVolumeOverTime),
  };
  return SURVEY_SECTIONS.filter((id) => has[id]);
}

/**
 * A base's standard name, as the volume card's base picker names it (`baseNames.ts`):
 * "Triangulated toe", "Lowest point" ...; a survey or design side by its own name.
 */
export function standardBaseName(ref: SurfaceRef): string {
  return baseName(
    ref,
    [],
    (k: MessageKey) => t(k),
    (r) => sideLabel(r, null),
  );
}

// ---------------------------------------------------------------- the engine

const ringOf = (m: SurveyMeasurement): [number, number][] => m.points.map((p) => [p[0], p[1]]);

/** The survey a survey-scoped measurement's ring is stored for; absent for a site-wide one. */
const scopeOf = (m: SurveyMeasurement): string | undefined =>
  m.scope.kind === 'survey' ? m.scope.capture : undefined;

/** The engine session's files come through the report's reader: its URL back to the path. */
const ENGINE_BASE = 'aio://report/';
const pathOf = (url: string) =>
  url.slice(ENGINE_BASE.length).split('/').map(decodeURIComponent).join('/');

/**
 * One engine for the report: the app's own engine session (`EngineSession`, its resolvers,
 * fingerprints and per-date runs) over the project's surfaces, designs and line-ups, results
 * memoised.
 */
class Engine {
  readonly session: EngineSession;
  private memo = new Map<string, Promise<ComparisonResult | null>>();
  private ctx: EngineContext;
  constructor(
    private files: SurveyFiles,
    bytes: (path: string) => Promise<Uint8Array | null>,
    captures: readonly CaptureRef[],
  ) {
    const s = files.settings;
    this.ctx = {
      base: ENGINE_BASE,
      surfaces: files.surfaces,
      captures: captures.map((c) => c.id),
      designs: files.designs,
      site: {
        verticalDatum: s.verticalDatum,
        ...(s.calibration ? { calibration: s.calibration } : {}),
      },
      ...lineUps(files.manifest),
    };
    this.session = new EngineSession(this.ctx, (url) => bytes(pathOf(url)));
  }

  resolver(capture?: string): Resolve {
    return this.session.resolver(capture);
  }

  /** The ring of a survey-scoped measurement is stored unshifted (`ringShifts`). */
  private ringShift(m: SurveyMeasurement) {
    return ringShifts(this.files.surfaces, this.ctx.shifts, scopeOf(m), this.ctx.turns);
  }

  /** One item on one survey, or null when the engine failed (the reason is in `problems`). */
  result(m: SurveyMeasurement, item: ComparisonItem, capture: string, grid?: GridOut[]) {
    const key = `${m.id}\u0000${item.id}\u0000${capture}`;
    const known = grid ? undefined : this.memo.get(key);
    if (known) return known;
    const run = compareItem(
      ringOf(m),
      item,
      this.resolver(capture),
      { site: this.ctx.site, shared: newShared(), ...this.ringShift(m) },
      grid,
    ).catch((e: unknown) => {
      this.problems.set(key, e instanceof Error ? e.message : String(e));
      return null;
    });
    this.memo.set(key, run);
    return run;
  }

  problems = new Map<string, string>();
  problem(m: SurveyMeasurement, item: ComparisonItem, capture: string): string {
    return this.problems.get(`${m.id}\u0000${item.id}\u0000${capture}`) ?? '';
  }

  /** The fingerprint each item of a measurement would have now (nothing computed), or null. */
  async prints(m: SurveyMeasurement): Promise<string[] | null> {
    if (m.family !== 'polygon' || m.items.length === 0 || m.points.length < 3) return null;
    const scope = scopeOf(m);
    try {
      return await this.session.fingerprints({
        ring: ringOf(m),
        items: m.items,
        ...(scope !== undefined ? { capture: scope } : {}),
      });
    } catch {
      return null;
    }
  }

  /** Heights of the survey on screen (or a design), for terrain readouts and sections. */
  async sampler(capture: string): Promise<PointSampler | null> {
    try {
      return samplerOf(await this.resolver(capture)({ kind: 'current' })).sample;
    } catch {
      return null;
    }
  }
}

/**
 * A measurement's stored results as its card shows them: a result whose inputs changed since it
 * was computed (`prints`, the fingerprints now) is marked stale; a figure carried over from an
 * earlier version is what it was, never stale (R16).
 */
export function storedResults(
  m: SurveyMeasurement,
  prints: readonly string[] | null,
): ComparisonResult[] {
  return m.results.map((r) => {
    if (r.carried || r.status === 'stale') return r;
    const k = m.items.findIndex((it) => it.id === r.item);
    const fp = prints?.[k];
    return fp !== undefined && fp !== r.fingerprint ? { ...r, status: 'stale' as const } : r;
  });
}

// ---------------------------------------------------------------- volume over time

/** One volume measurement over the survey dates, as its card and the Volumes view show it. */
export interface PileOverTime {
  id: string;
  ref: string;
  label: string;
  folder: string | null;
  material: SiteMaterial | null;
  /** The base in words: its standard name, or the survey or design it is. */
  base: string;
  /** "From an earlier version (kit, Triangulated)" when its figures are carried over, else null. */
  carried: string | null;
  /** One row per survey date (`volumeRows` of `pileSeries`), stale rows marked. */
  rows: TimeRow[];
  /**
   * Its outline (E, N) in the project CRS, as drawn, on the latest survey date: the site page's
   * stockpile map.
   */
  outline: [number, number][];
  /** Its outline (E, N) as drawn on each survey date, by capture id (`outlineOn`). */
  outlines: Record<string, [number, number][]>;
  /**
   * Its peak height (`ComparisonResult.peakM`, metres above its base) by capture id: only dates
   * whose figure is current (not stale or refused) and whose result has one.
   */
  peaks?: Record<string, number>;
}

/** The peak height on each date of `rows`, from the result each row was read from (`toCapture`). */
export function peaksOf(
  series: readonly ComparisonResult[],
  rows: readonly TimeRow[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.stale || row.valueM3 === null) continue;
    const r = series.find((x) => x.toCapture === row.capture);
    if (r && r.status !== 'refused' && r.peakM !== undefined) out[row.capture] = r.peakM;
  }
  return out;
}

/**
 * A measurement's drawn outline on each capture (one drawing per distinct outline) and the latest
 * as its outline; `points` on every capture without one of its own.
 */
function outlinesOf(
  m: SurveyMeasurement,
  ids: readonly string[],
  draw: (points: readonly SitePoint[]) => [number, number][],
): Pick<PileOverTime, 'outline' | 'outlines'> {
  const outlines: Record<string, [number, number][]> = {};
  for (const sr of seriesRequests(m, ids)) {
    const drawn = draw(sr.ring);
    for (const c of sr.captures) outlines[c] = drawn;
  }
  const last = ids.at(-1);
  return {
    outline: (last !== undefined ? outlines[last] : undefined) ?? draw(m.points),
    outlines,
  };
}

/** The volume measurements over time and the site inventory (the Volumes view's rule). */
export interface VolumesOverTime {
  piles: PileOverTime[];
  /** One row per survey date: the current figures added, the rest named (`inventorySeries`). */
  inventory: StackRow[];
}

/** A chart a template entry prints (W8), drawn by the shared charts. */
export type EntryChart =
  | { kind: 'profile'; series: ChartSeries[] }
  | {
      kind: 'elevation';
      rows: { capture: string; date: string; label: string; z: number | null }[];
      /** The point's own level (an elevation difference), metres. */
      level: number | null;
    }
  | { kind: 'volume'; rows: TimeRow[] };

/** A measurement the report template names, with the parts to print (W8). */
export interface ReportEntry {
  ref: string;
  /** The measurement with its stored results as its card shows them (stale marked). */
  m: SurveyMeasurement;
  parts: readonly TemplatePart[];
  chart: EntryChart | null;
  /**
   * Its card, as the app's detail card shows it: drawn where the app draws it (the date's
   * line-up added) with the survey's heights under it.
   */
  card: CardModel;
}

/** Everything the report prints of the survey: the CSVs' data and the volumes over time. */
export interface ReportSurveyData extends SurveyReportData {
  volumes: VolumesOverTime;
  /** The report template's measurement entries, in its order; empty without a template. */
  entries: ReportEntry[];
  /** What the cards are formatted with. */
  settings: SurveySettings;
  templates: SurveyTemplate[];
}

/**
 * A sampler of a date's prepared surface for points where the app draws them (the scope's date
 * line-up now added): moved back to where they are stored, then on by the line-up the surface was
 * prepared with, as the panel's card reads them (`onDrawnPoints`).
 */
function drawnOnSurface(
  sample: PointSampler,
  scope: MeasurementScope,
  surface: HeightTiles | null,
  manifest: ProjectManifest,
): PointSampler {
  return onDrawnPoints(sample, drawnShifts(scope, surface, manifest));
}

/**
 * A synchronous height sampler from an async one, for the tools' terrain questions: `ask` runs
 * with every height 0 to collect the places the tools ask for, each is sampled once in one go,
 * and the sampler answers them (`presample`, as the app's card reads its terrain). Undefined
 * without a sampler.
 */
async function presampled(
  ask: (s: HeightSampler) => void,
  sample: PointSampler | null,
): Promise<HeightSampler | undefined> {
  return sample ? presample(ask, (es, ns) => sample(es, ns)) : undefined;
}

// ---------------------------------------------------------------- the data

export type SurveyNeed = 'report' | 'measurements-csv' | 'stockpile-csv';

export interface BuildOptions {
  need: SurveyNeed;
  progress?: (done: number, total: number) => void;
  /**
   * Work out the dates of the volume measurements the app has not yet (in memory): when a
   * section or the summary prints them. Off, only their stored dates are read. Default on.
   */
  fillDates?: boolean;
}

/**
 * The volume measurements over the survey dates as the app shows them, with nothing written
 * (with `fill` off only the stored dates, for a report that prints none of them):
 * each one's dates the Volumes view would work out (`computeSeries`: a date with no row, or a stale
 * one, unless its figures are carried) are worked out in memory by the app's engine, then the card's
 * rule (`pileSeries`: the stored result stands for its own date) and the site inventory's
 * (`inventorySeries`: current figures added, the rest named). A figure is stale when its
 * fingerprint is not the one its inputs give now, as in the app.
 */
async function volumesOverTime(
  piles: readonly SurveyMeasurement[],
  captures: readonly CaptureRef[],
  engine: Engine | null,
  fill: boolean,
  info: {
    ref: (m: SurveyMeasurement) => string;
    material: (m: SurveyMeasurement) => SiteMaterial | null;
    /** An outline of the measurement as drawn (E, N). */
    outline: (m: SurveyMeasurement, points: readonly SitePoint[]) => [number, number][];
    tick: () => void;
  },
): Promise<VolumesOverTime> {
  const ids = captures.map((c) => c.id);
  const storedPrint = new Map<string, string>();
  const seriesPrints = new Map<string, Record<string, string>>();
  const failed = new Map<string, string>();
  const filled: SurveyMeasurement[] = [];
  for (const m of piles) {
    const it = m.items[0];
    let next = m;
    if (engine && it && m.points.length >= 3) {
      const scope = scopeOf(m);
      try {
        const [fp] = (await engine.prints(m)) ?? [];
        if (fp !== undefined) storedPrint.set(m.id, fp);
        if (seriesApplies(it) && !carriedItem(m, it.id)) {
          // each date on its own outline (`seriesRequests`, the Volumes tab's runs): one run per
          // distinct outline, each date's fingerprint of the ring it is worked out on
          const prints: Record<string, string> = {};
          const fresh: ComparisonResult[] = [];
          for (const sr of seriesRequests(m, ids)) {
            const req = {
              ring: sr.ring.map((p): [number, number] => [p[0], p[1]]),
              item: it,
              captures: sr.captures,
              ...(scope !== undefined ? { scope } : {}),
            };
            const fps = await engine.session.seriesFingerprints(req);
            sr.captures.forEach((c, k) => {
              const f = fps[k];
              if (f !== undefined) prints[`${it.id} ${c}`] = f;
            });
            const need = fill ? datesToRun(m, it.id, sr.captures, fps) : [];
            if (need.length > 0)
              fresh.push(...(await engine.session.series({ ...req, captures: need })));
          }
          seriesPrints.set(m.id, prints);
          if (fresh.length > 0) {
            const keys = new Set(fresh.map(seriesKeyOf));
            next = {
              ...m,
              series: [...(m.series ?? []).filter((r) => !keys.has(seriesKeyOf(r))), ...fresh],
            };
          }
        }
      } catch (e) {
        failed.set(m.id, e instanceof Error ? e.message : String(e));
      }
    }
    filled.push(next);
    info.tick();
  }
  const isStale = (m: SurveyMeasurement, r: ComparisonResult, stored: boolean): boolean => {
    if (r.carried) return false;
    if (r.status === 'stale') return true;
    const fp = stored ? storedPrint.get(m.id) : seriesPrints.get(m.id)?.[seriesKeyOf(r)];
    return fp !== undefined && fp !== r.fingerprint;
  };
  const inventory = inventorySeries(filled, captures, {
    isStale,
    failed: (m) => failed.get(m.id),
    ran: (m, capture) => {
      const it = m.items[0];
      return it !== undefined && seriesPrints.get(m.id)?.[`${it.id} ${capture}`] !== undefined;
    },
  });
  const dateOf = captureDateOf(captures);
  return {
    inventory,
    piles: filled.map((m) => {
      const { series, stored } = pileSeries(m);
      const carried = series.find((r) => r.carried)?.carried;
      const it = m.items[0];
      const rows = weighRows(
        volumeRows(series, captures, { isStale: (r) => isStale(m, r, r === stored) }),
        info.material(m),
        dateOf,
      );
      return {
        id: m.id,
        ref: info.ref(m),
        label: m.label,
        folder: m.folder?.trim() ? m.folder.trim() : null,
        material: info.material(m),
        base: it ? standardBaseName(it.from) : '',
        carried: carried ? tk('vol.status.carried', { base: kitBaseName(carried.base, tk) }) : null,
        // each date weighs at the material's density on that date (`densityOn`)
        rows,
        peaks: peaksOf(series, rows),
        ...outlinesOf(m, ids, (points) => info.outline(m, points)),
      };
    }),
  };
}

/** A pile on each survey for the stockpile inventory and its CSV, from its rows over time. */
function pileVolumes(p: PileOverTime, captures: readonly CaptureRef[]): PileVolume[] {
  return p.rows.flatMap((r) => {
    const capture = captures.find((c) => c.id === r.capture);
    if (!capture) return [];
    const status: PileVolume['status'] = r.stale ? 'stale' : r.status;
    return [
      {
        capture,
        volumeM3: r.stale ? null : r.valueM3,
        status,
        reason: r.reason ?? (r.status === 'missing' ? tk('house.survey.notComputed') : ''),
      },
    ];
  });
}

/** A surface on a profile and how the profile chart styles it (by kind, never by order). */
interface KindRef {
  ref: SectionRef;
  kind: 'current' | 'earlier' | 'design';
  date?: string;
}

/** Each surface's heights along a line (400 stations at most), with its kind and date. */
async function sampleProfiles(
  line: readonly (readonly [number, number])[],
  refs: readonly KindRef[],
  resolve: Resolve,
): Promise<SectionReport['profiles']> {
  const { surfaces } = await resolveSection(
    refs.map((r) => r.ref),
    resolve,
  );
  const length = lineLength(line);
  const s = await sampleSection({ line, stepM: Math.max(0.25, length / 400) }, surfaces);
  const byKey = new Map(refs.map((r) => [surfaceKey(r.ref), r]));
  return s.profiles.map((p) => {
    const k = byKey.get(p.surface);
    return {
      label: p.label,
      chainage: p.chainage,
      z: p.z,
      ...(k ? { kind: k.kind } : {}),
      ...(k?.date !== undefined ? { date: k.date } : {}),
    };
  });
}

/** A profile's surfaces as the shared chart's series. */
export const chartSeries = (profiles: SectionReport['profiles']): ChartSeries[] =>
  profiles.map((p, i) => ({
    key: `${p.kind ?? 'current'}-${String(i)}`,
    label: p.label,
    kind: p.kind ?? 'current',
    ...(p.date !== undefined ? { date: p.date } : {}),
    chainage: p.chainage,
    z: p.z,
  }));

/**
 * The chart a template entry prints, as its card draws it (`slots.tsx`): a pile's volume over
 * time, a line's profile on the latest survey and the one before, a point's elevation on each
 * survey (with its own level for an elevation difference).
 */
async function entryChart(
  m: SurveyMeasurement,
  c: {
    volumes: VolumesOverTime;
    engine: Engine;
    current: CaptureRef | null;
    surveyed: readonly CaptureRef[];
    files: SurveyFiles;
  },
): Promise<EntryChart | null> {
  if (m.tool === 'volume') {
    const p = c.volumes.piles.find((x) => x.id === m.id);
    return p ? { kind: 'volume', rows: p.rows } : null;
  }
  if (m.family === 'line') {
    const cur = c.current;
    if (!cur || m.points.length < 2) return null;
    const line = m.points.map((q) => [q[0], q[1]] as const);
    const at = c.surveyed.findIndex((x) => x.id === cur.id);
    const prev = at > 0 ? c.surveyed[at - 1] : undefined;
    const refs: KindRef[] = [{ ref: { kind: 'current' }, kind: 'current', date: cur.date }];
    const ps = prev ? surfaceOfCapture(c.files.surfaces, prev.id) : null;
    if (prev && ps)
      refs.push({ ref: { kind: 'survey', surface: ps.id }, kind: 'earlier', date: prev.date });
    try {
      const profiles = await sampleProfiles(line, refs, c.engine.resolver(cur.id));
      return { kind: 'profile', series: chartSeries(profiles) };
    } catch {
      return null;
    }
  }
  if (m.family === 'point') {
    const pt = m.points[0];
    if (!pt) return null;
    const rows: { capture: string; date: string; label: string; z: number | null }[] = [];
    for (const cap of c.surveyed) {
      const raw = await c.engine.sampler(cap.id);
      // the point where it is drawn, read on each date's surface where that was prepared
      const sample = raw
        ? drawnOnSurface(
            raw,
            { kind: 'survey', capture: cap.id },
            surfaceOfCapture(c.files.surfaces, cap.id),
            c.files.manifest,
          )
        : null;
      const h = sample ? (await sample(Float64Array.of(pt[0]), Float64Array.of(pt[1])))[0] : null;
      rows.push({
        capture: cap.id,
        date: cap.date,
        label: cap.label,
        z: h !== null && h !== undefined && Number.isFinite(h) ? h : null,
      });
    }
    return { kind: 'elevation', rows, level: m.tool === 'elevation-difference' ? pt[2] : null };
  }
  return null;
}

/**
 * Everything the survey sections or a survey CSV print. `need` limits the work: the report lists
 * at most `REPORT_MEASUREMENTS_MAX` measurements (or the template's); the stockpile CSV has every
 * pile on every survey; the measurements CSV every measurement.
 */
export async function buildSurveyData(
  files: SurveyFiles,
  bytes: (path: string) => Promise<Uint8Array | null>,
  opts: BuildOptions,
): Promise<ReportSurveyData> {
  const { settings, manifest } = files;
  const captures: CaptureRef[] = [...manifest.captures]
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1))
    .map((c) => ({ id: c.id, label: c.label, date: c.date }));
  const surveyed = captures.filter((c) => surfaceOfCapture(files.surfaces, c.id) !== null);
  const computed = surveyed.length > 0;
  const current = surveyed.at(-1) ?? null;
  const engine = new Engine(files, bytes, captures);
  const capRef = (id: string | undefined) => captures.find((c) => c.id === id) ?? null;
  const tplOf = (m: SurveyMeasurement) => files.templates.find((x) => x.id === m.template);
  const plan = surveyPlan(files);
  const material = (m: SurveyMeasurement) => pileMaterial(m, settings.materials, files.kit);

  // the report template's measurement entries (W8), in its order
  const byId = new Map(files.measurements.map((m) => [m.id, m]));
  const templated =
    opts.need === 'report'
      ? (files.template?.entries ?? []).flatMap((e) => {
          // an entry, or a part, a later build added is kept in the file and not printed here
          const m = isMeasurementEntry(e) ? byId.get(e.id) : undefined;
          if (!m || !isMeasurementEntry(e)) return [];
          const parts = knownParts(e);
          const shownParts: readonly TemplatePart[] = parts.length > 0 ? parts : ['value'];
          return [{ m, parts: shownParts }];
        })
      : [];

  // work to do, for the progress
  const listed =
    opts.need === 'stockpile-csv'
      ? []
      : opts.need === 'report'
        ? templated.length > 0
          ? templated.map((x) => x.m)
          : files.measurements.slice(0, REPORT_MEASUREMENTS_MAX)
        : files.measurements;
  const pileWork = opts.need === 'measurements-csv' ? [] : plan.stockpiles;
  const total =
    listed.length +
    pileWork.length +
    (opts.need === 'report'
      ? plan.earthworks.length + plan.landfill.length + plan.sections.length + templated.length
      : 0);
  let done = 0;
  const tick = () => {
    done++;
    opts.progress?.(done, total);
  };

  /** The survey a measurement's numbers are for: its own, or the latest with a surface. */
  const captureOf = (m: SurveyMeasurement): CaptureRef | null =>
    m.scope.kind === 'survey' ? capRef(m.scope.capture) : current;

  /** A measurement with its stored results as its card shows them (stale marked). */
  const asShown = async (m: SurveyMeasurement): Promise<SurveyMeasurement> =>
    m.family === 'polygon' && m.results.length > 0
      ? { ...m, results: storedResults(m, computed ? await engine.prints(m) : null) }
      : m;

  /** Every item of a measurement: its stored result, never a fresh recompute. */
  const itemsOf = (m: SurveyMeasurement): ComparisonReport[] =>
    m.items.map((it) => {
      const label = it.label ?? it.id;
      const r = m.results.find((x) => x.item === it.id) ?? null;
      return { item: it.id, label, result: r, reason: r ? '' : tk('house.survey.notComputed') };
    });

  // ------------------------------------------------ measurements
  const refs = new Map(files.measurements.map((m, i) => [m.id, `M${String(i + 1)}`]));
  const refOf = (m: SurveyMeasurement) => refs.get(m.id) ?? m.id;
  const measurements: MeasurementReport[] = [];
  const shown = new Map<string, SurveyMeasurement>();
  const cards = new Map<string, CardModel>();
  const cardCtx = { settings, templates: files.templates, captures };
  const angles = settings.angles ?? DEFAULT_ANGLES;
  for (const raw of listed) {
    const m = await asShown(raw);
    shown.set(m.id, m);
    // where the app draws it (its date's line-up added): its readouts, heights and card are of that
    const drawn: SurveyMeasurement = { ...m, points: drawnPoints(m, manifest) };
    const cap = captureOf(m);
    const comparisons = m.family === 'polygon' ? itemsOf(m) : [];
    const tpl = tplOf(m);
    const units = effectiveUnits(settings.units, m.units);
    const locale = settings.locale ?? localeOf(units.distance);
    // the terrain only where a row it prints reads it (a pile's never does), each place once, as
    // the app's card reads it (`useCardTerrain`); the readouts bound how many places a polygon asks
    const terrain = readsSurface(m.tool, tpl?.items);
    const onCap = computed && cap && terrain ? await engine.sampler(cap.id) : null;
    // the drawn points read where the date's surface was prepared (its line-up then), as the panel
    const sample =
      onCap && cap
        ? drawnOnSurface(onCap, m.scope, surfaceOfCapture(files.surfaces, cap.id), manifest)
        : null;
    const surface = await presampled((h) => {
      allRows(drawn, { surface: h });
    }, sample);
    const rows = measurementReadout(drawn, surface ? { surface } : {}, tpl?.items);
    cards.set(m.id, cardModel(drawn, { ...cardCtx, ...(surface ? { surface } : {}) }));
    const values: SurveyValue[] = rows.map((r) => ({
      key: r.key,
      label: r.label,
      si: r.value,
      kind: r.kind,
      display: formatRow(r, units, settings.precision, locale, angles),
    }));
    const names = new Map((tpl?.fields ?? []).map((f) => [f.id, f.name]));
    measurements.push({
      ref: refOf(m),
      id: m.id,
      label: m.label,
      folder: m.folder ?? null,
      template: tpl?.name ?? m.template ?? null,
      family: m.family,
      tool: m.tool,
      scope: m.scope.kind === 'survey' ? m.scope.capture : null,
      capture: cap,
      material: material(m),
      units,
      values,
      comparisons,
      fields: Object.entries(m.fields ?? {}).map(([id, v]) => ({
        name: names.get(id) ?? id,
        value: String(v),
      })),
      outline: drawn.points.map((p) => [p[0], p[1]]),
    });
    tick();
  }

  // ------------------------------------------------ volumes over time and the stockpiles
  const volumes = await volumesOverTime(
    pileWork,
    captures,
    computed ? engine : null,
    opts.fillDates ?? true,
    {
      ref: refOf,
      material,
      outline: (m, points) =>
        drawnPoints({ scope: m.scope, points: [...points] }, manifest).map(
          (p): [number, number] => [p[0], p[1]],
        ),
      tick,
    },
  );
  const piles: StockpileReport[] = volumes.piles.map((p) => ({
    ref: p.ref,
    id: p.id,
    label: p.label,
    material: p.material,
    base: p.carried ?? p.base,
    volumes: pileVolumes(p, captures),
  }));
  const stockpiles = stockpileInventory(piles, captures);

  // ------------------------------------------------ the template's entries
  const entries: ReportEntry[] = [];
  for (const { m: raw, parts } of templated) {
    const m = shown.get(raw.id) ?? (await asShown(raw));
    const drawn: SurveyMeasurement = { ...m, points: drawnPoints(m, manifest) };
    let chart: EntryChart | null = null;
    if (parts.includes('chart') && measurementHasChart(m))
      chart = await entryChart(drawn, {
        volumes,
        engine,
        current,
        surveyed,
        files,
      });
    const card = cards.get(m.id) ?? cardModel(drawn, cardCtx);
    entries.push({ ref: refOf(m), m, parts, chart, card });
    tick();
  }

  const earthworks: EarthworksReport[] = [];
  const sections: SectionReport[] = [];
  const landfill: LandfillReport[] = [];
  const first = surveyed[0] ?? null;
  if (opts.need === 'report') {
    // ---------------------------------------------- earthworks
    for (const m of plan.earthworks) {
      for (const it of designItems(m)) {
        const tol = it.deadbandM ?? settings.deadbandM ?? 0.05;
        const toDesign = isCurrent(it.from);
        const grid: GridOut[] = [];
        const cur = current ? await engine.result(m, it, current.id, grid) : null;
        const fst =
          first && current && first.id !== current.id ? await engine.result(m, it, first.id) : null;
        let tolerance: EarthworksReport['tolerance'] = null;
        if (cur && cur.status !== 'refused' && grid.length > 0) {
          const acc = { share: 0, areaM2: 0, inToleranceM2: 0, cutM2: 0, fillM2: 0 };
          for (const g of grid)
            for (const b of g.bands) {
              const s = toleranceShare(b.dz, tol, b.win.cell * b.win.cell, b.w);
              acc.areaM2 += s.areaM2;
              acc.inToleranceM2 += s.inToleranceM2;
              acc.cutM2 += s.cutM2;
              acc.fillM2 += s.fillM2;
            }
          acc.share = acc.areaM2 > 0 ? acc.inToleranceM2 / acc.areaM2 : 0;
          tolerance = acc;
        }
        const usable = (r: ComparisonResult | null) =>
          r && (r.status === 'ok' || r.status === 'partial') ? r : null;
        const c = usable(cur);
        const f = usable(fst);
        earthworks.push({
          ref: refs.get(m.id) ?? m.id,
          id: m.id,
          label: m.label,
          item: it.label ?? it.id,
          design:
            (toDesign ? cur?.toLabel : cur?.fromLabel) ??
            sideLabel(toDesign ? it.to : it.from, null),
          toleranceM: tol,
          first: f && first ? { capture: first, result: f } : null,
          current: c && current ? { capture: current, result: c } : null,
          reason: c
            ? ''
            : (cur?.reason ??
              (current ? engine.problem(m, it, current.id) : tk('house.survey.noSurface'))),
          progress: toDesign && c && f ? earthworksProgress(f.totalM3, c.totalM3) : null,
          tolerance,
        });
      }
      tick();
    }
    // ---------------------------------------------- sections
    for (const m of plan.sections) {
      const line = m.points.map((p) => [p[0], p[1]] as const);
      if (!current || line.length < 2) {
        tick();
        continue;
      }
      const refsOf: KindRef[] = [{ ref: { kind: 'current' }, kind: 'current', date: current.date }];
      const firstSurface =
        first && first.id !== current.id ? surfaceOfCapture(files.surfaces, first.id) : null;
      if (first && firstSurface)
        refsOf.push({
          ref: { kind: 'survey', surface: firstSurface.id },
          kind: 'earlier',
          date: first.date,
        });
      const seen = new Set<string>();
      for (const e of plan.earthworks)
        for (const it of designItems(e)) {
          const d = isDesign(it.to) ? it.to : it.from;
          if (d.kind !== 'design' || seen.has(`${d.design}/${d.layer}`) || seen.size >= 2) continue;
          seen.add(`${d.design}/${d.layer}`);
          refsOf.push({ ref: d, kind: 'design' });
        }
      try {
        const length = lineLength(line);
        sections.push({
          ref: refOf(m),
          label: m.label,
          lengthM: length,
          profiles: await sampleProfiles(line, refsOf, engine.resolver(current.id)),
        });
      } catch {
        // no surface to cut: the section is left out
      }
      tick();
    }
    // ---------------------------------------------- landfill
    for (const m of plan.landfill) {
      const items = landfillItems(m);
      const lifts: LiftReport[] = [];
      let prevPlaced: number | null = 0;
      const tonnesField = Object.entries(m.fields ?? {}).find(
        ([id, v]) => /tonn/i.test(id) && typeof v === 'number',
      )?.[1];
      for (const [i, cap] of surveyed.entries()) {
        const lift = items.lift ? await engine.result(m, items.lift, cap.id) : null;
        const placed = items.placed ? await engine.result(m, items.placed, cap.id) : null;
        const placedNet =
          placed && (placed.status === 'ok' || placed.status === 'partial') ? placed.netM3 : null;
        let volumeM3: number | null =
          lift && (lift.status === 'ok' || lift.status === 'partial') ? lift.netM3 : null;
        if (volumeM3 === null && placedNet !== null && prevPlaced !== null)
          volumeM3 = placedNet - prevPlaced;
        prevPlaced = placedNet;
        const after = surveyed[i - 1]?.date ?? '';
        const weighed = files.weighbridge.filter((w) => w.date > after && w.date <= cap.date);
        const tonnes =
          weighed.length > 0
            ? weighed.reduce((a, w) => a + w.tonnes, 0)
            : files.weighbridge.length === 0 &&
                cap.id === current?.id &&
                typeof tonnesField === 'number'
              ? tonnesField
              : null;
        const shown = lift ?? placed;
        lifts.push({
          capture: cap,
          volumeM3,
          tonnes,
          densityTPerM3: compaction(tonnes, volumeM3),
          status: volumeM3 !== null ? 'ok' : (shown?.status ?? 'missing'),
          reason: volumeM3 !== null ? '' : (shown?.reason ?? tk('house.survey.noLift')),
        });
      }
      const air =
        items.airspace && current ? await engine.result(m, items.airspace, current.id) : null;
      const airOk = air && (air.status === 'ok' || air.status === 'partial') ? air : null;
      const counted = lifts.filter((l) => l.volumeM3 !== null);
      const weighedLifts = counted.filter((l) => l.tonnes !== null);
      landfill.push({
        ref: refs.get(m.id) ?? m.id,
        id: m.id,
        label: m.label,
        design: air?.toLabel ?? (items.airspace ? sideLabel(items.airspace.to, null) : ''),
        airspace:
          airOk && current ? { capture: current, remainingM3: airOk.fillM3, result: airOk } : null,
        airspaceReason: airOk
          ? ''
          : (air?.reason ??
            (items.airspace ? tk('house.survey.noSurface') : tk('house.survey.noAirspace'))),
        lifts,
        usedM3: counted.reduce((a, l) => a + (l.volumeM3 ?? 0), 0),
        tonnes:
          weighedLifts.length > 0 ? weighedLifts.reduce((a, l) => a + (l.tonnes ?? 0), 0) : null,
      });
      tick();
    }
  }

  return {
    basis: surveyBasis(settings, manifest.crs, files.calibration),
    captures,
    current,
    computed,
    measurementCount: files.measurements.length,
    measurements,
    stockpiles,
    earthworks,
    sections,
    landfill,
    volumes,
    entries,
    settings,
    templates: files.templates,
  };
}
