// Spaces the mission import made for its chambers before their jobs ran (raw.ts
// `planInspectorJobs`), marked `source.pending`. A chamber whose import never filled its space (a
// cancel, a closed project, a dropped chamber) leaves it pending and empty; these are tidied away.
// A space that holds layers is pending no more, so a chamber the user emptied later stays.
import type { Space } from '@aio/schema';
import { updateManifestFile } from '../manifestFile';

export interface TidyResult {
  /** Ids of the pending, empty spaces removed. */
  removed: string[];
  /** Whether the manifest was written (a space removed, or a filled one no longer pending). */
  changed: boolean;
}

const unpend = (s: Space): Space => {
  if (!s.source) return s;
  const source = { ...s.source };
  delete source.pending;
  return { ...s, source };
};

/**
 * Remove the pending Flyability spaces no layer is in, except those of the inspections in `keep`
 * (their import waits, runs, or can be resumed), and clear `pending` on those that hold layers.
 * A project that cannot be read is left as it is.
 */
export async function removeEmptyInspectorSpaces(
  root: string,
  keep: ReadonlySet<string>,
): Promise<TidyResult> {
  try {
    const r = await updateManifestFile(root, (m) => {
      const used = new Set(m.layers.flatMap((l) => (l.space !== undefined ? [l.space] : [])));
      const removed: string[] = [];
      let changed = false;
      const spaces: Space[] = [];
      for (const s of m.spaces ?? []) {
        if (s.source?.kind !== 'flyability' || s.source.pending !== true) {
          spaces.push(s);
        } else if (used.has(s.id)) {
          spaces.push(unpend(s));
          changed = true;
        } else if (keep.has(s.source.inspectionId)) {
          spaces.push(s);
        } else {
          removed.push(s.id);
          changed = true;
        }
      }
      return changed
        ? { manifest: { ...m, spaces }, removed, changed }
        : { manifest: null, removed, changed };
    });
    return { removed: r.removed, changed: r.changed };
  } catch {
    return { removed: [], changed: false };
  }
}
