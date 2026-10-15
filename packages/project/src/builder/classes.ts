import { ClassCatalogue, type ProjectManifest } from '@aio/schema';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { updateManifestFile } from './manifestFile';

/*
 * Class catalogues edited after the project was created (ANN-7, `builder:updateClasses`). Only
 * `manifest.classCatalogues` changes; saved in turn with a backup like `updateCapture`.
 */

const RESERVED = new Set(['a', 'u']);

/** Why `catalogues` cannot replace the manifest's, or null. `usedClassIds`: classes issues use. */
export function cataloguesProblem(
  m: ProjectManifest,
  catalogues: readonly ClassCatalogue[],
  usedClassIds: ReadonlySet<string>,
): string | null {
  const parsed = z.array(ClassCatalogue).safeParse(catalogues);
  if (!parsed.success) {
    return `The classes are invalid: ${parsed.error.issues[0]?.message ?? 'unknown error'}`;
  }
  const models = new Set(m.severityModels.map((s) => s.id));
  const catalogueIds = new Set<string>();
  const ids = new Set<string>();
  const keys = new Map<string, string>();
  for (const c of catalogues) {
    if (catalogueIds.has(c.id)) return `Two class catalogues have the id "${c.id}".`;
    catalogueIds.add(c.id);
    for (const k of c.classes) {
      if (ids.has(k.id)) return `Two classes have the id "${k.id}".`;
      ids.add(k.id);
      if (!models.has(k.severityModel)) {
        return `Class ${k.label} names severity model "${k.severityModel}", which the project does not have.`;
      }
      if (k.hotkey) {
        if (!/^[a-z]$/i.test(k.hotkey)) return `Class ${k.label}: A hotkey is one letter.`;
        const key = k.hotkey.toLowerCase();
        if (RESERVED.has(key)) return `Class ${k.label}: "${key}" is reserved in the class picker.`;
        const other = keys.get(key);
        if (other) return `Classes ${other} and ${k.label} share the hotkey "${key}".`;
        keys.set(key, k.label);
      }
    }
  }
  const had = new Set(m.classCatalogues.flatMap((c) => c.classes.map((k) => k.id)));
  for (const id of usedClassIds) {
    if (had.has(id) && !ids.has(id)) {
      return `Class "${id}" still has issues. Move them to another class first.`;
    }
  }
  return null;
}

/** Class ids the saved issues use (an absent `issues.json` uses none). */
async function usedClasses(root: string): Promise<Set<string>> {
  let text: string;
  try {
    text = await readFile(join(root, 'issues.json'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw e;
  }
  let raw: { issues?: { classId?: unknown }[] };
  try {
    raw = JSON.parse(text) as { issues?: { classId?: unknown }[] };
  } catch {
    throw new Error('The issues file could not be read, so classes in use cannot be checked.');
  }
  return new Set(
    (raw.issues ?? []).flatMap((i) => (typeof i.classId === 'string' ? [i.classId] : [])),
  );
}

/** Replace the project's class catalogues (validated against the manifest and the saved issues). */
export async function updateClasses(
  root: string,
  catalogues: readonly ClassCatalogue[],
): Promise<{ manifest: ProjectManifest; backup: string }> {
  const r = await updateManifestFile(root, async (m) => {
    const used = await usedClasses(root);
    const problem = cataloguesProblem(m, catalogues, used);
    if (problem) throw new Error(problem);
    return {
      manifest: {
        ...m,
        classCatalogues: catalogues.map((c) => ({
          ...c,
          classes: c.classes.map((k) => ({ ...k })),
        })),
      },
    };
  });
  return { manifest: r.manifest, backup: r.backup };
}
