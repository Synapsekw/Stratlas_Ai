// Spaces the mission import made for its chambers before their jobs ran (raw.ts
// `planInspectorJobs`). A job that ends without importing, a chamber whose turn never came (a
// cancel, a closed project, a quit) leaves its space empty; these are tidied away.
import { updateManifestFile } from '../manifestFile';

/**
 * Remove the Flyability spaces no layer is in, except those of the inspections in `keep` (their
 * import still waits or runs). The job writes a space and its layers in one save, so an empty one
 * is always one made ahead for a chamber. Returns the ids removed; a project that cannot be read
 * is left as it is.
 */
export async function removeEmptyInspectorSpaces(
  root: string,
  keep: ReadonlySet<string>,
): Promise<string[]> {
  try {
    const r = await updateManifestFile(root, (m) => {
      const used = new Set(m.layers.flatMap((l) => (l.space !== undefined ? [l.space] : [])));
      const gone = (m.spaces ?? []).filter(
        (s) =>
          s.source?.kind === 'flyability' && !used.has(s.id) && !keep.has(s.source.inspectionId),
      );
      if (gone.length === 0) return { manifest: null, removed: [] as string[] };
      const ids = new Set(gone.map((s) => s.id));
      return {
        manifest: { ...m, spaces: (m.spaces ?? []).filter((s) => !ids.has(s.id)) },
        removed: [...ids],
      };
    });
    return r.removed;
  } catch {
    return [];
  }
}
