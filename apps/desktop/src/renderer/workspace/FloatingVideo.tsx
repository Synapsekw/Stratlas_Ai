import { VideoAnnotator } from '@aio/annotate';
import { getActiveStage } from '@aio/engine';
import { Button, Icon, matchShortcut, SplitHandle, useResizableSplit, useT } from '@aio/ui';
import { VideoWindow } from '@aio/video';
import { useWorkspace } from '@aio/workspace';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { FocusZone } from '../FocusZone';
import { SameViewButton } from './FramesPane';
import { shell } from '../shell';
import { cornersOf, type Corner } from './overlaySlots';
import { DateBadge } from './DatesOnScreen';
import { stagePrefs, useStagePrefs } from './stagePrefs';
import {
  clampVideoRect,
  defaultVideoRect,
  moveVideoRect,
  RESIZE_HANDLES,
  resizeVideoRect,
  sameVideoRect,
  videoHeight,
  type ResizeHandle,
  type StageSize,
  type VideoRect,
} from './videoWindow';

interface Props {
  layerId: string;
  docked: boolean;
  stageRef: RefObject<HTMLDivElement | null>;
  /** Floating, the stage corners it takes as it rests (the overlays keep out of them, D30). */
  onCorners?: (corners: readonly Corner[]) => void;
  /** Docked, where it sits and whether the stage has room beside the views. */
  dock?: DockPlace;
}

interface DockPlace {
  side: VideoDockSide;
  sideFits: boolean;
}

/** The docked video's split (D30): its size is kept on this computer under this id. */
export const VIDEO_DOCK_ID = 'scene.video';

export type VideoDockSide = 'side' | 'bottom';

/**
 * The dock beside the views or under them, as a share of the stage. Beside, the views keep 360 px
 * (Volumes or Changes in front at 1100 px wide).
 */
const DOCK = {
  side: { orientation: 'horizontal', defaultSize: 0.36, min: 280, max: '60%', otherMin: 360 },
  bottom: { orientation: 'vertical', defaultSize: 0.4, min: 180, max: '70%', otherMin: 200 },
} as const;

/** The narrowest stage with room for the dock beside the views; narrower, it docks under them. */
export const DOCK_SIDE_MIN = DOCK.side.min + DOCK.side.otherMin;

/** Where the docked video sits for the open project (absent: beside the views). */
function useVideoDockSide(): VideoDockSide {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const side = useStagePrefs((s) => (projectId ? s.byProject[projectId]?.videoDock : undefined));
  return side ?? 'side';
}

/**
 * The stage's views, and the docked video beside or under them with a divider between (D30):
 * drag it, or use the arrow keys on it, to share the stage; double-click it to reset. The views
 * stay mounted as the video docks and floats again (the 3D view and the map keep their canvas).
 */
export function VideoDock({
  video,
  children,
}: {
  /** The clip to dock; null: the views take the whole stage. */
  video: { layerId: string; stageRef: RefObject<HTMLDivElement | null> } | null;
  children: ReactNode;
}) {
  const t = useT();
  const wanted = useVideoDockSide();
  // the stage's width: too narrow for the views and the dock side by side, it docks under them
  const [width, setWidth] = useState<number | null>(null);
  const sideFits = width === null || width >= DOCK_SIDE_MIN;
  const side: VideoDockSide = wanted === 'side' && sideFits ? 'side' : 'bottom';
  const dock = DOCK[side];
  const { containerRef, separatorProps } = useResizableSplit({
    id: VIDEO_DOCK_ID,
    orientation: dock.orientation,
    sized: 'end',
    unit: 'fraction',
    defaultSize: dock.defaultSize,
    min: dock.min,
    max: dock.max,
    otherMin: dock.otherMin,
  });
  // Beside the views, the dock's width goes on the stage as --vdock-w: the stage's
  // own controls at its end edge (the right panel's toggle) stand left of it.
  const pane = useRef<HTMLDivElement>(null);
  const besides = video !== null && side === 'side';
  useLayoutEffect(() => {
    const stage = containerRef.current?.parentElement;
    const el = pane.current;
    if (!stage || !el || !besides) return;
    const read = () => {
      stage.style.setProperty('--vdock-w', `${String(Math.round(el.offsetWidth))}px`);
    };
    read();
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    watch?.observe(el);
    return () => {
      watch?.disconnect();
      stage.style.removeProperty('--vdock-w');
    };
  }, [besides, containerRef]);
  const docking = video !== null;
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !docking) return;
    const read = () => {
      setWidth(el.getBoundingClientRect().width);
    };
    read();
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    watch?.observe(el);
    return () => {
      watch?.disconnect();
    };
  }, [docking, containerRef]);
  return (
    <div
      ref={containerRef}
      className={video ? 'stage-body split' : 'stage-body'}
      data-dock={video ? side : undefined}
    >
      <div className="stage-views">{children}</div>
      {video && <SplitHandle separatorProps={separatorProps} label={t('stage.video.resizeDock')} />}
      {video && (
        <div ref={pane} className="split-pane stage-dock" id={separatorProps['aria-controls']}>
          <FloatingVideo
            layerId={video.layerId}
            docked
            stageRef={video.stageRef}
            dock={{ side, sideFits }}
          />
        </div>
      )}
    </div>
  );
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
 * title to put it back. Place and size are remembered per project. Docked, it fills its side of
 * the `VideoDock` split, beside or under the views.
 */
export function FloatingVideo({ layerId, docked, stageRef, onCorners, dock }: Props) {
  const t = useT();
  const layer = useWorkspace((s) => s.project?.manifest.layers.find((l) => l.id === layerId));
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const saved = useStagePrefs((s) => (projectId ? s.byProject[projectId]?.video : undefined));
  const [stage, setStage] = useState<StageSize | null>(null);
  /** How much of the stage's end edge the drawer covers (--drawer-inline, Drawer.tsx). */
  const [cover, setCover] = useState(0);
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
    const readCover = () => {
      setCover(Number.parseFloat(el.style.getPropertyValue('--drawer-inline')) || 0);
    };
    read();
    readCover();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    // the drawer writes its cover on the stage's style as it opens and closes
    const mo = new MutationObserver(readCover);
    mo.observe(el, { attributes: true, attributeFilter: ['style'] });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [docked, stageRef]);

  const want = live ?? saved ?? defaultVideoRect(stage);
  const rect = stage ? clampVideoRect(want, stage) : want;

  // The corners it takes as it rests (not while it is dragged): the corner overlays keep out. The
  // corners are those of the stage the drawer leaves uncovered, where the overlays stand.
  const resting = stage ? clampVideoRect(saved ?? defaultVideoRect(stage), stage) : null;
  const corners =
    docked || !stage || !resting
      ? ''
      : cornersOf(
          {
            left: resting.left,
            top: stage.height - resting.bottom - videoHeight(resting.width),
            width: resting.width,
            height: videoHeight(resting.width),
          },
          { width: Math.max(0, stage.width - cover), height: stage.height },
          document.documentElement.dir === 'rtl',
        ).join(' ');
  useEffect(() => {
    onCorners?.(corners ? (corners.split(' ') as Corner[]) : []);
  }, [corners, onCorners]);
  useEffect(
    () => () => {
      onCorners?.([]);
    },
    [onCorners],
  );

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
          <DateBadge layerId={layer.id} />
          <span className="mono">{meta}</span>
          <div className="acts">
            <SameViewButton source={{ kind: 'video', layer: layerId }} />
            {dock && (
              <Button
                variant="icon"
                size="sm"
                aria-label={
                  dock.side === 'side' ? t('stage.video.dockBottom') : t('stage.video.dockSide')
                }
                tip={dock.side === 'side' ? t('stage.video.dockBottom') : t('stage.video.dockSide')}
                disabledReason={
                  dock.side === 'bottom' && !dock.sideFits
                    ? t('stage.video.dockSideNarrow')
                    : undefined
                }
                onClick={() => {
                  if (projectId)
                    stagePrefs
                      .getState()
                      .update(projectId, { videoDock: dock.side === 'side' ? 'bottom' : 'side' });
                }}
              >
                <Icon name="split" size={14} className={dock.side === 'side' ? 'rot90' : ''} />
              </Button>
            )}
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
