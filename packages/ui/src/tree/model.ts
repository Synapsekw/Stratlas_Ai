import type { Issue, Layer, ProjectManifest } from '@aio/schema';
import { formatCompact, formatDuration } from '../format';
import { flightGroups } from '../timeline/model';
import type { IconName } from '../icons/Icon';

export type TreeGroupKind =
  | 'models'
  | 'pointclouds'
  | 'maps'
  | 'measurements'
  | 'drawings'
  | 'video'
  | 'walks'
  | 'photos'
  | 'panoramas'
  | 'annotations';

export interface TreeItem {
  /** Layer id for layer rows; a fixed id for annotation rows. */
  id: string;
  /** Present when the row is a manifest layer (visibility and selection apply). */
  layerId?: string;
  layerKind?: Layer['kind'];
  name: string;
  meta?: string;
  /** A flight row: its clips, shown when the row is expanded. */
  children?: TreeItem[];
  /** A flight row: the flight id (`flightGroups`), for its flight path. */
  flightId?: string;
  /** The row is a drawing's plan (its picture): it takes the drawing controls. */
  drawing?: true;
  /** A measurement row (its `id` is `measureMark(measure.id)`). */
  measure?: {
    id: string;
    color: string;
    dimmed: boolean;
    dimmedWhy?: string;
    /** An antenna measurement: it never moves to another survey date. */
    telecom?: boolean;
  };
  /** A measurement folder row (`measure-folder:<name>`): its rows are `children`. */
  folder?: string;
  /**
   * A measurement folder under a filter: every measurement in it, the ones the filter leaves out
   * too (its `children` are only the matches). Its eye acts on these, as it does unfiltered.
   */
  folderIds?: readonly string[];
}

export interface TreeGroup {
  kind: TreeGroupKind;
  label: string;
  icon: IconName;
  count: number;
  items: TreeItem[];
  /**
   * The Measurements group under a filter: every measurement id (its `items` are only the
   * matches). `count` and the group's eye still cover these.
   */
  measureIds?: readonly string[];
  /** The Measurements group under a filter: how many measurements match (`items` hold them). */
  matched?: number;
}

const GROUPS: { kind: TreeGroupKind; label: string; icon: IconName }[] = [
  { kind: 'models', label: 'Models', icon: 'scene' },
  { kind: 'pointclouds', label: 'Point clouds', icon: 'cloud' },
  { kind: 'maps', label: 'Maps and rasters', icon: 'map' },
  { kind: 'measurements', label: 'Measurements', icon: 'measure' },
  { kind: 'drawings', label: 'Drawings', icon: 'drawing' },
  { kind: 'video', label: 'Video', icon: 'video' },
  { kind: 'walks', label: '360 walks', icon: 'pano' },
  { kind: 'photos', label: 'Photos', icon: 'photo' },
  { kind: 'panoramas', label: 'Panoramas', icon: 'pano' },
  { kind: 'annotations', label: 'Annotations', icon: 'anno' },
];

const groupOf: Record<Layer['kind'], TreeGroupKind> = {
  mesh: 'models',
  // Retired: a delivered viewer gets no row (`buildDatasetTree` skips it); the type needs the key.
  legacy: 'models',
  pointcloud: 'pointclouds',
  basemap: 'maps',
  raster: 'maps',
  vector: 'maps',
  video: 'video',
  walk: 'walks',
  photos: 'photos',
  panoramas: 'panoramas',
};

const slashed = (path: string) => path.replace(/\\/g, '/');

/**
 * The plan raster of a drawing (`drawings/<stem>/plan.png`, data-conventions section 15): a DXF
 * drawn as a picture, a PDF page, a scan.
 */
export function isDrawingPlanLayer(layer: Layer): boolean {
  return (
    layer.kind === 'raster' &&
    layer.role === 'plan' &&
    'path' in layer.src &&
    /^drawings\/[^/]+\/plan\.png$/.test(slashed(layer.src.path))
  );
}

/** A layer of a drawing: its plan, or the line work the DXF import wrote beside it. */
function isDrawingLayer(layer: Layer): boolean {
  if (isDrawingPlanLayer(layer)) return true;
  return (
    layer.kind === 'vector' &&
    'path' in layer.src &&
    slashed(layer.src.path).startsWith('drawings/')
  );
}

/** What the tree is told beside the manifest. */
export interface TreeOptions {
  /** Drawings that lie on a provisional placement (their row says "not placed"). */
  unplaced?: ReadonlySet<string> | undefined;
  /** The Measurements group's rows (measurements and folders of them). */
  measurements?: readonly TreeItem[] | undefined;
  /**
   * Every measurement id, when `measurements` are only the rows a filter matched: the group stays
   * (with no match too), counts them all and its eye acts on them all.
   */
  measurementIds?: readonly string[] | undefined;
}

/** Prefix that keeps a measurement's row and mark id apart from layer ids. */
export const MEASURE_MARK = 'measure:';

export function measureMark(id: string): string {
  return `${MEASURE_MARK}${id}`;
}

/** The measurement id of a mark, or null when the mark is not a measurement's. */
export function measureIdOf(mark: string): string | null {
  return mark.startsWith(MEASURE_MARK) ? mark.slice(MEASURE_MARK.length) : null;
}

/** Measurement ids under a tree item (a folder row holds its measurements). */
export function itemMeasureIds(it: TreeItem): string[] {
  return [...(it.measure ? [it.measure.id] : []), ...(it.children ?? []).flatMap(itemMeasureIds)];
}

/** Every measurement id in a group, folder rows included (under a filter, the ones it hides too). */
export function groupMeasureIds(g: TreeGroup): string[] {
  return g.measureIds ? [...g.measureIds] : g.items.flatMap(itemMeasureIds);
}

/** Every measurement id a folder row's eye acts on (under a filter, the ones it hides too). */
export function folderMeasureIds(it: TreeItem): string[] {
  return it.folderIds ? [...it.folderIds] : itemMeasureIds(it);
}

/**
 * The Measurements group for these rows; null when there are no measurements. With `all` (every
 * measurement id, when `items` are only a filter's matches) the group stays with no match too.
 */
export function measurementsGroup(
  items: readonly TreeItem[],
  all?: readonly string[],
  label?: string,
): TreeGroup | null {
  const base = GROUPS.find((g) => g.kind === 'measurements');
  const shown = items.flatMap(itemMeasureIds).length;
  const count = all ? all.length : shown;
  if (!base || count === 0) return null;
  return {
    ...base,
    ...(label ? { label } : {}),
    count,
    items: [...items],
    ...(all ? { measureIds: all, matched: shown } : {}),
  };
}

function metaOf(layer: Layer, durations: Readonly<Record<string, number>>): string | undefined {
  switch (layer.kind) {
    case 'mesh':
      return layer.tags?.length ? `${formatCompact(layer.tags.length)} tags` : undefined;
    case 'legacy':
      return undefined;
    case 'pointcloud':
      return layer.pointCount !== undefined ? formatCompact(layer.pointCount) : layer.format;
    case 'basemap':
      return 'offline';
    case 'raster':
      return layer.role;
    case 'vector':
      return 'GeoJSON';
    case 'video': {
      const d = durations[layer.id];
      return d !== undefined ? formatDuration(d) : undefined;
    }
    case 'walk':
      // the walk's length (`durationS`, seconds) as m:ss
      return formatDuration(layer.durationS * 1000);
    case 'photos':
    case 'panoramas':
      return formatCompact(layer.items.length);
  }
}

/**
 * The sidebar dataset tree: layers grouped by kind with counts, plus the project's annotations.
 * Drawings (everything stored under `drawings/`) have their own group.
 */
export function buildDatasetTree(
  manifest: ProjectManifest,
  issues: readonly Issue[],
  durations: Readonly<Record<string, number>> = {},
  opts: TreeOptions = {},
): TreeGroup[] {
  const groups = new Map<TreeGroupKind, TreeGroup>(
    GROUPS.map((g) => [g.kind, { ...g, count: 0, items: [] }]),
  );
  // Clips cut from one flight log sit under one flight row.
  const flights = new Map<string, ReturnType<typeof flightGroups>[number]>();
  for (const f of flightGroups(manifest.layers)) {
    if (f.clips.length > 1) for (const c of f.clips) flights.set(c.id, f);
  }
  const placed = new Set<string>();
  for (const layer of manifest.layers) {
    // A retired delivered viewer stays in older manifests and is never listed.
    if (layer.kind === 'legacy') continue;
    const drawing = isDrawingLayer(layer);
    const g = groups.get(drawing ? 'drawings' : groupOf[layer.kind]);
    if (!g) continue;
    const flight = flights.get(layer.id);
    if (flight) {
      g.count += 1;
      if (placed.has(flight.id)) continue;
      placed.add(flight.id);
      const children = flight.clips.map((c) => {
        const m = metaOf(c, durations);
        return {
          id: c.id,
          layerId: c.id,
          layerKind: c.kind,
          name: c.name.startsWith(flight.name)
            ? c.name.slice(flight.name.length).replace(/^[\s·:,|-]+/, '') || c.name
            : c.name,
          ...(m !== undefined ? { meta: m } : {}),
        };
      });
      const total = flight.clips.reduce<number | undefined>(
        (n, c) =>
          n === undefined || durations[c.id] === undefined ? undefined : n + (durations[c.id] ?? 0),
        0,
      );
      g.items.push({
        id: `flight:${flight.id}`,
        flightId: flight.id,
        name: flight.name,
        meta: total !== undefined ? formatDuration(total) : `${String(children.length)} clips`,
        children,
      });
      continue;
    }
    const meta = opts.unplaced?.has(layer.id) ? 'not placed' : metaOf(layer, durations);
    g.items.push({
      id: layer.id,
      layerId: layer.id,
      layerKind: layer.kind,
      name: layer.name,
      ...(meta !== undefined ? { meta } : {}),
      ...(drawing && layer.kind === 'raster' ? { drawing: true as const } : {}),
    });
    g.count += layer.kind === 'photos' || layer.kind === 'panoramas' ? layer.items.length : 1;
  }
  const ann = groups.get('annotations');
  if (ann && issues.length > 0) {
    ann.count = issues.length;
    ann.items.push({ id: 'issues', name: 'Issues', meta: String(issues.length) });
    const drafts = issues.filter((i) => i.status === 'draft').length;
    if (drafts > 0) ann.items.push({ id: 'drafts', name: 'Drafts', meta: String(drafts) });
  }
  const measured = measurementsGroup(opts.measurements ?? [], opts.measurementIds);
  if (measured) groups.set('measurements', measured);
  // a filtered Measurements group stays with no match: its filter box is where to clear it
  return [...groups.values()].filter((g) => g.items.length > 0 || g.matched !== undefined);
}

/** Shown state of a set of layers: every one, none, or some (a mixed eye). */
export type Visibility = 'all' | 'none' | 'mixed';

/** Layer ids under a tree item (a flight row holds its clips). */
function itemLayerIds(it: TreeItem): string[] {
  return [...(it.layerId ? [it.layerId] : []), ...(it.children ?? []).flatMap(itemLayerIds)];
}

/** Layer kinds that are never of one survey date: an offline basemap, a retired viewer. */
const NEVER_DATED: ReadonlySet<Layer['kind']> = new Set(['basemap', 'legacy']);

/**
 * The layers a row stands for that can be filed under a survey date (a flight row: its clips).
 * Empty for a row that is not a layer (Issues, Drafts) and for basemaps and retired viewers.
 */
export function datableLayerIds(it: TreeItem): string[] {
  const own = it.layerId && it.layerKind && !NEVER_DATED.has(it.layerKind) ? [it.layerId] : [];
  return [...own, ...(it.children ?? []).flatMap(datableLayerIds)];
}

/** The layers of a group that can be filed under a survey date, flight clips included. */
export function groupDatableLayerIds(group: TreeGroup): string[] {
  return group.items.flatMap(datableLayerIds);
}

/** Every layer id in a group, flight clips included. */
export function groupLayerIds(group: TreeGroup): string[] {
  return group.items.flatMap(itemLayerIds);
}

/** Every layer id in the tree. */
export function treeLayerIds(groups: readonly TreeGroup[]): string[] {
  return groups.flatMap(groupLayerIds);
}

export function visibilityOf(
  layerIds: readonly string[],
  hidden: Readonly<Record<string, true>>,
): Visibility {
  const off = layerIds.filter((id) => hidden[id] === true).length;
  return off === 0 ? 'all' : off === layerIds.length ? 'none' : 'mixed';
}

/** What a click on a group or master eye does: hide when all show, else show them all. */
export function eyeTarget(v: Visibility): boolean {
  return v !== 'all';
}

export { NO_MARKS, nextMarks, type MarkMods, type Marks } from './marks';
