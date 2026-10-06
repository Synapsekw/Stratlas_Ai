/**
 * Sharing and sync (M9 streams T5 and T4): share a project, hub auto-sync, exchange files, the
 * Conflicts inbox and quarantine (`team:*`, `sync:*`, `exchange:*`; events `sync:progress`,
 * `exchange:progress`). The app touches the network only in server mode (T7). T0 stubs: every
 * channel answers "not available yet" until T5 fills it.
 */
import { notYet, type Handle } from '../notYet';

export interface SyncIpcDeps {
  handle: Handle;
}

export function registerSyncIpc({ handle }: SyncIpcDeps): void {
  const share = 'Sharing with a team';
  handle('team:share', () => notYet(share));
  handle('team:status', () => notYet(share));
  handle('team:leave', () => notYet(share));
  handle('sync:now', () => notYet(share));
  const merge = 'The Conflicts inbox';
  handle('sync:conflicts', () => notYet(merge));
  handle('sync:resolve', () => notYet(merge));
  handle('sync:quarantine', () => notYet(merge));
  handle('sync:release', () => notYet(merge));
  const exchange = 'Exchange files';
  handle('exchange:plan', () => notYet(exchange));
  handle('exchange:export', () => notYet(exchange));
  handle('exchange:preview', () => notYet(exchange));
  handle('exchange:import', () => notYet(exchange));
  handle('exchange:reply', () => notYet(exchange));
}
