/**
 * The `ledger:*` channels over ledger.ts. Registered by the job wiring (Task 8). The ledger lives
 * in `<userData>/detectors/ledger`.
 */
import type { IpcChannel } from '@aio/schema';
import { join } from 'node:path';
import type { Handler } from '../ipc';
import { appendLedger, isLedgerId, ledgerStats, readLedger, suggestThreshold } from './ledger';

/** 2 MB of bytes is about 2.8 M base64 characters; refuse before decoding. */
const MAX_CROP_BASE64 = 2_800_000;

export interface LedgerIpcDeps {
  handle: <C extends IpcChannel>(channel: C, handler: Handler<C>) => void;
  userData: string;
}

export function registerLedgerIpc(d: LedgerIpcDeps): void {
  const dir = join(d.userData, 'detectors', 'ledger');
  d.handle('ledger:append', async ({ entry, cropJpegBase64 }) => {
    try {
      if (cropJpegBase64.length > MAX_CROP_BASE64)
        throw new Error('That crop is too large for the ledger.');
      await appendLedger(dir, entry, Buffer.from(cropJpegBase64, 'base64'));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  d.handle('ledger:stats', async ({ detectorId }) => {
    if (!isLedgerId(detectorId))
      return { accepted: 0, rejected: 0, misses: 0, suggestedThreshold: null };
    const entries = await readLedger(dir, detectorId);
    return { ...ledgerStats(entries), suggestedThreshold: suggestThreshold(entries) };
  });
}
