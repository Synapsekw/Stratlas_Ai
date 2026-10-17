/** The Display group: callout labels, the issue pin toggle and layer visibility by kind. */
import { PinControls, pinDisplay, usePinDisplay } from '@aio/annotate';
import type { EngineStage, LabelMode } from '@aio/engine';
import type { Layer } from '@aio/schema';
import { Icon, useT, type IconName } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { shell, useShell } from '../../shell';
import { PopTool, Tool } from '../StageTools';

export const LABEL_MODES: { mode: LabelMode; label: string; hint: string }[] = [
  { mode: 'off', label: 'Off', hint: 'Selection and hover only' },
  { mode: 'key', label: 'Key', hint: 'One per component group' },
  { mode: 'all', label: 'All', hint: 'Every tagged component' },
];

export function nextLabelMode(m: LabelMode): LabelMode {
  const i = LABEL_MODES.findIndex((x) => x.mode === m);
  return LABEL_MODES[(i + 1) % LABEL_MODES.length]?.mode ?? 'key';
}

const KINDS: { kinds: Layer['kind'][]; label: string; icon: IconName }[] = [
  { kinds: ['mesh'], label: 'Models', icon: 'scene' },
  { kinds: ['pointcloud'], label: 'Point clouds', icon: 'cloud' },
  { kinds: ['photos'], label: 'Photo cameras', icon: 'photo' },
  { kinds: ['raster', 'basemap'], label: 'Maps and rasters', icon: 'raster' },
  { kinds: ['video'], label: 'Video clips', icon: 'video' },
];

function KindRow({ kinds, label, icon }: (typeof KINDS)[number]) {
  const ids = useWorkspace((s) =>
    (s.project?.manifest.layers ?? [])
      .filter((l) => kinds.includes(l.kind))
      .map((l) => l.id)
      .join('|'),
  );
  const anyVisible = useWorkspace((s) => ids.split('|').some((id) => id && !s.hidden[id]));
  if (!ids) return null;
  return (
    <label className="pop-row">
      <Icon name={icon} size={14} className="muted" />
      <span className="pop-grow">{label}</span>
      <input
        type="checkbox"
        checked={anyVisible}
        onChange={() => {
          for (const id of ids.split('|')) workspace.getState().setLayerVisible(id, !anyVisible);
        }}
      />
    </label>
  );
}

/**
 * Issue pins on and off in one click (I), so the severity heat map reads cleanly. The Layers
 * popover sets the same filter: the button turns the pins back on to the last filter it chose.
 */
export function PinToggle() {
  const t = useT();
  const on = usePinDisplay((s) => s.filter !== 'off');
  return (
    <Tool
      icon="pin"
      label={on ? t('stage.pins.hide') : t('stage.pins.show')}
      shortcut="scene.pins"
      pressed={on}
      onClick={() => {
        pinDisplay.getState().togglePins();
      }}
    />
  );
}

/** Callout labels, the issue pin toggle and layer visibility by kind. */
export function DisplayTools({ stage, map }: { stage: EngineStage | null; map: boolean }) {
  const labelMode = useShell((s) => s.labelMode);
  const pinFilter = usePinDisplay((s) => s.filter);
  const heat = usePinDisplay((s) => s.heat);
  return (
    <>
      <PinToggle />
      {!map && (
        <PopTool
          icon="tag"
          label="Labels"
          shortcut="scene.labels"
          pressed={labelMode !== 'off'}
          disabled={!stage}
        >
          <div className="pop-form">
            <div className="seg pop-seg" role="group" aria-label="Component labels">
              {LABEL_MODES.map((m) => (
                <button
                  key={m.mode}
                  type="button"
                  aria-pressed={labelMode === m.mode}
                  onClick={() => {
                    shell.getState().setLabelMode(m.mode);
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="pop-note">
              {LABEL_MODES.find((m) => m.mode === labelMode)?.hint}. Issue pins: see Layers.
            </p>
          </div>
        </PopTool>
      )}
      <PopTool
        icon="layers"
        label="Layers and issue pins"
        pressed={pinFilter !== 'all' || heat}
        wide
      >
        <div className="pop-form">
          {KINDS.map((k) => (
            <KindRow key={k.label} {...k} />
          ))}
          <span className="pop-title">Issue pins</span>
          <PinControls />
        </div>
      </PopTool>
    </>
  );
}
