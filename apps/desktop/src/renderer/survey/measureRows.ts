/**
 * The Measurements group's rows in the Datasets tree, built from the measurement store: folders
 * first (A to Z) holding their rows, then the loose rows, each sorted by name. The eye is the
 * tree's own (hidden ids are not read here); a survey measurement whose date is off screen is
 * only dimmed. Under a filter (the group's filter box) only the matching rows are built: a folder
 * with none goes, one with some holds only those and keeps every id for its eye (`folderIds`).
 */
import type { ProjectManifest, SurveyMeasurement } from '@aio/schema';
import {
  effectiveUnits,
  formatRow,
  groupByFolder,
  isTelecomTool,
  measurementReadout,
  sortMeasurements,
} from '@aio/survey';
import { formatDate, measureMark, t, type TreeItem } from '@aio/ui';
import { scopeOnScreen } from '@aio/workspace';
import type { DatesOnScreen } from './measureDates';
import { filterTerms, matchingMeasurements } from './measureFilter';
import { MEASURE_COLOR } from './measureScene';
import { knownTemplates, type MeasureState } from './measureStore';

type ValueState = Pick<MeasureState, 'settings' | 'templates'>;

/** A measurement's primary value as the list shows it; "" when it has no row to show. */
export function measureRowValue(
  m: SurveyMeasurement,
  s: ValueState,
  templates = knownTemplates(s),
): string {
  const telecom = isTelecomTool(m.tool);
  const row = telecom
    ? measurementReadout(m)[0]
    : measurementReadout(m, {}, templates.find((x) => x.id === m.template)?.items).find(
        (r) => r.value !== null,
      );
  if (!row) return '';
  if (telecom && row.value === null) return t('tree.measure.invalid');
  return formatRow(row, effectiveUnits(s.settings.units, m.units), s.settings.precision);
}

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
    const value = measureRowValue(m, s, templates);
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
        color: m.style?.color ?? MEASURE_COLOR,
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
