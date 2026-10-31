/**
 * The few-shot example crops a `detect.vlm` run shows the model in its yes/no check (roadmap V2,
 * the learning loop). The gate picks them when a run starts and sends them as absolute files on
 * each detector item (`examples`); the job reads them once (`detect/fewshot.py`).
 *
 * Per detector, at most `PER_VERDICT` "is" and `PER_VERDICT` "is not" crops, in this order:
 * 1. the detector's own curated `examples` (its `examples/` folder, file order);
 * 2. the local review ledger: an accepted candidate whose box was not corrected is an "is" crop, a
 *    rejected one is an "is not" crop when its reason says the object is not the thing
 *    (`IS_NOT_REASONS`, or no reason). Only the latest verdict per candidate counts. The open
 *    project's crops come first, then the newest.
 * The same files on disk always give the same set. A file that is not there is passed over.
 */
import type { DetectorWhere, LedgerEntry, RejectReason, VlmDetector } from '@aio/schema';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { detectorFolder, type DetectorOptions } from './detectors';
import { isLedgerId, latestPerDetection, readLedger } from './ledger';

export type ExampleVerdict = 'is' | 'is-not';

export interface FewShotExample {
  file: string;
  verdict: ExampleVerdict;
}

/** Crops per verdict and detector (vision 3.3: 2 to 4 in all); the job refuses more. */
export const PER_VERDICT = 2;

/** Reject reasons that say the crop is not the thing. `box-wrong` and `other` do not. */
export const IS_NOT_REASONS: ReadonlySet<RejectReason> = new Set<RejectReason>([
  'looks-like-but-is-not',
  'not-a-defect',
  'wrong-class',
]);

const cropNumber = (e: LedgerEntry) => Number(/^(\d+)\.jpg$/.exec(e.crop ?? '')?.[1] ?? 0);

/** The ledger entries that can be examples, best first: the open project's, then the newest. */
export function ledgerPicks(
  entries: readonly LedgerEntry[],
  projectId: string | null,
): { is: LedgerEntry[]; isNot: LedgerEntry[] } {
  const order = (a: LedgerEntry, b: LedgerEntry) => {
    const pa = a.photo.project === projectId ? 0 : 1;
    const pb = b.photo.project === projectId ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    return cropNumber(b) - cropNumber(a);
  };
  const withCrop = latestPerDetection(entries).filter((e) => e.crop !== undefined);
  return {
    is: withCrop.filter((e) => e.verdict === 'accepted' && e.corrected === undefined).sort(order),
    isNot: withCrop
      .filter(
        (e) => e.verdict === 'rejected' && (e.reason === undefined || IS_NOT_REASONS.has(e.reason)),
      )
      .sort(order),
  };
}

const isFile = async (p: string) => (await stat(p).catch(() => null))?.isFile() ?? false;

async function firstThere(files: readonly string[], room: number): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    if (out.length >= room) break;
    if (await isFile(f)) out.push(f);
  }
  return out;
}

/** One detector's examples: "is" crops first, then "is not". */
export async function detectorExamples(a: {
  detector: VlmDetector;
  /** The detector's folder, null when it is not known. */
  folder: string | null;
  ledgerDir: string;
  projectId: string | null;
}): Promise<FewShotExample[]> {
  const entries = isLedgerId(a.detector.id) ? await readLedger(a.ledgerDir, a.detector.id) : [];
  const picks = ledgerPicks(entries, a.projectId);
  const cropDir = join(a.ledgerDir, 'crops', a.detector.id);
  const out: FewShotExample[] = [];
  for (const [verdict, ledger] of [
    ['is', picks.is],
    ['is-not', picks.isNot],
  ] as const) {
    const folder = a.folder;
    const curated =
      folder === null
        ? []
        : (a.detector.examples ?? [])
            .filter((e) => e.verdict === verdict)
            .map((e) => join(folder, ...e.file.split('/')));
    const files = [...curated, ...ledger.map((e) => join(cropDir, e.crop ?? ''))];
    for (const file of await firstThere(files, PER_VERDICT)) out.push({ file, verdict });
  }
  return out;
}

/**
 * The examples of each detector of a run, in the order of `refs`. A detector whose examples
 * cannot be read gets none: examples never stop a run.
 */
export async function runExamples(
  o: DetectorOptions,
  refs: readonly { where: DetectorWhere; id: string }[],
  stored: readonly VlmDetector[],
  ledgerDir: string,
  projectId: string | null,
): Promise<FewShotExample[][]> {
  const out: FewShotExample[][] = [];
  for (const [i, ref] of refs.entries()) {
    const detector = stored[i];
    if (detector === undefined) {
      out.push([]);
      continue;
    }
    try {
      const folder = await detectorFolder(o, ref.where, ref.id);
      out.push(await detectorExamples({ detector, folder, ledgerDir, projectId }));
    } catch {
      out.push([]);
    }
  }
  return out;
}
