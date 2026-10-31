import { VideoAnnotator } from '@aio/annotate';
import { getActiveStage } from '@aio/engine';
import { Icon, IconButton, matchShortcut, Tip, useT } from '@aio/ui';
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
import { useStore } from 'zustand';
import { FocusZone } from '../FocusZone';
import { SameViewButton } from './FramesPane';
import { cornersOf, type Corner } from './overlaySlots';
import { DateBadge } from './DatesOnScreen';
import { videoDock } from './video/videoDockStore';
import {
  clampVideoRect,
  defaultVideoRect,
  moveVideoRect,
  RESIZE_HANDLES,
  resizeVideoRect,
  sameVideoRect,
  VIDEO_MARGIN,
  videoHeight,
  type ResizeHandle,
  type StageSize,
  type VideoRect,
} from './videoWindow';

interface Props {
  layerId: string;
  stageRef: RefObject<HTMLDivElement | null>;
  /** The stage corners it takes as it rests (the overlays keep out of them, D30). */
  onCorners?: (corners: readonly Corner[]) => void;
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
 * The popped-out video (D4): a window over the stage. Drag the title bar to move it, pull an edge
 * or corner to resize it (the frame keeps its aspect ratio, 320 x 180 up to 80 % of the stage),
 * double-click the title to put it back at its first place, top left under the island. Pop in
 * returns it to the tile in the bottom strip. Place and size are remembered for this user.
 */
export function FloatingVideo({ layerId, stageRef, onCorners }: Props) {
  const t = useT();
  const layer = useWorkspace((s) => s.project?.manifest.layers.find((l) => l.id === layerId));
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const saved = useStore(videoDock, (s) => s.rect) ?? undefined;
  const [stage, setStage] = useState<StageSize | null>(null);
  /** How much of the stage's end edge the drawer covers (--drawer-inline, Drawer.tsx). */
  const [cover, setCover] = useState(0);
  /** The rect while a drag or resize runs; saved when it ends. */
  const [live, setLive] = useState<VideoRect | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const header = useRef<HTMLDivElement>(null);
  // popped out by a click: focus goes to the title bar, where the arrow keys move the window
  const ready = layer?.kind === 'video';
  useEffect(() => {
    if (!ready || videoDock.getState().focus !== 'header') return;
    videoDock.getState().takeFocus();
    header.current?.focus();
  }, [ready]);

  // Follow the stage size (sidebar, right panel, window resize) to keep the window inside it.
  // A passive effect: the stage's ref is attached after this child's layout effects run.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    // the island's reach: opened, it may reach lower than the room kept for it, and the window
    // never covers it (D4)
    const island = () => el.querySelector<HTMLElement>('.island');
    const read = () => {
      const isl = island()?.getBoundingClientRect();
      const top = isl
        ? Math.ceil(isl.bottom - el.getBoundingClientRect().top + VIDEO_MARGIN)
        : undefined;
      setStage((prev) =>
        prev?.width === el.clientWidth && prev.height === el.clientHeight && prev.top === top
          ? prev
          : {
              width: el.clientWidth,
              height: el.clientHeight,
              ...(top === undefined ? {} : { top }),
            },
      );
    };
    const readCover = () => {
      setCover(Number.parseFloat(el.style.getPropertyValue('--drawer-inline')) || 0);
    };
    read();
    readCover();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    const isl = island();
    if (isl) ro.observe(isl);
    // the drawer writes its cover on the stage's style as it opens and closes
    const mo = new MutationObserver(readCover);
    mo.observe(el, { attributes: true, attributeFilter: ['style'] });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [stageRef]);

  const want = live ?? saved ?? defaultVideoRect(stage);
  const rect = stage ? clampVideoRect(want, stage) : want;

  // The corners it takes as it rests (not while it is dragged): the corner overlays keep out. The
  // corners are those of the stage the drawer leaves uncovered, where the overlays stand: the
  // drawer covers the end edge, the physical left right to left.
  const resting = stage ? clampVideoRect(saved ?? defaultVideoRect(stage), stage) : null;
  const rtl = document.documentElement.dir === 'rtl';
  const corners =
    !stage || !resting
      ? ''
      : cornersOf(
          {
            left: rtl ? resting.left - cover : resting.left,
            top: stage.height - resting.bottom - videoHeight(resting.width),
            width: resting.width,
            height: videoHeight(resting.width),
          },
          { width: Math.max(0, stage.width - cover), height: stage.height },
          rtl,
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
  }, [rect.left, rect.bottom, rect.width]);

  const save = (r: VideoRect | null) => {
    if (r === null || !sameVideoRect(r, saved)) videoDock.getState().setRect(r);
  };

  const begin = (e: ReactPointerEvent<HTMLElement>, handle: ResizeHandle | null) => {
    if (e.button !== 0 || !stage) return;
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
    if (!stage || e.target !== e.currentTarget) return;
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
      className={`vwin${live ? ' moving' : ''}`}
      style={{ left: rect.left, bottom: rect.bottom, width: rect.width }}
      aria-label={t('stage.video.window', { name: layer.name })}
      data-testid="video-window"
    >
      <div className="vwin-in" dir="ltr">
        <div
          ref={header}
          className="vh"
          onPointerDown={(e) => {
            begin(e, null);
          }}
          onPointerMove={track}
          onPointerUp={end}
          onPointerCancel={end}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            save(null);
          }}
          onKeyDown={onKey}
          tabIndex={0}
          role="group"
          aria-label={t('stage.video.titleBar')}
          aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown + - Home"
          title={t('stage.video.moveHint')}
          data-testid="video-header"
        >
          <Icon name="video" size={14} className="muted" />
          {/* the full name on a tip: a narrow header has little room for it */}
          <Tip content={layer.name}>
            <b>{layer.name}</b>
          </Tip>
          <DateBadge layerId={layer.id} />
          <span className="mono">{meta}</span>
          <div className="acts">
            <SameViewButton source={{ kind: 'video', layer: layerId }} />
            <IconButton
              icon="split"
              size="sm"
              label={t('stage.video.popIn')}
              data-testid="video-popin"
              onClick={() => {
                if (projectId) videoDock.getState().popIn(projectId);
              }}
            />
            <IconButton
              icon="x"
              size="sm"
              label={t('stage.video.close')}
              onClick={() => {
                if (projectId) videoDock.getState().close(projectId);
              }}
            />
          </div>
        </div>
        <div className="vframe">
          <VideoWindow layerId={layerId} className="scene-fill">
            <VideoAnnotator key={layerId} layerId={layerId} />
          </VideoWindow>
        </div>
      </div>
      {RESIZE_HANDLES.map((h) => (
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
