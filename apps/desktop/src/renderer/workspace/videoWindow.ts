/**
 * Geometry of the floating video window over the stage: where it sits (from the stage's left and
 * bottom edges, so it stays near the timeline as the stage resizes) and how wide it is. The height
 * follows from the width: the title bar plus a 16:9 frame.
 */
export interface VideoRect {
  left: number;
  bottom: number;
  width: number;
}

export interface StageSize {
  width: number;
  height: number;
}

/** Edge or corner a resize starts from (compass directions, physical, not mirrored in RTL). */
export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const RESIZE_HANDLES: readonly ResizeHandle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** Gap kept between the window and the stage edges. */
export const VIDEO_MARGIN = 12;
/** Gap kept below the stage top: the toolbar row stays clear, so the title bar can be grabbed. */
export const VIDEO_TOP = 56;
/** Title bar and borders above and around the frame. */
export const VIDEO_CHROME = 32;
export const VIDEO_ASPECT = 16 / 9;
export const VIDEO_MIN_W = 240;
export const VIDEO_MAX_W = 1280;

export function videoHeight(width: number): number {
  return Math.round(VIDEO_CHROME + width / VIDEO_ASPECT);
}

/** The widest window that fits the stage with its margins (never below the minimum). */
export function maxVideoWidth(stage: StageSize): number {
  const byW = stage.width - 2 * VIDEO_MARGIN;
  const byH = (stage.height - VIDEO_MARGIN - VIDEO_TOP - VIDEO_CHROME) * VIDEO_ASPECT;
  return Math.max(VIDEO_MIN_W, Math.floor(Math.min(VIDEO_MAX_W, byW, byH)));
}

/** Until the person moves it, the window takes a share of the stage that leaves the stage usable. */
export function defaultVideoRect(stage: StageSize | null): VideoRect {
  const width = stage ? Math.round(Math.min(400, Math.max(280, stage.width * 0.42))) : 400;
  return { left: VIDEO_MARGIN, bottom: VIDEO_MARGIN, width };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** The window kept inside the stage: width within the limits, position within the margins. */
export function clampVideoRect(r: VideoRect, stage: StageSize): VideoRect {
  const width = Math.round(clamp(r.width, VIDEO_MIN_W, maxVideoWidth(stage)));
  const h = videoHeight(width);
  return {
    width,
    left: Math.round(clamp(r.left, VIDEO_MARGIN, stage.width - width - VIDEO_MARGIN)),
    bottom: Math.round(clamp(r.bottom, VIDEO_MARGIN, stage.height - h - VIDEO_TOP)),
  };
}

/** Moved by a pointer delta (screen pixels, y down). */
export function moveVideoRect(r: VideoRect, dx: number, dy: number, stage: StageSize): VideoRect {
  return clampVideoRect({ ...r, left: r.left + dx, bottom: r.bottom - dy }, stage);
}

/**
 * Resized from an edge or corner by a pointer delta, keeping the frame's aspect ratio. The edge
 * opposite the handle stays put; on a corner the larger of the two pulls wins.
 */
export function resizeVideoRect(
  r: VideoRect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  stage: StageSize,
): VideoRect {
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.includes('n');
  const south = handle.includes('s');
  const byX = east ? dx : west ? -dx : 0;
  const byY = (north ? -dy : south ? dy : 0) * VIDEO_ASPECT;
  const want =
    (east || west) && (north || south)
      ? Math.abs(byX) >= Math.abs(byY)
        ? byX
        : byY
      : east || west
        ? byX
        : byY;
  const width = Math.round(clamp(r.width + want, VIDEO_MIN_W, maxVideoWidth(stage)));
  const dw = width - r.width;
  const dh = videoHeight(width) - videoHeight(r.width);
  return clampVideoRect(
    {
      width,
      left: west ? r.left - dw : r.left,
      bottom: south ? r.bottom - dh : r.bottom,
    },
    stage,
  );
}

/** Same window, same values: no re-render or save needed. */
export function sameVideoRect(a: VideoRect | null | undefined, b: VideoRect | null | undefined) {
  return (
    a === b || (!!a && !!b && a.left === b.left && a.bottom === b.bottom && a.width === b.width)
  );
}

/** A remembered rect read back from storage, or null when it is not one. */
export function parseVideoRect(v: unknown): VideoRect | null {
  if (!v || typeof v !== 'object') return null;
  const { left, bottom, width } = v as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  return ok(left) && ok(bottom) && ok(width) ? { left, bottom, width } : null;
}
