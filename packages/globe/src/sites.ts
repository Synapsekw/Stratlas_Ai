import type { GlobeSite, Issue, ProjectManifest, SeverityModel, Sighting, Vec3 } from '@aio/schema';

/**
 * Library projects and their issues as pins on the Globe: where each pin goes and what it says.
 * Positions of issues are local-frame points of their 3D sightings (mesh and point cloud);
 * issues seen only in photos, video or on the map have no 3D anchor and no pin.
 */

/** The pin colour of an open issue: its severity level's colour, grey when uncertain. */
export function severityColour(
  issue: Pick<Issue, 'severity' | 'severityModelId'>,
  models: readonly SeverityModel[],
): string {
  const model = models.find((m) => m.id === issue.severityModelId);
  if (issue.severity === 'uncertain') return model?.uncertain?.color ?? '#8a8f98';
  const level = model?.levels.find((l) => l.value === issue.severity);
  return level?.color ?? '#d0a03a';
}

const centroid = (pts: readonly Vec3[]): Vec3 => {
  const s = pts.reduce<Vec3>((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]);
  return [s[0] / pts.length, s[1] / pts.length, s[2] / pts.length];
};

/** The local-frame anchor of a 3D sighting, or null (photo, video, map, panorama, selection). */
export function sightingAnchor(s: Sighting): Vec3 | null {
  if (s.on === 'mesh') {
    const g = s.geom;
    if (g.type === 'spoint') return g.p;
    if (g.type === 'spolyline' || g.type === 'spolygon') return centroid(g.points);
    return g.center ?? null;
  }
  if (s.on === 'pointcloud') {
    const g = s.geom;
    if (g.type === 'point3') return g.p;
    if (g.type === 'box3') return centroid([g.min, g.max]);
    if (g.type === 'polygon3') return centroid(g.points);
  }
  return null;
}

export interface IssuePin {
  id: string;
  code: string;
  title: string;
  local: Vec3;
  colour: string;
  severity: Issue['severity'];
}

/** Open issues (not closed) with a 3D anchor, as pins. */
export function issuePins(
  issues: readonly Issue[],
  manifest: Pick<ProjectManifest, 'severityModels'>,
): IssuePin[] {
  const out: IssuePin[] = [];
  for (const i of issues) {
    if (i.status === 'closed') continue;
    const local = i.sightings.map(sightingAnchor).find((a) => a !== null);
    if (!local) continue;
    out.push({
      id: i.id,
      code: i.code,
      title: i.title,
      local,
      colour: severityColour(i, manifest.severityModels),
      severity: i.severity,
    });
  }
  return out;
}

/** The last capture date of a site, or null. */
export function lastCapture(site: Pick<GlobeSite, 'captures'>): string | null {
  return (
    site.captures
      .map((c) => c.date)
      .sort()
      .at(-1) ?? null
  );
}

/** Sites in a stable order: by name, then id. */
export function sortSites<S extends Pick<GlobeSite, 'name' | 'projectId'>>(
  sites: readonly S[],
): S[] {
  return [...sites].sort(
    (a, b) => a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId),
  );
}

/** A box around every site (with a margin), for the opening view; null without sites. */
export function sitesBounds(
  sites: readonly Pick<GlobeSite, 'lonLat'>[],
  marginDeg = 2,
): [number, number, number, number] | null {
  if (sites.length === 0) return null;
  const lons = sites.map((s) => s.lonLat[0]);
  const lats = sites.map((s) => s.lonLat[1]);
  return [
    Math.max(-180, Math.min(...lons) - marginDeg),
    Math.max(-90, Math.min(...lats) - marginDeg),
    Math.min(180, Math.max(...lons) + marginDeg),
    Math.min(90, Math.max(...lats) + marginDeg),
  ];
}
