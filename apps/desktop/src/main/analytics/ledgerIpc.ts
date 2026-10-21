/**
 * The `ledger:*` channels over ledger.ts. Registered by the job wiring (Task 8). The ledger lives
 * in `<userData>/detectors/ledger`.
 */
import type { IpcChannel } from '@aio/schema';
import { join } from 'node:path';
import type { Handler } from '../ipc';
import { appendLedger, ledgerStats, readLedger, suggestThreshold } from './ledger';

export interface LedgerIpcDeps {
  handle: <C extends IpcChannel>(channel: C, handler: Handler<C>) => void;
  userData: string;
}

export function registerLedgerIpc(d: LedgerIpcDeps): void {
  const dir = join(d.userData, 'detectors', 'ledger');
  d.handle('ledger:append', async ({ entry, cropJpegBase64 }) => {
    try {
      await appendLedger(dir, entry, Buffer.from(cropJpegBase64, 'base64'));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  d.handle('ledger:stats', async ({ detectorId }) => {
    let entries: Awaited<ReturnType<typeof readLedger>> = [];
    try {
      entries = await readLedger(dir, detectorId);
    } catch {
      // an invalid id has no ledger
    }
    return { ...ledgerStats(entries), suggestedThreshold: suggestThreshold(entries) };
  });
}
