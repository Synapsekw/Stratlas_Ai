import type { SurveyMeasurement, SurveyTemplate } from '@aio/schema';
import { TOOL_LABELS } from './readout';

/**
 * The measurement list (PRD SRV-4): search, filters (template, created by me, last 7 days, scope,
 * a dropdown field's value), sort and folders. Pure, so the list, the reports (G9) and the bulk
 * totals (G4) choose the same measurements.
 */

export type MeasurementSort = 'newest' | 'oldest' | 'name' | 'tool';

export interface MeasurementFilter {
  search?: string;
  /** A template id, or `none` for measurements without one. */
  template?: string | null;
  /** The person's name (`createdBy`), when only theirs are wanted. */
  createdBy?: string | null;
  /** Only those made or changed in the last 7 days (relative to `now`). */
  lastSevenDays?: boolean;
  /** `site`, or a capture id for one survey's (`survey:<capture>`), or any survey (`survey`). */
  scope?: 'site' | 'survey' | `survey:${string}` | null;
  /** A custom field's value (a dropdown choice). */
  field?: { id: string; value: string } | null;
  /** A site material (G4). */
  material?: string | null;
}

const DAY = 86_400_000;

function matches(
  m: SurveyMeasurement,
  f: MeasurementFilter,
  templates: ReadonlyMap<string, SurveyTemplate>,
  now: number,
): boolean {
  const q = f.search?.trim().toLowerCase();
  if (q) {
    const t = m.template ? templates.get(m.template)?.name : undefined;
    const text = [m.label, m.folder, m.description, t, TOOL_LABELS[m.tool]]
      .concat(Object.values(m.fields ?? {}).map(String))
      .filter((x): x is string => typeof x === 'string')
      .join('\n')
      .toLowerCase();
    if (!text.includes(q)) return false;
  }
  if (f.template === 'none' && m.template) return false;
  if (f.template && f.template !== 'none' && m.template !== f.template) return false;
  if (f.createdBy && m.createdBy !== f.createdBy) return false;
  if (f.lastSevenDays) {
    const at = Date.parse(m.updatedAt ?? m.createdAt);
    if (!(now - at <= 7 * DAY)) return false;
  }
  if (f.scope === 'site' && m.scope.kind !== 'site') return false;
  if (f.scope === 'survey' && m.scope.kind !== 'survey') return false;
  if (f.scope?.startsWith('survey:')) {
    const capture = f.scope.slice('survey:'.length);
    if (m.scope.kind !== 'survey' || m.scope.capture !== capture) return false;
  }
  if (f.field && String(m.fields?.[f.field.id] ?? '') !== f.field.value) return false;
  if (f.material && m.material !== f.material) return false;
  return true;
}

export function filterMeasurements(
  list: readonly SurveyMeasurement[],
  f: MeasurementFilter,
  templates: readonly SurveyTemplate[] = [],
  now = Date.now(),
): SurveyMeasurement[] {
  const byId = new Map(templates.map((t) => [t.id, t]));
  return list.filter((m) => matches(m, f, byId, now));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortMeasurements(
  list: readonly SurveyMeasurement[],
  by: MeasurementSort,
): SurveyMeasurement[] {
  const out = [...list];
  switch (by) {
    case 'newest':
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    case 'oldest':
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    case 'name':
      return out.sort((a, b) => collator.compare(a.label, b.label));
    case 'tool':
      return out.sort(
        (a, b) =>
          collator.compare(TOOL_LABELS[a.tool], TOOL_LABELS[b.tool]) ||
          collator.compare(a.label, b.label),
      );
  }
}

export interface MeasurementFolder {
  /** The folder path, or '' for measurements in no folder (listed last). */
  folder: string;
  measurements: SurveyMeasurement[];
}

/** Group by folder (named folders A to Z, then the ones in no folder), keeping the order within. */
export function groupByFolder(list: readonly SurveyMeasurement[]): MeasurementFolder[] {
  const map = new Map<string, SurveyMeasurement[]>();
  for (const m of list) {
    const k = m.folder?.trim() ?? '';
    const arr = map.get(k) ?? [];
    arr.push(m);
    map.set(k, arr);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : collator.compare(a, b)))
    .map(([folder, measurements]) => ({ folder, measurements }));
}

/** Every dropdown field of the templates in use, with its choices, for the list's filter. */
export function dropdownFilters(
  templates: readonly SurveyTemplate[],
): { id: string; name: string; options: string[] }[] {
  const out = new Map<string, { id: string; name: string; options: string[] }>();
  for (const t of templates)
    for (const f of t.fields) {
      if (f.type !== 'dropdown') continue;
      const cur = out.get(f.id) ?? { id: f.id, name: f.name, options: [] };
      cur.options = [...new Set([...cur.options, ...(f.options ?? [])])];
      out.set(f.id, cur);
    }
  return [...out.values()];
}
