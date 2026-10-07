import type { IpcEvent, IpcRequest, IpcResponse } from '@aio/schema';
import { join } from 'node:path';
import {
  defaultExportName,
  EXPORT_FILTERS,
  type ExportJob,
  type ExportProgress,
  type ExportResult,
} from './run';

/** A temporary project folder for an export (a package's manifest and issues). */
export interface StagedRoot {
  root: string;
  dispose(): Promise<void>;
}

export interface ExportDeps {
  /** Folder of an open folder project; undefined for packages and unknown ids. */
  projectRoot: (projectId: string) => string | undefined;
  /** Why this format may not be exported from this project (package policy), or null. */
  refuse?: (projectId: string, format: IpcRequest<'export:run'>['format']) => string | null;
  /** Stage an open package for an export; undefined when the id is not an open package. */
  stage?: (projectId: string) => Promise<StagedRoot | undefined>;
  projectName: (root: string) => Promise<string>;
  downloadsDir: string;
  /** Native save dialog; resolves to the chosen path or null. */
  chooseSavePath: (
    defaultPath: string,
    filter: { name: string; extensions: string[] },
  ) => Promise<string | null>;
  /** Write a file export off the UI thread (the export utility process). */
  runFile: (
    job: ExportJob,
    progress: (p: ExportProgress) => void,
    signal: AbortSignal,
  ) => Promise<ExportResult>;
  /** Render and print the issue register report (`report-pdf`) or the house report (`house-pdf`). */
  printReport: (
    args: {
      projectId: string;
      root: string;
      outPath: string;
      issueIds?: string[] | undefined;
      kind: 'register' | 'house';
    },
    progress: (p: ExportProgress) => void,
    signal: AbortSignal,
  ) => Promise<ExportResult>;
  emit: (event: IpcEvent<'export:progress'>) => void;
  /** M9 T1: `audit-csv` and `audit-json` through the journal's audit export. */
  audit?: (
    projectId: string,
    format: 'audit-csv' | 'audit-json',
  ) => Promise<IpcResponse<'export:run'>>;
}

export interface ExportJobs {
  run(req: IpcRequest<'export:run'>): Promise<IpcResponse<'export:run'>>;
  cancel(jobId: string): boolean;
}

/** `export:run` and `export:cancel`: one save dialog, then a cancellable job per request. */
export function createExportJobs(deps: ExportDeps): ExportJobs {
  const running = new Map<string, AbortController>();
  return {
    async run(req) {
      const refused = deps.refuse?.(req.projectId, req.format) ?? null;
      if (refused !== null) return { ok: false, error: refused };
      // M9 T1: the audit formats come from the journal (checked by format, never by file name).
      if (req.format === 'audit-csv' || req.format === 'audit-json') {
        return deps.audit
          ? await deps.audit(req.projectId, req.format)
          : { ok: false, error: 'The audit export is not available in this build.' };
      }
      if (running.has(req.jobId)) return { ok: false, error: 'This export is already running.' };
      let root = deps.projectRoot(req.projectId);
      let staged: StagedRoot | undefined;
      if (root === undefined) {
        staged = await deps.stage?.(req.projectId);
        root = staged?.root;
      }
      if (root === undefined) {
        return {
          ok: false,
          error: `Project "${req.projectId}" is not open. Open it, then export again.`,
        };
      }
      try {
        return await runIn(req, root);
      } finally {
        await staged?.dispose();
      }
    },
    cancel(jobId) {
      const ac = running.get(jobId);
      if (!ac) return false;
      ac.abort();
      running.delete(jobId);
      return true;
    },
  };

  async function runIn(
    req: IpcRequest<'export:run'>,
    root: string,
  ): Promise<IpcResponse<'export:run'>> {
    const name = defaultExportName(await deps.projectName(root), req.format);
    const outPath = await deps.chooseSavePath(
      join(deps.downloadsDir, name),
      EXPORT_FILTERS[req.format],
    );
    if (outPath === null) return { ok: true, path: null };
    const ac = new AbortController();
    running.set(req.jobId, ac);
    const progress = (p: ExportProgress) => {
      if (!ac.signal.aborted) deps.emit({ jobId: req.jobId, ...p });
    };
    try {
      const r =
        req.format === 'report-pdf' || req.format === 'house-pdf'
          ? await deps.printReport(
              {
                projectId: req.projectId,
                root,
                outPath,
                issueIds: req.issueIds,
                kind: req.format === 'house-pdf' ? 'house' : 'register',
              },
              progress,
              ac.signal,
            )
          : await deps.runFile(
              { root, format: req.format, outPath, issueIds: req.issueIds },
              progress,
              ac.signal,
            );
      return { ok: true, path: outPath, count: r.count, bytes: r.bytes };
    } catch (e) {
      if (ac.signal.aborted) return { ok: true, path: null };
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      running.delete(req.jobId);
    }
  }
}
