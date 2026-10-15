import type { LibraryEntry } from '@aio/schema';

export type ProjectActionId =
  | 'open'
  | 'rename'
  | 'reveal'
  | 'thumbnail'
  | 'move'
  | 'emptyTrash'
  | 'export'
  | 'close'
  | 'remove'
  | 'delete';

/** Why an action is not offered for this project (shown under the greyed item). */
export type WhyNot = 'package' | 'demo' | 'kit' | 'outside' | 'open' | 'job';

export interface ProjectAction {
  id: ProjectActionId;
  /** Set when the action is shown but cannot run. */
  why?: WhyNot;
}

/** The props every dialog opened from the project menu takes. */
export interface EntryDialogProps {
  entry: LibraryEntry;
  current: boolean;
  onClose: () => void;
  returnTo: () => HTMLElement | null;
}

/** Windows paths compare without case and with either slash. */
function norm(path: string): { parts: string[]; windows: boolean } {
  const windows = path.includes('\\') || /^[A-Za-z]:/.test(path);
  const unified = windows ? path.replace(/\//g, '\\').toLowerCase() : path;
  return { parts: unified.split(windows ? '\\' : '/').filter((p) => p !== ''), windows };
}

/** Do two path texts name the same place, going by the names alone (case and slash folded)? */
export function samePathText(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  return (
    x.windows === y.windows &&
    x.parts.length === y.parts.length &&
    x.parts.every((part, i) => y.parts[i] === part)
  );
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
 * The menu of one project card, in order. Rename is shown greyed with its reason when the card is
 * not an ordinary project folder in the data folder; Export package and Close project appear on the
 * open project only. Remove from library is always offered; Delete is held back on the open project
 * and while a job runs in it.
 */
export function projectActions(
  entry: LibraryEntry,
  o: { dataRoot: string; current: boolean; jobRunning: boolean },
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
    { id: 'thumbnail' },
    { id: 'move' },
    withWhy('emptyTrash', entry.package ? 'package' : entry.kind !== 'native' ? 'kit' : undefined),
    ...(o.current && !entry.package ? [{ id: 'export' as const }] : []),
    ...(o.current ? [{ id: 'close' as const }] : []),
    { id: 'remove' },
    withWhy('delete', o.current ? 'open' : o.jobRunning ? 'job' : undefined),
  ];
}
