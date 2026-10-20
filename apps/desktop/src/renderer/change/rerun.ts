import {
  changeProducers,
  changeStore,
  IN_APP_PRODUCERS,
  runProducer,
  type ChangePairContext,
} from '@aio/change';
import type { LonLatRing } from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { polygonRing } from './area/areaModel';
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

/** Where an area's polygon is drawn now, as a lon/lat ring, or why it cannot run. */
export type AreaRingNow = (
  scopeId: string,
) => { ring: LonLatRing } | { reason: string } | Promise<{ ring: LonLatRing } | { reason: string }>;

/**
 * The polygon of an area where the open project draws it now (its date's current line-up
 * applied), or why not: the polygon was deleted, or the measurements are still loading.
 */
export async function areaRingNow(
  scopeId: string,
): Promise<{ ring: LonLatRing } | { reason: string }> {
  // loaded on first use: the measurement store reaches the preload bridge
  const { measureStore } = await import('../survey/measureStore');
  const project = workspace.getState().project;
  const s = measureStore.getState();
  if (!project) return { reason: t('change.area.gone') };
  if (s.projectId !== project.id || s.status === 'loading' || s.status === 'idle')
    return { reason: t('change.area.measuresLoading') };
  const m = s.file.measurements.find((x) => x.id === scopeId);
  if (!m) return { reason: t('change.area.gone') };
  return polygonRing(m, project.manifest);
}

/**
 * The stored params of an area's run with its polygon where it is now: the mask, and the area of
 * a volume run, follow the polygon (a date lined up since moves it). Everything else is kept.
 * The reason sentence when the area cannot run; never params without the area.
 */
async function withAreaNow(
  params: Record<string, unknown>,
  ringOf: AreaRingNow,
): Promise<Record<string, unknown> | string> {
  const scope = params.scope as { id?: unknown } | undefined;
  if (typeof scope?.id !== 'string') return t('lineUp.rerun.unavailable');
  const id = scope.id;
  const now = await ringOf(id);
  if ('reason' in now) return now.reason;
  const next: Record<string, unknown> = { ...params, mask: now.ring };
  if (Array.isArray(params.areas))
    next.areas = params.areas.map((a: unknown) =>
      a && typeof a === 'object' && (a as { id?: unknown }).id === id
        ? { ...a, ring: now.ring }
        : a,
    );
  return next;
}

/**
 * Start a scoped change job again with the parameters it ran with, the area's polygon taken
 * where it is drawn now (`areaRingNow`: a Run again after a line-up, or the run that follows the
 * Line up offer, cuts the ground the person sees). Never a whole-map run: params without their
 * area, or an area whose polygon is gone, are refused with a sentence. `producer` is
 * `change.raster` / `change.surface`, or a bare `raster` / `surface`. It goes through
 * `startChangeRun`, so a refusal for the dates' gap is kept for the Line up offer. The error
 * sentence comes back, or null when the job started.
 */
export async function rerunScoped(
  producer: string,
  params: Record<string, unknown>,
  deps?: ProducerDeps,
  ringOf: AreaRingNow = areaRingNow,
): Promise<string | null> {
  const bare = producer.startsWith('change.') ? producer.slice('change.'.length) : producer;
  if (bare !== 'raster' && bare !== 'surface') return t('lineUp.rerun.unavailable');
  const next = await withAreaNow(params, ringOf);
  if (typeof next === 'string') return next;
  // loaded on first use: the producers module needs the preload bridge of the real window
  const d = deps ?? (await import('./producers/register')).appProducerDeps();
  const r = await startChangeRun(d, latestScoped, bare, `change.${bare}`, next);
  return r.ok ? null : r.error;
}
