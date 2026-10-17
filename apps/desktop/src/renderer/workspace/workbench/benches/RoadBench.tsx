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

/** A section's props: the bench's id and its heading. */
const head = (id: string, title: string) => ({ id, bench: 'road' as const, title });

export function RoadBench() {
  const t = useT();
  const closeup = useRoad((s) => s.closeup);
  const measure = useRoad((s) => s.measure);
  // the close-up and the measure are the map's: not in the 3D view
  const onMap = useShell((s) => s.stageMode) !== '3d';
  const reading = measure.mode ? measureText(measure.mode, measure.vertices) : null;
  const mapOnly = onMap ? {} : { disabledReason: t('roadBench.mapOnly') };
  return (
    <div className="wb-scroll" data-testid="road-bench">
      <Section {...head('overlay', t('roadBench.overlay'))} defaultOpen>
        <div className="pop-form wb-form">
          <RoadOverlayControls />
          <RoadLegend inline />
        </div>
      </Section>
      <Section {...head('closeup', t('roadBench.closeup'))}>
        <div className="pop-form wb-form">
          <Button
            icon="photo"
            pressed={closeup}
            shortcut="road.closeup"
            onClick={() => {
              setRoad({ closeup: !closeup });
            }}
            {...mapOnly}
          >
            {t('roadBench.closeupButton')}
          </Button>
          <p className="pop-note">{t('roadBench.closeupHint')}</p>
        </div>
      </Section>
      <Section {...head('layers', t('roadBench.layers'))}>
        <div className="pop-form wb-form rr-layers">
          <RoadLayerControls />
        </div>
      </Section>
      <Section {...head('measure', t('roadBench.measure'))}>
        <div className="pop-form wb-form">
          <Button
            icon="ruler"
            pressed={measure.mode !== null}
            shortcut="road.measure"
            onClick={() => {
              toggleMeasure();
            }}
            {...mapOnly}
          >
            {t('roadBench.measureButton')}
          </Button>
          <p className="pop-note">{reading ?? t('roadBench.measureHint')}</p>
        </div>
      </Section>
    </div>
  );
}
