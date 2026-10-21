/**
 * The Measurements group's rows in the Datasets tree, built from the measurement store: folders
 * first (A to Z) holding their rows, then the loose rows, each sorted by name. The eye is the
 * tree's own (hidden ids are not read here); a survey measurement whose date is off screen is
 * only dimmed. Under a filter (the group's filter box) only the matching rows are built: a folder
 * with none goes, one with some holds only those and keeps every id for its eye (`folderIds`).
 */
import type { MeasurementsFile, ProjectManifest, SurveyMeasurement } from '@aio/schema';
import { groupByFolder, isTelecomTool, sortMeasurements } from '@aio/survey';
import { formatDate, measureMark, t, type TreeItem } from '@aio/ui';
import { scopeOnScreen } from '@aio/workspace';
import type { DatesOnScreen } from './measureDates';
import { filterTerms, matchingMeasurements } from './measureFilter';
import { primaryText } from './card/cardModel';
import { DEFAULT_MEASURE_COLOUR } from './measureColours';
import { knownTemplates, type MeasureState } from './measureStore';

/**
 * A measurement that belongs under "Needs a date": its scope is the whole site (the legacy scope),
 * or a survey date the manifest no longer has.
 */
export function needsDate(
  m: SurveyMeasurement,
  manifest: Pick<ProjectManifest, 'captures'> | null,
): boolean {
  const scope = m.scope;
  if (scope.kind === 'site') return true;
  return !manifest?.captures.some((x) => x.id === scope.capture);
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

export function buildMeasureItems(
  s: Pick<MeasureState, 'file' | 'settings' | 'templates'>,
  manifest: Pick<ProjectManifest, 'captures' | 'layers'> | null,
  ws: DatesOnScreen,
  query = '',
  on?: string | null,
): TreeItem[] {
  const templates = knownTemplates(s);
  const filtering = filterTerms(query).length > 0;
  const mine = ofDate(s.file.measurements, manifest, on);
  const kept = filtering
    ? new Set(matchingMeasurements(mine, query, templates).map((m) => m.id))
    : null;
  const folderId = (name: string) =>
    on === undefined ? `measure-folder:${name}` : `measure-folder:${on ?? 'needs'}:${name}`;
  const row = (m: SurveyMeasurement): TreeItem => {
    // the one primary value (R1): the card, the view labels and the island read the same
    const value = primaryText(m, { settings: s.settings, templates });
    const scope = m.scope;
    const capture =
      scope.kind === 'survey' ? manifest?.captures.find((x) => x.id === scope.capture) : undefined;
    // under a date folder the date is the folder's: said again it only crowds out the name (the
    // dimmed note still names it)
    const dateLabel = capture ? formatDate(capture.date) : '';
    const date = on === undefined ? dateLabel : '';
    const dimmed = scope.kind === 'survey' && !scopeOnScreen(scope, ws.dates, ws.hidden);
    return {
      id: measureMark(m.id),
      name: m.label,
      meta: [value, date].filter(Boolean).join(' · '),
      measure: {
        id: m.id,
        color: m.style?.color ?? DEFAULT_MEASURE_COLOUR,
        dimmed,
        ...(isTelecomTool(m.tool) ? { telecom: true } : {}),
        ...(dimmed ? { dimmedWhy: t('tree.measure.dimmed', { date: dateLabel }) } : {}),
      },
    };
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
