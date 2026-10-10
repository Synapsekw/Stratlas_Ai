import type { Capture, Issue, ProjectManifest } from '@aio/schema';
import { issuesByCapture } from '@aio/workspace';
import { ICONS, type IconName } from '../icons/paths';
import { buildDatasetTree, treeLayerIds, type TreeGroup } from './model';

export const EVERY_DATE = 'every';

/** The icons a survey date folder can take instead of its colour square. */
export const DATE_ICONS = [
  'flag',
  'pin',
  'tag',
  'target',
  'check',
  'warn',
  'lock',
  'clock',
  'drone',
  'camera',
  'sun',
  'pile',
  'road',
  'plant',
  'tank',
] as const satisfies readonly IconName[];

/** `name` when it is an icon this build can draw (a newer build may have saved another). */
export function dateIcon(name: string | undefined): IconName | undefined {
  return name !== undefined && Object.hasOwn(ICONS, name) ? (name as IconName) : undefined;
}

/**
 * The name a person gave a survey date, shown beside its date: `Capture.label`, unless it only
 * repeats the date (the ISO date or the way the folder writes it).
 */
export function captureName(c: Capture, dateLabel: string): string | undefined {
  return c.label !== dateLabel && c.label !== c.date ? c.label : undefined;
}

/**
 * What to save as `Capture.label` for the name typed into a folder's rename field: the name, or
 * the plain date when the field was emptied (the folder then shows its date alone).
 */
export function captureLabelFor(c: Pick<Capture, 'date'>, typed: string): string {
  return typed.trim() || c.date;
}

/** The survey date a drop on `folder` files layers under: its capture, or null for Every date. */
export function dropCapture(folder: Pick<DateFolder, 'capture'>): string | null {
  return folder.capture?.id ?? null;
}

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
  // an issue sits in the folder of its survey date (the folder eye hides it with the layers)
  const byDate = issuesByCapture(issues, dates);
  const everyGroups = buildDatasetTree({ ...manifest, layers: common }, byDate.undated, durations);
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
    const own = byDate.dated[c.id] ?? [];
    const groups =
      layers.length > 0 || own.length > 0
        ? buildDatasetTree({ ...manifest, layers }, own, durations)
        : [];
    const label = labels.dateLabel(c);
    const name = captureName(c, label);
    folders.push({
      id: c.id,
      capture: c,
      label,
      ...(name !== undefined ? { sub: name } : {}),
      groups,
      layerIds: treeLayerIds(groups),
    });
  }
  return folders;
}
