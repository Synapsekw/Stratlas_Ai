/**
 * 3D model change (M8 stream C3) in the Changes panel: the `change.mesh` pipeline for the models
 * of a date pair (deviation colours and the tagged part diff: added, removed, moved, changed).
 */
import type { ChangePairContext, ChangeProducer } from '@aio/change';
import type { ChangeMeshParams } from '@aio/schema';
import { type ChangeThresholds, type Layer } from '@aio/schema';
import { pairByName, runJob, type ChangeJob, type ProducerDeps } from './cloud';

type MeshLayer = Extract<Layer, { kind: 'mesh' }>;
type MeshParams = ReturnType<typeof ChangeMeshParams.parse>;

const isModel = (l: Layer): l is MeshLayer => l.kind === 'mesh' && !l.derived;

/** The 3D models of the two dates to compare, or what is missing. */
export function meshPair(ctx: ChangePairContext): { from: MeshLayer; to: MeshLayer } | string {
  const a = ctx.layersFrom.filter(isModel);
  const b = ctx.layersTo.filter(isModel);
  if (!a.length || !b.length) return 'Each date needs a 3D model of its own.';
  return (
    pairByName(a, b) ??
    'Several 3D models on a date: name them alike (with their dates) to compare them.'
  );
}

/** The `change.mesh` job for the pair: parts change from the significant cloud distance. */
export function meshJob(
  ctx: ChangePairContext,
  project: string,
  t: ChangeThresholds,
): ChangeJob | string {
  const pair = meshPair(ctx);
  if (typeof pair === 'string') return pair;
  const params: MeshParams = {
    layerFrom: pair.from.id,
    layerTo: pair.to.id,
    captures: { from: ctx.from, to: ctx.to },
    minDistM: t.cloud.significantM,
    maxDistM: t.cloud.farM,
  };
  return { pipeline: 'change.mesh', project, params };
}

export function meshChangeProducer(deps: ProducerDeps): ChangeProducer {
  return {
    id: 'mesh',
    label: 'Run model change',
    kinds: ['component'],
    available: (ctx) => {
      const pair = meshPair(ctx);
      return typeof pair === 'string' ? pair : true;
    },
    run: (ctx) => runJob(deps, (project) => meshJob(ctx, project, deps.thresholds())),
  };
}
