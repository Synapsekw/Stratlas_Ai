/**
 * Sharing and sync (M9 streams T5 and T4): share a project, hub sync, exchange files
 * (`team:*`, `sync:now`, `exchange:*`; events `sync:progress`, `exchange:progress`,
 * `journal:changed`). Only the project folder, userData and the hub folder are touched: no
 * network (server mode is T7). The Conflicts inbox and quarantine channels stay with T4, and reply
 * files from the player come later; both answer "not available yet".
 */
import { notYet, type Handle } from '../notYet';
import type { SyncService } from './service';

export interface SyncIpcDeps {
  handle: Handle;
  service: SyncService;
}

export function registerSyncIpc({ handle, service }: SyncIpcDeps): void {
  handle('team:share', (req) => service.share(req));
  handle('team:status', ({ projectId }) => service.status(projectId));
  handle('team:leave', ({ projectId }) => service.leave(projectId));
  handle('sync:now', ({ projectId }) => service.syncNow(projectId));
  // T4 fills these four with the merge engine's inbox and quarantine
  const merge = 'The Conflicts inbox';
  handle('sync:conflicts', () => notYet(merge));
  handle('sync:resolve', () => notYet(merge));
  handle('sync:quarantine', () => notYet(merge));
  handle('sync:release', () => notYet(merge));
  handle('exchange:plan', (req) => service.plan(req));
  handle('exchange:export', (req) => service.exportFile(req));
  handle('exchange:preview', (req) => service.preview(req));
  handle('exchange:import', (req) => service.importFile(req));
  handle('exchange:reply', () => notYet('Replies from customer packages'));
}

export { createSyncService, type SyncService, type SyncServiceDeps } from './service';
