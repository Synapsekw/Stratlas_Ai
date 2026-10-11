/*
 * The file imports that are running (`builder:import`), so one can be cancelled
 * (`builder:cancelImport`) and all of them when the app quits: a 360 video stitch runs ffmpeg for
 * minutes, and without this the only way out was to quit, which left ffmpeg running.
 * Cancel is for an import as a whole, by project; there is no cancel per file.
 */

export interface ImportRun {
  /** Aborted when the import is cancelled. */
  signal: AbortSignal;
  /** The import returned: it can no longer be cancelled. */
  end(): void;
}

export interface ImportRuns {
  begin(projectId: string): ImportRun;
  /** Cancel what is running for the project; false when nothing is. */
  cancel(projectId: string): boolean;
  /** Cancel every running import; how many there were. */
  cancelAll(): number;
}

export function createImportRuns(): ImportRuns {
  const running = new Map<string, Set<AbortController>>();
  return {
    begin(projectId) {
      const run = new AbortController();
      const set = running.get(projectId) ?? new Set<AbortController>();
      set.add(run);
      running.set(projectId, set);
      return {
        signal: run.signal,
        end: () => {
          set.delete(run);
          if (set.size === 0 && running.get(projectId) === set) running.delete(projectId);
        },
      };
    },
    cancel(projectId) {
      const set = running.get(projectId);
      if (!set || set.size === 0) return false;
      running.delete(projectId);
      for (const run of set) run.abort();
      set.clear();
      return true;
    },
    cancelAll() {
      let n = 0;
      for (const set of running.values()) {
        for (const run of set) {
          run.abort();
          n++;
        }
        set.clear();
      }
      running.clear();
      return n;
    },
  };
}
