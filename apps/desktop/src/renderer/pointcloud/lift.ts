/**
 * Classify on point cloud: photo outlines (detections with a polygon, from the Review mask assist)
 * lifted onto a COPC point cloud by `segment.lift` (the Segmentation add-on and pipeline pack
 * SEGMENT_LIFT_MIN_PACK; main refuses an older pack with the update wording). Each mask goes
 * through its photo's camera; the answer is one lasso region per mask with a depth band, which is
 * added to the layer's cleanup recipe as one step with the class the person picked, so Undo and
 * Save work as for regions drawn by hand.
 */
import type { Detection } from '@aio/annotate/detections';
import { className } from '@aio/pointcloud';
import {
  MAX_LASSO_VERTICES,
  MAX_REGIONS,
  emptyCleanup,
  type CleanupRegion,
  type Layer,
  type LiftedRegion,
  type LiftMask,
  type SegmentLiftParams,
  type SegmentLiftResult,
} from '@aio/schema';
import { t } from '@aio/ui';
import type { JobsDeps } from './cleanupJobs';

type CloudLayer = Extract<Layer, { kind: 'pointcloud' }>;

/** The classes offered: ground, the three vegetation heights, building and the first user class. */
export const LIFT_CLASSES: readonly number[] = [2, 3, 4, 5, 6, 64];
export const liftClassName = (code: number): string =>
  code === 64 ? t('cleanup.lift.userClass') : className(code);

/** Most masks one job takes (`SegmentLiftParams.masks`). */
export const MAX_LIFT_MASKS = 50;
/** The smallest grid side a mask accepts; a normalized outline is scaled to the photo first. */
const MIN_GRID = 16;

/** Every `step`-th vertex so an outline fits MAX_LASSO_VERTICES. */
function thin(points: readonly [number, number][]): [number, number][] {
  if (points.length <= MAX_LASSO_VERTICES) return points.map(([x, y]) => [x, y]);
  const step = Math.ceil(points.length / MAX_LASSO_VERTICES);
  return points.filter((_, i) => i % step === 0).map(([x, y]) => [x, y]);
}

/** True for an outline on a photo that a lift can take. */
export function liftable(d: Detection): boolean {
  return (
    d.status !== 'rejected' &&
    d.source.kind === 'photo' &&
    d.geom.type === 'polygon' &&
    d.geom.points.length >= 3
  );
}

/**
 * One mask for an outline: its polygon in the pixel grid it was drawn in, with that grid's size.
 * A normalized outline (a `[1, 1]` grid) is scaled to the photo's pixels (`photoSize`); null when
 * that size is unknown or the outline is not liftable.
 */
export function maskOf(
  d: Detection,
  photoSize: (layer: string, photo: string) => [number, number] | null,
  label: string,
): LiftMask | null {
  if (!liftable(d) || d.source.kind !== 'photo' || d.geom.type !== 'polygon') return null;
  const { layer, photo } = d.source;
  let [w, h] = d.size;
  let pts: [number, number][] = d.geom.points.map((p) => [p[0], p[1]]);
  if (w < MIN_GRID || h < MIN_GRID) {
    const size = photoSize(layer, photo);
    if (!size) return null;
    const [pw, ph] = size;
    pts = pts.map(([x, y]) => [(x / w) * pw, (y / h) * ph]);
    [w, h] = [pw, ph];
  }
  return {
    layer,
    photo,
    polygon: thin(pts),
    width: Math.round(w),
    height: Math.round(h),
    label: label.slice(0, 120),
  };
}

/** The masks of the picked photos' outlines, at most MAX_LIFT_MASKS. */
export function masksFor(
  dets: readonly Detection[],
  picks: readonly { layerId: string; photoId: string }[],
  photoSize: (layer: string, photo: string) => [number, number] | null,
  labelOf: (d: Detection) => string,
): LiftMask[] {
  const on = new Set(picks.map((p) => `${p.layerId}\n${p.photoId}`));
  const out: LiftMask[] = [];
  for (const d of dets) {
    if (d.source.kind !== 'photo' || !on.has(`${d.source.layer}\n${d.source.photo}`)) continue;
    const m = maskOf(d, photoSize, labelOf(d));
    if (m) out.push(m);
    if (out.length >= MAX_LIFT_MASKS) break;
  }
  return out;
}

/** The `segment.lift` params; null for a cloud with no file in the project. */
export function liftParams(layer: CloudLayer, masks: LiftMask[]): SegmentLiftParams | null {
  if (!('path' in layer.src) || masks.length === 0) return null;
  return { layerId: layer.id, src: layer.src.path, masks };
}

/** The lifted masks as cleanup regions that set `value` on the points each photo saw. */
export function liftedRegions(
  lifted: readonly LiftedRegion[],
  value: number,
  newId: () => string,
): CleanupRegion[] {
  return lifted.map((r) => ({
    id: newId(),
    shape: 'lasso',
    viewProj: [...r.viewProj],
    polygon: r.polygon.map(([x, y]) => [x, y] as [number, number]),
    depth: { near: r.depth.near, far: r.depth.far },
    ...(r.label !== undefined ? { label: r.label } : {}),
    action: { kind: 'class', value },
  }));
}

export const newLiftRegionId = (): string =>
  `lift-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export type LiftOutcome =
  { ok: true; added: number; skipped: SegmentLiftResult['skipped'] } | { ok: false; error: string };

/**
 * Start `segment.lift`, wait for it, read its answer and add the regions to the layer's recipe as
 * one step. A project switched meanwhile adds nothing.
 */
export async function runLift(
  d: JobsDeps,
  layer: CloudLayer,
  masks: LiftMask[],
  value: number,
  newId: () => string = newLiftRegionId,
): Promise<LiftOutcome> {
  const p = d.project();
  if (!p) return { ok: false, error: 'No project is open.' };
  if (!d.cleanup.canEdit()) return { ok: false, error: t('cleanup.lookOnly') };
  const params = liftParams(layer, masks);
  if (!params) return { ok: false, error: 'This cloud has no file in the project.' };
  const here = () => d.cleanup.store.getState().projectId === p.id;
  const r = await d.call('jobs:start', { pipeline: 'segment.lift', project: p.root, params });
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.value.ok) return { ok: false, error: r.value.error };
  const job = await d.waitForJob(r.value.job.id);
  if (job.status !== 'done') return { ok: false, error: job.error ?? 'The lift did not finish.' };
  const read = await d.call('pointcloud:readCleanup', {
    projectId: p.id,
    liftRun: { layerId: layer.id, runId: job.id },
  });
  if (!read.ok) return { ok: false, error: read.error };
  if (!read.value.ok) return { ok: false, error: read.value.error };
  const lift = read.value.lift ?? null;
  if (!lift) return { ok: false, error: 'The lift left no result.' };
  if (!here()) return { ok: true, added: 0, skipped: lift.skipped };
  if (lift.regions.length === 0) return { ok: true, added: 0, skipped: lift.skipped };
  const base = d.cleanup.recipeOf(layer.id) ?? emptyCleanup(layer.id);
  const room = MAX_REGIONS - base.regions.length;
  if (room < lift.regions.length)
    return { ok: false, error: t('cleanup.select.full', { max: MAX_REGIONS }) };
  const regions = liftedRegions(lift.regions, value, newId);
  const ok = await d.cleanup.commit(
    layer.id,
    { ...base, regions: [...base.regions, ...regions] },
    { kind: 'classSet', name: liftClassName(value) },
  );
  if (!ok) return { ok: false, error: 'The cleanup could not be saved.' };
  return { ok: true, added: regions.length, skipped: lift.skipped };
}
