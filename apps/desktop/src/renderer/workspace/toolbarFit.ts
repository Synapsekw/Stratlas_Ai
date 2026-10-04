/** Stage toolbar groups and how many fit on one row. */
export type GroupId = 'view' | 'measure' | 'display' | 'clouds' | 'video' | 'annotate' | 'road';

export const GROUP_LABEL: Record<GroupId, string> = {
  view: 'View',
  measure: 'Measure and section',
  display: 'Labels and layers',
  clouds: 'Point clouds',
  video: 'Video and camera',
  annotate: 'Annotate',
  road: 'Road layers and measure',
};

/**
 * Groups move into the overflow menu in this order as the stage narrows. The point cloud control
 * stays on the bar almost to the end: tucked under More nobody found it.
 */
const COLLAPSE_ORDER: GroupId[] = [
  'display',
  'video',
  'view',
  'measure',
  'clouds',
  'road',
  'annotate',
];
export const GAP = 8;
const MORE_W = 36;

/**
 * Which groups fit on one row. `widths` are the groups' natural widths (measured while shown),
 * `fixed` the width of what always stays (view modes, right panel toggle).
 */
export function fitGroups(
  groups: readonly GroupId[],
  widths: ReadonlyMap<GroupId, number>,
  fixed: number,
  available: number,
): GroupId[] {
  const w = (g: GroupId) => (widths.get(g) ?? 64) + GAP;
  let total = fixed + groups.reduce((n, g) => n + w(g), 0);
  const hidden: GroupId[] = [];
  for (const g of COLLAPSE_ORDER) {
    if (total <= available) break;
    if (!groups.includes(g)) continue;
    if (hidden.length === 0) total += MORE_W + GAP;
    hidden.push(g);
    total -= w(g);
  }
  return hidden;
}
