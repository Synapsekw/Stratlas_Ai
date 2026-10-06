import { VideoAnnotator } from '@aio/annotate';
import { getActiveStage } from '@aio/engine';
import { Icon, matchShortcut, useT } from '@aio/ui';
import { VideoWindow } from '@aio/video';
import { useWorkspace } from '@aio/workspace';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { FocusZone } from '../FocusZone';
import { SameViewButton } from './FramesPane';
import { shell } from '../shell';
import { stagePrefs, useStagePrefs } from './stagePrefs';
import {
  clampVideoRect,
  defaultVideoRect,
  moveVideoRect,
  RESIZE_HANDLES,
  resizeVideoRect,
  sameVideoRect,
  type ResizeHandle,
  type StageSize,
  type VideoRect,
} from './videoWindow';

interface Props {
  layerId: string;
  docked: boolean;
  stageRef: RefObject<HTMLDivElement | null>;
}

/** Arrow key steps: a nudge, or a stride with Shift. */
const STEP = 10;
const STRIDE = 50;

interface Gesture {
  pointer: number;
  x: number;
  y: number;
  start: VideoRect;
  /** null: moving by the title bar. */
  handle: ResizeHandle | null;
}

/**
 * Picture-in-picture video for the active clip. Drag the title bar to move it anywhere over the
 * stage, pull an edge or corner to resize it (the frame keeps its aspect ratio), double-click the
 * title to put it back. Place and size are remembered per project. Docks to the side of the stage.
 */
export function FloatingVideo({ layerId, docked, stageRef }: Props) {
  const t = useT();
  const layer = useWorkspace((s) => s.project?.manifest.layers.find((l) => l.id === layerId));
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const saved = useStagePrefs((s) => (projectId ? s.byProject[projectId]?.video : undefined));
  const [stage, setStage] = useState<StageSize | null>(null);
  /** The rect while a drag or resize runs; saved when it ends. */
  const [live, setLive] = useState<VideoRect | null>(null);
  const gesture = useRef<Gesture | null>(null);

  // Follow the stage size (sidebar, right panel, window resize) to keep the window inside it.
  // A passive effect: the stage's ref is attached after this child's layout effects run.
  useEffect(() => {
    const el = stageRef.current;
    if (docked || !el) return;
    const read = () => {
      setStage((prev) =>
        prev?.width === el.clientWidth && prev.height === el.clientHeight
          ? prev
          : { width: el.clientWidth, height: el.clientHeight },
      );
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [docked, stageRef]);

  const want = live ?? saved ?? defaultVideoRect(stage);
  const rect = stage ? clampVideoRect(want, stage) : want;

  // Callouts keep clear of the window (the stage reads its rect as a keep-out area).
  useEffect(() => {
    getActiveStage()?.requestRender();
  }, [rect.left, rect.bottom, rect.width, docked]);

  const save = (r: VideoRect | null) => {
    if (!projectId) return;
    if (r === null) stagePrefs.getState().update(projectId, { video: undefined });
    else if (!sameVideoRect(r, saved)) stagePrefs.getState().update(projectId, { video: r });
  };

  const begin = (e: ReactPointerEvent<HTMLElement>, handle: ResizeHandle | null) => {
    if (docked || e.button !== 0 || !stage) return;
    if (handle === null && (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, start: rect, handle };
  };
  const track = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (g?.pointer !== e.pointerId || !stage) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const next = g.handle
      ? resizeVideoRect(g.start, g.handle, dx, dy, stage)
      : moveVideoRect(g.start, dx, dy, stage);
    setLive((prev) => (sameVideoRect(prev, next) ? prev : next));
  };
  const end = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (g?.pointer !== e.pointerId) return;
    gesture.current = null;
    if (live) save(live);
    setLive(null);
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (docked || !stage || e.target !== e.currentTarget) return;
    const id = matchShortcut('videoWindow', e);
    const d = e.shiftKey ? STRIDE : STEP;
    let next: VideoRect | null = null;
    if (id === 'videoWindow.move' || id === 'videoWindow.moveFar') {
      if (e.key === 'ArrowLeft') next = moveVideoRect(rect, -d, 0, stage);
      else if (e.key === 'ArrowRight') next = moveVideoRect(rect, d, 0, stage);
      else if (e.key === 'ArrowUp') next = moveVideoRect(rect, 0, -d, stage);
      else next = moveVideoRect(rect, 0, d, stage);
    } else if (id === 'videoWindow.grow') next = resizeVideoRect(rect, 'ne', d * 2, 0, stage);
    else if (id === 'videoWindow.shrink') next = resizeVideoRect(rect, 'ne', -d * 2, 0, stage);
    else if (id === 'videoWindow.reset') save(null);
    else return;
    e.preventDefault();
    e.stopPropagation();
    if (next) save(next);
  };

  if (layer?.kind !== 'video') return null;
  const meta = `${layer.lens.model === 'ftheta' ? 'f-theta' : 'pinhole'} ${String(layer.lens.hfovDeg)}°`;

  return (
    <FocusZone
      kind="video"
      className={`vwin${docked ? ' docked' : ''}${live ? ' moving' : ''}`}
      style={docked ? undefined : { left: rect.left, bottom: rect.bottom, width: rect.width }}
      aria-label={t('stage.video.window', { name: layer.name })}
      data-testid="video-window"
    >
      <div className="vwin-in" dir="ltr">
        <div
          className="vh"
          onPointerDown={(e) => {
            begin(e, null);
          }}
          onPointerMove={track}
          onPointerUp={end}
          onPointerCancel={end}
          onDoubleClick={(e) => {
            if (docked || (e.target as HTMLElement).closest('button')) return;
            save(null);
          }}
          onKeyDown={onKey}
          tabIndex={docked ? undefined : 0}
          role={docked ? undefined : 'group'}
          aria-label={docked ? undefined : t('stage.video.titleBar')}
          aria-keyshortcuts={docked ? undefined : 'ArrowLeft ArrowRight ArrowUp ArrowDown + - Home'}
          title={docked ? undefined : t('stage.video.moveHint')}
          data-testid="video-header"
        >
          <Icon name="video" size={14} className="muted" />
          <b>{layer.name}</b>
          <span className="mono">{meta}</span>
          <div className="acts">
            <SameViewButton source={{ kind: 'video', layer: layerId }} />
            <button
              type="button"
              className="btn icon sm ghost"
              title={docked ? t('stage.video.float') : t('stage.video.dock')}
              aria-label={docked ? t('stage.video.floatLabel') : t('stage.video.dockLabel')}
              onClick={() => {
                shell.getState().setVideoDocked(!docked);
              }}
            >
              <Icon name={docked ? 'maximize' : 'split'} size={14} />
            </button>
            <button
              type="button"
              className="btn icon sm ghost"
              title={t('stage.video.hide')}
              aria-label={t('stage.video.hideLabel')}
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
      {!docked &&
        RESIZE_HANDLES.map((h) => (
          <div
            key={h}
            className={`vwin-rs rs-${h}`}
            data-handle={h}
            aria-hidden
            title={t('stage.video.resize')}
            onPointerDown={(e) => {
              begin(e, h);
            }}
            onPointerMove={track}
            onPointerUp={end}
            onPointerCancel={end}
          />
        ))}
    </FocusZone>
  );
}
