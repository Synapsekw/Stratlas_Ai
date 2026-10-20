/**
 * The Measurements group's rows in the Datasets tree, built from the measurement store: folders
 * first (A to Z) holding their rows, then the loose rows, each sorted by name. The eye is the
 * tree's own (hidden ids are not read here); a survey measurement whose date is off screen is
 * only dimmed. Under a filter (the group's filter box) only the matching rows are built: a folder
 * with none goes, one with some holds only those and keeps every id for its eye (`folderIds`).
 */
import type { ProjectManifest, SurveyMeasurement } from '@aio/schema';
import { groupByFolder, sortMeasurements } from '@aio/survey';
import { formatDate, measureMark, t, type TreeItem } from '@aio/ui';
import { scopeOnScreen } from '@aio/workspace';
import type { DatesOnScreen } from './measureDates';
import { filterTerms, matchingMeasurements } from './measureFilter';
import { primaryText } from './card/cardModel';
import { DEFAULT_MEASURE_COLOUR } from './measureColours';
import { knownTemplates, type MeasureState } from './measureStore';

export function buildMeasureItems(
  s: Pick<MeasureState, 'file' | 'settings' | 'templates'>,
  manifest: Pick<ProjectManifest, 'captures' | 'layers'> | null,
  ws: DatesOnScreen,
  query = '',
): TreeItem[] {
  const templates = knownTemplates(s);
  const filtering = filterTerms(query).length > 0;
  const kept = filtering
    ? new Set(matchingMeasurements(s.file.measurements, query, templates).map((m) => m.id))
    : null;
  const row = (m: SurveyMeasurement): TreeItem => {
    // the one primary value (R1): the card, the view labels and the island read the same
    const value = primaryText(m, { settings: s.settings, templates });
    const scope = m.scope;
    const capture =
      scope.kind === 'survey' ? manifest?.captures.find((x) => x.id === scope.capture) : undefined;
    const date = capture ? formatDate(capture.date) : '';
    const dimmed = scope.kind === 'survey' && !scopeOnScreen(scope, ws.dates, ws.hidden);
    return {
      id: measureMark(m.id),
      name: m.label,
      meta: [value, date].filter(Boolean).join(' · '),
      measure: {
        id: m.id,
        color: m.style?.color ?? DEFAULT_MEASURE_COLOUR,
        dimmed,
        ...(dimmed ? { dimmedWhy: t('tree.measure.dimmed', { date }) } : {}),
      },
    };
  };
  const folders: TreeItem[] = [];
  const loose: TreeItem[] = [];
  for (const g of groupByFolder(sortMeasurements(s.file.measurements, 'name'))) {
    const shown = kept ? g.measurements.filter((m) => kept.has(m.id)) : g.measurements;
    if (g.folder === '') loose.push(...shown.map(row));
    else if (shown.length > 0)
      folders.push({
        id: `measure-folder:${g.folder}`,
        name: g.folder,
        folder: g.folder,
        meta: String(shown.length),
        children: shown.map(row),
        ...(filtering ? { folderIds: g.measurements.map((m) => m.id) } : {}),
      });
  }
  return [...folders, ...loose];
}
