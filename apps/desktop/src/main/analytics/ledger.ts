/**
 * The local review ledger: one JSON line per reviewer verdict on a detector candidate, with the crop
 * it was judged on, kept on this computer under `<userData>/detectors/ledger` (the caller passes that
 * folder). It only ever suggests a better threshold; nothing leaves the machine.
 */
import { LedgerEntry } from '@aio/schema';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ID_RULE = /^[a-z0-9][a-z0-9-]{1,60}$/;
/** A crop is resized by the caller to 512 px; anything past this is not a crop. */
const MAX_CROP_BYTES = 2 * 1024 * 1024;
const MIN_SCORED = 20;

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
    await appendFile(join(dir, `${id}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8');
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

export function ledgerStats(entries: readonly LedgerEntry[]): {
  accepted: number;
  rejected: number;
  misses: number;
} {
  const s = { accepted: 0, rejected: 0, misses: 0 };
  for (const e of entries) {
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
export function suggestThreshold(entries: readonly LedgerEntry[]): number | null {
  const scored: { score: number; accepted: boolean }[] = [];
  let misses = 0;
  for (const e of entries) {
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

export async function clearLedger(dir: string, detectorId: string): Promise<void> {
  const id = safeId(detectorId);
  await rm(join(dir, `${id}.jsonl`), { force: true });
  await rm(join(dir, 'crops', id), { recursive: true, force: true });
}
