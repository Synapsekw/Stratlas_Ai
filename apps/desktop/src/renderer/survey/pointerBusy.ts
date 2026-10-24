/**
 * Whether another tool owns the pointer over a view now, so the passive pointer features (the
 * linked hover's snap and pin) keep out of its way. The tools say so in one of four ways:
 *
 * - a measure tool is armed, drawing or editing vertices (`measureStore`);
 * - the 3D stage's own tool is not Select (section, clip box, point-cloud lasso);
 * - a point pick is armed on the pane (`data-picking`, set by the app's pick hook, as the
 *   markers' `busy` reads it);
 * - the view's surface shows a crosshair: every pick and drawing sets one while armed (walk
 *   placement, correction and tower picks, the volumetric section pick, the point-cloud polygon,
 *   annotate and map drawings, the map's pointer sessions).
 */
import { measureStore } from './measureStore';

/** A measure tool is armed, drawing or editing. */
export function measureBusy(): boolean {
  const m = measureStore.getState();
  return m.tool !== null || m.draw !== null || m.editing !== null;
}

/** Another tool owns the pointer over `surface` (the 3D canvas or the map canvas). */
export function pointerBusy(
  surface: HTMLElement,
  stage?: { readonly tool: string } | null,
): boolean {
  if (measureBusy()) return true;
  if (stage && stage.tool !== 'select') return true;
  if (surface.closest('[data-picking="true"]') !== null) return true;
  return surface.style.cursor === 'crosshair';
}
