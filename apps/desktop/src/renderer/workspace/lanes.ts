import { siteUtcOffsetMin } from '@aio/geo';
import type { ProjectManifest } from '@aio/schema';

/**
 * Whether the bottom timeline shows date lanes: a project with video and at least one survey
 * date. Road projects are decided by the caller (they keep the chainage ruler).
 */
export function usesLanes(
  manifest: Pick<ProjectManifest, 'layers'>,
  index: { captures: readonly unknown[] } | null,
): boolean {
  return (
    index !== null && index.captures.length > 0 && manifest.layers.some((l) => l.kind === 'video')
  );
}

/** The site clock offset from the project longitude (builder rule), null when unknown. */
export function siteOffset(manifest: Pick<ProjectManifest, 'crs' | 'origin'>): number | null {
  return siteUtcOffsetMin(manifest.origin, 'epsg' in manifest.crs ? manifest.crs.epsg : undefined);
}
