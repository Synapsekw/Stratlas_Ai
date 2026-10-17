import { convertMediaManifest, updateManifestFile } from '@aio/project/builder';
import type { ProjectManifest } from '@aio/schema';
import { readIssues, readManifest } from './project';

interface OpenProjects {
  root(projectId: string): string | undefined;
  package(projectId: string): unknown;
}

export type ConvertMediaResult =
  | { ok: true; manifest: ProjectManifest; layerId: string; itemId: string }
  | { ok: false; error: string };

const fail = (error: string): ConvertMediaResult => ({ ok: false, error });

// the wording of the `pin.convert.*` strings in @aio/ui (main has no i18n)
const PACKAGE = 'A package cannot be changed.';
const MARKS = 'This photo has marks on it. Remove them first.';
const MARKS_360 = 'This 360 has marks on it. Remove them first.';
const STITCHED = 'Only a single 360 image can become a photo.';
const MISSING = 'That item is not in this layer.';
const KIND = 'That layer does not hold this kind of image.';
const REASONS = { stitched: STITCHED, missing: MISSING, kind: KIND } as const;

/**
 * Treat as 360 / Treat as photo: move one ready-made image between a photos layer and a panoramas
 * layer of its date, keeping its file. Refused, before anything is written, on a package and on a
 * photo with marks on it (a mark names the photo by id and layer, so it would lose its image).
 */
export async function convertMedia(
  registry: OpenProjects,
  req: { projectId: string; layerId: string; itemId: string; to: 'pano' | 'photo' },
): Promise<ConvertMediaResult> {
  if (registry.package(req.projectId)) return fail(PACKAGE);
  const root = registry.root(req.projectId);
  if (root === undefined) return fail(`Project "${req.projectId}" is not open.`);
  const manifest = await readManifest(root);
  if (!manifest.ok) return fail(manifest.error);
  const checked = convertMediaManifest(manifest.value, req);
  if ('error' in checked) return fail(REASONS[checked.error]);

  const issues = await readIssues(root);
  if (!issues.ok) return fail(issues.error);
  const marked = issues.value.some((issue) =>
    issue.sightings.some((s) =>
      req.to === 'pano'
        ? s.on === 'image' && s.layer === req.layerId && s.photo === req.itemId
        : s.on === 'pano' && s.layer === req.layerId && s.pano === req.itemId,
    ),
  );
  if (marked) return fail(req.to === 'pano' ? MARKS : MARKS_360);

  try {
    const saved = await updateManifestFile(root, (current) => {
      const r = convertMediaManifest(current, req);
      if ('error' in r) throw new Error(REASONS[r.error]);
      return { manifest: r.manifest, layerId: r.layerId, itemId: r.itemId };
    });
    return { ok: true, manifest: saved.manifest, layerId: saved.layerId, itemId: saved.itemId };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
