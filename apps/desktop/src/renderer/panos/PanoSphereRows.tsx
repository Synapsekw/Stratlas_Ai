import type { Layer, PanoRef } from '@aio/schema';
import { Icon, t } from '@aio/ui';
import { workspace, useWorkspace } from '@aio/workspace';
import { jobs, shell, useJobs } from '../shell';
import { jobForPano, PANO_FLY_DISTANCE_M, panoStatus, panoStatusText } from './panoModel';
import './panos.css';

type PanoLayer = Extract<Layer, { kind: 'panoramas' }>;

/** Same rule as the engine adapter (`panoOpenable`): queued, running and failed spheres have no image. */
const openable = (p: PanoRef) => p.stitch === undefined || p.stitch.status === 'done';

function open(layerId: string, p: PanoRef) {
  const ws = workspace.getState();
  ws.setLayerVisible(layerId, true);
  shell.getState().go('scene');
  ws.openPano(layerId, p.id);
}

function SphereRow({
  layer,
  item,
  canEdit,
  root,
}: {
  layer: PanoLayer;
  item: PanoRef;
  canEdit: boolean;
  root: string;
}) {
  const job = useJobs((s) => jobForPano(s.jobs, root, layer.id, item.id));
  const status = panoStatus(item, job);
  const name = item.name ?? item.id;
  const act = (
    kind: string,
    icon: 'pano' | 'target' | 'refresh',
    label: string,
    run: () => void,
  ) => (
    <button
      type="button"
      className="eye tact"
      aria-label={label}
      title={label}
      data-testid={`pano-${kind}-${item.id}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        run();
      }}
    >
      <Icon name={icon} size={14} />
    </button>
  );
  return (
    <div
      className={`pano-sphere ${status.kind}`}
      data-testid={`pano-sphere-${layer.id}-${item.id}`}
    >
      <span className="tn">{item.name ?? item.id}</span>
      <span className="pano-st" data-testid={`pano-status-${item.id}`}>
        {panoStatusText(status)}
      </span>
      {status.kind === 'stitching' && (
        <span className="walk-meter" aria-hidden="true">
          <span style={{ inlineSize: `${String(status.pct)}%` }} />
        </span>
      )}
      <span className="tacts">
        {(status.kind === 'done' || status.kind === 'ready') &&
          openable(item) &&
          act('open', 'pano', t('pano.action.open', { name }), () => {
            open(layer.id, item);
          })}
        {act('fly', 'target', t('pano.action.flyTo', { name }), () => {
          workspace.getState().flyTo({ kind: 'point', p: item.pos, distance: PANO_FLY_DISTANCE_M });
        })}
        {canEdit &&
          (status.kind === 'queued' || status.kind === 'failed') &&
          act('stitch', 'refresh', t('pano.action.stitch', { name }), () => {
            void jobs.getState().start({
              pipeline: 'pano.stitch',
              project: root,
              params: { layer: layer.id, pano: item.id, quality: 'standard' },
            });
          })}
      </span>
    </div>
  );
}

/** One row per sphere under a panoramas layer's row in the Datasets tree. */
export function PanoSphereRows({ layer, canEdit }: { layer: PanoLayer; canEdit: boolean }) {
  const root = useWorkspace((s) => s.project?.root);
  if (root === undefined) return null;
  return (
    <div className="pano-spheres" role="group" aria-label={layer.name}>
      {layer.items.map((p) => (
        <SphereRow key={p.id} layer={layer} item={p} canEdit={canEdit} root={root} />
      ))}
    </div>
  );
}
