import {
  changeProducers,
  changeStore,
  IN_APP_PRODUCERS,
  runProducer,
  type ChangePairContext,
} from '@aio/change';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import type { startChangeJob } from './producers/register';

type StartJob = typeof startChangeJob;

/**
 * Run a change producer again for a pair (the panel's Run again, and the run that follows a saved
 * line-up). `name` is a producer id or a change set's producer (`change.raster`). It goes through
 * the same path as the panel's own producer button (`runProducer`): an error sentence comes back,
 * and the new sets are read. Null when it ran.
 */
export async function rerunProducer(
  name: string,
  ctx: ChangePairContext | null,
): Promise<string | null> {
  const producer = changeProducers().find((p) => p.id === name || `change.${p.id}` === name);
  if (ctx && producer) return runProducer(producer, ctx);
  // the in-app comparisons (issues, detections, vectors) are no registered producers: the
  // store runs them. Nothing else is run blindly.
  const inApp = (Object.values(IN_APP_PRODUCERS) as string[]).includes(name);
  if (ctx && inApp) {
    await changeStore.getState().compute();
    return changeStore.getState().error;
  }
  return t('lineUp.rerun.unavailable');
}

/**
 * Start a scoped change job again with the parameters it ran with (the polygon as it was: the
 * result stays a snapshot of the area). Never a whole-map run: the stored params are replayed
 * unchanged. `producer` is `change.raster` / `change.surface`, or a bare `raster` / `surface`.
 * The error sentence comes back, or null when the job started.
 */
export async function rerunScoped(
  producer: string,
  params: Record<string, unknown>,
  start?: StartJob,
): Promise<string | null> {
  const project = workspace.getState().project?.id;
  if (!project) return t('lineUp.rerun.unavailable');
  const pipeline = (
    producer.startsWith('change.') ? producer : `change.${producer}`
  ) as Parameters<StartJob>[0]['pipeline'];
  // loaded on first use: the producers module needs the preload bridge of the real window
  const run = start ?? (await import('./producers/register')).startChangeJob;
  const res = await run({ pipeline, project, params });
  return 'error' in res ? res.error : null;
}
