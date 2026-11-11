/**
 * After a local model run over 360 walk frames: the drafts of neighbouring frames that saw the same
 * object become one draft (`walk.track`, pipeline pack 0.35.0), placed in the project from the walk
 * path. It runs quietly, one job per walk pass of the run. Processing tools without the job refuse
 * it, and a tracking that fails changes nothing: the drafts then stay one per frame, as before.
 */
import type { IpcRequest, JobRecord } from '@aio/schema';
import type { DetectItem } from '../../detections/convert';

/** The pass of one local model run (main's `modelPassName`, `inference/run.ts`). */
export const modelPassName = (runId: string): string =>
  `model-${runId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100)}.json`;

/**
 * The walk passes a local model run wrote: one pass per layer of the run (named after the layer
 * when the run had several), of which those of a walk layer.
 */
export function walkPassesOf(
  runId: string,
  items: readonly DetectItem[],
  walkLayers: ReadonlySet<string>,
): { pass: string; layer: string }[] {
  return runPasses(runId, items)
    .filter(
      ({ layer }) =>
        walkLayers.has(layer) && items.some((x) => x.kind === 'frame' && x.layer === layer),
    )
    .map(({ name, layer }) => ({ pass: `detections/${name}`, layer }));
}

/** Every pass of a local model run, by layer: one per layer, named after it when there are several. */
export function runPasses(
  runId: string,
  items: readonly DetectItem[],
): { name: string; layer: string }[] {
  const layers = [...new Set(items.map((x) => x.layer))];
  const several = layers.length > 1;
  return layers.map((layer) => ({
    name: modelPassName(several ? `${runId}-${layer}` : runId),
    layer,
  }));
}

export interface WalkTrackDeps {
  startQuiet: (req: IpcRequest<'jobs:start'>) => Promise<{ jobId: string } | { error: string }>;
  /** Wait for the job to end; resolves null at once when `signal` aborts. */
  wait: (jobId: string, signal?: AbortSignal) => Promise<JobRecord | null>;
  /** Cancel a job (Stop during the tracking). */
  cancel: (jobId: string) => Promise<unknown>;
}

/**
 * Track each walk pass in turn; resolves with how many were tracked (job done). A refused start
 * (older processing tools) or a failed job is left as it is, never an error. `signal` (Stop)
 * cancels the job in hand and starts no other: the passes not tracked keep their drafts.
 */
export async function trackWalkPasses(
  deps: WalkTrackDeps,
  project: string,
  passes: readonly { pass: string; layer: string }[],
  signal?: AbortSignal,
): Promise<number> {
  let tracked = 0;
  for (const p of passes) {
    if (signal?.aborted) break;
    const started = await Promise.resolve()
      .then(() =>
        deps.startQuiet({
          pipeline: 'walk.track',
          project,
          params: { pass: p.pass, layer: p.layer },
        }),
      )
      .catch(() => ({ error: 'not started' }));
    if ('error' in started) continue;
    const { jobId } = started;
    const stop = () => {
      void Promise.resolve()
        .then(() => deps.cancel(jobId))
        .catch(() => undefined);
    };
    // a Stop pressed while the job was starting cancels it too
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    const job = await deps.wait(jobId, signal).catch(() => null);
    signal?.removeEventListener('abort', stop);
    if (signal?.aborted) break;
    if (job?.status === 'done') tracked++;
  }
  return tracked;
}
