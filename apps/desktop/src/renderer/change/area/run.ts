/**
 * Compare one polygon with the previous survey: starts imagery change limited to the area and,
 * when asked, volume change for it too, then shows the area's entry in the Changes tab.
 *
 * A volume run that cannot start or ends refused or failed does not undo the imagery result: the
 * area's imagery set records why (`ChangeSet.volumesMissing`) once both jobs have ended.
 */
import { changeStore, type ChangePairContext } from '@aio/change';
import type { ChangeScope, JobRecord } from '@aio/schema';
import { t } from '@aio/ui';
import {
  areaRasterParams,
  areaSurfaceParams,
  startChangeRun,
  type ChangeArea,
  type ProducerDeps,
} from '../producers/raster';
import { openChangesTab } from '../useChangeOverlays';

/** Area runs supersede each other's late refusals, apart from the panel's own buttons. */
const latestRaster = { run: 0 };
const latestSurface = { run: 0 };

type SurfaceStart = { jobId: string } | { error: string };

/** Why a volume job did not give a result: its gap when refused, else its error text. */
function whyFailed(job: JobRecord): string {
  const f = job.failure;
  const shiftM = f?.data.shiftM;
  if (f?.code === 'misaligned' && typeof shiftM === 'number' && Number.isFinite(shiftM))
    return `Misaligned by ${shiftM.toFixed(1)} m`;
  return job.error ?? 'The volume run failed.';
}

/**
 * Once both jobs have ended: when imagery came through and volumes did not, keep why on the
 * area's imagery set. Nothing when volumes ran, imagery failed or another project is open.
 */
export async function recordVolumesOutcome(
  deps: ProducerDeps,
  rasterJobId: string,
  surface: SurfaceStart,
  scope: ChangeScope,
  pair: { from: string; to: string },
): Promise<void> {
  const { finished } = deps;
  if (!finished) return;
  const project = deps.projectId?.() ?? null;
  const [imagery, volumes] = await Promise.all([
    finished(rasterJobId),
    'jobId' in surface ? finished(surface.jobId) : Promise.resolve(null),
  ]);
  if (imagery?.status !== 'done') return;
  let reason: string;
  if ('error' in surface) reason = surface.error;
  else if (volumes?.status === 'failed') reason = whyFailed(volumes);
  else return;
  if (!project || (deps.projectId?.() ?? null) !== project) return;
  const store = changeStore.getState();
  await store.load(project);
  if ((deps.projectId?.() ?? null) !== project) return;
  const set = Object.values(changeStore.getState().sets).find(
    (s) =>
      s.producer === 'change.raster' &&
      s.scope?.id === scope.id &&
      s.from === pair.from &&
      s.to === pair.to,
  );
  if (!set) return;
  await changeStore.getState().save({
    ...set,
    volumesMissing: { reason: reason.slice(0, 300), at: new Date().toISOString() },
  });
}

/**
 * Start the area's imagery change (its error is the result and nothing else starts) and, with
 * `volumes`, its volume change (an error there is a note). On success the Changes tab opens on
 * the pair and the area.
 */
export async function runAreaCompare(
  deps: ProducerDeps,
  ctx: ChangePairContext,
  area: ChangeArea,
  opts: { volumes: boolean },
): Promise<{ ok: true; notes: string[] } | { ok: false; error: string }> {
  const thresholds = deps.thresholds();
  const imageryParams = areaRasterParams(ctx, area, thresholds);
  if (typeof imageryParams === 'string') return { ok: false, error: imageryParams };
  const imagery = await startChangeRun(
    deps,
    latestRaster,
    'raster',
    'change.raster',
    imageryParams,
  );
  if (!imagery.ok) return { ok: false, error: imagery.error };

  const notes: string[] = [];
  if (opts.volumes) {
    const volumeParams = areaSurfaceParams(ctx, area, thresholds);
    let surface: SurfaceStart;
    if (typeof volumeParams === 'string') surface = { error: volumeParams };
    else {
      const r = await startChangeRun(
        deps,
        latestSurface,
        'surface',
        'change.surface',
        volumeParams,
      );
      surface = r.ok
        ? r.jobId
          ? { jobId: r.jobId }
          : { error: 'The job did not start.' }
        : { error: r.error };
    }
    if ('error' in surface) notes.push(t('change.area.volumesFailed', { why: surface.error }));
    if (imagery.jobId)
      void recordVolumesOutcome(deps, imagery.jobId, surface, area.scope, {
        from: ctx.from,
        to: ctx.to,
      });
  }

  // the pair first: setting it afterwards would reset the area
  const store = changeStore.getState();
  store.setPair({ from: ctx.from, to: ctx.to });
  changeStore.getState().setArea(area.scope.id);
  openChangesTab();
  return { ok: true, notes };
}
