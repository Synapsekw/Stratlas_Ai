import type { Issue, Layer, ProjectManifest } from '@aio/schema';
import { formatCompact, formatDuration } from '../format';
import { flightGroups } from '../timeline/model';
import type { IconName } from '../icons/Icon';

export type TreeGroupKind =
  'models' | 'pointclouds' | 'maps' | 'video' | 'photos' | 'panoramas' | 'annotations';

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
}

export interface TreeGroup {
  kind: TreeGroupKind;
  label: string;
  icon: IconName;
  count: number;
  items: TreeItem[];
}

const GROUPS: { kind: TreeGroupKind; label: string; icon: IconName }[] = [
  { kind: 'models', label: 'Models', icon: 'scene' },
  { kind: 'pointclouds', label: 'Point clouds', icon: 'cloud' },
  { kind: 'maps', label: 'Maps and rasters', icon: 'map' },
  { kind: 'video', label: 'Video', icon: 'video' },
  { kind: 'photos', label: 'Photos', icon: 'photo' },
  { kind: 'panoramas', label: 'Panoramas', icon: 'pano' },
  { kind: 'annotations', label: 'Annotations', icon: 'anno' },
];

const groupOf: Record<Layer['kind'], TreeGroupKind> = {
  mesh: 'models',
  legacy: 'models',
  pointcloud: 'pointclouds',
  basemap: 'maps',
  raster: 'maps',
  vector: 'maps',
  video: 'video',
  photos: 'photos',
  panoramas: 'panoramas',
};

function metaOf(layer: Layer, durations: Readonly<Record<string, number>>): string | undefined {
  switch (layer.kind) {
    case 'mesh':
      return layer.tags?.length ? `${formatCompact(layer.tags.length)} tags` : undefined;
    case 'legacy':
      return 'legacy';
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
    case 'photos':
    case 'panoramas':
      return formatCompact(layer.items.length);
  }
}

/** The sidebar dataset tree: layers grouped by kind with counts, plus the project's annotations. */
export function buildDatasetTree(
  manifest: ProjectManifest,
  issues: readonly Issue[],
  durations: Readonly<Record<string, number>> = {},
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
    const g = groups.get(groupOf[layer.kind]);
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
    const meta = metaOf(layer, durations);
    g.items.push({
      id: layer.id,
      layerId: layer.id,
      layerKind: layer.kind,
      name: layer.name,
      ...(meta !== undefined ? { meta } : {}),
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
  return [...groups.values()].filter((g) => g.items.length > 0);
}
