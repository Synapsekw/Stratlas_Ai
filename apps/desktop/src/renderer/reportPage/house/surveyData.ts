// The survey sections' data (M11 G9, PRD SRV-13): the project's survey files read through the
// report page's fetch, every comparison computed now by the survey engine's TypeScript executor
// (the same arithmetic and inputs as the measurement panel, so the totals match it), and the
// readouts formatted as the panel formats them. The PDF sections and the CSVs are made from what
// this returns, so they always agree. Without prepared surfaces the stored results are reported
// as they were saved (and say so).
import {
  compaction,
  earthworksProgress,
  parseWeighbridge,
  stockpileInventory,
  surveyBasis,
  usableVolume,
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
  CALIBRATION_FILE,
  defaultSurveySettings,
  DESIGNS_FILE,
  DesignsFile,
  HeightTiles,
  isSurfaceSide,
  MEASUREMENTS_FILE,
  MeasurementsFile,
  SiteCalibration,
  SURVEY_SETTINGS_FILE,
  SURVEY_TEMPLATES_FILE,
  SurveySettings,
  SurveyTemplatesFile,
  type ComparisonItem,
  type ComparisonResult,
  type DesignEntry,
  type ProjectManifest,
  type ReportSectionId,
  type SurfaceRef,
  type SurveyMeasurement,
  type SurveyTemplate,
} from '@aio/schema';
import {
  compareItem,
  effectiveUnits,
  formatRow,
  industryTemplates,
  lineLength,
  measurementReadout,
  newShared,
  projectResolver,
  resolveSection,
  sampleSection,
  samplerOf,
  sideLabel,
  surfaceOfCapture,
  TileCache,
  toleranceShare,
  type GridOut,
  type PointSampler,
  type Resolve,
  type SectionRef,
} from '@aio/survey';
import { t } from '@aio/ui';

type Key = Parameters<typeof t>[0];
const tk = (key: string, vars?: Record<string, string | number>) => t(key as Key, vars);

/** Where the weighbridge log of a landfill lives (date and tonnes columns). */
export const WEIGHBRIDGE_FILE = 'survey/weighbridge.csv';

/** The report lists at most this many measurements; the measurements CSV has every one. */
export const REPORT_MEASUREMENTS_MAX = 300;

/** Terrain areas are sampled for polygons up to this size (0.5 m apart: about 800,000 heights). */
const TERRAIN_AREA_MAX_M2 = 200_000;

const ringArea = (pts: readonly (readonly number[])[]) => {
  let a = 0;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length] ?? p;
    a += (p[0] ?? 0) * (q[1] ?? 0) - (q[0] ?? 0) * (p[1] ?? 0);
  });
  return Math.abs(a) / 2;
};

/** Project files the survey data is read from (the report page's `aio://` fetch). */
export interface SurveyReader {
  json(path: string): Promise<unknown>;
  text(path: string): Promise<string | null>;
  bytes(path: string): Promise<Uint8Array | null>;
}

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
}

function parsed<T>(schema: { safeParse(v: unknown): { success: boolean; data?: T } }, v: unknown) {
  if (v === null || v === undefined) return null;
  const r = schema.safeParse(v);
  return r.success ? (r.data ?? null) : null;
}

/**
 * Read the survey files; null when the project has no saved survey measurements. `surfaceIds` are
 * the prepared surfaces main listed (`survey/surfaces/<id>/tiles.json`).
 */
export async function readSurveyFiles(
  read: SurveyReader,
  manifest: ProjectManifest,
  surfaceIds: readonly string[],
): Promise<SurveyFiles | null> {
  const file = parsed<MeasurementsFile>(MeasurementsFile, await read.json(MEASUREMENTS_FILE));
  if (!file || file.measurements.length === 0) return null;
  const [settingsRaw, calRaw, designsRaw, templatesRaw, weigh, ...tiles] = await Promise.all([
    read.json(SURVEY_SETTINGS_FILE),
    read.json(CALIBRATION_FILE),
    read.json(DESIGNS_FILE),
    read.json(SURVEY_TEMPLATES_FILE),
    read.text(WEIGHBRIDGE_FILE),
    ...surfaceIds.map((id) => read.json(`survey/surfaces/${id}/tiles.json`)),
  ]);
  const settings = parsed<SurveySettings>(SurveySettings, settingsRaw) ?? defaultSurveySettings();
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
    templates: [
      ...(project?.templates ?? []),
      ...industryTemplates(settings.templateSets).filter(
        (x) => !project?.templates.some((p) => p.id === x.id),
      ),
    ],
    weighbridge: typeof weigh === 'string' ? parseWeighbridge(weigh) : [],
  };
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
    stockpiles: files.measurements.filter((m) => !lf.has(m.id) && stockpileItem(m) !== null),
    earthworks,
    landfill,
    sections:
      earthworks.length > 0
        ? files.measurements.filter((m) => m.tool === 'section').slice(0, 12)
        : [],
  } satisfies SurveyPlan;
}

/** The survey sections that have something to print. */
export function surveySectionIds(files: SurveyFiles): ReportSectionId[] {
  const plan = surveyPlan(files);
  const has: Record<(typeof SURVEY_SECTIONS)[number], boolean> = {
    measurements: files.measurements.length > 0,
    earthworks: plan.earthworks.length > 0,
    stockpiles: plan.stockpiles.length > 0,
    landfill: plan.landfill.length > 0,
  };
  return SURVEY_SECTIONS.filter((id) => has[id]);
}

// ---------------------------------------------------------------- the engine

const ringOf = (m: SurveyMeasurement): [number, number][] => m.points.map((p) => [p[0], p[1]]);

/** One engine for the report: a resolver per survey over one tile cache, results memoised. */
class Engine {
  private cache = new TileCache();
  private resolvers = new Map<string, Resolve>();
  private memo = new Map<string, Promise<ComparisonResult | null>>();
  readonly captureIds: string[];
  constructor(
    private files: SurveyFiles,
    private bytes: (path: string) => Promise<Uint8Array | null>,
    captures: readonly CaptureRef[],
  ) {
    this.captureIds = captures.map((c) => c.id);
  }

  resolver(capture: string): Resolve {
    let r = this.resolvers.get(capture);
    if (!r) {
      r = projectResolver({
        surfaces: this.files.surfaces,
        captures: this.captureIds,
        capture,
        designs: this.files.designs,
        fetchBytes: this.bytes,
        cache: this.cache,
      });
      this.resolvers.set(capture, r);
    }
    return r;
  }

  private get site() {
    const s = this.files.settings;
    return {
      verticalDatum: s.verticalDatum,
      ...(s.calibration ? { calibration: s.calibration } : {}),
    };
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
      { site: this.site, shared: newShared() },
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
 * The readout rows with terrain values from an async sampler: the tools ask a synchronous sampler,
 * so the points they ask for are collected first (every height 0), sampled in one go, then asked
 * again with the answers.
 */
async function readout(
  m: SurveyMeasurement,
  items: readonly string[] | undefined,
  sample: PointSampler | null,
) {
  if (!sample) return measurementReadout(m, {}, items);
  const es: number[] = [];
  const ns: number[] = [];
  measurementReadout(
    m,
    {
      surface: {
        heightAt: (e, n) => {
          es.push(e);
          ns.push(n);
          return 0;
        },
      },
    },
    items,
  );
  const hs = es.length
    ? await sample(Float64Array.from(es), Float64Array.from(ns))
    : new Float64Array();
  const at = new Map<string, number>();
  es.forEach((e, i) => at.set(`${String(e)},${String(ns[i])}`, hs[i] ?? Number.NaN));
  return measurementReadout(
    m,
    {
      surface: {
        heightAt: (e, n) => {
          const h = at.get(`${String(e)},${String(n)}`);
          return h === undefined || !Number.isFinite(h) ? null : h;
        },
      },
    },
    items,
  );
}

// ---------------------------------------------------------------- the data

export type SurveyNeed = 'report' | 'measurements-csv' | 'stockpile-csv';

export interface BuildOptions {
  need: SurveyNeed;
  progress?: (done: number, total: number) => void;
}

const refused = (reason: string): Pick<ComparisonReport, 'result' | 'reason'> => ({
  result: null,
  reason,
});

/**
 * Everything the survey sections or a survey CSV print. `need` limits the work: the report lists
 * at most `REPORT_MEASUREMENTS_MAX` measurements and the stockpiles on the last two surveys; the
 * stockpile CSV has every pile on every survey; the measurements CSV every measurement.
 */
export async function buildSurveyData(
  files: SurveyFiles,
  bytes: (path: string) => Promise<Uint8Array | null>,
  opts: BuildOptions,
): Promise<SurveyReportData> {
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
  const material = (m: SurveyMeasurement) =>
    settings.materials.find((x) => x.id === m.material) ?? null;

  // work to do, for the progress
  const listed =
    opts.need === 'stockpile-csv'
      ? []
      : opts.need === 'report'
        ? files.measurements.slice(0, REPORT_MEASUREMENTS_MAX)
        : files.measurements;
  const pileCaptures = opts.need === 'stockpile-csv' ? surveyed : surveyed.slice(-2);
  const total =
    listed.length +
    plan.stockpiles.length * Math.max(1, pileCaptures.length) +
    (opts.need === 'report'
      ? plan.earthworks.length + plan.landfill.length + plan.sections.length
      : 0);
  let done = 0;
  const tick = () => {
    done++;
    opts.progress?.(done, total);
  };

  /** The survey a measurement's numbers are for: its own, or the latest with a surface. */
  const captureOf = (m: SurveyMeasurement): CaptureRef | null =>
    m.scope.kind === 'survey' ? capRef(m.scope.capture) : current;

  /** Every item of a measurement on a survey (stored results without prepared surfaces). */
  const itemsOn = async (m: SurveyMeasurement, cap: CaptureRef | null) =>
    Promise.all(
      m.items.map(async (it): Promise<ComparisonReport> => {
        const label = it.label ?? it.id;
        if (!computed) {
          const r = m.results.find((x) => x.item === it.id) ?? null;
          return { item: it.id, label, result: r, reason: r ? '' : tk('house.survey.notComputed') };
        }
        if (!cap) return { item: it.id, label, ...refused(tk('house.survey.noSurface')) };
        const r = await engine.result(m, it, cap.id);
        return { item: it.id, label, result: r, reason: r ? '' : engine.problem(m, it, cap.id) };
      }),
    );

  // ------------------------------------------------ measurements
  const refs = new Map(files.measurements.map((m, i) => [m.id, `M${String(i + 1)}`]));
  const measurements: MeasurementReport[] = [];
  for (const m of listed) {
    const cap = captureOf(m);
    const comparisons = m.family === 'polygon' ? await itemsOn(m, cap) : [];
    const tpl = tplOf(m);
    const units = effectiveUnits(settings.units, m.units);
    const results = comparisons.flatMap((c) => (c.result ? [c.result] : []));
    const terrain = m.family !== 'polygon' || ringArea(m.points) <= TERRAIN_AREA_MAX_M2;
    const sample = computed && cap && terrain ? await engine.sampler(cap.id) : null;
    const rows = await readout({ ...m, results }, tpl?.items, sample);
    const values: SurveyValue[] = rows.map((r) => ({
      key: r.key,
      label: r.label,
      si: r.value,
      kind: r.kind,
      display: formatRow(r, units, settings.precision),
    }));
    const names = new Map((tpl?.fields ?? []).map((f) => [f.id, f.name]));
    measurements.push({
      ref: refs.get(m.id) ?? m.id,
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
      outline: m.points.map((p) => [p[0], p[1]]),
    });
    tick();
  }

  // ------------------------------------------------ stockpiles
  const piles: StockpileReport[] = [];
  for (const m of plan.stockpiles) {
    const it = stockpileItem(m);
    if (!it) continue;
    const own = m.scope.kind === 'survey' ? capRef(m.scope.capture) : null;
    const on = own ? [own] : pileCaptures;
    const volumes: PileVolume[] = [];
    if (!computed) {
      const r = m.results.find((x) => x.item === it.id) ?? null;
      const cap = capRef(r?.toCapture ?? r?.fromCapture) ?? own ?? captures.at(-1) ?? null;
      if (cap)
        volumes.push({
          capture: cap,
          volumeM3: usableVolume(r),
          status: r?.status ?? 'missing',
          reason: r?.reason ?? (r ? '' : tk('house.survey.notComputed')),
        });
      tick();
    }
    for (const cap of computed ? on : []) {
      const r = await engine.result(m, it, cap.id);
      volumes.push({
        capture: cap,
        volumeM3: usableVolume(r),
        status: r?.status ?? 'missing',
        reason: r?.reason ?? (r ? '' : engine.problem(m, it, cap.id)),
      });
      tick();
    }
    piles.push({
      ref: refs.get(m.id) ?? m.id,
      id: m.id,
      label: m.label,
      material: material(m),
      base: sideLabel(it.from, null),
      volumes,
    });
  }
  const stockpiles = stockpileInventory(piles, captures);

  const earthworks: EarthworksReport[] = [];
  const sections: SectionReport[] = [];
  const landfill: LandfillReport[] = [];
  if (opts.need === 'report') {
    // ---------------------------------------------- earthworks
    const first = surveyed[0] ?? null;
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
      const refsOf: SectionRef[] = [{ kind: 'current' }];
      const firstSurface =
        first && first.id !== current.id ? surfaceOfCapture(files.surfaces, first.id) : null;
      if (firstSurface) refsOf.push({ kind: 'survey', surface: firstSurface.id });
      const seen = new Set<string>();
      for (const e of plan.earthworks)
        for (const it of designItems(e)) {
          const d = isDesign(it.to) ? it.to : it.from;
          if (d.kind !== 'design' || seen.has(`${d.design}/${d.layer}`) || seen.size >= 2) continue;
          seen.add(`${d.design}/${d.layer}`);
          refsOf.push(d);
        }
      try {
        const { surfaces } = await resolveSection(refsOf, engine.resolver(current.id));
        const length = lineLength(line);
        const s = await sampleSection({ line, stepM: Math.max(0.25, length / 400) }, surfaces);
        sections.push({
          ref: refs.get(m.id) ?? m.id,
          label: m.label,
          lengthM: length,
          profiles: s.profiles.map((p) => ({ label: p.label, chainage: p.chainage, z: p.z })),
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
  };
}
