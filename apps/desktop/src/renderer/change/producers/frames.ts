import {
  changeProducers,
  registerChangeProducer,
  type ChangePairContext,
  type ChangeProducer,
  type ChangeRunResult,
} from '@aio/change';
import type { Layer } from '@aio/schema';
import { t } from '@aio/ui';
import { pairsFor, type FramePair } from '@aio/video';

/**
 * "Find changes in matched frames" (M8 C4) for the Changes panel: pairs the photos of the two
 * dates by camera pose (`@aio/video` `pairsFor`) and starts `change.frames`, which aligns each pair
 * by features, writes the changes as draft detections for the review and `frame` items in the
 * change set `<from>-<to>-frames`. Video frames are not sent: the pipeline pack cannot decode
 * video yet.
 */

/** Stricter than the Frames pane: only pairs that show nearly the same view are compared. */
export const FRAMES_PAIRING = { maxPoseM: 10, maxAngleDeg: 15 } as const;
/** The pipeline takes at most this many pairs per run (`ChangeFramesParams`). */
export const MAX_FRAME_PAIRS = 5000;

export interface FramesStartRequest {
  pipeline: 'change.frames';
  /** Project folder. */
  project: string;
  params: Record<string, unknown>;
}

export interface FramesProducerDeps {
  /** The folder of an open project, or undefined. */
  root(projectId: string): string | undefined;
  start(req: FramesStartRequest): Promise<ChangeRunResult>;
}

const posedPhotos = (layers: readonly Layer[]) =>
  layers.some((l) => l.kind === 'photos' && l.items.some((p) => p.pos && p.q));

/** Photo pairs of the two dates that show the same view. */
export function framePairs(ctx: ChangePairContext): FramePair[] {
  const captureOf: Record<string, string> = {};
  for (const l of ctx.layersFrom) captureOf[l.id] = ctx.from;
  for (const l of ctx.layersTo) captureOf[l.id] = ctx.to;
  // the context already sorted the layers by date: no explicit capture may move them again
  const layers = [...ctx.layersFrom, ...ctx.layersTo].map((l) => ({
    ...l,
    capture: captureOf[l.id],
  }));
  return pairsFor(
    ctx.from,
    ctx.to,
    { layers, captureOf, flights: new Map() },
    { photosOnly: true, ...FRAMES_PAIRING },
  );
}

export function framesProducer(deps: FramesProducerDeps): ChangeProducer {
  return {
    id: 'frames',
    label: t('frames.run'),
    kinds: ['frame'],
    available: (ctx) =>
      posedPhotos(ctx.layersFrom) && posedPhotos(ctx.layersTo) ? true : t('frames.run.noPhotos'),
    run: async (ctx) => {
      const project = deps.root(ctx.projectId);
      if (!project) return { ok: false, error: t('frames.run.noProject') };
      // the best pairs when there are too many, in the order of the earlier date's photos
      const pairs = framePairs(ctx)
        .map((p, i) => ({ p, i }))
        .sort((x, y) => x.p.cost - y.p.cost)
        .slice(0, MAX_FRAME_PAIRS)
        .sort((x, y) => x.i - y.i)
        .map((x) => x.p);
      if (pairs.length === 0) return { ok: false, error: t('frames.run.noPairs') };
      return deps.start({
        pipeline: 'change.frames',
        project,
        params: {
          from: ctx.from,
          to: ctx.to,
          pairs: pairs.map((p) => ({ a: p.a, b: p.b })),
          ...FRAMES_PAIRING,
        },
      });
    },
  };
}

/** Register the producer once (the Frames pane module calls this with the app's jobs). */
export function ensureFramesProducer(deps: FramesProducerDeps): void {
  if (changeProducers().some((p) => p.id === 'frames')) return;
  registerChangeProducer(framesProducer(deps));
}
