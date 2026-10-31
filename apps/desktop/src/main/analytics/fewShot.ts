/**
 * The few-shot example crops a `detect.vlm` run shows the model in its yes/no check (roadmap V2,
 * the learning loop). The gate picks them when a run starts and sends them as absolute files on
 * each detector item (`examples`); the job reads them once (`detect/fewshot.py`). Only processing
 * tools from `DETECT_EXAMPLES_MIN_PACK` take them, and only for a detector whose **Learn from my
 * reviews** switch is on (`thresholds.ts`).
 *
 * Per detector, at most `PER_VERDICT` "is" and `PER_VERDICT` "is not" crops, in this order:
 * 1. the detector's own curated `examples` (its `examples/` folder, file order);
 * 2. the local review ledger, lines of the detector's current version and of the model the run
 *    uses only: an accepted candidate whose box was not corrected is an "is" crop, a rejected one
 *    is an "is not" crop when its reason says the object is not the thing (`IS_NOT_REASONS`, or no
 *    reason). Only the latest verdict per candidate counts. Crops from the open project's folder
 *    come first, then the newest.
 * The same files on disk always give the same set. A file that is not there is passed over.
 *
 * Each run that sends examples is recorded (`runs/<run>.json` in the ledger folder), so a review
 * of its candidates is filed as one made with examples (`fewShot` on the ledger line).
 */
import type { DetectorWhere, LedgerEntry, RejectReason, VlmDetector } from '@aio/schema';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { detectorFolder, type DetectorOptions } from './detectors';
import { isLedgerId, latestPerDetection, readLedger } from './ledger';
import { readLearning } from './thresholds';

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

/** One spelling of a folder, to compare two (case-blind on Windows). */
export function folderKey(p: string): string {
  const r = resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

const cropNumber = (e: LedgerEntry) => Number(/^(\d+)\.jpg$/.exec(e.crop ?? '')?.[1] ?? 0);

/** What the ledger lines must match to be examples for this run. */
export interface PickFor {
  /** The detector's current version. */
  version: number;
  /** The model the run uses; null matches any. */
  modelSha256: string | null;
  /** The open project's folder; its crops come first. */
  projectDir: string | null;
}

/** The ledger entries that can be examples, best first: the open project's, then the newest. */
export function ledgerPicks(
  entries: readonly LedgerEntry[],
  f: PickFor,
): { is: LedgerEntry[]; isNot: LedgerEntry[] } {
  const here = f.projectDir === null ? null : folderKey(f.projectDir);
  const inProject = (e: LedgerEntry) =>
    here !== null && e.projectDir !== undefined && folderKey(e.projectDir) === here ? 0 : 1;
  const order = (a: LedgerEntry, b: LedgerEntry) => {
    const pa = inProject(a);
    const pb = inProject(b);
    if (pa !== pb) return pa - pb;
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    return cropNumber(b) - cropNumber(a);
  };
  const usable = latestPerDetection(entries).filter(
    (e) =>
      e.crop !== undefined &&
      e.detectorVersion === f.version &&
      (f.modelSha256 === null || e.modelSha256 === f.modelSha256),
  );
  return {
    is: usable.filter((e) => e.verdict === 'accepted' && e.corrected === undefined).sort(order),
    isNot: usable
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
  projectDir: string | null;
  modelSha256: string | null;
}): Promise<FewShotExample[]> {
  const entries = isLedgerId(a.detector.id) ? await readLedger(a.ledgerDir, a.detector.id) : [];
  const picks = ledgerPicks(entries, {
    version: a.detector.version,
    modelSha256: a.modelSha256,
    projectDir: a.projectDir,
  });
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

/** What a run's examples depend on besides its detectors. */
export interface RunContext {
  ledgerDir: string;
  /** The open project's folder. */
  projectDir: string | null;
  /** The model the run uses. */
  modelSha256: string | null;
  /** Detector ids whose **Learn from my reviews** switch is off. */
  learnOff: ReadonlySet<string>;
}

/**
 * The examples of each detector of a run, in the order of `refs`. A detector with learning off,
 * or whose examples cannot be read, gets none: examples never stop a run.
 */
export async function runExamples(
  o: DetectorOptions,
  refs: readonly { where: DetectorWhere; id: string }[],
  stored: readonly VlmDetector[],
  c: RunContext,
): Promise<FewShotExample[][]> {
  const out: FewShotExample[][] = [];
  for (const [i, ref] of refs.entries()) {
    const detector = stored[i];
    if (detector === undefined || c.learnOff.has(detector.id)) {
      out.push([]);
      continue;
    }
    try {
      const folder = await detectorFolder(o, ref.where, ref.id);
      out.push(
        await detectorExamples({
          detector,
          folder,
          ledgerDir: c.ledgerDir,
          projectDir: c.projectDir,
          modelSha256: c.modelSha256,
        }),
      );
    } catch {
      out.push([]);
    }
  }
  return out;
}

const RUN = /^run-[a-z0-9-]{1,60}$/;
const runFile = (ledgerDir: string, run: string) => join(ledgerDir, 'runs', `${run}.json`);

/** Note which detectors of a run were shown examples (none: nothing is written). */
export async function recordRun(
  ledgerDir: string,
  run: string,
  detectorIds: readonly string[],
): Promise<void> {
  if (!RUN.test(run) || detectorIds.length === 0) return;
  await mkdir(join(ledgerDir, 'runs'), { recursive: true });
  await writeFile(runFile(ledgerDir, run), `${JSON.stringify({ fewShot: [...detectorIds] })}\n`);
}

/**
 * Whether the run of a pass (`vlm-run-....json`) showed this detector examples: true or false
 * for a pass of a `detect.vlm` run, undefined for any other pass or none.
 */
export async function passUsedExamples(
  ledgerDir: string,
  pass: string | undefined,
  detectorId: string,
): Promise<boolean | undefined> {
  const run = /^vlm-(run-[a-z0-9-]{1,60})(?:\.json)?$/.exec(pass ?? '')?.[1];
  if (run === undefined) return undefined;
  try {
    const r = JSON.parse(await readFile(runFile(ledgerDir, run), 'utf8')) as { fewShot?: unknown };
    return Array.isArray(r.fewShot) && r.fewShot.includes(detectorId);
  } catch {
    return false;
  }
}

/**
 * The gate's picker: the examples of each detector of a run, with the learning switches read
 * from `userData`, and the run recorded so its reviews are filed as made with examples.
 */
export async function examplesForRun(a: {
  userData: string;
  ledgerDir: string;
  o: DetectorOptions;
  refs: readonly { where: DetectorWhere; id: string }[];
  stored: readonly VlmDetector[];
  run: string;
  modelSha256: string;
}): Promise<FewShotExample[][]> {
  const { learnOff } = await readLearning(a.userData);
  const shots = await runExamples(a.o, a.refs, a.stored, {
    ledgerDir: a.ledgerDir,
    projectDir: a.o.projectDir ?? null,
    modelSha256: a.modelSha256,
    learnOff: new Set(learnOff),
  });
  const used = a.stored.filter((_, i) => (shots[i]?.length ?? 0) > 0).map((d) => d.id);
  await recordRun(a.ledgerDir, a.run, used);
  return shots;
}
