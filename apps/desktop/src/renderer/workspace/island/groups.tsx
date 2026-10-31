/**
 * The island's modes (UI revision W8): the stage view switch, and each mode's slim row of its top
 * tools from the tool registry (`tools/registry.ts`), favourites and recent first. A mode's whole
 * set is its section of the right panel, which picking the mode opens. The switches the old quick
 * rows carried (view preset, cloud colour, pile bodies) sit in the Tools tab's sections now
 * (`GroupControls`).
 */
import type { EngineStage } from '@aio/engine';
import {
  pointcloudSettings,
  usePointcloudCounts,
  usePointcloudSettings,
  type ColourMode,
} from '@aio/pointcloud';
import {
  Button,
  Icon,
  shortcutHint,
  useT,
  type IconName,
  type MessageKey,
  type ShortcutId,
} from '@aio/ui';
import { useVolumetric, volumetric, type BodyMode } from '@aio/volumetric';
import type { StageMode } from '../../store';
import { VolumeChangePicks } from '../VolumeTools';
import { favouritesAndRecent, useFavourites } from '../../survey/measureCatalogue';
import {
  measureToolId,
  nameKeyOf,
  topTools,
  type IslandMode,
  type ToolCtx,
  type ToolDef,
  type ToolGroup,
} from '../../tools/registry';
import { useToolPress } from '../../tools/ToolRows';

/** The stage views, keys 1, 2 and 3. */
export const MODES: { mode: StageMode; label: MessageKey; icon: IconName; keys: string }[] = [
  { mode: '3d', label: 'island.mode.3d', icon: 'scene', keys: '1' },
  { mode: 'map', label: 'island.mode.map', icon: 'map', keys: '2' },
  { mode: 'split', label: 'island.mode.split', icon: 'split', keys: '3' },
];

export interface GroupCtx {
  stage: EngineStage | null;
  /** The registry's context: what the project holds and the view in use. */
  tool: ToolCtx;
  /** The island back to rest (a tile that opened its panel). */
  done: () => void;
}

/* ----------------------------------------------------------------------- tiles */

interface TileProps {
  icon: IconName;
  /** The short name under the icon. */
  label: string;
  /** The accessible name and tooltip, when longer than the label. */
  name?: string | undefined;
  shortcut?: ShortcutId | undefined;
  pressed?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Greyed out with the reason in the tooltip (and read as its description). */
  disabledReason?: string | undefined;
  /** Opens a panel (the corner caret). */
  caret?: boolean;
  /** Opens the group's workbench: the accent tile at the end of a row. */
  toSide?: boolean;
  flip?: boolean;
  testId?: string | undefined;
  onClick: () => void;
}

/** A quick tile: icon, short name and key. */
export function Tile({
  icon,
  label,
  name,
  shortcut,
  pressed,
  disabled,
  disabledReason,
  caret,
  toSide,
  flip,
  testId,
  onClick,
}: TileProps) {
  // a single key in the corner; a combination ("Ctrl J") only in the tooltip
  const hint = shortcut ? shortcutHint(shortcut) : '';
  const corner = hint && !hint.includes(' ') ? hint : '';
  return (
    <Button
      variant="quiet"
      className={`isl-tile${toSide ? ' isl-to-side' : ''}`}
      aria-label={name ?? label}
      tip={name ?? label}
      data-testid={testId}
      onClick={onClick}
      {...(pressed !== undefined ? { pressed } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
      {...(disabledReason ? { disabledReason } : {})}
      {...(shortcut ? { shortcut } : {})}
    >
      <Icon name={icon} size={20} {...(flip ? { className: 'flip' } : {})} />
      <span className="isl-tl">{label}</span>
      {corner && (
        <span className="isl-tk" aria-hidden="true">
          {corner}
        </span>
      )}
      {caret && <span className="caret" aria-hidden="true" />}
    </Button>
  );
}

interface ChoiceProps<V extends string> {
  label: string;
  shortcut?: ShortcutId;
  options: readonly { value: V; label: string; disabled?: boolean }[];
  value: V | null;
  disabled?: boolean;
  onPick: (v: V) => void;
}

/** An inline switch with its caption under it. */
export function Choice<V extends string>({
  label,
  shortcut,
  options,
  value,
  disabled,
  onPick,
}: ChoiceProps<V>) {
  return (
    <div className="isl-choice" role="group" aria-label={label}>
      <div className="seg">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            disabled={disabled === true || o.disabled === true}
            onClick={() => {
              onPick(o.value);
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
      <span className="isl-cl" aria-hidden="true">
        {label}
        {shortcut && <span className="isl-tk">{shortcutHint(shortcut)}</span>}
      </span>
    </div>
  );
}

/* ----------------------------------------------------------------------- the mode rows */

/** A registry tool as an island tile: greyed out with its reason when it cannot start here. */
function ToolTile({ def, ctx }: { def: ToolDef; ctx: GroupCtx }) {
  const t = useT();
  const { on, can, press } = useToolPress(def, ctx.tool);
  return (
    <Tile
      icon={def.icon}
      label={t(def.labelKey)}
      name={def.nameKey || def.nameOnKey ? t(nameKeyOf(def, on)) : undefined}
      shortcut={def.shortcutId}
      pressed={def.useOn ? on : undefined}
      disabled={can !== true && !on}
      disabledReason={can === true ? undefined : t(can.reason)}
      caret={def.opens === true}
      testId={def.testId}
      onClick={() => {
        press();
        // a tile that opened its panel in the right sidebar: the island goes back to rest
        if (def.opens) ctx.done();
      }}
    />
  );
}

/** A mode's slim row (D3): its top tools, favourites and recent first. */
export function ModeRow({ mode, ctx }: { mode: IslandMode; ctx: GroupCtx }) {
  const favourites = useFavourites((s) => s.favourites);
  const recent = useFavourites((s) => s.recent);
  const preferred =
    mode === 'measure' ? favouritesAndRecent({ favourites, recent }).map(measureToolId) : [];
  return (
    <>
      {topTools(mode, ctx.tool, preferred).map((d) => (
        <ToolTile key={d.id} def={d} ctx={ctx} />
      ))}
    </>
  );
}

/* ----------------------------------------------------------------------- group switches */

const PRESETS: readonly { value: 'iso' | 'top' | 'north'; label: MessageKey }[] = [
  { value: 'iso', label: 'island.tile.presetIso' },
  { value: 'top', label: 'island.tile.presetTop' },
  { value: 'north', label: 'island.tile.presetNorth' },
];

/** The 3D view's presets (Iso, Top, North), in Tools > View. */
function ViewPresets({ stage }: { stage: EngineStage }) {
  const t = useT();
  return (
    <Choice
      label={t('island.tile.viewPreset')}
      options={PRESETS.map((p) => ({ value: p.value, label: t(p.label) }))}
      value={null}
      onPick={(p) => {
        stage.setViewPreset(p);
      }}
    />
  );
}

/** The colour switch the quick row offers (D5); the workbench has every mode. */
const CLOUD_COLOURS: readonly { value: ColourMode; label: MessageKey }[] = [
  { value: 'rgb', label: 'island.tile.colourRgb' },
  { value: 'height', label: 'island.tile.colourElevation' },
  { value: 'intensity', label: 'island.tile.colourIntensity' },
  { value: 'flight', label: 'island.tile.colourFlight' },
];

/** RGB / Elevation / Intensity / Flight; none pressed while the cloud is coloured another way. */
function CloudColour() {
  const t = useT();
  const mode = usePointcloudSettings((s) => s.colourMode);
  const counts = usePointcloudCounts();
  // as the workbench's controls: an intensity-only cloud draws the RGB choice as intensity
  const hasRgb = counts.layers === 0 || counts.rgb;
  const shown = mode === 'rgb' && !hasRgb ? 'intensity' : mode;
  return (
    <Choice
      label={t('island.tile.colour')}
      options={CLOUD_COLOURS.map((c) => ({
        value: c.value,
        label: t(c.label),
        disabled: c.value === 'rgb' && !hasRgb,
      }))}
      value={CLOUD_COLOURS.some((c) => c.value === shown) ? shown : null}
      onPick={(m) => {
        pointcloudSettings.getState().setColourMode(m);
      }}
    />
  );
}

const BODIES: readonly { value: BodyMode; label: MessageKey }[] = [
  { value: 'lift', label: 'island.tile.lifted' },
  { value: 'place', label: 'island.tile.inPlace' },
  { value: 'off', label: 'island.tile.hidden' },
];

/**
 * The stockpile kit's bodies (lifted, in place, hidden), and while Cut / fill shows the two
 * surveys it compares, in Tools > Volumes.
 */
function Bodies() {
  const t = useT();
  const kit = useVolumetric((s) => s.status === 'ready');
  const body = useVolumetric((s) => s.body);
  const change = useVolumetric((s) => s.surface === 'change');
  if (!kit) return null;
  return (
    <>
      {change && <VolumeChangePicks />}
      <Choice
        label={t('island.tile.bodies')}
        options={BODIES.map((b) => ({ value: b.value, label: t(b.label) }))}
        value={body}
        onPick={(b) => {
          volumetric.getState().setBody(b);
        }}
      />
    </>
  );
}

/** A group's switches, under its tools in the Tools tab (the old quick rows' inline switches). */
export function GroupControls({
  group,
  stage,
  mode,
}: {
  group: ToolGroup;
  stage: EngineStage | null;
  mode: StageMode;
}) {
  const threeD = stage !== null && mode !== 'map';
  let body = null;
  if (group === 'view' && threeD) body = <ViewPresets stage={stage} />;
  else if (group === 'pointcloud') body = <CloudColour />;
  else if (group === 'volumes') body = <Bodies />;
  if (!body) return null;
  return <div className="tool-controls">{body}</div>;
}
