/**
 * The Road workbench (stage island D12): the area overlay with its legend, the close-up of the
 * selected defect, the layers and measuring on the map. The controls are the road toolbar's own
 * (road/RoadTools.tsx); the road keys (P, D, C, M) are unchanged and still run from the stage.
 */
import { Button, useT } from '@aio/ui';
import {
  RoadLayerControls,
  RoadLegend,
  RoadOverlayControls,
  toggleMeasure,
} from '../../../road/RoadTools';
import { setRoad, useRoad } from '../../../road/store';
import { measureText } from '../../../road/useRoadMap';
import { useShell } from '../../../shell';
import { Section } from '../Section';
import './benches.css';

export function RoadBench() {
  const t = useT();
  const closeup = useRoad((s) => s.closeup);
  const measure = useRoad((s) => s.measure);
  // the close-up and the measure are the map's: not in the 3D view
  const onMap = useShell((s) => s.stageMode) !== '3d';
  const reading = measure.mode ? measureText(measure.mode, measure.vertices) : null;
  const mapOnly = onMap ? undefined : t('roadBench.mapOnly');
  return (
    <div className="wb-scroll" data-testid="road-bench">
      <Section id="road-overlay" bench="road" title={t('roadBench.overlay')} defaultOpen>
        <div className="pop-form wb-pop-form">
          <RoadOverlayControls />
          <RoadLegend inline />
        </div>
      </Section>
      <Section id="road-closeup" bench="road" title={t('roadBench.closeup')}>
        <div className="pop-form wb-pop-form">
          <Button
            icon="photo"
            pressed={closeup}
            shortcut="road.closeup"
            onClick={() => {
              setRoad({ closeup: !closeup });
            }}
            disabledReason={mapOnly}
          >
            {t('roadBench.closeupButton')}
          </Button>
          <p className="pop-note">{t('roadBench.closeupHint')}</p>
        </div>
      </Section>
      <Section id="road-layers" bench="road" title={t('roadBench.layers')}>
        <div className="pop-form wb-pop-form rr-layers">
          <RoadLayerControls />
        </div>
      </Section>
      <Section id="road-measure" bench="road" title={t('roadBench.measure')}>
        <div className="pop-form wb-pop-form">
          <Button
            icon="ruler"
            pressed={measure.mode !== null}
            shortcut="road.measure"
            onClick={() => {
              toggleMeasure();
            }}
            disabledReason={mapOnly}
          >
            {t('roadBench.measureButton')}
          </Button>
          <p className="pop-note">{reading ?? t('roadBench.measureHint')}</p>
        </div>
      </Section>
    </div>
  );
}
