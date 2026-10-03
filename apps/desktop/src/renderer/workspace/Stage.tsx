import { getActiveScene, onActiveScene, SceneView } from '@aio/engine';
import { MapView } from '@aio/maps';
import type { Layer } from '@aio/schema';
import {
  Compass,
  crsLabel,
  formatEastNorth,
  headingDeg,
  Icon,
  localToProject,
  type IconName,
} from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { FocusZone } from '../FocusZone';
import { shell, useShell } from '../shell';
import type { StageMode } from '../store';
import { FloatingVideo } from './FloatingVideo';

const MODES: { mode: StageMode; label: string; icon: IconName }[] = [
  { mode: '3d', label: '3D', icon: 'scene' },
  { mode: 'map', label: 'Map', icon: 'map' },
  { mode: 'split', label: 'Split', icon: 'split' },
];

const KIND_TOGGLES: { kinds: Layer['kind'][]; label: string; icon: IconName }[] = [
  { kinds: ['mesh', 'legacy'], label: 'Models', icon: 'scene' },
  { kinds: ['pointcloud'], label: 'Point clouds', icon: 'cloud' },
  { kinds: ['raster', 'basemap'], label: 'Maps and rasters', icon: 'raster' },
  { kinds: ['video'], label: 'Video projection and flight paths', icon: 'video' },
];

/** Heading of the live 3D camera, updated when it changes by more than half a degree. */
function useSceneHeading(): number | null {
  const [heading, setHeading] = useState<number | null>(null);
  useEffect(() => {
    let offFrame: (() => void) | null = null;
    let last = Number.NaN;
    const attach = (h: ReturnType<typeof getActiveScene>) => {
      offFrame?.();
      offFrame = null;
      if (!h) {
        setHeading(null);
        return;
      }
      const read = () => {
        const e = h.camera.matrixWorld.elements;
        // The camera looks down its local -Z; column 2 of the world matrix is local +Z.
        const deg = headingDeg(-e[8], -e[10]);
        if (!(Math.abs(deg - last) < 0.5)) {
          last = deg;
          setHeading(deg);
        }
      };
      read();
      offFrame = h.onFrame(read);
    };
    attach(getActiveScene());
    const off = onActiveScene(attach);
    return () => {
      off();
      offFrame?.();
    };
  }, []);
  return heading;
}

function CursorReadout({ text }: { text: string | null }) {
  const crs = useWorkspace((s) => (s.project ? crsLabel(s.project.manifest.crs) : ''));
  return (
    <div className="cursor-ro" aria-live="off">
      {crs}
      <br />
      {text ?? 'Point at the scene for coordinates'}
    </div>
  );
}

function ScenePane({ hidden }: { hidden: boolean }) {
  const heading = useSceneHeading();
  const [cursor, setCursor] = useState<string | null>(null);
  const pending = useRef<{ x: number; y: number } | null>(null);
  const raf = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    },
    [],
  );

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    pending.current = {
      x: ((e.clientX - r.left) / r.width) * 2 - 1,
      y: -(((e.clientY - r.top) / r.height) * 2 - 1),
    };
    if (raf.current !== null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      const p = pending.current;
      const h = getActiveScene();
      const project = workspace.getState().project;
      if (!p || !h || !project) return;
      const hit = h.raycast(p.x, p.y);
      if (!hit) {
        setCursor(null);
        return;
      }
      const [e2, n, el] = localToProject(project.manifest.origin, [
        hit.point.x,
        hit.point.y,
        hit.point.z,
      ]);
      setCursor(`${formatEastNorth(e2, n)} · EL ${el.toFixed(1)} m`);
    });
  };

  return (
    <FocusZone
      kind="scene3d"
      className={`pane pane-3d${hidden ? ' is-hidden' : ''}`}
      onPointerMove={onMove}
      onPointerLeave={() => {
        setCursor(null);
      }}
      aria-hidden={hidden}
    >
      <SceneView className="fill" />
      {heading !== null && <Compass headingDeg={heading} className="stage-compass" />}
      <CursorReadout text={cursor} />
    </FocusZone>
  );
}

function KindToggle({ kinds, label, icon }: (typeof KIND_TOGGLES)[number]) {
  const ids = useWorkspace((s) =>
    (s.project?.manifest.layers ?? [])
      .filter((l) => kinds.includes(l.kind))
      .map((l) => l.id)
      .join('|'),
  );
  const anyVisible = useWorkspace((s) => ids.split('|').some((id) => id && !s.hidden[id]));
  if (!ids) return null;
  return (
    <button
      type="button"
      className="tool"
      aria-pressed={anyVisible}
      aria-label={`${anyVisible ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
      onClick={() => {
        for (const id of ids.split('|')) workspace.getState().setLayerVisible(id, !anyVisible);
      }}
    >
      <Icon name={icon} />
      <span className="tip">{label}</span>
    </button>
  );
}

export function Stage() {
  const mode = useShell((s) => s.stageMode);
  const docked = useShell((s) => s.videoDocked);
  const videoHidden = useShell((s) => s.videoHidden);
  const rightCollapsed = useShell((s) => s.rightCollapsed);
  const activeClip = useWorkspace((s) => s.activeClip);
  const selection = useWorkspace((s) => s.selection);
  const stageRef = useRef<HTMLDivElement>(null);
  const showVideo = activeClip !== null && !videoHidden;

  return (
    <div className={`stage${docked && showVideo ? ' docked' : ''}`} ref={stageRef} data-mode={mode}>
      <div className={`stage-panes${docked && showVideo ? ' with-video' : ''}`} data-mode={mode}>
        <ScenePane hidden={mode === 'map'} />
        {mode !== '3d' && (
          <FocusZone kind="map" className="pane pane-map">
            <MapView className="fill" />
          </FocusZone>
        )}
        {docked && showVideo && <FloatingVideo layerId={activeClip} docked stageRef={stageRef} />}
      </div>
      <div className="stbar">
        <div className="seg overlay-seg" role="group" aria-label="View">
          {MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              aria-pressed={mode === m.mode}
              onClick={() => {
                shell.getState().setStageMode(m.mode);
              }}
            >
              <Icon name={m.icon} size={14} />
              {m.label}
            </button>
          ))}
        </div>
        <div className="tgroup-h overlay-box">
          <button
            type="button"
            className="tool"
            aria-label="Fly to the whole site"
            onClick={() => {
              workspace.getState().flyTo({ kind: 'home' });
            }}
          >
            <Icon name="target" />
            <span className="tip">Whole site</span>
          </button>
          <button
            type="button"
            className="tool"
            aria-label="Fly to the selection"
            disabled={!selection}
            onClick={() => {
              if (selection) workspace.getState().flyTo({ kind: 'selection', selection });
            }}
          >
            <Icon name="follow" />
            <span className="tip">Fly to selection</span>
          </button>
        </div>
        <div className="tgroup-h overlay-box">
          {KIND_TOGGLES.map((k) => (
            <KindToggle key={k.label} {...k} />
          ))}
        </div>
        <div className="tgroup-h overlay-box">
          <button
            type="button"
            className="tool"
            aria-pressed={showVideo}
            disabled={activeClip === null}
            aria-label={showVideo ? 'Hide the video window' : 'Show the video window'}
            onClick={() => {
              shell.getState().setVideoHidden(!videoHidden);
            }}
          >
            <Icon name="droneeye" />
            <span className="tip">Video window</span>
          </button>
        </div>
        <span className="stbar-sp" />
        <div className="tgroup-h overlay-box">
          <button
            type="button"
            className="tool"
            aria-pressed={!rightCollapsed}
            aria-label={rightCollapsed ? 'Show the right panel' : 'Hide the right panel'}
            aria-keyshortcuts="Control+Alt+B"
            onClick={shell.getState().toggleRight}
          >
            <Icon name="sidebar" className="flip" />
            <span className="tip tip-end">
              Right panel <span className="kbd">Ctrl Alt B</span>
            </span>
          </button>
        </div>
      </div>
      {!docked && showVideo && (
        <FloatingVideo layerId={activeClip} docked={false} stageRef={stageRef} />
      )}
    </div>
  );
}
