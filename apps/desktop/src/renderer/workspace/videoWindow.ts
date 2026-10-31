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
  /** Room kept free at the stage top when the island reaches lower than VIDEO_TOP (absent: VIDEO_TOP). */
  top?: number;
}

/** The room kept free at the stage top: the island's reach, at least VIDEO_TOP. */
const topOf = (stage: StageSize) => Math.max(VIDEO_TOP, stage.top ?? 0);

/** Edge or corner a resize starts from (compass directions, physical, not mirrored in RTL). */
export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const RESIZE_HANDLES: readonly ResizeHandle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** Gap kept between the window and the stage edges. */
export const VIDEO_MARGIN = 12;
/**
 * Gap kept below the stage top: the island (its two rows when opened, at most 100 px, D3) and the
 * top-right slot's first row stay clear, so the window never covers the island.
 */
export const VIDEO_TOP = 112;
/** Title bar and borders above and around the frame. */
export const VIDEO_CHROME = 32;
export const VIDEO_ASPECT = 16 / 9;
/** The smallest frame is 320 x 180 (D4). */
export const VIDEO_MIN_W = 320;
export const VIDEO_MAX_W = 1280;
/** At most this share of the stage, in each direction (D4). */
export const VIDEO_MAX_SHARE = 0.8;

export function videoHeight(width: number): number {
  return Math.round(VIDEO_CHROME + width / VIDEO_ASPECT);
}

/** The widest window that fits the stage with its margins (never below the minimum). */
export function maxVideoWidth(stage: StageSize): number {
  const byW = stage.width - 2 * VIDEO_MARGIN;
  const byH = (stage.height - VIDEO_MARGIN - topOf(stage) - VIDEO_CHROME) * VIDEO_ASPECT;
  const shareW = stage.width * VIDEO_MAX_SHARE;
  const shareH = (stage.height * VIDEO_MAX_SHARE - VIDEO_CHROME) * VIDEO_ASPECT;
  const share = Math.floor(Math.min(VIDEO_MAX_W, byW, byH, shareW, shareH));
  // never below the minimum, unless the room itself is smaller: then the room is the cap
  const room = Math.max(0, Math.floor(Math.min(byW, byH)));
  return Math.max(Math.min(VIDEO_MIN_W, room), share);
}

/**
 * Until the person moves it, the popped-out window sits at the stage's top left, under the island
 * and clear of the top-right slot (D4), at a share of the stage that leaves the stage usable.
 */
export function defaultVideoRect(stage: StageSize | null): VideoRect {
  const width = stage ? Math.round(Math.min(400, Math.max(VIDEO_MIN_W, stage.width * 0.42))) : 400;
  const bottom = stage ? stage.height - topOf(stage) - videoHeight(width) : VIDEO_MARGIN;
  return { left: VIDEO_MARGIN, bottom: Math.max(VIDEO_MARGIN, bottom), width };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** The window kept inside the stage: width within the limits, position within the margins. */
export function clampVideoRect(r: VideoRect, stage: StageSize): VideoRect {
  const max = maxVideoWidth(stage);
  const width = Math.round(clamp(r.width, Math.min(VIDEO_MIN_W, max), max));
  const h = videoHeight(width);
  return {
    width,
    left: Math.round(clamp(r.left, VIDEO_MARGIN, stage.width - width - VIDEO_MARGIN)),
    // the top edge first: the title bar never sits under the island, even with no room left
    bottom: Math.round(Math.min(Math.max(r.bottom, VIDEO_MARGIN), stage.height - h - topOf(stage))),
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
  const max = maxVideoWidth(stage);
  const width = Math.round(clamp(r.width + want, Math.min(VIDEO_MIN_W, max), max));
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
