import type { WalkLayer } from '@aio/schema';
import type { TreeGroupKind } from '@aio/ui';

/*
 * How a walk shows in the Datasets list: the one badge on its row, and the Add 360 video action on
 * the 360 walks group header.
 */

export type WalkBadge = {
  text: 'Needs placing' | 'Check placing' | 'Path not computed' | 'Files missing';
  tone: 'info' | 'warn';
} | null;

/**
 * The badge of a walk row, most pressing first: its files are gone, it is not placed, its path is
 * not computed (placed between the pins only), its fit is worth a second look. A well placed walk
 * with a path has none.
 */
export function walkBadge(layer: WalkLayer, filesMissing: boolean): WalkBadge {
  if (filesMissing) return { text: 'Files missing', tone: 'warn' };
  if (!layer.place || layer.place.quality === 'unplaced')
    return { text: 'Needs placing', tone: 'info' };
  if (!layer.path) return { text: 'Path not computed', tone: 'info' };
  if (layer.place.quality === 'check' || layer.place.quality === 'poor')
    return { text: 'Check placing', tone: 'warn' };
  return null;
}

/** The 360 walks header adds a 360 video, except in a package (nothing is imported into one). */
export function walkGroupAction(
  kind: TreeGroupKind,
  readOnly: boolean,
  label: string,
  onAdd: () => void,
): { label: string; onClick: () => void } | undefined {
  return kind === 'walks' && !readOnly ? { label, onClick: onAdd } : undefined;
}
