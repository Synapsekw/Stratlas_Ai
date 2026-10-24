/**
 * The Measurements group's rows in the Datasets tree, built from the measurement store: folders
 * first (A to Z) holding their rows, then the loose rows, each sorted by name. The eye is the
 * tree's own (hidden ids are not read here); a survey measurement whose date is off screen is
 * only dimmed. Under a filter (the group's filter box) only the matching rows are built: a folder
 * with none goes, one with some holds only those and keeps every id for its eye (`folderIds`).
 */
import { formatQuantity, localeOf } from '@aio/geo';
import type {
  MeasurementsFile,
  ProjectManifest,
  SurveyMeasurement,
  SurveySettings,
  SurveyTemplate,
} from '@aio/schema';
import {
  effectiveUnits,
  figureOn,
  groupByFolder,
  isTelecomTool,
  sortMeasurements,
  type PileFigure,
} from '@aio/survey';
import { formatDate, measureMark, t, type TreeItem } from '@aio/ui';
import { scopeOnScreen } from '@aio/workspace';
import type { DatesOnScreen } from './measureDates';
import { filterTerms, matchingMeasurements } from './measureFilter';
import { primaryText } from './card/cardModel';
import { DEFAULT_MEASURE_COLOUR } from './measureColours';
import { knownTemplates, type MeasureState } from './measureStore';
import { countedFigureOn, type IsCounted } from './volumes/inventory';

/**
 * A stockpile of the whole site (volumetrics redesign, spec section 5): a site-scoped volume
 * polygon, converted kit piles included. These sit in the project-level Stockpiles group, never
 * under "Needs a date"; a volume drawn on a survey date stays under its date.
 */
export function isStockpile(m: SurveyMeasurement): boolean {
  return m.scope.kind === 'site' && m.tool === 'volume' && m.family === 'polygon';
}

/**
 * A measurement that belongs under "Needs a date": its scope is the whole site (the legacy scope),
 * or a survey date the manifest no longer has. A stockpile of the whole site does not.
 */
export function needsDate(
  m: SurveyMeasurement,
  manifest: Pick<ProjectManifest, 'captures'> | null,
): boolean {
  const scope = m.scope;
  if (scope.kind === 'site') return !isStockpile(m);
  return !manifest?.captures.some((x) => x.id === scope.capture);
}

/**
 * The survey date whose figures the rows, labels and cards show: the date in focus (the notch's)
 * when the project has it, else the latest survey date; null without one.
 */
export function captureInFocus(
  focus: string | null,
  manifest: { captures: readonly { id: string; date: string }[] } | null,
): string | null {
  // with no project open there is nothing to check the focus against
  if (manifest === null) return focus;
  const captures = manifest.captures;
  if (focus !== null && captures.some((c) => c.id === focus)) return focus;
  return [...captures].sort((a, b) => a.date.localeCompare(b.date)).at(-1)?.id ?? null;
}

/** The measurements of one date: `on` a capture id, null for "Needs a date", undefined for all. */
function ofDate(
  list: readonly SurveyMeasurement[],
  manifest: Pick<ProjectManifest, 'captures'> | null,
  on: string | null | undefined,
): SurveyMeasurement[] {
  if (on === undefined) return [...list];
  if (on === null) return list.filter((m) => needsDate(m, manifest));
  return list.filter(
    (m) => m.scope.kind === 'survey' && m.scope.capture === on && !needsDate(m, manifest),
  );
}

/** The folder names in use for one date (`on` undefined: every date's), A to Z. */
export function measureFoldersOf(
  file: MeasurementsFile,
  on: string | null | undefined,
  manifest: Pick<ProjectManifest, 'captures'> | null = null,
): string[] {
  const folders = new Set<string>();
  for (const m of ofDate(file.measurements, manifest, on)) {
    const f = m.folder?.trim();
    if (f) folders.add(f);
  }
  return [...folders].sort(new Intl.Collator(undefined, { sensitivity: 'base' }).compare);
}

/** One measurement row; `meta` is its value (and date, when the row says it). */
function measureRow(
  m: SurveyMeasurement,
  meta: string,
  dimmed: boolean,
  dimmedWhy: string | null,
): TreeItem {
  return {
    id: measureMark(m.id),
    name: m.label,
    meta,
    measure: {
      id: m.id,
      color: m.style?.color ?? DEFAULT_MEASURE_COLOUR,
      dimmed,
      ...(isTelecomTool(m.tool) ? { telecom: true } : {}),
      ...(dimmed && dimmedWhy !== null ? { dimmedWhy } : {}),
    },
  };
}

/**
 * The rows of the Measurements group (all, one date's with `on` a capture id, or "Needs a date"'s
 * with `on` null). A volume reads its figure on `capture` (the date in focus, `captureInFocus`);
 * under a date folder, on that folder's date.
 */
export function buildMeasureItems(
  s: Pick<MeasureState, 'file' | 'settings' | 'templates'>,
  manifest: Pick<ProjectManifest, 'captures' | 'layers'> | null,
  ws: DatesOnScreen,
  query = '',
  on?: string | null,
  capture?: string | null,
): TreeItem[] {
  const templates = knownTemplates(s);
  const filtering = filterTerms(query).length > 0;
  const mine = ofDate(s.file.measurements, manifest, on);
  const kept = filtering
    ? new Set(matchingMeasurements(mine, query, templates).map((m) => m.id))
    : null;
  const folderId = (name: string) =>
    on === undefined ? `measure-folder:${name}` : `measure-folder:${on ?? 'needs'}:${name}`;
  const figureDate = typeof on === 'string' ? on : (capture ?? undefined);
  const row = (m: SurveyMeasurement): TreeItem => {
    // the one primary value (R1): the card, the view labels and the island read the same
    const value = primaryText(m, { settings: s.settings, templates, capture: figureDate });
    const scope = m.scope;
    const dated =
      scope.kind === 'survey' ? manifest?.captures.find((x) => x.id === scope.capture) : undefined;
    // under a date folder the date is the folder's: said again it only crowds out the name (the
    // dimmed note still names it)
    const dateLabel = dated ? formatDate(dated.date) : '';
    const date = on === undefined ? dateLabel : '';
    const dimmed = scope.kind === 'survey' && !scopeOnScreen(scope, ws.dates, ws.hidden);
    return measureRow(
      m,
      [value, date].filter(Boolean).join(' · '),
      dimmed,
      t('tree.measure.dimmed', { date: dateLabel }),
    );
  };
  const folders: TreeItem[] = [];
  const loose: TreeItem[] = [];
  for (const g of groupByFolder(sortMeasurements(mine, 'name'))) {
    const shown = kept ? g.measurements.filter((m) => kept.has(m.id)) : g.measurements;
    if (g.folder === '') loose.push(...shown.map(row));
    else if (shown.length > 0)
      folders.push({
        id: folderId(g.folder),
        name: g.folder,
        folder: g.folder,
        meta: String(shown.length),
        children: shown.map(row),
        ...(filtering ? { folderIds: g.measurements.map((m) => m.id) } : {}),
      });
  }
  return [...folders, ...loose];
}

/** What the Stockpiles group shows: each pile's volume, its net change, or the piles by material. */
export type StockpileMode = 'volume' | 'net' | 'material';

export interface StockpileContext {
  settings: SurveySettings;
  templates: readonly SurveyTemplate[];
  /** The earlier date of the net change (net mode); without it no change shows. */
  previous?: string | null;
  /**
   * The site inventory's counting rule (`useCounted`): a figure it leaves out (stale by the
   * fingerprints or the series check, a failed run) is not read as a volume. Without it only the
   * figure's own status is checked.
   */
  isCounted?: IsCounted;
}

/** A figure that is read as a volume: stale and refused ones never are (they sort last). */
const counted = (f: PileFigure | null): f is PileFigure =>
  f !== null && f.status !== 'stale' && f.status !== 'refused';

/** A pile's figure on a date when it is read as a volume, by the rule when there is one. */
const figureRead = (
  m: SurveyMeasurement,
  capture: string,
  isCounted: IsCounted | undefined,
): PileFigure | null => {
  const f = isCounted ? countedFigureOn(m, capture, isCounted) : figureOn(m, capture);
  return counted(f) ? f : null;
};

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

/** Largest `v` first, piles without one last (by name). */
function byValue<T extends { m: SurveyMeasurement; v: number | null }>(rows: T[]): T[] {
  return rows.sort((a, b) =>
    a.v === null && b.v === null
      ? byName(a.m.label, b.m.label)
      : a.v === null
        ? 1
        : b.v === null
          ? -1
          : b.v - a.v || byName(a.m.label, b.m.label),
  );
}

/** A signed volume as the boards write it: "+50.0 m³", "−400.0 m³" (Unicode minus). */
function signedVolume(x: number, m: SurveyMeasurement, settings: SurveySettings): string {
  const units = effectiveUnits(settings.units, m.units);
  const text = formatQuantity(
    Math.abs(x),
    'volume',
    units,
    settings.precision,
    settings.locale ?? localeOf(units.distance),
  );
  return `${x < 0 ? '−' : x > 0 ? '+' : ''}${text}`;
}

/**
 * The Stockpiles group's rows (spec section 5, "Stockpiles in the sidebar"): the site's piles on
 * `capture` (the date in focus). `volume`: each pile's figure on that date, largest first. `net`:
 * the change since `ctx.previous`, most lost first. `material`: one folder row per material with
 * its piles (largest first), the materials by their volume on that date and "No material" last.
 * A pile with no figure on the date says so (its primary text) and goes last.
 */
export function stockpileItems(
  measurements: readonly SurveyMeasurement[],
  capture: string | null,
  mode: StockpileMode,
  ctx: StockpileContext,
): TreeItem[] {
  const piles = measurements.filter(isStockpile);
  const figure = (m: SurveyMeasurement): number | null => {
    if (capture === null) return null;
    return figureRead(m, capture, ctx.isCounted)?.netM3 ?? null;
  };
  const text = (m: SurveyMeasurement) =>
    primaryText(m, {
      settings: ctx.settings,
      templates: ctx.templates,
      capture: capture ?? undefined,
    });
  if (mode === 'net') {
    const previous = ctx.previous ?? null;
    const rows = piles.map((m) => {
      const now = figure(m);
      const before = previous !== null ? figureRead(m, previous, ctx.isCounted) : null;
      const change = now !== null && before ? now - before.netM3 : null;
      // most lost first: the largest loss is the most negative change
      return { m, change, v: change === null ? null : -change };
    });
    return byValue(rows).map(({ m, change }) =>
      measureRow(m, change === null ? text(m) : signedVolume(change, m, ctx.settings), false, null),
    );
  }
  const rows = byValue(piles.map((m) => ({ m, v: figure(m) })));
  if (mode === 'volume') return rows.map(({ m }) => measureRow(m, text(m), false, null));
  const materials = ctx.settings.materials;
  const NONE = '';
  const groups = new Map<string, { name: string; volume: number; rows: TreeItem[] }>();
  for (const { m, v } of rows) {
    const mat = m.material !== undefined ? materials.find((x) => x.id === m.material) : undefined;
    const key = mat?.id ?? NONE;
    let g = groups.get(key);
    if (!g) {
      g = { name: mat?.name ?? t('volumes.noMaterial'), volume: 0, rows: [] };
      groups.set(key, g);
    }
    g.volume += v ?? 0;
    g.rows.push(measureRow(m, text(m), false, null));
  }
  return [...groups.entries()]
    .sort(([ka, a], [kb, b]) => (ka === NONE ? 1 : kb === NONE ? -1 : b.volume - a.volume))
    .map(([key, g]) => ({
      id: `stockpile-material:${key === NONE ? 'none' : key}`,
      name: g.name,
      folder: g.name,
      meta: String(g.rows.length),
      children: g.rows,
    }));
}

/**
 * The Stockpiles group's header: "Stockpiles" with "19 · 10 Jan" (how many, the date in focus),
 * "19 · net change" in net mode, and "Stockpiles by material 10 Jan" with the count by material.
 */
export function stockpileHeader(
  count: number,
  mode: StockpileMode,
  dateLabel: string,
): { label: string; countText: string } {
  if (mode === 'material')
    return { label: t('stockpiles.byMaterial', { date: dateLabel }), countText: String(count) };
  return {
    label: t('stockpiles.group'),
    countText:
      mode === 'net'
        ? t('stockpiles.netChange', { count })
        : t('stockpiles.count', { count, date: dateLabel }),
  };
}
