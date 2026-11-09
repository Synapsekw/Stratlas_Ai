// Find the Flyability Inspector exports in a picked folder: the export itself, or a mission folder
// where the chambers' exports sit some levels down beside raw drone folders, reports and ROV dives.
// The walk lists folders only (one readdir each), never opens a file, never goes into an export,
// and stops at a depth and a folder cap so a whole drive picked by mistake stays quick.
import type { InspectorMission, ProjectManifest } from '@aio/schema';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { scanInspectorExport } from './scan';

const REQUIRED = ['flights', 'maps', 'pois', 'snapshots'];

/** How deep below the picked folder an export may sit (the picked folder is depth 0). */
export const MISSION_MAX_DEPTH = 5;
/** Folders listed at most; past it the walk stops and says so (`capped`). */
export const MISSION_MAX_DIRS = 5000;

/** Folders the walk never enters nor reports: hidden, system, archive revisions. */
const IGNORED = /^(\..*|\$.*|system volume information|__macosx|.*\.backup)$/i;
/** Files the operating system adds to a folder; not counted as skipped files. */
const OS_FILES = /^(thumbs\.db|desktop\.ini|\.ds_store|\._.*|\..*)$/i;

export interface MissionWalkOptions {
  maxDepth?: number;
  maxDirs?: number;
}

export interface ExportWalk {
  /** Export folders, absolute, in folder order (Chamber 2 before Chamber 10). */
  exports: string[];
  skipped: InspectorMission['skipped'];
  /** The loose files counted in `skipped.files`, relative to the picked folder. */
  looseFiles: string[];
  capped: boolean;
}

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** The exports in `path` (itself, or at most `maxDepth` levels down), and what was left out. */
export async function findInspectorExports(
  path: string,
  opts: MissionWalkOptions = {},
): Promise<ExportWalk> {
  const root = resolve(path);
  const maxDepth = opts.maxDepth ?? MISSION_MAX_DEPTH;
  const maxDirs = opts.maxDirs ?? MISSION_MAX_DIRS;
  const exports: string[] = [];
  const folders: string[] = [];
  const looseFiles: string[] = [];
  let visited = 0;
  let capped = false;

  /** Whether `dir` is or holds an export; the folders beside an export's path are noted. */
  const visit = async (dir: string, depth: number): Promise<boolean> => {
    if (visited >= maxDirs) {
      capped = true;
      return false;
    }
    visited++;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && !IGNORED.test(e.name))
      .map((e) => e.name)
      .sort(byName);
    const names = new Set(dirs);
    if (REQUIRED.every((n) => names.has(n))) {
      exports.push(dir);
      return true;
    }
    const without: string[] = [];
    let holds = false;
    for (const name of dirs) {
      const child = join(dir, name);
      if (depth < maxDepth && (await visit(child, depth + 1))) holds = true;
      else without.push(child);
    }
    // only on the way to an export (or at the picked folder) is anything reported as left out
    if (holds || depth === 0) {
      folders.push(...without.map((p) => relative(root, p)));
      for (const e of entries)
        if (e.isFile() && !OS_FILES.test(e.name))
          looseFiles.push(relative(root, join(dir, e.name)));
    }
    return holds;
  };

  await visit(root, 0);
  const depthOf = (p: string) => p.split(sep).length;
  folders.sort((a, b) => depthOf(a) - depthOf(b) || byName(a, b));
  return { exports, skipped: { folders, files: looseFiles.length }, looseFiles, capped };
}

/** The inspection ids of an export (`inspections/<id>/inspection.json`, else the folder name). */
export async function inspectionIdsOf(exportRoot: string): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(join(exportRoot, 'inspections'))).sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    try {
      const v = JSON.parse(
        await readFile(join(exportRoot, 'inspections', n, 'inspection.json'), 'utf8'),
      ) as { id?: unknown } | null;
      out.push(typeof v?.id === 'string' && v.id !== '' ? v.id : n);
    } catch {
      /* not an inspection record */
    }
  }
  return out;
}

const sameKey = (p: string) =>
  process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);

/**
 * Every export in a picked folder, read for the picker. A chamber is named after its export
 * folder; an export picked itself is named after its sole inspection (else its asset, else the
 * folder). Two chambers of one name are told apart by their path below the picked folder.
 */
export async function scanInspectorMission(
  path: string,
  manifest: ProjectManifest | null,
  opts: MissionWalkOptions = {},
): Promise<InspectorMission> {
  const root = resolve(path);
  const walk = await findInspectorExports(root, opts);
  const exports: InspectorMission['exports'] = [];
  // one after the other: the exports often sit on one slow drive
  for (const p of walk.exports) {
    const scan = await scanInspectorExport(p, manifest);
    const own = sameKey(p) === sameKey(root);
    const sole = scan.inspections.length === 1 ? (scan.inspections[0]?.name.trim() ?? '') : '';
    const asset = scan.asset?.trim() ?? '';
    const name = !own ? basename(p) : sole !== '' ? sole : asset !== '' ? asset : basename(root);
    exports.push({ path: p, name, scan });
  }
  const seen = new Map<string, number>();
  for (const e of exports) seen.set(e.name, (seen.get(e.name) ?? 0) + 1);
  for (const e of exports)
    if ((seen.get(e.name) ?? 0) > 1 && sameKey(e.path) !== sameKey(root))
      e.name = relative(root, e.path);
  return { root, exports, skipped: walk.skipped, capped: walk.capped };
}
