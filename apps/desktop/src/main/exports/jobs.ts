import type { IpcEvent, IpcRequest, IpcResponse } from '@aio/schema';
import { join } from 'node:path';
import {
  defaultExportName,
  EXPORT_FILTERS,
  type ExportJob,
  type ExportProgress,
  type ExportResult,
} from './run';

export interface ExportDeps {
  projectRoot: (projectId: string) => string | undefined;
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
  /** Render and print the issue register report. */
  printReport: (
    args: { projectId: string; root: string; outPath: string; issueIds?: string[] | undefined },
    progress: (p: ExportProgress) => void,
    signal: AbortSignal,
  ) => Promise<ExportResult>;
  emit: (event: IpcEvent<'export:progress'>) => void;
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
      const root = deps.projectRoot(req.projectId);
      if (root === undefined) {
        return {
          ok: false,
          error: `Project "${req.projectId}" is not open. Open it, then export again.`,
        };
      }
      if (running.has(req.jobId)) return { ok: false, error: 'This export is already running.' };
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
          req.format === 'report-pdf'
            ? await deps.printReport(
                { projectId: req.projectId, root, outPath, issueIds: req.issueIds },
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
    },
    cancel(jobId) {
      const ac = running.get(jobId);
      if (!ac) return false;
      ac.abort();
      running.delete(jobId);
      return true;
    },
  };
}
