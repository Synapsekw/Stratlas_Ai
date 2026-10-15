import type { Issue, ProjectManifest } from '@aio/schema';

/** A layer a finding can be placed on, for the picker. */
export interface LayerChoice {
  id: string;
  name: string;
  kind: 'mesh' | 'pointcloud';
  /** Of a survey date the findings' photos or frames belong to. */
  sameDate: boolean;
}

/** The project's mesh and point-cloud layers, those of the photos' dates first (spec section 6). */
export function layerChoices(
  manifest: Pick<ProjectManifest, 'layers'>,
  dates: { of: Readonly<Record<string, string>> } | null,
  issues: readonly Issue[],
): LayerChoice[] {
  const photoDates = new Set<string>();
  for (const i of issues)
    for (const s of i.sightings) {
      if (s.on !== 'image' && s.on !== 'video') continue;
      const d = dates?.of[s.layer];
      if (d) photoDates.add(d);
    }
  const all: LayerChoice[] = [];
  for (const l of manifest.layers) {
    if (l.kind !== 'mesh' && l.kind !== 'pointcloud') continue;
    const d = dates?.of[l.id];
    all.push({
      id: l.id,
      name: l.name,
      kind: l.kind,
      sameDate: d !== undefined && photoDates.has(d),
    });
  }
  return [...all.filter((c) => c.sameDate), ...all.filter((c) => !c.sameDate)];
}

/** An image sighting with a box, rotated box or polygon, or a video sighting (always shaped). */
export function hasPhotoShape(issue: Pick<Issue, 'sightings'>): boolean {
  return issue.sightings.some((s) =>
    s.on === 'image'
      ? s.geom.type === 'box' || s.geom.type === 'rotbox' || s.geom.type === 'polygon'
      : s.on === 'video' && s.track.length > 0,
  );
}
