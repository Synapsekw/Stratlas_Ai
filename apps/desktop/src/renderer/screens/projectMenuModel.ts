import type { LibraryEntry } from '@aio/schema';

export type ProjectActionId = 'open' | 'rename' | 'reveal' | 'export' | 'close' | 'delete';

/** Why an action is not offered for this project (shown under the greyed item). */
export type WhyNot = 'package' | 'demo' | 'kit' | 'outside' | 'open';

export interface ProjectAction {
  id: ProjectActionId;
  /** Set when the action is shown but cannot run. */
  why?: WhyNot;
}

/** Windows paths compare without case and with either slash. */
function norm(path: string): { parts: string[]; windows: boolean } {
  const windows = path.includes('\\') || /^[A-Za-z]:/.test(path);
  const unified = windows ? path.replace(/\//g, '\\').toLowerCase() : path;
  return { parts: unified.split(windows ? '\\' : '/').filter((p) => p !== ''), windows };
}

/**
 * Is `path` a folder directly inside `<dataRoot>/projects`, going by the names alone? Only those
 * projects can be renamed or deleted from the library. Main checks the disk again before it acts.
 */
export function inDataFolder(dataRoot: string, path: string): boolean {
  if (dataRoot.trim() === '') return false;
  const root = norm(dataRoot);
  const p = norm(path);
  if (root.windows !== p.windows || p.parts.length !== root.parts.length + 2) return false;
  if (p.parts.includes('..') || p.parts.includes('.')) return false;
  return (
    root.parts.every((part, i) => p.parts[i] === part) && p.parts[root.parts.length] === 'projects'
  );
}

/**
 * The menu of one project card, in order. Rename and Delete are shown greyed with their reason
 * when the card is not an ordinary project folder in the data folder; Export package and Close
 * project appear on the open project only.
 */
export function projectActions(
  entry: LibraryEntry,
  o: { dataRoot: string; current: boolean },
): ProjectAction[] {
  const fixed: WhyNot | undefined = entry.package
    ? 'package'
    : entry.demo
      ? 'demo'
      : entry.kind !== 'native'
        ? 'kit'
        : !inDataFolder(o.dataRoot, entry.path)
          ? 'outside'
          : undefined;
  const withWhy = (id: ProjectActionId, why: WhyNot | undefined): ProjectAction =>
    why ? { id, why } : { id };
  return [
    { id: 'open' },
    withWhy('rename', fixed),
    { id: 'reveal' },
    ...(o.current && !entry.package ? [{ id: 'export' as const }] : []),
    ...(o.current ? [{ id: 'close' as const }] : []),
    withWhy('delete', fixed ?? (o.current ? 'open' : undefined)),
  ];
}
