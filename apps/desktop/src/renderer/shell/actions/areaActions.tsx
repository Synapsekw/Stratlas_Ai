import { defineAction, registerActions, t, type ActionCtx, type MenuTarget } from '@aio/ui';
import type { SurveyMeasurement } from '@aio/schema';
import { captureIndex, workspace } from '@aio/workspace';
import { areaCompare } from '../../change/area/areaCompareStore';
import { polygonRing, previousPair } from '../../change/area/areaModel';
import { orthoPair } from '../../change/producers/raster';
import { pairContext } from '../../change/producers/register';
import { measureStore } from '../../survey/measureStore';
import { timeline } from '../../workspace/timeline';
import { editBlocked } from './reasons';

/*
 * "Compare with previous survey" on one polygon measurement (its Datasets row, or the measurement
 * on the map or in 3D): imagery change, and volumes when asked, limited to the polygon. The
 * confirm box (`AreaCompareDialog`) starts the runs.
 */

type Target = Extract<MenuTarget, { kind: 'measurements' }>;

const clickedOf = (tg: Target): SurveyMeasurement | undefined =>
  measureStore.getState().file.measurements.find((m) => m.id === tg.clicked);

/** The pair the polygon compares (the survey before its own), or why there is none. */
function pairOf(
  m: SurveyMeasurement,
  ctx: ActionCtx,
): { from: string; to: string } | { reason: string } {
  const index = timeline.getState().index ?? captureIndex(ctx.manifest);
  return previousPair(index, m, ctx.focus);
}

/** Why the polygon cannot be compared (the first reason wins), or false. */
export function areaCompareBlocked(tg: Target, ctx: ActionCtx): string | false {
  // the runs write change sets and layers: never for a package or a reviewer who may only look
  const blocked = editBlocked(ctx);
  if (blocked) return blocked;
  const project = workspace.getState().project;
  if (!project?.root) return t('actions.reason.package');
  const m = clickedOf(tg);
  if (!m) return t('actions.measure.notFound');
  const ring = polygonRing(m, ctx.manifest);
  if ('reason' in ring) return ring.reason;
  const pair = pairOf(m, ctx);
  if ('reason' in pair) return pair.reason;
  const pc = pairContext(project.id, pair.from, pair.to);
  if (!pc || typeof orthoPair(pc) === 'string') return t('actions.area.reason.noImagery');
  return false;
}

const actions = [
  defineAction<'measurements'>({
    id: 'change.areaCompare',
    label: 'actions.area.compare',
    icon: 'split',
    section: 'compare',
    targets: ['measurements'],
    appliesTo: (tg) => clickedOf(tg)?.family === 'polygon',
    disabled: areaCompareBlocked,
    run: (tg, ctx) => {
      const m = clickedOf(tg);
      if (!m) return;
      const pair = pairOf(m, ctx);
      if ('reason' in pair) return;
      areaCompare.getState().ask({ measurementId: m.id, from: pair.from, to: pair.to });
    },
  }),
];

/** Register the area compare action of polygon measurements. */
export function registerAreaActions(): () => void {
  return registerActions(actions);
}
