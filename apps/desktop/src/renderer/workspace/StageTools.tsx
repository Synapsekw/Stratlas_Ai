import {
  getActiveStage,
  onActiveScene,
  type EngineStage,
  type LabelMode,
  type SectionState,
  type ViewPreset,
} from '@aio/engine';
import { PointCloudControls } from '@aio/pointcloud';
import type { Layer } from '@aio/schema';
import { Icon, type IconName } from '@aio/ui';
import { setCameraMode, videoRig, type CameraMode } from '@aio/video';
import { useWorkspace, workspace } from '@aio/workspace';
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { shell, useShell } from '../shell';
import { insideView, stopCutaway, useCutawayState } from './useCutaway';

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
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** A square stage tool with a tooltip that names its shortcut. */
export function Tool({ icon, label, keys, pressed, disabled, onClick }: ToolProps) {
  return (
    <button
      type="button"
      className="tool"
      aria-pressed={pressed}
      aria-label={label}
      aria-keyshortcuts={keys}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
      <Tip label={label} keys={keys} />
    </button>
  );
}

/** A tool button that opens a panel below it; closes on outside click and Escape. */
export function PopTool({
  icon,
  label,
  keys,
  pressed,
  disabled,
  wide,
  children,
}: {
  icon: IconName;
  label: string;
  keys?: string | undefined;
  pressed?: boolean;
  disabled?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="pop-anchor" ref={ref}>
      <button
        type="button"
        className="tool"
        aria-pressed={pressed ?? open}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        aria-keyshortcuts={keys}
        disabled={disabled}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name={icon} />
        <span className="caret" aria-hidden />
        {!open && <Tip label={label} keys={keys} />}
      </button>
      {open && (
        <div
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
        keys="H"
        onClick={() => {
          workspace.getState().flyTo({ kind: 'home' });
        }}
      />
      <Tool
        icon="target"
        label="Fly to selection"
        keys="F"
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
  return (
    <>
      <Tool
        icon="select"
        label="Select"
        keys="Esc"
        pressed={tool === 'select'}
        disabled={!stage}
        onClick={() => stage?.setTool('select')}
      />
      <Tool
        icon="ruler"
        label="Measure a distance"
        keys="M"
        pressed={tool === 'measure'}
        disabled={!stage}
        onClick={() => stage?.setTool(tool === 'measure' ? 'select' : 'measure')}
      />
      {stage && (
        <PopTool icon="section" label="Section plane" keys="X" pressed={stage.section.enabled}>
          <SectionPanel stage={stage} />
        </PopTool>
      )}
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
  { kinds: ['video'], label: 'Video and flight paths', icon: 'video' },
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

/** Callout labels, layer visibility by kind and point-cloud display. */
export function DisplayTools({ stage, map }: { stage: EngineStage | null; map: boolean }) {
  const labelMode = useShell((s) => s.labelMode);
  const hasClouds = useWorkspace((s) =>
    (s.project?.manifest.layers ?? []).some((l) => l.kind === 'pointcloud'),
  );
  return (
    <>
      {!map && (
        <PopTool icon="tag" label="Labels" keys="L" pressed={labelMode !== 'off'} disabled={!stage}>
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
              {LABEL_MODES.find((m) => m.mode === labelMode)?.hint}. Issue pins always show.
            </p>
          </div>
        </PopTool>
      )}
      <PopTool icon="layers" label="Layers">
        <div className="pop-form">
          {KINDS.map((k) => (
            <KindRow key={k.label} {...k} />
          ))}
        </div>
      </PopTool>
      {!map && hasClouds && (
        <PopTool icon="point" label="Point cloud display" wide>
          <PointCloudControls className="pop-form" />
        </PopTool>
      )}
    </>
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
  const inside = useCutawayState((s) => s.inside);
  const engaged = useCutawayState((s) => s.engaged);
  const showVideo = activeClip !== null && !videoHidden;
  const mode = stage && activeClip ? videoRig(stage).cameraMode : 'free';
  const [, bump] = useReducer((n: number) => n + 1, 0);
  return (
    <>
      <Tool
        icon="video"
        label={showVideo ? 'Hide the video window' : 'Show the video window'}
        keys="W"
        pressed={showVideo}
        disabled={activeClip === null}
        onClick={() => {
          shell.getState().setVideoHidden(!videoHidden);
        }}
      />
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
        <Tool
          icon="cutaway"
          label={
            inside
              ? 'Inside view: cut the asset open at the drone'
              : 'Inside view (drone is outside)'
          }
          keys="C"
          pressed={engaged}
          disabled={!stage || !inside}
          onClick={() => {
            if (!stage) return;
            if (engaged) stopCutaway();
            else {
              if (videoRig(stage).cameraMode === 'drone') setCameraMode(stage, 'free');
              insideView(stage);
            }
            stage.requestRender();
            bump();
          }}
        />
      )}
    </>
  );
}

/* ----------------------------------------------------------------------- annotate */

export function AnnotateToggle() {
  const on = useShell((s) => s.annotating);
  return (
    <Tool
      icon="anno"
      label={on ? 'Close the annotation tools' : 'Annotate: pins, lines, areas, cloud regions'}
      keys="A"
      pressed={on}
      onClick={() => {
        shell.getState().setAnnotating(!on);
      }}
    />
  );
}
