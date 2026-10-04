import type { ExportKind, PackagePlan } from '@aio/schema';

type PlanLayer = PackagePlan['layers'][number];

export interface LayerGroup {
  kind: string;
  label: string;
  layers: PlanLayer[];
  count: number;
  bytes: number;
  /** How many of the group's layers are in the package. */
  state: 'all' | 'some' | 'none';
}

const GROUPS: { kind: string; label: string }[] = [
  { kind: 'mesh', label: 'Models' },
  { kind: 'pointcloud', label: 'Point clouds' },
  { kind: 'video', label: 'Video clips' },
  { kind: 'photos', label: 'Photos' },
  { kind: 'panoramas', label: 'Panoramas' },
  { kind: 'raster', label: 'Rasters and orthos' },
  { kind: 'basemap', label: 'Base maps' },
  { kind: 'legacy', label: 'Original review viewer' },
];

/** Export kinds a builder can grant, in dialog order. */
export const EXPORT_CHOICES: { kind: ExportKind; label: string }[] = [
  { kind: 'issues-csv', label: 'Issue list (CSV)' },
  { kind: 'report-pdf', label: 'PDF report' },
  { kind: 'snapshot', label: 'Screenshots and views' },
  { kind: 'issues-geojson', label: 'GeoJSON' },
  { kind: 'kit-json', label: 'Kit and COCO JSON' },
  { kind: 'masks', label: 'Mask archives' },
  { kind: 'files', label: 'Source files (models, clips)' },
];

export function groupLayers(
  layers: readonly PlanLayer[],
  excluded: ReadonlySet<string>,
): LayerGroup[] {
  const out: LayerGroup[] = [];
  for (const g of GROUPS) {
    const members = layers.filter((l) => l.kind === g.kind);
    if (members.length === 0) continue;
    const kept = members.filter((l) => !excluded.has(l.id)).length;
    out.push({
      kind: g.kind,
      label: g.label,
      layers: members,
      count: members.length,
      bytes: members.reduce((n, l) => n + l.bytes, 0),
      state: kept === members.length ? 'all' : kept === 0 ? 'none' : 'some',
    });
  }
  return out;
}

/** Leave a whole group out, or bring it all back when any of it is out. */
export function toggleGroup(
  excluded: ReadonlySet<string>,
  layers: readonly PlanLayer[],
  kind: string,
): Set<string> {
  const ids = layers.filter((l) => l.kind === kind).map((l) => l.id);
  const next = new Set(excluded);
  const allIn = ids.every((id) => !excluded.has(id));
  for (const id of ids) {
    if (allIn) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** Null when the passphrase can be used. */
export function validatePassphrase(pass: string, again: string): string | null {
  if (pass.length < 8) return 'Use at least 8 characters.';
  if (pass !== again) return 'The two passphrases do not match.';
  return null;
}
