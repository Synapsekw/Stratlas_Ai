import { AnnotationToolbar } from '@aio/annotate';
import {
  getActiveStage,
  onActiveScene,
  type EngineStage,
  type SectionState,
  type ViewPreset,
} from '@aio/engine';
import { PointCloudControls } from '@aio/pointcloud';
import { Icon, type IconName } from '@aio/ui';
import { setCameraMode, type CameraMode } from '@aio/video';
import { useWorkspace } from '@aio/workspace';
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

/** The live 3D stage (view presets, tools, section), re-rendering on tool and section changes. */
export function useEngineStage(): EngineStage | null {
  const stage = useSyncExternalStore(onActiveScene, getActiveStage, getActiveStage);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => stage?.onStateChange(bump), [stage]);
  return stage;
}

/** A tool button that opens a panel below it; closes on outside click and Escape. */
function PopTool({
  icon,
  label,
  pressed,
  disabled,
  children,
}: {
  icon: IconName;
  label: string;
  pressed?: boolean;
  disabled?: boolean;
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
        aria-label={label}
        disabled={disabled}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name={icon} />
        {!open && <span className="tip">{label}</span>}
      </button>
      {open && (
        <div className="stage-pop overlay-box" role="dialog" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}

const PRESETS: { preset: ViewPreset; label: string }[] = [
  { preset: 'top', label: 'Top' },
  { preset: 'north', label: 'North' },
  { preset: 'iso', label: 'Iso' },
];

/** North-up top, north elevation and isometric views of the whole site. */
export function ViewPresets({ stage }: { stage: EngineStage | null }) {
  return (
    <div className="seg overlay-seg" role="group" aria-label="View presets">
      {PRESETS.map((p) => (
        <button
          key={p.preset}
          type="button"
          disabled={!stage}
          title={`${p.label} view of the whole site`}
          onClick={() => {
            stage?.setViewPreset(p.preset);
          }}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

/** Compass bearing from the orbit target toward the camera: the half a viewer wants removed. */
function cameraBearing(stage: EngineStage): number {
  const v = stage.camera.position.clone().sub(stage.controls.target);
  return Math.round(((Math.atan2(v.x, -v.z) * 180) / Math.PI + 360) % 360);
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
          onChange={(e) => {
            // Turning the cut on opens the side facing the camera.
            set(
              e.target.checked && s.mode === 'vertical'
                ? { enabled: true, bearingDeg: cameraBearing(stage) }
                : { enabled: e.target.checked },
            );
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

/** Select, measure and section tools of the engine stage, plus point-cloud display. */
export function EngineTools({ stage }: { stage: EngineStage | null }) {
  const hasClouds = useWorkspace((s) =>
    (s.project?.manifest.layers ?? []).some((l) => l.kind === 'pointcloud'),
  );
  const tool = stage?.tool ?? 'select';
  return (
    <div className="tgroup-h overlay-box" role="group" aria-label="3D tools">
      <button
        type="button"
        className="tool"
        aria-pressed={tool === 'select'}
        aria-label="Select"
        disabled={!stage}
        onClick={() => stage?.setTool('select')}
      >
        <Icon name="select" />
        <span className="tip">Select</span>
      </button>
      <button
        type="button"
        className="tool"
        aria-pressed={tool === 'measure'}
        aria-label="Measure a distance"
        disabled={!stage}
        onClick={() => stage?.setTool(tool === 'measure' ? 'select' : 'measure')}
      >
        <Icon name="ruler" />
        <span className="tip">Measure (Esc clears)</span>
      </button>
      {stage && (
        <PopTool icon="section" label="Section plane" pressed={stage.section.enabled}>
          <SectionPanel stage={stage} />
        </PopTool>
      )}
      {hasClouds && (
        <PopTool icon="point" label="Point cloud display">
          <PointCloudControls className="pop-form" />
        </PopTool>
      )}
    </div>
  );
}

const CAMERA_MODES: { mode: CameraMode; label: string; icon: IconName }[] = [
  { mode: 'free', label: 'Free orbit', icon: 'orbit' },
  { mode: 'follow', label: 'Follow the drone', icon: 'follow' },
  { mode: 'drone', label: 'Drone eye (through the camera)', icon: 'droneeye' },
];

/** Free, follow-cam and drone-eye views for the active clip (video rig of @aio/video). */
export function CameraModes({ stage }: { stage: EngineStage | null }) {
  const activeClip = useWorkspace((s) => s.activeClip);
  const [mode, setMode] = useState<CameraMode>('free');
  // A new 3D stage starts in free orbit.
  const [seen, setSeen] = useState(stage);
  if (seen !== stage) {
    setSeen(stage);
    setMode('free');
  }
  return (
    <div className="tgroup-h overlay-box" role="group" aria-label="Camera">
      {CAMERA_MODES.map((m) => (
        <button
          key={m.mode}
          type="button"
          className="tool"
          aria-pressed={mode === m.mode}
          aria-label={m.label}
          disabled={!stage || (m.mode !== 'free' && activeClip === null)}
          onClick={() => {
            if (!stage) return;
            setCameraMode(stage, m.mode);
            setMode(m.mode);
          }}
        >
          <Icon name={m.icon} />
          <span className="tip">{m.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Pins, lines and areas on the mesh, points and boxes on clouds; installs the 3D issue pins. */
export function AnnotateTools() {
  return <AnnotationToolbar className="stage-ann" />;
}
