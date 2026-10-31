/**
 * What the user chose about learning from reviews, per detector id (the review ledger's own
 * scope), kept on this computer in `<userData>/detector-thresholds.json`:
 *
 * - `thresholds`: a threshold applied from the ledger's suggestion (**Apply suggested threshold**
 *   in Settings, Models and detection, Detector library). `detectors:list` reports a detector with
 *   it in place, so runs and reviews use it. **Use the detector's own threshold** removes it, and
 *   so do clearing the review history and removing the detector.
 * - `learnOff`: detectors whose **Learn from my reviews** switch is off: no example crops in their
 *   runs and no suggested threshold. Absent means on.
 *
 * Nothing is applied without the user's click. A file that cannot be read is never overwritten
 * silently: it is moved aside to `detector-thresholds.json.bak-<time>` with a warning first.
 */
import { rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readJson, writeJsonAtomic } from '../fsutil';
import { isLedgerId } from './ledger';

export const THRESHOLDS_FILE = 'detector-thresholds.json';

const Learning = z.object({
  thresholds: z.record(z.string(), z.number().min(0).max(1)),
  learnOff: z.array(z.string()).optional(),
});

export interface LearningSettings {
  thresholds: Record<string, number>;
  learnOff: string[];
}

const EMPTY: LearningSettings = { thresholds: {}, learnOff: [] };

const fileOf = (userData: string) => join(userData, THRESHOLDS_FILE);

/** The settings as stored, `null` when the file is there but cannot be read as settings. */
async function readRaw(userData: string): Promise<LearningSettings | null> {
  if (!(await stat(fileOf(userData)).catch(() => null))) return { ...EMPTY };
  try {
    const r = Learning.safeParse(await readJson(fileOf(userData)));
    return r.success ? { thresholds: r.data.thresholds, learnOff: r.data.learnOff ?? [] } : null;
  } catch {
    return null;
  }
}

/** Every applied threshold and switch; none when the file is missing or cannot be read. */
export async function readLearning(userData: string): Promise<LearningSettings> {
  return (await readRaw(userData)) ?? { ...EMPTY };
}

/** Every applied threshold by detector id. */
export async function readApplied(userData: string): Promise<Record<string, number>> {
  return (await readLearning(userData)).thresholds;
}

export type Warn = (line: string) => void;

/** Changes are chained so two at once both land. */
let queue: Promise<unknown> = Promise.resolve();

async function update(
  userData: string,
  change: (s: LearningSettings) => LearningSettings,
  warn: Warn = () => undefined,
): Promise<void> {
  const run = async () => {
    let s = await readRaw(userData);
    if (s === null) {
      const aside = `${fileOf(userData)}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await rename(fileOf(userData), aside);
      warn(`${THRESHOLDS_FILE} could not be read; it was moved to ${aside} and started again.`);
      s = { ...EMPTY };
    }
    const next = change(s);
    await writeJsonAtomic(fileOf(userData), {
      thresholds: next.thresholds,
      ...(next.learnOff.length > 0 ? { learnOff: [...new Set(next.learnOff)].sort() } : {}),
    });
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  await next;
}

function checkId(detectorId: string): void {
  if (!isLedgerId(detectorId)) throw new Error('That detector id is not valid.');
}

const without = (r: Record<string, number>, id: string) =>
  Object.fromEntries(Object.entries(r).filter(([k]) => k !== id));

export async function applyThreshold(
  userData: string,
  detectorId: string,
  threshold: number,
  warn?: Warn,
): Promise<void> {
  checkId(detectorId);
  if (!(threshold >= 0 && threshold <= 1)) throw new Error('A threshold is between 0 and 1.');
  await update(
    userData,
    (s) => ({ ...s, thresholds: { ...s.thresholds, [detectorId]: threshold } }),
    warn,
  );
}

/** Back to the detector's own threshold. */
export async function resetThreshold(
  userData: string,
  detectorId: string,
  warn?: Warn,
): Promise<void> {
  checkId(detectorId);
  await update(userData, (s) => ({ ...s, thresholds: without(s.thresholds, detectorId) }), warn);
}

/** The **Learn from my reviews** switch. */
export async function setLearn(
  userData: string,
  detectorId: string,
  on: boolean,
  warn?: Warn,
): Promise<void> {
  checkId(detectorId);
  await update(
    userData,
    (s) => ({
      ...s,
      learnOff: on ? s.learnOff.filter((x) => x !== detectorId) : [...s.learnOff, detectorId],
    }),
    warn,
  );
}

/** A removed detector leaves nothing behind: its applied threshold and its switch. */
export async function forgetDetector(
  userData: string,
  detectorId: string,
  warn?: Warn,
): Promise<void> {
  if (!isLedgerId(detectorId)) return;
  const s = await readLearning(userData);
  if (!(detectorId in s.thresholds) && !s.learnOff.includes(detectorId)) return;
  await update(
    userData,
    (x) => ({
      thresholds: without(x.thresholds, detectorId),
      learnOff: x.learnOff.filter((y) => y !== detectorId),
    }),
    warn,
  );
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
