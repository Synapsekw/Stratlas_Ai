/**
 * The plan of a local detector run (`detect.vlm`) from the Detect dialog: the selection split into
 * one job per photo layer (video frames are skipped, detectors run on photos), the time it will
 * take, and the detectors ordered for the project.
 */
import type { DetectorWhere, IpcRequest, VlmDetector } from '@aio/schema';
import type { DetectItem } from '../convert';

/** Measured seconds one detector takes on one photo (spike: 5 to 8 s on an RTX 5070 Ti). */
export const VLM_SECONDS_PER_PHOTO = 7;
/** At most this many photos in one job (`DetectVlmParams.photos`). */
export const MAX_RUN_PHOTOS = 5000;

/** A detector picked for the run, with the bar it runs at. */
export interface Chosen {
  where: DetectorWhere;
  detector: VlmDetector;
  threshold: number;
}

export interface PlannedRun {
  layer: string;
  photos: string[];
  detectors: Chosen[];
}

/** One run per photo layer (in the order the layers come), each photo once; frames are counted. */
export function planRuns(
  items: readonly DetectItem[],
  detectors: readonly Chosen[],
): { runs: PlannedRun[]; skippedFrames: number } {
  const byLayer = new Map<string, Set<string>>();
  let skippedFrames = 0;
  for (const i of items) {
    if (i.kind === 'frame') {
      skippedFrames++;
      continue;
    }
    const photos = byLayer.get(i.layer) ?? new Set<string>();
    photos.add(i.photo);
    byLayer.set(i.layer, photos);
  }
  const runs: PlannedRun[] = [];
  for (const [layer, set] of byLayer) {
    const photos = [...set];
    for (let at = 0; at < photos.length; at += MAX_RUN_PHOTOS) {
      runs.push({
        layer,
        photos: photos.slice(at, at + MAX_RUN_PHOTOS),
        detectors: [...detectors],
      });
    }
  }
  return { runs, skippedFrames };
}

/** Whole minutes, rounded up. */
export function estimateMinutes(photos: number, detectorCount: number): number {
  return Math.ceil((photos * detectorCount * VLM_SECONDS_PER_PHOTO) / 60);
}

/** Detectors for the project's asset types first, then the rest ("All detectors"). */
export function orderForProject<T extends { detector: Pick<VlmDetector, 'assetTypes'> }>(
  list: readonly T[],
  assetTypes: readonly string[],
): { forProject: T[]; rest: T[] } {
  const wanted = new Set(assetTypes.map((a) => a.trim().toLowerCase()));
  const fits = (x: T) => x.detector.assetTypes.some((a) => wanted.has(a.trim().toLowerCase()));
  return { forProject: list.filter(fits), rest: list.filter((x) => !fits(x)) };
}

/** `run-` and eight characters of a random uuid, as `DetectVlmParams.run` wants. */
export const newRunId = (): string => `run-${globalThis.crypto.randomUUID().slice(0, 8)}`;

/** The `jobs:start` of one run; the gate fills the server, the model and the stored detector. */
export function runRequest(
  project: string,
  runId: string,
  r: PlannedRun,
): IpcRequest<'jobs:start'> {
  return {
    pipeline: 'detect.vlm',
    project,
    params: {
      run: runId,
      layer: r.layer,
      photos: r.photos,
      detectors: r.detectors.map((c) => ({
        where: c.where,
        detector: c.detector,
        threshold: c.threshold,
      })),
    },
  };
}
