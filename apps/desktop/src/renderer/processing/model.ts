/**
 * The rules of the project's Processing chip and drawer, as pure functions: which jobs belong to
 * the open project, what runs elsewhere on this computer, what still needs a look, and what the
 * chip says. The job index is machine-wide (`jobs:list`); a job belongs to the project whose
 * folder it wrote into.
 */
import type { JobRecord, LibraryEntry } from '@aio/schema';
import { isActive, sameFolder } from '../jobs';

export interface ProjectJobs {
  /** Newest first, as the index gives them. */
  running: JobRecord[];
  finished: JobRecord[];
}

/** The jobs of the project at `root`. Without a project (or in a package), none. */
export function projectJobs(all: readonly JobRecord[], root: string | null): ProjectJobs {
  if (root === null) return { running: [], finished: [] };
  const mine = all.filter((j) => sameFolder(j.project, root));
  return { running: mine.filter(isActive), finished: mine.filter((j) => !isActive(j)) };
}

/**
 * What is running in other project folders. A map pack build is not project work (Settings, Map
 * packs shows it), so it is left out.
 */
export function runningElsewhere(all: readonly JobRecord[], root: string | null): JobRecord[] {
  return all.filter(
    (j) =>
      isActive(j) &&
      !j.pipeline.startsWith('packs.') &&
      (root === null || !sameFolder(j.project, root)),
  );
}

export interface Seen {
  /** When this session started (ISO). */
  start: string;
  /** When the drawer was last opened or closed in this project, this session (ISO), or null. */
  seenAt: string | null;
}

/**
 * The finished jobs a person has not looked at: a failure of this session since the drawer was
 * last open, and any interrupted job until the drawer is opened once (it waits for Resume).
 */
export function needsAttention(finished: readonly JobRecord[], seen: Seen): JobRecord[] {
  return finished.filter((j) => {
    if (j.status === 'interrupted') return seen.seenAt === null || j.updatedAt > seen.seenAt;
    if (j.status === 'failed') return j.updatedAt > (seen.seenAt ?? seen.start);
    return false;
  });
}

export type ChipState =
  | { kind: 'hidden' }
  | { kind: 'idle' }
  | { kind: 'one'; pct: number }
  | { kind: 'many'; count: number }
  | { kind: 'attention'; count: number }
  | { kind: 'elsewhere'; count: number };

/**
 * What the chip says. `own` is false with no project open and in a read-only package, which has
 * no processing of its own: the chip then shows only while something runs elsewhere.
 */
export function chipState(input: {
  own: boolean;
  mine: ProjectJobs;
  elsewhere: number;
  attention: number;
}): ChipState {
  const { own, mine, elsewhere, attention } = input;
  if (own && attention > 0) return { kind: 'attention', count: attention };
  const first = mine.running[0];
  if (own && mine.running.length === 1 && first)
    return { kind: 'one', pct: Math.round(first.progress * 100) };
  if (own && mine.running.length > 1) return { kind: 'many', count: mine.running.length };
  if (elsewhere > 0) return { kind: 'elsewhere', count: elsewhere };
  return own ? { kind: 'idle' } : { kind: 'hidden' };
}

/** A project folder by the name the library knows it under, else by its folder name. */
export function projectLabel(
  folder: string,
  library: readonly Pick<LibraryEntry, 'name' | 'path'>[],
): string {
  const known = library.find((e) => sameFolder(e.path, folder));
  if (known) return known.name;
  return (
    folder
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? folder
  );
}

/**
 * The job whose details the drawer shows: the picked one, if it belongs to the open project or
 * is still running elsewhere. A picked job that is gone, or that belongs to a project no longer
 * open, shows nothing: the drawer falls back to its list.
 */
export function shownJob(
  all: readonly JobRecord[],
  picked: string | null,
  root: string | null,
): JobRecord | undefined {
  if (picked === null) return undefined;
  const job = all.find((j) => j.id === picked);
  if (!job) return undefined;
  const here = root !== null && sameFolder(job.project, root);
  return here || isActive(job) ? job : undefined;
}
