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
 * - untouched imported issues the source no longer has are dropped, unless `opts.keepMissing`
 *   is set: then they stay too, so a re-import of a partial export loses nothing.
 * Rules with `keepMissing`: the Python flyability.import job (`merge_issues` in
 * python/src/aio_pipelines/flyability/findings.py) merges this way; no TS caller passes it, it is
 * kept here so the parity tests in keep.test.ts pin the rules both sides follow:
 *   1. result = the imported issues in import order, each replaced by the saved issue with the
 *      same id when that one is not untouched (source 'import' and updatedAt === createdAt);
 *   2. then every saved issue whose id is not in the import, in saved order, whatever its
 *      state (untouched or edited, imported or human); without `keepMissing` only the ones
 *      that are not untouched imports;
 *   3. saved entries that fail Issue validation are ignored; a repeated saved id keeps the last.
 */
export function mergeImportedIssues(
  existing: readonly unknown[],
  imported: readonly Issue[],
  opts: { keepMissing?: boolean } = {},
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
  for (const s of saved.values())
    if (!ids.has(s.id) && (opts.keepMissing || !untouchedImport(s))) out.push(s);
  return out;
}

/** The `issues` array of `<dir>/issues.json`, or an empty list when there is none. */
export function readSavedIssues(dir: string): unknown[] {
  const file = join(dir, 'issues.json');
  if (!existsSync(file)) return [];
  const json = JSON.parse(readFileSync(file, 'utf8')) as { issues?: unknown };
  return Array.isArray(json.issues) ? json.issues : [];
}
