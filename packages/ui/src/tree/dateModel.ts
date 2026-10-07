import type { Capture, Issue, ProjectManifest } from '@aio/schema';
import { buildDatasetTree, treeLayerIds, type TreeGroup } from './model';

export const EVERY_DATE = 'every';

/** One sidebar folder: a survey date (or Every date) holding the usual kind groups. */
export interface DateFolder {
  id: string;
  capture: Capture | null;
  label: string;
  sub?: string;
  groups: TreeGroup[];
  layerIds: string[];
}

export function buildDateTree(
  manifest: ProjectManifest,
  issues: readonly Issue[],
  durations: Readonly<Record<string, number>>,
  dates: { captures: readonly Capture[]; of: Readonly<Record<string, string>> },
  labels: { every: string; dateLabel: (c: Capture) => string },
): DateFolder[] {
  const folders: DateFolder[] = [];
  const common = manifest.layers.filter((l) => !(l.id in dates.of));
  const everyGroups = buildDatasetTree({ ...manifest, layers: common }, issues, durations);
  if (everyGroups.length > 0) {
    folders.push({
      id: EVERY_DATE,
      capture: null,
      label: labels.every,
      groups: everyGroups,
      layerIds: treeLayerIds(everyGroups),
    });
  }
  const newestFirst = [...dates.captures].sort(
    (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id),
  );
  for (const c of newestFirst) {
    const layers = manifest.layers.filter((l) => dates.of[l.id] === c.id);
    const groups =
      layers.length > 0 ? buildDatasetTree({ ...manifest, layers }, [], durations) : [];
    const label = labels.dateLabel(c);
    folders.push({
      id: c.id,
      capture: c,
      label,
      ...(c.label !== label && c.label !== c.date ? { sub: c.label } : {}),
      groups,
      layerIds: treeLayerIds(groups),
    });
  }
  return folders;
}
