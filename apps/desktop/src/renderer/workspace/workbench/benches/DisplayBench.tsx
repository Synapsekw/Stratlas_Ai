/**
 * The Display workbench (stage island D12): Labels, Issue pins (the severity filter and heat map),
 * Layers by kind with an eye each, and the Street map. Labels and Pins start open (D16). The
 * controls are the ones the island's full set had; this lays them out as sections.
 */
import { PinControls, pinDisplay, usePinDisplay } from '@aio/annotate';
import { Button, EmptyState, IconButton, Row, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { shell, useShell } from '../../../shell';
import { useStreetMapButton } from '../../StreetMapTool';
import { KINDS, LABEL_MODES, useKindLayers } from '../../tools/display';
import { Section } from '../Section';
import './benches.css';

const BENCH = 'display';

/** A layer kind's row: its icon, name and count, and one eye for every layer of the kind. */
function KindEye({ kinds, label, icon }: (typeof KINDS)[number]) {
  const t = useT();
  const { ids, visible, toggle } = useKindLayers(kinds);
  if (ids.length === 0) return null;
  const name = t('bench.display.eye', { kind: label });
  return (
    <Row
      kind="tree"
      className="wb-eye-row"
      data-testid={`display-kind-${kinds[0] ?? label}`}
      icon={icon}
      label={label}
      count={ids.length}
      actions={
        <IconButton
          icon={visible ? 'eye' : 'eye-off'}
          label={name}
          pressed={visible}
          onClick={toggle}
        />
      }
    />
  );
}

function Labels() {
  const t = useT();
  const mode = useShell((s) => s.labelMode);
  const hint = LABEL_MODES.find((m) => m.mode === mode)?.hint ?? '';
  return (
    <div className="wb-controls">
      <div className="seg" role="group" aria-label={t('bench.display.labelsGroup')}>
        {LABEL_MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            aria-pressed={mode === m.mode}
            onClick={() => {
              shell.getState().setLabelMode(m.mode);
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="wb-note">{t('bench.display.labelsNote', { hint })}</p>
    </div>
  );
}

function Pins() {
  const t = useT();
  const on = usePinDisplay((s) => s.filter !== 'off');
  return (
    <div className="wb-controls">
      <Button
        icon="pin"
        pressed={on}
        shortcut="scene.pins"
        data-testid="display-pins-toggle"
        onClick={() => {
          pinDisplay.getState().togglePins();
        }}
      >
        {on ? t('stage.pins.hide') : t('stage.pins.show')}
      </Button>
      <PinControls />
    </div>
  );
}

/** How many of the project's layers the kind rows cover. */
function useLayerCount(): number {
  return useWorkspace(
    (s) =>
      (s.project?.manifest.layers ?? []).filter((l) => KINDS.some((k) => k.kinds.includes(l.kind)))
        .length,
  );
}

function Layers({ count }: { count: number }) {
  const t = useT();
  if (count === 0)
    return (
      <EmptyState
        icon="layers"
        title={t('bench.display.layersEmpty')}
        body={t('bench.display.layersEmptyBody')}
      />
    );
  return (
    <>
      {KINDS.map((k) => (
        <KindEye key={k.label} {...k} />
      ))}
    </>
  );
}

function StreetMap() {
  const t = useT();
  const tool = useStreetMapButton();
  if (!tool) return null;
  return (
    <Section id="display-streetmap" bench={BENCH} title={t('bench.display.streetMap')}>
      <div className="wb-controls">
        <Button
          icon="map"
          pressed={tool.pressed}
          disabled={tool.disabled}
          data-testid="street-map-3d"
          onClick={tool.toggle}
        >
          {t(tool.label)}
        </Button>
      </div>
    </Section>
  );
}

export function DisplayBench() {
  const t = useT();
  // the callout labels are the 3D view's; the map has none
  const map = useShell((s) => s.stageMode === 'map');
  const layers = useLayerCount();
  return (
    <div className="wb-bench wb-scroll" data-testid="display-bench">
      {!map && (
        <Section id="display-labels" bench={BENCH} title={t('bench.display.labels')} defaultOpen>
          <Labels />
        </Section>
      )}
      <Section id="display-pins" bench={BENCH} title={t('bench.display.pins')} defaultOpen>
        <Pins />
      </Section>
      <Section id="display-layers" bench={BENCH} title={t('bench.display.layers')} count={layers}>
        <Layers count={layers} />
      </Section>
      {!map && <StreetMap />}
    </div>
  );
}
