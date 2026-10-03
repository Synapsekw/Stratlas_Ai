import { VideoAnnotator } from '@aio/annotate';
import { Icon } from '@aio/ui';
import { VideoWindow } from '@aio/video';
import { useWorkspace } from '@aio/workspace';
import {
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { FocusZone } from '../FocusZone';
import { shell } from '../shell';

interface Props {
  layerId: string;
  docked: boolean;
  stageRef: RefObject<HTMLDivElement | null>;
}

const MARGIN = 12;
const DEFAULT_W = 400;

/** Position survives docking and undocking within a session. */
let remembered: { left: number; bottom: number; width: number } | null = null;

/** Picture-in-picture video for the active clip: drag by the header, dock to the side of the stage. */
export function FloatingVideo({ layerId, docked, stageRef }: Props) {
  const layer = useWorkspace((s) => s.project?.manifest.layers.find((l) => l.id === layerId));
  const [pos, setPos] = useState(remembered ?? { left: MARGIN, bottom: MARGIN, width: DEFAULT_W });
  const winRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; bottom: number } | null>(null);

  // Keep the window inside the stage when the stage shrinks (sidebar, right panel, resize).
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (docked || !stage) return;
    const ro = new ResizeObserver(() => {
      const win = winRef.current;
      if (!win) return;
      setPos((prev) => {
        // until the user moves it, the window takes a share of the stage that leaves it usable
        const p = remembered
          ? prev
          : {
              ...prev,
              width: Math.round(Math.min(DEFAULT_W, Math.max(280, stage.clientWidth * 0.42))),
            };
        const maxLeft = Math.max(MARGIN, stage.clientWidth - win.offsetWidth - MARGIN);
        const maxBottom = Math.max(MARGIN, stage.clientHeight - win.offsetHeight - MARGIN);
        const next = {
          ...p,
          left: Math.min(p.left, maxLeft),
          bottom: Math.min(p.bottom, maxBottom),
        };
        return next.left === prev.left && next.bottom === prev.bottom && next.width === prev.width
          ? prev
          : next;
      });
    });
    ro.observe(stage);
    return () => {
      ro.disconnect();
    };
  }, [docked, stageRef]);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (docked || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, left: pos.left, bottom: pos.bottom };
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const stage = stageRef.current;
    const win = winRef.current;
    if (!d || !stage || !win) return;
    const maxLeft = stage.clientWidth - win.offsetWidth - MARGIN;
    const maxBottom = stage.clientHeight - win.offsetHeight - MARGIN;
    const next = {
      width: win.offsetWidth,
      left: Math.round(
        Math.min(Math.max(MARGIN, d.left + e.clientX - d.x), Math.max(MARGIN, maxLeft)),
      ),
      bottom: Math.round(
        Math.min(Math.max(MARGIN, d.bottom - (e.clientY - d.y)), Math.max(MARGIN, maxBottom)),
      ),
    };
    remembered = next;
    setPos(next);
  };
  const onUp = () => {
    drag.current = null;
  };

  if (layer?.kind !== 'video') return null;
  const meta = `${layer.lens.model === 'ftheta' ? 'f-theta' : 'pinhole'} ${String(layer.lens.hfovDeg)}°`;

  return (
    <FocusZone
      kind="video"
      className={`vwin${docked ? ' docked' : ''}`}
      style={docked ? undefined : { left: pos.left, bottom: pos.bottom, width: pos.width }}
      aria-label={`Video ${layer.name}`}
    >
      <div ref={winRef} className="vwin-in">
        <div
          className="vh"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          data-testid="video-header"
        >
          <Icon name="video" size={14} className="muted" />
          <b>{layer.name}</b>
          <span className="mono">{meta}</span>
          <div className="acts">
            <button
              type="button"
              className="btn icon sm ghost"
              title={docked ? 'Float over the stage' : 'Dock beside the stage'}
              aria-label={docked ? 'Float the video window' : 'Dock the video window'}
              onClick={() => {
                shell.getState().setVideoDocked(!docked);
              }}
            >
              <Icon name={docked ? 'maximize' : 'split'} size={14} />
            </button>
            <button
              type="button"
              className="btn icon sm ghost"
              title="Hide video window"
              aria-label="Hide the video window"
              onClick={() => {
                shell.getState().setVideoHidden(true);
              }}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>
        <div className="vframe">
          <VideoWindow layerId={layerId} className="scene-fill">
            <VideoAnnotator key={layerId} layerId={layerId} />
          </VideoWindow>
        </div>
      </div>
    </FocusZone>
  );
}
