import type { Issue, Sighting, Vec3 } from '@aio/schema';

const isCloudPoint = (s: Sighting): boolean => s.on === 'pointcloud' && s.geom.type === 'point3';

/** The 3D point an issue sits at in a point cloud (its first cloud point sighting), if any. */
export function findingPoint(issue: Issue): { layer: string; p: Vec3 } | null {
  for (const s of issue.sightings) {
    if (s.on === 'pointcloud' && s.geom.type === 'point3') return { layer: s.layer, p: s.geom.p };
  }
  return null;
}

/**
 * Move an issue's cloud point: replace the first cloud point sighting (or add one) and stamp
 * `updatedAt`. An imported finding is marked `moved` so a re-import keeps the person's edit.
 */
export function moveFindingPoint(issue: Issue, layer: string, p: Vec3, now: string): Issue {
  const next: Sighting = { on: 'pointcloud', layer, geom: { type: 'point3', p } };
  const at = issue.sightings.findIndex(isCloudPoint);
  const sightings =
    at < 0 ? [...issue.sightings, next] : issue.sightings.map((s, i) => (i === at ? next : s));
  return {
    ...issue,
    sightings,
    updatedAt: now,
    ...(issue.external ? { external: { ...issue.external, locationCheck: 'moved' as const } } : {}),
  };
}
