import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { homographyCss, type Homography } from './pairing';

/**
 * Two frames of two survey dates (M8 C4): side by side, or stacked with a swipe or a blend. The
 * later date can be drawn through a homography (the pose difference over the ground plane) so the
 * ground lines up with the earlier frame. Presentational: the caller gives both frames and the
 * text, and keeps the mode and amount.
 */

export type FramesMode = 'side' | 'swipe' | 'blend';

export interface FramesCompareLabels {
  /** Date of each side ("1 Jan 2026"). */
  a: string;
  b: string;
  /** Name of the swipe handle for assistive technology. */
  handle: string;
  /** Shown where the other date has no frame. */
  empty: string;
}

export interface FramesCompareProps {
  /** The frame of the first date (fills its box). */
  a: ReactNode;
  /** The matching frame of the other date, or null when there is none. */
  b: ReactNode | null;
  mode: FramesMode;
  /** Swipe position or blend amount, 0 to 1. */
  amount: number;
  onAmount: (amount: number) => void;
  /** Width over height of the frames (stacked modes keep it so the warp lines up). */
  aspect: number;
  /** Draws `b` in the frame of `a` (normalised image coordinates of b to a). */
  warp?: Homography | null;
  labels: FramesCompareLabels;
  className?: string;
}

const STEP = 0.05;

/** Clamp to 0 to 1. */
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0.5);

/** The swipe position under a pointer over a box. */
export function swipeAt(clientX: number, box: { left: number; width: number }): number {
  return box.width > 0 ? clamp01((clientX - box.left) / box.width) : 0.5;
}

/** A key on the swipe handle: arrows step 5%, Home and End go to the edges; null for other keys. */
export function swipeKey(key: string, amount: number, big = false): number | null {
  const step = big ? STEP * 4 : STEP;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp01(amount - step);
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp01(amount + step);
    case 'Home':
      return 0;
    case 'End':
      return 1;
    default:
      return null;
  }
}

const fill: CSSProperties = { position: 'absolute', inset: 0 };
const chip: CSSProperties = {
  position: 'absolute',
  top: 6,
  padding: '2px 7px',
  borderRadius: 4,
  background: 'rgba(8,14,24,.66)',
  color: '#e8eef7',
  font: '11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
};
const emptyText: CSSProperties = {
  ...fill,
  display: 'grid',
  placeItems: 'center',
  color: '#aab4c3',
  fontSize: 12,
  padding: 12,
  textAlign: 'center',
};

/** The size of an element, followed. */
function useSize(): [RefObject<HTMLDivElement | null>, { w: number; h: number }] {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const read = () => {
      setSize((s) =>
        s.w === el.clientWidth && s.h === el.clientHeight
          ? s
          : { w: el.clientWidth, h: el.clientHeight },
      );
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);
  return [ref, size];
}

export function FramesCompare({
  a,
  b,
  mode,
  amount,
  onAmount,
  aspect,
  warp,
  labels,
  className,
}: FramesCompareProps) {
  const [boxRef, size] = useSize();
  const dragging = useRef<number | null>(null);
  const v = clamp01(amount);

  if (mode === 'side') {
    return (
      <div
        className={className}
        data-testid="frames-compare"
        data-mode="side"
        style={{ display: 'flex', gap: 2, width: '100%', height: '100%', background: '#05080d' }}
      >
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }} data-testid="frames-a">
          {a}
          <span style={{ ...chip, left: 6 }}>{labels.a}</span>
        </div>
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }} data-testid="frames-b">
          {b ?? <div style={emptyText}>{labels.empty}</div>}
          <span style={{ ...chip, left: 6 }}>{labels.b}</span>
        </div>
      </div>
    );
  }

  const warpCss = warp && size.w > 0 && size.h > 0 ? homographyCss(warp, size.w, size.h) : null;
  const top: CSSProperties = {
    ...fill,
    ...(warpCss ? { transform: warpCss, transformOrigin: '0 0' } : {}),
  };
  const shown: CSSProperties =
    mode === 'swipe'
      ? { ...fill, clipPath: `inset(0 0 0 ${String(v * 100)}%)` }
      : { ...fill, opacity: v };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (mode !== 'swipe' || e.button !== 0) return;
    dragging.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    onAmount(swipeAt(e.clientX, e.currentTarget.getBoundingClientRect()));
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current !== e.pointerId) return;
    onAmount(swipeAt(e.clientX, e.currentTarget.getBoundingClientRect()));
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current === e.pointerId) dragging.current = null;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = swipeKey(e.key, v, e.shiftKey);
    if (next === null) return;
    e.preventDefault();
    onAmount(next);
  };

  return (
    <div
      className={className}
      data-testid="frames-compare"
      data-mode={mode}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'grid',
        placeItems: 'center',
        background: '#05080d',
        overflow: 'hidden',
      }}
    >
      <div
        ref={boxRef}
        data-testid="frames-stack"
        data-warped={warpCss ? '' : undefined}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        style={{
          position: 'relative',
          aspectRatio: String(aspect > 0 ? aspect : 16 / 9),
          maxWidth: '100%',
          maxHeight: '100%',
          width: '100%',
          overflow: 'hidden',
          cursor: mode === 'swipe' ? 'ew-resize' : undefined,
          touchAction: 'none',
        }}
      >
        <div style={fill} data-testid="frames-a">
          {a}
        </div>
        <div style={shown} data-testid="frames-b">
          <div style={top}>{b ?? <div style={emptyText}>{labels.empty}</div>}</div>
        </div>
        <span style={{ ...chip, left: 6 }}>{labels.a}</span>
        <span style={{ ...chip, right: 6 }}>{labels.b}</span>
        {mode === 'swipe' && (
          <div
            role="slider"
            tabIndex={0}
            aria-label={labels.handle}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(v * 100)}
            aria-orientation="horizontal"
            data-testid="frames-swipe"
            onKeyDown={onKey}
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${String(v * 100)}%`,
              width: 2,
              marginLeft: -1,
              background: '#e8eef7',
              boxShadow: '0 0 0 1px rgba(0,0,0,.5)',
            }}
          />
        )}
      </div>
    </div>
  );
}

export interface FrameImageProps {
  /** Image or video URL. */
  src: string;
  kind: 'photo' | 'video';
  /** Video second to show (paused). */
  t?: number;
  /** Text when the footage cannot be shown. */
  missing: string;
  alt?: string;
}

/**
 * One frame, filling its box: a photo, or a paused video seeked to `t` (exact-frame decode, not
 * playback, so two clips never play at once).
 */
export function FrameImage({ src, kind, t, missing, alt }: FrameImageProps) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const video = useRef<HTMLVideoElement>(null);
  const seeking = useRef(false);
  const want = useRef<number | undefined>(t);

  useEffect(() => {
    queueMicrotask(() => {
      setState('loading');
    });
  }, [src]);

  // seek to the latest wanted time; a seek in flight finishes first
  const seek = () => {
    const el = video.current;
    const target = want.current;
    if (!el || target === undefined || el.readyState < 1 || seeking.current) return;
    const d = Number.isFinite(el.duration) ? el.duration : target;
    const to = Math.min(Math.max(0, target), Math.max(0, d - 0.001));
    if (Math.abs(el.currentTime - to) < 0.5 / 120) return;
    seeking.current = true;
    el.currentTime = to;
  };

  useEffect(() => {
    want.current = t;
    seek();
  }, [t]);

  const style: CSSProperties = { ...fill, width: '100%', height: '100%', objectFit: 'fill' };
  if (state === 'error')
    return (
      <div style={emptyText} data-testid="frame-missing">
        {missing}
      </div>
    );
  if (kind === 'photo')
    return (
      <img
        src={src}
        alt={alt ?? ''}
        draggable={false}
        style={style}
        data-state={state}
        onLoad={() => {
          setState('ready');
        }}
        onError={() => {
          setState('error');
        }}
      />
    );
  return (
    <video
      ref={video}
      src={src}
      muted
      playsInline
      preload="auto"
      crossOrigin="anonymous"
      disablePictureInPicture
      style={style}
      data-state={state}
      data-t={t}
      onLoadedMetadata={seek}
      onSeeked={() => {
        seeking.current = false;
        setState('ready');
        seek();
      }}
      onLoadedData={() => {
        if (t === undefined || t === 0) setState('ready');
      }}
      onError={() => {
        setState('error');
      }}
    />
  );
}
