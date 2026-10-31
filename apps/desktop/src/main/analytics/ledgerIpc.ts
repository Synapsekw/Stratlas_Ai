/**
 * The `ledger:*` channels over ledger.ts. Registered by the job wiring (Task 8). The ledger lives
 * in `<userData>/detector-ledger`, outside the detector library (`<userData>/detectors/<id>`), so
 * removing or replacing a library detector whose id is `ledger` cannot touch it.
 *
 * Learning from reviews (roadmap V2): a line is stamped here with the project's folder and with
 * whether its run showed the model example crops (`fewShot.ts`). The suggested threshold is worked
 * out from reviews of runs like the next one (`suggestFor`), never applied without the user's
 * click (`ledger:applyThreshold`), and can be undone (`ledger:resetThreshold`). The **Learn from
 * my reviews** switch (`ledger:setLearn`) turns the examples and the suggestion off.
 */
import type { IpcChannel, LedgerEntry } from '@aio/schema';
import { en } from '@aio/ui/i18n/en';
import { join } from 'node:path';
import type { Handler } from '../ipc';
import { packTakesExamples } from './detectPack';
import { IS_NOT_REASONS, passUsedExamples } from './fewShot';
import {
  appendLedger,
  clearLedger,
  isLedgerId,
  latestPerDetection,
  ledgerStats,
  readLedger,
  scoredCount,
  suggestFor,
} from './ledger';
import { applyThreshold, readLearning, resetThreshold, setLearn, type Warn } from './thresholds';

/** 2 MB of bytes is about 2.8 M base64 characters; refuse before decoding. */
const MAX_CROP_BASE64 = 2_800_000;

export interface LedgerIpcDeps {
  handle: <C extends IpcChannel>(channel: C, handler: Handler<C>) => void;
  userData: string;
  /** The folder of an open project by its id, null when unknown. */
  projectDir?: (projectId: string) => string | null;
  /** The installed processing tools' version (`dev`, or null for none). */
  pipelinePack?: () => Promise<string | null>;
  /** A line for the app log. */
  warn?: Warn;
}

/** Where the ledger lives: its own folder, never inside the detector library. */
export function ledgerDir(userData: string): string {
  return join(userData, 'detector-ledger');
}

/** Whether any review could be an example crop (the gate's picks, before version and files). */
function hasExampleCrops(entries: readonly LedgerEntry[]): boolean {
  return latestPerDetection(entries).some(
    (e) =>
      e.crop !== undefined &&
      ((e.verdict === 'accepted' && e.corrected === undefined) ||
        (e.verdict === 'rejected' && (e.reason === undefined || IS_NOT_REASONS.has(e.reason)))),
  );
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function registerLedgerIpc(d: LedgerIpcDeps): void {
  const dir = ledgerDir(d.userData);
  const badId = { ok: false as const, error: en['detect.learn.err.badId'] };

  /** The suggestion for the next run of a detector, or null with learning off. */
  const suggestion = async (entries: readonly LedgerEntry[], learn: boolean) => {
    if (!learn) return null;
    const pack = d.pipelinePack ? await d.pipelinePack().catch(() => null) : null;
    const nextFewShot = packTakesExamples(pack) && hasExampleCrops(entries);
    return suggestFor(entries, nextFewShot);
  };

  d.handle('ledger:append', async ({ entry, cropJpegBase64 }) => {
    try {
      if (cropJpegBase64.length > MAX_CROP_BASE64)
        throw new Error('That crop is too large for the ledger.');
      // the run's examples and the project's folder are main's to say, never the window's
      const given: LedgerEntry = { ...entry };
      delete given.fewShot;
      delete given.projectDir;
      const fewShot = await passUsedExamples(dir, given.pass, given.detectorId);
      const projectDir = d.projectDir?.(given.photo.project) ?? null;
      await appendLedger(
        dir,
        {
          ...given,
          ...(fewShot === undefined ? {} : { fewShot }),
          ...(projectDir === null ? {} : { projectDir }),
        },
        Buffer.from(cropJpegBase64, 'base64'),
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  });
  d.handle('ledger:stats', async ({ detectorId }) => {
    if (!isLedgerId(detectorId))
      return {
        accepted: 0,
        rejected: 0,
        misses: 0,
        scored: 0,
        suggestedThreshold: null,
        suggestedFrom: null,
        applied: null,
        learn: true,
      };
    const entries = await readLedger(dir, detectorId);
    const learning = await readLearning(d.userData);
    const learn = !learning.learnOff.includes(detectorId);
    const s = await suggestion(entries, learn);
    return {
      ...ledgerStats(entries),
      scored: scoredCount(entries),
      suggestedThreshold: s?.value ?? null,
      suggestedFrom: s?.from ?? null,
      applied: learning.thresholds[detectorId] ?? null,
      learn,
    };
  });
  d.handle('ledger:applyThreshold', async ({ detectorId }) => {
    if (!isLedgerId(detectorId)) return badId;
    try {
      const learning = await readLearning(d.userData);
      if (learning.learnOff.includes(detectorId))
        return { ok: false, error: en['detect.learn.err.off'] };
      const s = await suggestion(await readLedger(dir, detectorId), true);
      if (s === null) return { ok: false, error: en['detect.learn.err.none'] };
      await applyThreshold(d.userData, detectorId, s.value, d.warn);
      return { ok: true, threshold: s.value };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  });
  d.handle('ledger:resetThreshold', async ({ detectorId }) => {
    if (!isLedgerId(detectorId)) return badId;
    try {
      await resetThreshold(d.userData, detectorId, d.warn);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  });
  d.handle('ledger:setLearn', async ({ detectorId, on }) => {
    if (!isLedgerId(detectorId)) return badId;
    try {
      await setLearn(d.userData, detectorId, on, d.warn);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  });
  d.handle('ledger:clear', async ({ detectorId }) => {
    if (!isLedgerId(detectorId)) return badId;
    try {
      await clearLedger(dir, detectorId);
      // a threshold applied from the cleared reviews goes with them
      if ((await readLearning(d.userData)).thresholds[detectorId] !== undefined)
        await resetThreshold(d.userData, detectorId, d.warn);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  });
}
