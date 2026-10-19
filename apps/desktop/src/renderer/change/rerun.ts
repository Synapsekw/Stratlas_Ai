import {
  changeProducers,
  changeStore,
  IN_APP_PRODUCERS,
  runProducer,
  type ChangePairContext,
} from '@aio/change';
import { t } from '@aio/ui';
import { startChangeRun, type ProducerDeps } from './producers/raster';

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

/** Scoped reruns supersede each other's late refusals. */
const latestScoped = { run: 0 };

/**
 * Start a scoped change job again with the parameters it ran with (the polygon as it was: the
 * result stays a snapshot of the area). Never a whole-map run: the stored params are replayed
 * unchanged. `producer` is `change.raster` / `change.surface`, or a bare `raster` / `surface`.
 * It goes through `startChangeRun`, so a refusal for the dates' gap is kept for the Line up offer.
 * The error sentence comes back, or null when the job started.
 */
export async function rerunScoped(
  producer: string,
  params: Record<string, unknown>,
  deps?: ProducerDeps,
): Promise<string | null> {
  const bare = producer.startsWith('change.') ? producer.slice('change.'.length) : producer;
  if (bare !== 'raster' && bare !== 'surface') return t('lineUp.rerun.unavailable');
  // loaded on first use: the producers module needs the preload bridge of the real window
  const d = deps ?? (await import('./producers/register')).appProducerDeps();
  const r = await startChangeRun(d, latestScoped, bare, `change.${bare}`, params);
  return r.ok ? null : r.error;
}
