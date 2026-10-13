/*
 * Marking Datasets rows for one action (delete and start over, spec "Multi-select"): Ctrl+click
 * toggles a row, Shift+click marks the range from the anchor in display order, a plain click
 * clears the marks (and selects as before). Esc clears too (the caller). Pure, so the tree and
 * the sidebar share it.
 */

export interface MarkMods {
  ctrl: boolean;
  shift: boolean;
}

export interface Marks {
  marked: ReadonlySet<string>;
  /** The row Shift ranges from: the last row clicked with Ctrl, or alone. */
  anchor: string | null;
}

export const NO_MARKS: Marks = { marked: new Set(), anchor: null };

/** Marks after a click on layer `id` over the rows in display `order`; a plain click clears. */
export function nextMarks(m: Marks, order: readonly string[], id: string, mods: MarkMods): Marks {
  if (mods.shift) {
    const from = m.anchor === null ? -1 : order.indexOf(m.anchor);
    const to = order.indexOf(id);
    if (from < 0 || to < 0) return { marked: new Set([id]), anchor: id };
    const [a, b] = from <= to ? [from, to] : [to, from];
    return { marked: new Set(order.slice(a, b + 1)), anchor: m.anchor };
  }
  if (mods.ctrl) {
    const marked = new Set(m.marked);
    if (marked.has(id)) marked.delete(id);
    else marked.add(id);
    return { marked, anchor: id };
  }
  return NO_MARKS;
}
