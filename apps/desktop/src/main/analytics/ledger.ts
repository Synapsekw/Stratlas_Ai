/**
 * The local review ledger: one JSON line per reviewer verdict on a detector candidate, with the crop
 * it was judged on, kept on this computer under `<userData>/detector-ledger` (the caller passes that
 * folder). It only ever suggests a better threshold; nothing leaves the machine.
 */
import { LedgerEntry } from '@aio/schema';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ID_RULE = /^[a-z0-9][a-z0-9-]{1,60}$/;
/** A crop is resized by the caller to 512 px; anything past this is not a crop. */
const MAX_CROP_BYTES = 2 * 1024 * 1024;
const MIN_SCORED = 20;

export const isLedgerId = (id: string): boolean => ID_RULE.test(id);

function safeId(id: string): string {
  if (!ID_RULE.test(id)) throw new Error('That detector id is not a valid file name.');
  return id;
}

/** Appends are chained so two verdicts in flight never claim the same crop number. */
let queue: Promise<unknown> = Promise.resolve();

export async function appendLedger(dir: string, e: LedgerEntry, cropJpeg: Buffer): Promise<void> {
  const entry = LedgerEntry.parse(e);
  const id = safeId(entry.detectorId);
  if (cropJpeg.length > MAX_CROP_BYTES) throw new Error('That crop is too large for the ledger.');
  const run = async () => {
    const cropDir = join(dir, 'crops', id);
    await mkdir(cropDir, { recursive: true });
    const taken = (await readdir(cropDir))
      .map((f) => /^(\d+)\.jpg$/.exec(f))
      .map((m) => (m ? Number(m[1]) : 0));
    const n = Math.max(0, ...taken) + 1;
    await writeFile(join(cropDir, `${n}.jpg`), cropJpeg, { flag: 'wx' });
    const file = join(dir, `${id}.jsonl`);
    // A crash can leave a last line without its newline; end it so this entry starts its own line.
    const existing = await readFile(file).catch(() => null);
    const lead =
      existing && existing.length > 0 && existing[existing.length - 1] !== 0x0a ? '\n' : '';
    const line: LedgerEntry = { ...entry, crop: `${n}.jpg` };
    await appendFile(file, `${lead}${JSON.stringify(line)}\n`, 'utf8');
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  await next;
}

/** Every valid entry; a torn last line or any other bad line is skipped. */
export async function readLedger(dir: string, detectorId: string): Promise<LedgerEntry[]> {
  const id = safeId(detectorId);
  let text: string;
  try {
    text = await readFile(join(dir, `${id}.jsonl`), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: LedgerEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = LedgerEntry.safeParse(JSON.parse(line));
      if (r.success) out.push(r.data);
    } catch {
      // torn or hand-edited line
    }
  }
  return out;
}

/**
 * A candidate reviewed twice (accepted, then reopened and rejected) has two lines: only the latest
 * counts. Lines without a `detectionId` all count. Order is the file's.
 */
export function latestPerDetection(entries: readonly LedgerEntry[]): LedgerEntry[] {
  const last = new Map<string, number>();
  entries.forEach((e, i) => {
    if (e.detectionId !== undefined) last.set(e.detectionId, i);
  });
  return entries.filter((e, i) => e.detectionId === undefined || last.get(e.detectionId) === i);
}

export function ledgerStats(all: readonly LedgerEntry[]): {
  accepted: number;
  rejected: number;
  misses: number;
} {
  const s = { accepted: 0, rejected: 0, misses: 0 };
  for (const e of latestPerDetection(all)) {
    if (e.verdict === 'accepted') s.accepted++;
    else if (e.verdict === 'rejected') s.rejected++;
    else s.misses++;
  }
  return s;
}

/**
 * The threshold with the best F1 over the reviewed candidates: accepted at or above is a true
 * positive, rejected at or above a false positive, accepted below plus every miss a false negative.
 * Candidates are each distinct score and 0.50 to 0.95 in 0.05 steps; ties go to the higher one.
 * Null until 20 accepted or rejected entries carry a score.
 */
export function suggestThreshold(all: readonly LedgerEntry[]): number | null {
  const scored: { score: number; accepted: boolean }[] = [];
  let misses = 0;
  for (const e of latestPerDetection(all)) {
    if (e.verdict === 'miss') misses++;
    else if (typeof e.score === 'number')
      scored.push({ score: e.score, accepted: e.verdict === 'accepted' });
  }
  if (scored.length < MIN_SCORED) return null;
  const candidates = new Set<number>(scored.map((s) => s.score));
  for (let i = 0; i <= 9; i++) candidates.add(Math.round((0.5 + i * 0.05) * 100) / 100);
  let best: number | null = null;
  let bestF1 = -1;
  for (const t of [...candidates].sort((a, b) => a - b)) {
    let tp = 0;
    let fp = 0;
    let fn = misses;
    for (const s of scored) {
      if (s.score >= t) {
        if (s.accepted) tp++;
        else fp++;
      } else if (s.accepted) fn++;
    }
    const f1 = tp === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
    if (f1 >= bestF1) {
      bestF1 = f1;
      best = t;
    }
  }
  return best;
}

/** Accepted or rejected candidates with a score (latest verdict each): the count toward 20. */
export function scoredCount(all: readonly LedgerEntry[]): number {
  return latestPerDetection(all).filter((e) => e.verdict !== 'miss' && typeof e.score === 'number')
    .length;
}

/**
 * The suggested threshold for the next run. Reviews of runs like it (with few-shot example crops
 * when `fewShot`, without otherwise; a line without the flag counts as without) are used once
 * there are 20 scored ones (`from: 'same'`); until then every review is (`from: 'all'`). The
 * scores of the two kinds of run are not on the same scale, so the first is preferred.
 */
export function suggestFor(
  all: readonly LedgerEntry[],
  fewShot: boolean,
): { value: number; from: 'same' | 'all' } | null {
  const latest = latestPerDetection(all);
  const same = latest.filter((e) => e.verdict === 'miss' || (e.fewShot === true) === fewShot);
  const mine = suggestThreshold(same);
  if (mine !== null) return { value: mine, from: 'same' };
  const any = suggestThreshold(latest);
  return any === null ? null : { value: any, from: 'all' };
}

export async function clearLedger(dir: string, detectorId: string): Promise<void> {
  const id = safeId(detectorId);
  await rm(join(dir, `${id}.jsonl`), { force: true });
  await rm(join(dir, 'crops', id), { recursive: true, force: true });
}
