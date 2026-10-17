/**
 * The Point cloud workbench (stage island D12): show, colour with legend, size and EDL, the clouds
 * list with an eye each, Clean up and Survey QA. The colour, size and EDL controls are the point
 * cloud package's own; `cloud-panel` and `cleanup-tool` keep the test ids the specs look for.
 */
import { PointCloudControls } from '@aio/pointcloud';
import type { Layer } from '@aio/schema';
import { Button, EmptyState, IconButton, Row, useT } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { openCleanupPanel } from '../../../pointcloud/cleanupActions';
import { cleanup, useCleanup } from '../../../pointcloud/cleanupStore';
import { openQaPanel, useQa } from '../../../survey/qaStore';
import { useCloudLayers } from '../../tools/cloud';
import { Section } from '../Section';
import './benches.css';

const BENCH = 'clouds';

/** The project's point cloud layers (a stable list: the manifest's own objects). */
function useClouds(): Extract<Layer, { kind: 'pointcloud' }>[] {
  const layers = useWorkspace((s) => s.project?.manifest.layers);
  return (layers ?? []).filter(
    (l): l is Extract<Layer, { kind: 'pointcloud' }> => l.kind === 'pointcloud',
  );
}

function CloudEye({ layer }: { layer: Extract<Layer, { kind: 'pointcloud' }> }) {
  const t = useT();
  const visible = useWorkspace((s) => !s.hidden[layer.id]);
  return (
    <Row
      kind="tree"
      className="wb-eye-row"
      data-testid={`cloud-row-${layer.id}`}
      icon="cloud"
      label={layer.name}
      actions={
        <IconButton
          icon={visible ? 'eye' : 'eye-off'}
          label={t('bench.cloud.eye', { name: layer.name })}
          pressed={visible}
          data-testid={`cloud-eye-${layer.id}`}
          onClick={() => {
            workspace.getState().setLayerVisible(layer.id, !visible);
          }}
        />
      }
    />
  );
}

export function CloudBench() {
  const t = useT();
  const clouds = useClouds();
  const { shown, many, toggle } = useCloudLayers();
  const cleanupOpen = useCleanup((s) => s.panelOpen);
  const qaOpen = useQa((s) => s.panel === 'qa');
  if (clouds.length === 0)
    return (
      <div className="wb-bench" data-testid="cloud-bench">
        <EmptyState icon="cloud" title={t('bench.cloud.empty')} body={t('bench.cloud.emptyBody')} />
      </div>
    );
  return (
    <div className="wb-bench" data-testid="cloud-bench">
      <Section id="cloud-show" bench={BENCH} title={t('bench.cloud.show')} defaultOpen>
        <div className="wb-controls">
          <Button icon="cloud" pressed={shown} data-testid="cloud-show-all" onClick={toggle}>
            {many ? t('bench.cloud.showMany') : t('bench.cloud.showAll')}
          </Button>
        </div>
      </Section>
      <Section id="cloud-colour" bench={BENCH} title={t('bench.cloud.colour')} defaultOpen>
        <div className="wb-controls" data-testid="cloud-panel">
          <PointCloudControls className="pop-form" />
        </div>
      </Section>
      <Section
        id="cloud-clouds"
        bench={BENCH}
        title={t('bench.cloud.clouds')}
        count={clouds.length}
      >
        {clouds.map((c) => (
          <CloudEye key={c.id} layer={c} />
        ))}
      </Section>
      <Section id="cloud-cleanup" bench={BENCH} title={t('bench.cloud.cleanup')}>
        <div className="wb-controls">
          <Button
            icon="boxclip"
            pressed={cleanupOpen}
            data-testid="cleanup-tool"
            onClick={() => {
              if (cleanupOpen) cleanup.closePanel();
              else openCleanupPanel();
            }}
          >
            {t('cleanup.tool')}
          </Button>
          <p className="wb-note">{t('bench.cloud.cleanupHint')}</p>
        </div>
      </Section>
      <Section id="cloud-qa" bench={BENCH} title={t('bench.cloud.qa')}>
        <div className="wb-controls">
          <Button
            icon="shield"
            pressed={qaOpen}
            data-testid="cloud-qa-open"
            onClick={() => {
              openQaPanel(qaOpen ? null : 'qa');
            }}
          >
            {t('bench.cloud.qaOpen')}
          </Button>
          <p className="wb-note">{t('bench.cloud.qaHint')}</p>
        </div>
      </Section>
    </div>
  );
}
