import type { ExportKind, PackageInfo, ProjectManifest } from '@aio/schema';

/** Cloud AI is off for this package whatever Settings say (AI-2, default forbid). */
export function cloudAiBlocked(pkg: PackageInfo | null): boolean {
  return pkg !== null && pkg.header.aiPolicy !== 'allow';
}

/** Player mode: a read-only customer package is open. */
export function isPlayer(pkg: PackageInfo | null): boolean {
  return pkg?.header.readOnly ?? false;
}

/**
 * May this kind of file be saved while the project is open: always for a folder project, and
 * inside a package only for the kinds its header allows (main enforces it again on save).
 */
export function exportAllowed(pkg: PackageInfo | null, kind: ExportKind): boolean {
  return pkg === null || pkg.header.exports.includes(kind);
}

const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

/** "What to try" on the welcome screen, from what the package holds. */
export function welcomeTips(manifest: ProjectManifest, issueCount: number): string[] {
  const count = (kind: string) => manifest.layers.filter((l) => l.kind === kind).length;
  const photos = manifest.layers.reduce(
    (n, l) => n + (l.kind === 'photos' ? l.items.length : 0),
    0,
  );
  const tips: string[] = [];
  if (count('mesh') > 0) {
    tips.push('Orbit the 3D model: drag to turn, scroll to zoom, double-click to focus a part.');
  }
  if (count('video') > 0) {
    tips.push(
      `Play the ${plural(count('video'), 'video clip')} on the timeline and watch the drone fly over the model.`,
    );
  }
  if (count('pointcloud') > 0) tips.push('Turn the point clouds on and off from the sidebar.');
  if (count('raster') > 0 || count('basemap') > 0) {
    tips.push('Switch the stage to Map or Split to see the site from above.');
  }
  if (issueCount > 0) {
    tips.push(
      `Open the register of ${plural(issueCount, 'issue')}; pick one to fly to it and see its photos.`,
    );
  }
  if (photos > 0) tips.push(`Browse ${plural(photos, 'inspection photo')} in Media.`);
  if (count('legacy') > 0) tips.push('Open the original review delivered with the survey.');
  tips.push('Press Ctrl K to search layers, issues and commands.');
  return tips;
}
