import {
  getActiveStage,
  onActiveScene,
  type EngineStage,
  type LabelMode,
  type SectionState,
  type ViewPreset,
} from '@aio/engine';
import { PinControls, pinDisplay, usePinDisplay } from '@aio/annotate';
import { PointCloudControls } from '@aio/pointcloud';
import type { Layer } from '@aio/schema';
import {
  ariaKeys,
  Icon,
  shortcutHint,
  useFocusTrap,
  useT,
  type IconName,
  type ShortcutId,
} from '@aio/ui';
import { setCameraMode, videoRig, type CameraMode } from '@aio/video';
import { useVolumetric } from '@aio/volumetric';
import { useWorkspace, workspace } from '@aio/workspace';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { shell, useShell } from '../shell';
import { PATH_MODES, setPathMode } from './flightPaths';
import { updateFlightPaths, useFlightPathModel } from './pathModel';
import { CutawayPanel } from './CutawayTool';
import { MeasureToolbar } from '../survey/MeasureToolbar';
import { usePopPlacement } from './popPlacement';
import { toggleTelemetry, useTelemetryOn } from './telemetryPref';
import { useCutawayPref } from './useCutaway';
import {
  siteBasemap,
  siteBasemapDefault,
  siteBasemapOn,
  useSiteBasemap,
  wantsSiteBasemap,
} from './siteBasemap';

/** The live 3D stage (view presets, tools, section), re-rendering on tool and section changes. */
export function useEngineStage(): EngineStage | null {
  const stage = useSyncExternalStore(onActiveScene, getActiveStage, getActiveStage);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => stage?.onStateChange(bump), [stage]);
  return stage;
}

/** Tooltip text with an optional key hint. */
function Tip({ label, keys, end }: { label: string; keys?: string | undefined; end?: boolean }) {
  return (
    <span className={`tip${end ? ' tip-end' : ''}`}>
      {label}
      {keys && <span className="kbd">{keys}</span>}
    </span>
  );
}

interface ToolProps {
  icon: IconName;
  label: string;
  keys?: string | undefined;
  /** The registry shortcut (Settings, Keyboard) this tool also answers to; names its key. */
  shortcut?: ShortcutId;
  pressed?: boolean;
  disabled?: boolean;
  /** A `data-testid` for the e2e specs. */
  testId?: string;
  onClick: () => void;
}

/** A square stage tool with a tooltip that names its shortcut. */
export function Tool({
  icon,
  label,
  keys,
  shortcut,
  pressed,
  disabled,
  testId,
  onClick,
}: ToolProps) {
  const hint = shortcut ? shortcutHint(shortcut) : keys;
  return (
    <button
      type="button"
      className="tool"
      aria-pressed={pressed}
      aria-label={label}
      aria-keyshortcuts={shortcut ? ariaKeys(shortcut) : keys}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
    >
      <Icon name={icon} />
      <Tip label={label} keys={hint} />
    </button>
  );
}

/**
 * A tool button that opens a panel below it; closes on outside click and Escape. Pass `open` and
 * `onOpenChange` to open it from elsewhere (the sidebar, the command palette).
 */
export function PopTool({
  icon,
  label,
  keys,
  shortcut,
  pressed,
  disabled,
  wide,
  open: openProp,
  onOpenChange,
  children,
}: {
  icon: IconName;
  label: string;
  keys?: string | undefined;
  shortcut?: ShortcutId;
  pressed?: boolean;
  disabled?: boolean;
  wide?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [own, setOwn] = useState(false);
  const open = openProp ?? own;
  const change = useRef(onOpenChange);
  useLayoutEffect(() => {
    change.current = onOpenChange;
  });
  const controlled = openProp !== undefined;
  const setOpen = useCallback(
    (o: boolean) => {
      if (!controlled) setOwn(o);
      change.current?.(o);
    },
    [controlled],
  );
  const ref = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // on the stage, never under the timeline or the Context panel; it scrolls when the stage is short
  usePopPlacement(open, ref, pop);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    return () => {
      window.removeEventListener('pointerdown', away);
    };
  }, [open, setOpen]);
  // focus moves into the panel, Tab stays inside, Esc closes and focus returns to the tool
  useFocusTrap(pop, open, {
    onEscape: () => {
      setOpen(false);
    },
    returnTo: () => button.current,
  });
  return (
    <div className="pop-anchor" ref={ref}>
      <button
        ref={button}
        type="button"
        className="tool"
        aria-pressed={pressed ?? open}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        aria-keyshortcuts={shortcut ? ariaKeys(shortcut) : keys}
        disabled={disabled}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name={icon} />
        <span className="caret" aria-hidden />
        {!open && <Tip label={label} keys={shortcut ? shortcutHint(shortcut) : keys} />}
      </button>
      {open && (
        <div
          ref={pop}
          className={`stage-pop overlay-box${wide ? ' wide' : ''}`}
          role="dialog"
          aria-label={label}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------- view */

const PRESETS: { preset: ViewPreset; label: string }[] = [
  { preset: 'iso', label: 'Iso' },
  { preset: 'top', label: 'Top' },
  { preset: 'north', label: 'North' },
];

/** Whole site, fly to the selection and the view presets (north-up top, north, isometric). */
export function ViewTools({ stage, map }: { stage: EngineStage | null; map: boolean }) {
  const selection = useWorkspace((s) => s.selection);
  return (
    <>
      <Tool
        icon="maximize"
        label="Whole site"
        shortcut="scene.home"
        onClick={() => {
          workspace.getState().flyTo({ kind: 'home' });
        }}
      />
      <Tool
        icon="target"
        label="Fly to selection"
        shortcut="scene.flySelection"
        disabled={!selection}
        onClick={() => {
          if (selection) workspace.getState().flyTo({ kind: 'selection', selection });
        }}
      />
      {!map && (
        <PopTool icon="box" label="View presets" disabled={!stage}>
          <div className="seg pop-seg" role="group" aria-label="View presets">
            {PRESETS.map((p) => (
              <button
                key={p.preset}
                type="button"
                title={`${p.label} view of the whole site`}
                onClick={() => {
                  stage?.setViewPreset(p.preset);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="pop-note">The compass also flips to a north-up top view.</p>
        </PopTool>
      )}
    </>
  );
}

/* ----------------------------------------------------------------------- measure and section */

/** Compass bearing from the orbit target toward the camera: the half a viewer wants removed. */
function cameraBearing(stage: EngineStage): number {
  const v = stage.camera.position.clone().sub(stage.controls.target);
  return Math.round(((Math.atan2(v.x, -v.z) * 180) / Math.PI + 360) % 360);
}

/** Turn the section on toward the camera, or off. */
export function toggleSection(stage: EngineStage): void {
  const s = stage.section;
  stage.setSection(
    s.enabled
      ? { enabled: false }
      : s.mode === 'vertical'
        ? { enabled: true, bearingDeg: cameraBearing(stage) }
        : { enabled: true },
  );
}

function SectionPanel({ stage }: { stage: EngineStage }) {
  const s = stage.section;
  const set = (patch: Partial<SectionState>) => {
    stage.setSection(patch);
  };
  return (
    <div className="pop-form">
      <label className="pop-row">
        <span>Section</span>
        <input
          type="checkbox"
          checked={s.enabled}
          onChange={() => {
            toggleSection(stage);
          }}
        />
      </label>
      <div className="seg" role="group" aria-label="Cut direction">
        {(['vertical', 'horizontal'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={s.mode === m}
            onClick={() => {
              set({ mode: m, enabled: true });
            }}
          >
            {m === 'vertical' ? 'Vertical' : 'Horizontal'}
          </button>
        ))}
      </div>
      {s.mode === 'vertical' && (
        <label className="pop-row">
          <span>Bearing</span>
          <input
            type="range"
            min={0}
            max={359}
            value={s.bearingDeg}
            onChange={(e) => {
              set({ bearingDeg: Number(e.target.value), enabled: true });
            }}
          />
          <span className="mono">{String(s.bearingDeg).padStart(3, '0')}°</span>
        </label>
      )}
      <label className="pop-row">
        <span>Offset</span>
        <input
          type="range"
          min={-20}
          max={20}
          step={0.05}
          value={s.offset}
          onChange={(e) => {
            set({ offset: Number(e.target.value), enabled: true });
          }}
        />
        <span className="mono">{s.offset.toFixed(2)} m</span>
      </label>
      <label className="pop-row">
        <span>Keep other half</span>
        <input
          type="checkbox"
          checked={s.flip}
          onChange={(e) => {
            set({ flip: e.target.checked });
          }}
        />
      </label>
    </div>
  );
}

/** Select, measure and section. */
export function MeasureTools({ stage }: { stage: EngineStage | null }) {
  const tool = stage?.tool ?? 'select';
  // No separate Select tool: the ruler toggles off and Esc returns to selecting. The survey tools
  // took its place, so the bar still fits one row at 1440 px with both side panels open.
  return (
    <>
      <Tool
        icon="ruler"
        label="Measure a distance"
        shortcut="scene.measure"
        pressed={tool === 'measure'}
        disabled={!stage}
        onClick={() => stage?.setTool(tool === 'measure' ? 'select' : 'measure')}
      />
      {stage && (
        <PopTool
          icon="section"
          label="Section plane"
          shortcut="scene.section"
          pressed={stage.section.enabled}
        >
          <SectionPanel stage={stage} />
        </PopTool>
      )}
      <MeasureToolbar />
    </>
  );
}

/* ----------------------------------------------------------------------- display */

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
  { kinds: ['mesh', 'legacy'], label: 'Models', icon: 'scene' },
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

/** The offline street map under the site in 3D, for projects that can have it. */
function StreetMapRow() {
  const t = useT();
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const wanted = useWorkspace((s) => (s.project ? wantsSiteBasemap(s.project.manifest) : false));
  const volumes = useVolumetric((s) => s.status === 'ready');
  const covered = useSiteBasemap((s) => s.covered);
  const defaultOn = useWorkspace((s) =>
    s.project ? siteBasemapDefault(s.project.manifest, volumes) : false,
  );
  const on = useSiteBasemap((s) =>
    projectId ? siteBasemapOn(s.choices, projectId, defaultOn) : false,
  );
  if (!projectId || !wanted) return null;
  return (
    <label
      className="pop-row"
      title={covered === false ? t('stage.streetMap.none') : t('stage.streetMap.tip')}
    >
      <Icon name="map" size={14} className="muted" />
      <span className="pop-grow">{t('stage.streetMap')}</span>
      <input
        type="checkbox"
        data-testid="street-map-3d"
        disabled={covered === false}
        checked={on && covered !== false}
        onChange={() => {
          siteBasemap.getState().set(projectId, !on);
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
          {!map && <StreetMapRow />}
          <span className="pop-title">Issue pins</span>
          <PinControls />
        </div>
      </PopTool>
    </>
  );
}

/* ----------------------------------------------------------------------- point clouds */

/** Cloud layer ids of the open project, joined (a stable selector value). */
const cloudIds = (layers: readonly Layer[] | undefined) =>
  (layers ?? [])
    .filter((l) => l.kind === 'pointcloud')
    .map((l) => l.id)
    .join('|');

/** The point cloud panel: show it, colour by RGB, elevation, intensity or flight, size, EDL. */
export function CloudTools() {
  const open = useShell((s) => s.cloudPanelOpen);
  const ids = useWorkspace((s) => cloudIds(s.project?.manifest.layers));
  const shown = useWorkspace((s) => ids.split('|').some((id) => id && !s.hidden[id]));
  const many = ids.includes('|');
  if (!ids) return null;
  return (
    <PopTool
      icon="cloud"
      label="Point cloud"
      wide
      open={open}
      onOpenChange={(o) => {
        shell.getState().setCloudPanel(o);
      }}
    >
      <div className="pop-form" data-testid="cloud-panel">
        <span className="pop-title">Point cloud{many ? 's' : ''}</span>
        <label className="pop-row">
          <Icon name="cloud" size={14} className="muted" />
          <span className="pop-grow">Show the point cloud{many ? 's' : ''}</span>
          <input
            type="checkbox"
            checked={shown}
            onChange={() => {
              for (const id of ids.split('|')) workspace.getState().setLayerVisible(id, !shown);
            }}
          />
        </label>
        <PointCloudControls className="pop-form" />
      </div>
    </PopTool>
  );
}

/* ----------------------------------------------------------------------- flight paths */

/** All, active clip only or no flight paths in 3D (P turns them off and back on). */
export function FlightPathTool() {
  const m = useFlightPathModel();
  if (!m) return null;
  const { mode } = m.pref;
  const current = PATH_MODES.find((p) => p.mode === mode);
  return (
    <PopTool
      icon="path"
      label="Flight paths"
      shortcut="scene.flightPaths"
      pressed={mode !== 'off'}
      wide
    >
      <div className="pop-form" data-testid="path-panel">
        <span className="pop-title">Flight paths</span>
        <div className="seg pop-seg" role="group" aria-label="Flight paths">
          {PATH_MODES.map((p) => (
            <button
              key={p.mode}
              type="button"
              aria-pressed={mode === p.mode}
              title={p.hint}
              onClick={() => {
                updateFlightPaths((pref) => setPathMode(pref, p.mode));
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="pop-note">
          {current?.hint}. <span className="kbd">P</span> turns the paths off and on; the eye on a
          flight in the Video list hides that flight&apos;s path.
        </p>
      </div>
    </PopTool>
  );
}

/** Drone telemetry while a clip plays: flown track, distance ticks and the HUD (D). */
export function TelemetryTool() {
  const t = useT();
  const on = useTelemetryOn();
  if (!useFlightPathModel()) return null;
  return (
    <Tool
      icon="telemetry"
      label={on ? t('stage.telemetry.hide') : t('stage.telemetry.show')}
      shortcut="scene.telemetry"
      pressed={on}
      onClick={toggleTelemetry}
    />
  );
}

/* ----------------------------------------------------------------------- video and camera */

const CAMERA_MODES: { mode: CameraMode; label: string; icon: IconName }[] = [
  { mode: 'free', label: 'Free orbit', icon: 'orbit' },
  { mode: 'follow', label: 'Follow the drone', icon: 'follow' },
  { mode: 'drone', label: 'Drone eye (through the camera)', icon: 'droneeye' },
];

/** Video window, free, follow-cam and drone-eye views, and the inside view of the asset. */
export function VideoTools({ stage, map }: { stage: EngineStage | null; map: boolean }) {
  const activeClip = useWorkspace((s) => s.activeClip);
  const videoHidden = useShell((s) => s.videoHidden);
  const cut = useCutawayPref();
  const t = useT();
  const showVideo = activeClip !== null && !videoHidden;
  const mode = stage && activeClip ? videoRig(stage).cameraMode : 'free';
  const [, bump] = useReducer((n: number) => n + 1, 0);
  return (
    <>
      <Tool
        icon="video"
        label={showVideo ? 'Hide the video window' : 'Show the video window'}
        shortcut="scene.video"
        pressed={showVideo}
        disabled={activeClip === null}
        onClick={() => {
          shell.getState().setVideoHidden(!videoHidden);
        }}
      />
      {!map && <FlightPathTool />}
      {!map && <TelemetryTool />}
      {!map &&
        CAMERA_MODES.map((m) => (
          <Tool
            key={m.mode}
            icon={m.icon}
            label={m.label}
            pressed={mode === m.mode}
            disabled={!stage || (m.mode !== 'free' && activeClip === null)}
            onClick={() => {
              if (!stage) return;
              setCameraMode(stage, m.mode);
              bump();
            }}
          />
        ))}
      {!map && (
        <PopTool
          icon="cutaway"
          label={t('stage.cutaway.tool')}
          pressed={cut.mode !== 'off'}
          disabled={!stage}
          wide
        >
          <CutawayPanel stage={stage} />
        </PopTool>
      )}
    </>
  );
}

/* ----------------------------------------------------------------------- annotate */

export function AnnotateToggle() {
  const on = useShell((s) => s.annotating);
  // Packages are never annotated (player mode).
  const pkg = useShell((s) => s.pkg);
  if (pkg) return null;
  return (
    <Tool
      icon="anno"
      label={on ? 'Close the annotation tools' : 'Annotate: pins, lines, areas, cloud regions'}
      shortcut="scene.annotate"
      pressed={on}
      onClick={() => {
        shell.getState().setAnnotating(!on);
      }}
    />
  );
}
