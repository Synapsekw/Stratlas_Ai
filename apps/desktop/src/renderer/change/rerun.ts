import {
  changeProducers,
  changeStore,
  IN_APP_PRODUCERS,
  runProducer,
  type ChangePairContext,
} from '@aio/change';
import { t } from '@aio/ui';

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
