/**
 * Sharing and sync (M9 streams T5 and T4): share a project, hub and server sync, exchange files
 * (`team:*`, `sync:now`, `exchange:*`; events `sync:progress`, `exchange:progress`,
 * `journal:changed`, `sync:notice`), and T4's Conflicts inbox and quarantine (`sync:conflicts`,
 * `sync:resolve`, `sync:quarantine`, `sync:release`). Reply files from the player come later.
 */
import { notYet, type Handle } from '../notYet';
import type { TeamEngine } from './engine';
import type { SyncService } from './service';

export interface SyncIpcDeps {
  handle: Handle;
  service: SyncService;
  engine: TeamEngine;
  /** Folder of an open folder project; undefined for packages and unknown ids. */
  projectRoot: (projectId: string) => string | undefined;
  isPackage: (projectId: string) => boolean;
}

const notOpen = (projectId: string) => ({
  ok: false as const,
  error: `Project "${projectId}" is not open as a folder.`,
});

export function registerSyncIpc({
  handle,
  service,
  engine,
  projectRoot,
  isPackage,
}: SyncIpcDeps): void {
  const folder = (projectId: string) => (isPackage(projectId) ? undefined : projectRoot(projectId));
  handle('team:share', (req) => service.share(req));
  handle('team:status', ({ projectId }) => service.status(projectId));
  handle('team:leave', ({ projectId }) => service.leave(projectId));
  handle('team:hubProjects', ({ hubPath }) => service.hubProjects(hubPath));
  handle('sync:now', ({ projectId }) => service.syncNow(projectId));
  handle('sync:conflicts', ({ projectId }) => {
    const root = projectRoot(projectId);
    return root ? engine.conflicts(root) : Promise.resolve({ ok: true as const, conflicts: [] });
  });
  handle('sync:resolve', ({ projectId, conflict, choice, op, value }) => {
    const root = folder(projectId);
    if (!root) return Promise.resolve(notOpen(projectId));
    return engine.resolve(projectId, root, {
      conflict,
      choice,
      ...(op !== undefined ? { op } : {}),
      ...(value !== undefined ? { value } : {}),
    });
  });
  handle('sync:quarantine', ({ projectId }) => {
    const root = projectRoot(projectId);
    return root ? engine.quarantine(root) : Promise.resolve({ ok: true as const, entries: [] });
  });
  handle('sync:release', ({ projectId, op }) => {
    const root = folder(projectId);
    return root ? engine.release(projectId, root, op) : Promise.resolve(notOpen(projectId));
  });
  handle('exchange:peers', ({ projectId }) => service.peers(projectId));
  handle('exchange:plan', (req) => service.plan(req));
  handle('exchange:export', (req) => service.exportFile(req));
  handle('exchange:preview', (req) => service.preview(req));
  handle('exchange:import', (req) => service.importFile(req));
  handle('exchange:reply', () => notYet('Replies from customer packages'));
}

export { createSyncService, type SyncService, type SyncServiceDeps } from './service';
