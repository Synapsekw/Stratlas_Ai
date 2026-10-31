/**
 * Thresholds the user applied from the review ledger's suggestion (Settings, Models and detection,
 * Detector library: **Apply suggested threshold**). Kept on this computer in
 * `<userData>/detector-thresholds.json`, by detector id: the ledger's own scope, so a shipped
 * detector (whose folder is the pack's) takes one as well as a library or project one. Nothing is
 * ever applied without that click; `detectors:list` reports each detector with its applied
 * threshold in place, so runs and reviews use it.
 */
import { join } from 'node:path';
import { z } from 'zod';
import { readJson, writeJsonAtomic } from '../fsutil';
import { isLedgerId } from './ledger';

export const THRESHOLDS_FILE = 'detector-thresholds.json';

const Applied = z.object({ thresholds: z.record(z.string(), z.number().min(0).max(1)) });

const fileOf = (userData: string) => join(userData, THRESHOLDS_FILE);

/** Every applied threshold by detector id; none when the file is missing or not valid. */
export async function readApplied(userData: string): Promise<Record<string, number>> {
  try {
    const r = Applied.safeParse(await readJson(fileOf(userData)));
    return r.success ? r.data.thresholds : {};
  } catch {
    return {};
  }
}

/** Writes are chained so two applies at once both land. */
let queue: Promise<unknown> = Promise.resolve();

export async function applyThreshold(
  userData: string,
  detectorId: string,
  threshold: number,
): Promise<void> {
  if (!isLedgerId(detectorId)) throw new Error('That detector id is not valid.');
  if (!(threshold >= 0 && threshold <= 1)) throw new Error('A threshold is between 0 and 1.');
  const run = async () => {
    const thresholds = { ...(await readApplied(userData)), [detectorId]: threshold };
    await writeJsonAtomic(fileOf(userData), { thresholds });
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  await next;
}

/** The items with each applied threshold in place of the detector's own. */
export function withApplied<T extends { detector: { id: string; threshold: number } }>(
  items: readonly T[],
  applied: Readonly<Record<string, number>>,
): T[] {
  return items.map((i) => {
    const t = applied[i.detector.id];
    return t === undefined ? i : { ...i, detector: { ...i.detector, threshold: t } };
  });
}
