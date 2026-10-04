import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Issue } from '@aio/schema';

/** An imported issue nobody has changed since the importer wrote it. */
const untouchedImport = (i: Issue) => i.source === 'import' && i.updatedAt === i.createdAt;

/**
 * Merge a fresh import into the issues already saved in the package, by id, so a re-run never
 * loses work done in the app:
 * - an imported issue replaces the saved one only while the saved one is untouched;
 * - issues people or agents created, and imported issues someone edited, are always kept
 *   (after the imported ones, in their saved order);
 * - untouched imported issues the source no longer has are dropped.
 * Saved entries that are not valid issues are ignored.
 */
export function mergeImportedIssues(
  existing: readonly unknown[],
  imported: readonly Issue[],
): Issue[] {
  const saved = new Map<string, Issue>();
  for (const raw of existing) {
    const p = Issue.safeParse(raw);
    if (p.success) saved.set(p.data.id, p.data);
  }
  const out = imported.map((i) => {
    const s = saved.get(i.id);
    return s && !untouchedImport(s) ? s : i;
  });
  const ids = new Set(imported.map((i) => i.id));
  for (const s of saved.values()) if (!ids.has(s.id) && !untouchedImport(s)) out.push(s);
  return out;
}

/** The `issues` array of `<dir>/issues.json`, or an empty list when there is none. */
export function readSavedIssues(dir: string): unknown[] {
  const file = join(dir, 'issues.json');
  if (!existsSync(file)) return [];
  const json = JSON.parse(readFileSync(file, 'utf8')) as { issues?: unknown };
  return Array.isArray(json.issues) ? json.issues : [];
}
