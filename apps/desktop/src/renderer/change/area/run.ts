/**
 * Compare one polygon with the previous survey: starts imagery change limited to the area and,
 * when asked, volume change for it too, then shows the area's entry in the Changes tab.
 *
 * A volume run that cannot start or ends refused or failed does not undo the imagery result: the
 * area's imagery set records why (`ChangeSet.volumesMissing`) once both jobs have ended.
 */
import { changeStore, type ChangePairContext } from '@aio/change';
import type { ChangeScope, ChangeSet, JobRecord } from '@aio/schema';
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

type SurfaceStart = { jobId: string } | { error: string } | { notStarted: true };

type VolumesMissing = NonNullable<ChangeSet['volumesMissing']>;
type Why = Omit<VolumesMissing, 'at'>;

/**
 * True for the refusal of processing tools older than area runs: they do not take the area's
 * params (`known_keys`: "change.raster does not take: scope.").
 */
export function oldPackRefusal(error: string | undefined): boolean {
  return !!error && /does not take: .*\b(scope|mask)\b/.test(error);
}

/**
 * Why a volume job did not give a result, as a code the Changes tab words in the person's
 * language: its gap when refused, an older pack, a cancel, else the job's own error text.
 */
function whyEnded(job: JobRecord): Why | null {
  if (job.status === 'cancelled') return { reason: 'cancelled' };
  if (job.status !== 'failed') return null;
  const f = job.failure;
  const shiftM = f?.data.shiftM;
  if (f?.code === 'misaligned' && typeof shiftM === 'number' && Number.isFinite(shiftM))
    return { reason: 'misaligned', shiftM: Math.abs(shiftM) };
  if (oldPackRefusal(job.error)) return { reason: 'packTooOld' };
  return job.error ? { reason: 'failed', detail: job.error.slice(0, 300) } : { reason: 'failed' };
}

/** Why the volume run could not start. */
function whyNotStarted(surface: Exclude<SurfaceStart, { jobId: string }>): Why {
  if ('notStarted' in surface) return { reason: 'notStarted' };
  return { reason: 'unavailable', detail: surface.error.slice(0, 300) };
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
  const why = 'jobId' in surface ? (volumes ? whyEnded(volumes) : null) : whyNotStarted(surface);
  if (!why) return;
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
    volumesMissing: { ...why, at: new Date().toISOString() },
  });
}

/**
 * Once the area's first imagery run has ended without a result, show the whole map again: the
 * area would stay chosen with nothing to show. A refusal for the dates' gap keeps the area, so
 * its Line up offer shows. Nothing when another area, pair or project is shown by then.
 */
export async function releaseFailedArea(
  deps: ProducerDeps,
  rasterJobId: string,
  areaId: string,
  pair: { from: string; to: string },
): Promise<void> {
  const { finished } = deps;
  if (!finished) return;
  const project = deps.projectId?.() ?? null;
  const imagery = await finished(rasterJobId);
  if (!imagery || imagery.status === 'done' || imagery.failure?.code === 'misaligned') return;
  if ((deps.projectId?.() ?? null) !== project) return;
  const s = changeStore.getState();
  if (s.area !== areaId || s.pair?.from !== pair.from || s.pair.to !== pair.to) return;
  // its sets may have come in after all (a reload): then it stays
  if (Object.values(s.sets).some((x) => x.scope?.id === areaId)) return;
  s.setArea(null);
  // processing tools older than area runs refuse the area's params: say what to do
  if (oldPackRefusal(imagery.error)) s.setError(t('change.area.why.packTooOld'));
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
      surface = r.ok ? (r.jobId ? { jobId: r.jobId } : { notStarted: true }) : { error: r.error };
    }
    if ('error' in surface) notes.push(t('change.area.volumesFailed', { why: surface.error }));
    if ('notStarted' in surface)
      notes.push(t('change.area.volumesFailed', { why: t('change.area.why.notStarted') }));
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
  if (imagery.jobId)
    void releaseFailedArea(deps, imagery.jobId, area.scope.id, { from: ctx.from, to: ctx.to });
  openChangesTab();
  return { ok: true, notes };
}
