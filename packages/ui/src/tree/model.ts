import type { Issue, Layer, ProjectManifest } from '@aio/schema';
import { formatCompact, formatDuration } from '../format';
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
  for (const layer of manifest.layers) {
    const g = groups.get(groupOf[layer.kind]);
    if (!g) continue;
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
