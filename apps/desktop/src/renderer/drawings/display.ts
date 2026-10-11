import { cleanLayerDisplay, type LayerDisplay } from '@aio/workspace';

/**
 * How the drawings of a project lie over the 3D view and the map: opacity and on top per plan
 * layer. A view preference of this computer (`StagePref.drawings`), never written to the project.
 */
export type DrawingDisplay = Record<string, LayerDisplay>;

/** The saved choices, each clamped; a layer with nothing chosen is left out. Undefined: none. */
export function parseDrawingDisplay(v: unknown): DrawingDisplay | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: DrawingDisplay = {};
  for (const [id, d] of Object.entries(v)) {
    const clean = cleanLayerDisplay(d);
    if (Object.keys(clean).length > 0) out[id] = clean;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `all` with `patch` merged into one layer's choice (undefined when nothing is chosen at all). */
export function withDrawingDisplay(
  all: DrawingDisplay | undefined,
  layerId: string,
  patch: LayerDisplay,
): DrawingDisplay | undefined {
  return parseDrawingDisplay({ ...all, [layerId]: { ...all?.[layerId], ...patch } });
}

/** The opacity a slider shows for a drawing that has none chosen: the map's 75 percent. */
export const DEFAULT_OPACITY = 0.75;
