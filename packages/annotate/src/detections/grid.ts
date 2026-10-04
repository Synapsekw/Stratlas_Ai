/*
 * Virtual window of a contact sheet: thousands of tiles, only the rows near the view are in the
 * DOM. Pure maths so it can be tested and reused (photos, frames, detection crops).
 */

export interface GridInput {
  count: number;
  /** Inner width of the scroller in pixels. */
  width: number;
  /** Height of the scroller's view in pixels. */
  height: number;
  scrollTop: number;
  /** Smallest tile side; tiles grow to fill the row. */
  minTile: number;
  gap: number;
  /** Extra text under each tile (caption), in pixels. */
  caption?: number;
  /** Rows rendered above and below the view. */
  overscan?: number;
}

export interface GridWindow {
  cols: number;
  /** Tile side in pixels. */
  tile: number;
  rowHeight: number;
  rows: number;
  totalHeight: number;
  /** First and last index (exclusive) to render. */
  start: number;
  end: number;
  /** Offset of the first rendered row from the top. */
  offsetTop: number;
}

export function gridWindow(g: GridInput): GridWindow {
  const gap = Math.max(0, g.gap);
  const cols = Math.max(1, Math.floor((Math.max(0, g.width) + gap) / (g.minTile + gap)));
  const tile = Math.max(1, (Math.max(g.width, g.minTile) - gap * (cols - 1)) / cols);
  const rowHeight = tile + (g.caption ?? 0) + gap;
  const rows = Math.ceil(Math.max(0, g.count) / cols);
  const overscan = g.overscan ?? 2;
  const firstRow = Math.max(0, Math.floor(Math.max(0, g.scrollTop) / rowHeight) - overscan);
  const lastRow = Math.min(
    rows,
    Math.ceil((Math.max(0, g.scrollTop) + g.height) / rowHeight) + overscan,
  );
  return {
    cols,
    tile,
    rowHeight,
    rows,
    totalHeight: Math.max(0, rows * rowHeight - gap),
    start: Math.min(g.count, firstRow * cols),
    end: Math.min(g.count, lastRow * cols),
    offsetTop: firstRow * rowHeight,
  };
}

/** Scroll position that brings tile `index` into view (unchanged when it already is). */
export function scrollToIndex(
  w: Pick<GridWindow, 'cols' | 'rowHeight'>,
  index: number,
  scrollTop: number,
  height: number,
): number {
  const row = Math.floor(index / Math.max(1, w.cols));
  const top = row * w.rowHeight;
  const bottom = top + w.rowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + height) return Math.max(0, bottom - height);
  return scrollTop;
}
