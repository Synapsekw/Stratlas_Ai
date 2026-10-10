/** Stage toolbar groups and how many fit on one row. */
export type GroupId =
  'view' | 'measure' | 'display' | 'clouds' | 'volumes' | 'video' | 'annotate' | 'road';

export const GROUP_LABEL: Record<GroupId, string> = {
  view: 'View',
  measure: 'Measure and section',
  display: 'Labels and layers',
  clouds: 'Point clouds',
  volumes: 'Volumes',
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
  'volumes',
  'annotate',
];
export const GAP = 8;
const MORE_W = 36;

/**
 * Which groups fit on one row. `widths` are the groups' natural widths (measured while shown),
 * `fixed` the width of what always stays (view modes, right panel toggle). Only `groups`, the
 * groups of the view that is showing, count.
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

export interface ToolbarFit {
  /**
   * The groups to fold under More tools. `view` is the stage view the tools work on, `groups`
   * its groups, `shown` the widths of the groups that are on the bar right now; `fixed` and
   * `available` as in `fitGroups`.
   */
  fit(
    view: string,
    groups: readonly GroupId[],
    shown: ReadonlyMap<GroupId, number>,
    fixed: number,
    available: number,
  ): GroupId[];
}

/**
 * The fit of one toolbar across its views. A folded group cannot be measured, so its width is
 * remembered from when it was on the bar. That width holds for one view only: a group's tools
 * differ from view to view (Labels and layers is wider on the 3D view than on the map), and the
 * map kept its groups folded by the widths they had on the 3D view. So when the view or its set
 * of groups changes, the remembered widths are dropped, and while a group of this view has no
 * width yet nothing is folded: every group goes on the bar and is measured, and the next fit (the
 * caller fits again after each layout) folds what does not fit.
 */
export function createToolbarFit(): ToolbarFit {
  const widths = new Map<GroupId, number>();
  let measuredFor = '';
  return {
    fit(view, groups, shown, fixed, available) {
      const key = `${view}:${groups.join()}`;
      if (key !== measuredFor) {
        widths.clear();
        measuredFor = key;
      }
      for (const g of groups) {
        const w = shown.get(g);
        if (w !== undefined) widths.set(g, w);
      }
      if (groups.some((g) => !widths.has(g))) return [];
      return fitGroups(groups, widths, fixed, available);
    },
  };
}
