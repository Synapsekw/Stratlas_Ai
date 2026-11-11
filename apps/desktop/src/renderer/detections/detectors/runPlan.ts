/**
 * The plan of a local detector run (`detect.vlm`) from the Detect dialog: the selection split into
 * one job per photo layer or 360 walk layer (other video frames are skipped), the time it will
 * take, and the detectors ordered for the project.
 */
import {
  WALK_FRAME_FACES,
  type DetectorWhere,
  type IpcRequest,
  type VlmDetector,
} from '@aio/schema';
import type { DetectItem } from '../convert';

/** Measured seconds one detector takes on one photo (spike: 5 to 8 s on an RTX 5070 Ti). */
export const VLM_SECONDS_PER_PHOTO = 7;
/** At most this many photos in one job (`DetectVlmParams.photos`). */
export const MAX_RUN_PHOTOS = 5000;
/** At most this many detectors in one run (`DetectVlmParams.detectors`). */
export const MAX_RUN_DETECTORS = 10;

/** A detector picked for the run, with the bar it runs at. */
export interface Chosen {
  where: DetectorWhere;
  detector: VlmDetector;
  threshold: number;
}

/** At most this many walk frames in one job (`DetectVlmParams.frames`). */
export const MAX_RUN_FRAMES = 2000;

export interface PlannedRun {
  /** A photos layer, or the walk layer of a run over walk frames. */
  layer: string;
  photos: string[];
  /** Walk frames (video seconds of `layer`); a walk run has no photos (pipeline pack 0.35.0). */
  frames?: number[];
  detectors: Chosen[];
}

/**
 * One run per layer (in the order the layers come): the photos of a photos layer, each once, or
 * the frames of a walk layer (`walkLayers`), each once. Frames of other video layers are counted
 * and skipped: the detectors read photos and 360 walk frames only.
 */
export function planRuns(
  items: readonly DetectItem[],
  detectors: readonly Chosen[],
  walkLayers: ReadonlySet<string> = new Set(),
): { runs: PlannedRun[]; skippedFrames: number } {
  const byLayer = new Map<string, { photos: Set<string>; frames: Map<number, number> }>();
  let skippedFrames = 0;
  for (const i of items) {
    if (i.kind === 'frame' && !walkLayers.has(i.layer)) {
      skippedFrames++;
      continue;
    }
    const entry = byLayer.get(i.layer) ?? { photos: new Set<string>(), frames: new Map() };
    if (i.kind === 'photo') entry.photos.add(i.photo);
    else if (!entry.frames.has(Math.round(i.t * 1000)))
      entry.frames.set(Math.round(i.t * 1000), i.t);
    byLayer.set(i.layer, entry);
  }
  const runs: PlannedRun[] = [];
  for (const [layer, { photos: set, frames: times }] of byLayer) {
    const photos = [...set];
    for (let at = 0; at < photos.length; at += MAX_RUN_PHOTOS) {
      runs.push({
        layer,
        photos: photos.slice(at, at + MAX_RUN_PHOTOS),
        detectors: [...detectors],
      });
    }
    const frames = [...times.values()];
    for (let at = 0; at < frames.length; at += MAX_RUN_FRAMES) {
      runs.push({
        layer,
        photos: [],
        frames: frames.slice(at, at + MAX_RUN_FRAMES),
        detectors: [...detectors],
      });
    }
  }
  return { runs, skippedFrames };
}

/** The items one run reads, as the strip counts them: its photos, or its walk frames. */
export const runSize = (r: PlannedRun): number => r.photos.length + (r.frames?.length ?? 0);

/**
 * The pictures one run sends to the detectors, for time estimates: a photo is one, a walk frame
 * `WALK_FRAME_FACES` (its four perspective faces).
 */
export const runImages = (r: PlannedRun): number =>
  r.photos.length + (r.frames?.length ?? 0) * WALK_FRAME_FACES;

/** Whole minutes the planned runs take (`estimateMinutes` over every run's pictures). */
export function estimateRunMinutes(
  runs: readonly PlannedRun[],
  detectorCount: number,
  learning = 0,
): number {
  return estimateMinutes(
    runs.reduce((n, r) => n + runImages(r), 0),
    detectorCount,
    learning,
  );
}

/** What one run reads, as Ask AI items (for what is left after a stop or a failure). */
export const runItems = (r: PlannedRun): DetectItem[] => [
  ...r.photos.map((photo) => ({ kind: 'photo' as const, layer: r.layer, photo })),
  ...(r.frames ?? []).map((t) => ({ kind: 'frame' as const, layer: r.layer, t })),
];

/**
 * How much longer a detector takes when its yes/no checks carry few-shot example crops (up to 4
 * more images per check; the server's prompt cache keeps most of them across a photo's checks).
 */
export const EXAMPLES_TIME_FACTOR = 1.5;

/**
 * Whole minutes, rounded up. `learning` of the detectors learn from reviews: their checks carry
 * example crops (on by default), so each takes `EXAMPLES_TIME_FACTOR` times as long.
 */
export function estimateMinutes(photos: number, detectorCount: number, learning = 0): number {
  const plain = Math.max(0, detectorCount - learning);
  const withExamples = Math.min(learning, detectorCount) * EXAMPLES_TIME_FACTOR;
  return Math.ceil((photos * (plain + withExamples) * VLM_SECONDS_PER_PHOTO) / 60);
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
      ...(r.frames && r.frames.length > 0
        ? { frames: r.frames.map((t) => ({ layer: r.layer, t })) }
        : {}),
      detectors: r.detectors.map((c) => ({
        where: c.where,
        detector: c.detector,
        threshold: c.threshold,
      })),
    },
  };
}
