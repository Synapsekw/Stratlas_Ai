import type { JobRecord } from '@aio/schema';
import { join } from 'node:path';
import { jobDir } from './runner';

export { findPack, findPdal, type PackInfo } from './pack';
export { RpcClient, RpcError } from './rpc';
export { JobRunner, jobDir, safeJobEvent } from './runner';
export { JobStore } from './store';

/**
 * What "open" means for a job: its first artifact (a folder opens, a file is shown selected),
 * its log file, or the project folder.
 */
export function openTarget(
  job: Pick<JobRecord, 'project' | 'id' | 'artifacts'>,
  what: 'output' | 'log' | 'project',
): { action: 'open' | 'reveal'; path: string } | null {
  if (what === 'project') return { action: 'open', path: job.project };
  if (what === 'log') return { action: 'reveal', path: join(jobDir(job), 'job.log') };
  const first = job.artifacts.find((a) => !a.path.startsWith('jobs/')) ?? job.artifacts[0];
  if (!first) return null;
  const path = join(job.project, ...first.path.split('/'));
  return first.kind === 'folder' ? { action: 'open', path } : { action: 'reveal', path };
}
