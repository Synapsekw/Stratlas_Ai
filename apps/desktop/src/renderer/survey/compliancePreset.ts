/**
 * The compliance presets at work (M11 G6 with G4): **Cut/Fill to design** and **Remaining to
 * design** add their comparison item (the design layer, used with its vertical offset; Remaining
 * with the tolerance as its deadband) to the focused polygon, which is then computed; the
 * in-tolerance share comes with its result (`compareStore` `Computed.shares`). With no polygon in
 * focus the person draws one first (a one-shot Volume drawing with a prompt in the drawing bar).
 */
import type { ComparisonItem, SurveyMeasurement } from '@aio/schema';
import { compute } from './compareStore';
import { measureStore, startTool, updateMeasurement } from './measureStore';

/** As the comparisons section allows. */
export const MAX_ITEMS = 20;

/** The item with an id the measurement does not use yet (`<id>`, `<id>-2`, ...). */
export function withFreeId(m: Pick<SurveyMeasurement, 'items'>, item: ComparisonItem) {
  const taken = new Set(m.items.map((x) => x.id));
  if (!taken.has(item.id)) return item;
  const base = item.id.slice(0, 76);
  for (let n = 2; ; n++) {
    const id = `${base}-${String(n)}`;
    if (!taken.has(id)) return { ...item, id };
  }
}

/** Add the item to a polygon measurement and compute it; an error sentence or null. */
export function addDesignItem(id: string, item: ComparisonItem): string | null {
  const m = measureStore.getState().file.measurements.find((x) => x.id === id);
  if (m?.family !== 'polygon') return 'Choose a polygon measurement first.';
  if (m.items.length >= MAX_ITEMS)
    return `"${m.label}" has ${String(MAX_ITEMS)} comparisons already; remove one first.`;
  const it = withFreeId(m, item);
  updateMeasurement(id, (x) => ({ ...x, items: [...x.items, it] }));
  // a person's action: the result is saved as an edit
  void compute(id);
  return null;
}

export const DRAW_PROMPT =
  'Draw the area to compare to the design: click its corners, then Finish (or double-click).';

/**
 * Apply a preset: to the focused polygon, else after the person draws one. Answers the line the
 * Compliance section shows.
 */
export function applyDesignPreset(item: ComparisonItem, label: string): string {
  const s = measureStore.getState();
  if (s.readOnly) return 'Measurements cannot be changed in this project.';
  const m = s.file.measurements.find((x) => x.id === s.focus);
  if (m?.family === 'polygon') {
    const err = addDesignItem(m.id, item);
    return err ?? `${label} added to "${m.label}". Its results are in the measurement's panel.`;
  }
  startTool('volume', null, {
    prompt: DRAW_PROMPT,
    then: (drawn) => {
      addDesignItem(drawn.id, item);
    },
  });
  return `No polygon is selected. ${DRAW_PROMPT} ${label} is added to it.`;
}
