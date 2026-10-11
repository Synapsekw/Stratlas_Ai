import { rename as fsRename } from 'node:fs/promises';

/*
 * Moving a finished file or folder into place when another program may hold it open. Windows
 * refuses a rename while anything has the file, or any file inside the folder, open, even only to
 * read it: antivirus, the search indexer, a thumbnailer, a synced folder. Such a reader is gone
 * within seconds, so the rename is tried again for about half a minute before it fails. The
 * manifest save does the same for a small file over a few seconds (`manifestFile.ts`); a playback
 * copy that took minutes to make is worth a longer wait.
 */

/** Codes Windows gives a rename of something another program has open at that moment. */
const LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY']);

export function isLockedError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && LOCKED.has(code);
}

/** The waits between tries: quick at first, then every 2 s; about 30 s in all. */
export const RENAME_WAITS_MS: readonly number[] = [
  50,
  100,
  200,
  400,
  800,
  1600,
  ...Array.from({ length: 13 }, () => 2000),
];

export interface RenameOptions {
  /** The rename itself (tests hand in one that fails). */
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Only Windows refuses a rename for an open file; elsewhere the first error stands. */
  platform?: NodeJS.Platform;
  /**
   * Asked after a refusal, before waiting: true when the refusal is not a lock after all (the
   * target exists, so the name is taken). The error is then thrown at once.
   */
  giveUp?: () => Promise<boolean>;
  /** Aborting stops the waiting; the last error is thrown. */
  signal?: AbortSignal;
}

/**
 * Rename `from` to `to`, trying again while another program holds it open. Throws the last error
 * when it stays refused; `from` is then untouched.
 */
export async function renameWhenFree(
  from: string,
  to: string,
  o: RenameOptions = {},
): Promise<void> {
  const rename = o.rename ?? fsRename;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const platform = o.platform ?? process.platform;
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const wait = RENAME_WAITS_MS[i];
      if (platform !== 'win32' || !isLockedError(e) || wait === undefined) throw e;
      if (o.signal?.aborted || (await o.giveUp?.())) throw e;
      await sleep(wait);
      if (o.signal?.aborted) throw e;
    }
  }
}
