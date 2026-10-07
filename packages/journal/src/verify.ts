import type { VerifyReport } from '@aio/schema';

/** A journal as files: project-relative path (forward slashes) to text. */
export type JournalFiles = ReadonlyMap<string, string>;

/**
 * Verify chains, `deps`, signatures, forks, gaps, checkpoints and redactions, naming the exact
 * file and line of each problem (data-conventions section 17, the golden fixtures' `cases.json`).
 * Runs in the data process, never on the UI thread. T0 declares it; T1 implements it.
 */
export function verifyJournal(files: JournalFiles, now: Date = new Date()): VerifyReport {
  throw new Error(
    `verifyJournal is not implemented yet (M9 T1; ${files.size} files at ${now.toISOString()}).`,
  );
}
