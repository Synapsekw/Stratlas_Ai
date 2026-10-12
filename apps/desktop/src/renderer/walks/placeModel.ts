import { surfaceFrameFromCorners, type SurfaceFrame, type WalkSurfaces } from '@aio/geo';
import { MODEL_SURFACE } from '@aio/schema';
import type { Capture, ProjectManifest, WalkLayer } from '@aio/schema';
import { captureIndex } from '@aio/workspace';

/*
 * Placing a walk (design "Placing a walk: the flow"): the pure choices of the Place walk strip.
 * The session itself is `placeStore.ts`; the fit is `@aio/geo`'s `fitWalk`.
 */

export type PlaceStep = 'date' | 'surface' | 'start' | 'end' | 'correct';

/** What a walk can be placed on: a drawing (a plan raster) or the map (the model frame). */
export type PlaceSurface =
  { kind: 'drawing'; id: string; name: string; dated: boolean } | { kind: 'map' };

/** What the drawing's `placement.json` says: its picture size and whether it is provisional. */
export interface DrawingInfo {
  provisional: boolean;
  size: { width: number; height: number };
}

/** The drawing info of a plan layer by id (from the drawings store's `placed`). */
export type DrawingLookup = (id: string) => DrawingInfo | undefined;

/** A plan raster with model-frame corners: the only drawings a walk can be placed on. */
function drawingsOf(m: ProjectManifest) {
  return m.layers.flatMap((l) =>
    l.kind === 'raster' && l.role === 'plan' && l.corners ? [{ layer: l, corners: l.corners }] : [],
  );
}

/**
 * The surfaces the Place on picker lists: the drawings of the walk's date, then the drawings with
 * no date, then the map (only with a coordinate system). Drawings of other dates are left out.
 */
export function placeSurfaces(
  m: ProjectManifest,
  walk: WalkLayer,
  hasCrs: boolean,
): PlaceSurface[] {
  const index = captureIndex(m);
  const dated: PlaceSurface[] = [];
  const undated: PlaceSurface[] = [];
  for (const { layer } of drawingsOf(m)) {
    const c = index.of[layer.id];
    if (c === undefined)
      undated.push({ kind: 'drawing', id: layer.id, name: layer.name, dated: false });
    else if (walk.capture !== undefined && c === walk.capture)
      dated.push({ kind: 'drawing', id: layer.id, name: layer.name, dated: true });
  }
  return [...dated, ...undated, ...(hasCrs ? [{ kind: 'map' } as const] : [])];
}

/** The key a surface is remembered by (`placedOn`): the drawing's layer id, or `@model`. */
export function surfaceKey(s: PlaceSurface): string {
  return s.kind === 'map' ? MODEL_SURFACE : s.id;
}

/** The surface the walk was last placed on, when the picker still lists it. */
export function rememberedSurface(
  walk: WalkLayer,
  surfaces: readonly PlaceSurface[],
): PlaceSurface | null {
  const key = walk.place?.placedOn;
  return key === undefined ? null : (surfaces.find((s) => surfaceKey(s) === key) ?? null);
}

/**
 * The drawings' frames for the fit: image px to model x/z from the raster corners and the picture
 * size, base height from the top-left corner. A drawing that is gone, has no corners, or whose
 * size is not known yet has no frame (its pins are inactive).
 */
export function surfaceFramesOf(m: ProjectManifest, drawings: DrawingLookup): WalkSurfaces {
  const corners = new Map(drawingsOf(m).map((d) => [d.layer.id, d.corners]));
  return {
    drawing(id: string): SurfaceFrame | null {
      const c = corners.get(id);
      const info = drawings(id);
      if (!c || !info) return null;
      const { width: w, height: h } = info.size;
      if (!(w > 0) || !(h > 0)) return null;
      return surfaceFrameFromCorners(c, [w, h], info.provisional);
    },
  };
}

/** The first step of a session: the survey date when the walk has none, else the surface. */
export function firstStep(walk: WalkLayer): PlaceStep {
  return walk.capture === undefined ? 'date' : 'surface';
}

/**
 * The date step's choices: capture ids, the walk's own and the `capturedAt` date's first, then
 * the others in date order; `add` is the `capturedAt` date (`YYYY-MM-DD`) when the project has no
 * survey date on it.
 */
export function dateChoices(
  walk: WalkLayer,
  captures: readonly Capture[],
  capturedAt?: string,
): { pick: string[]; add?: string } {
  const date = capturedAt && /^\d{4}-\d{2}-\d{2}/.test(capturedAt) ? capturedAt.slice(0, 10) : null;
  const sorted = [...captures].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
  const rank = (c: Capture): number => (c.id === walk.capture ? 0 : c.date === date ? 1 : 2);
  const pick = sorted
    .map((c, i) => ({ c, i }))
    .sort((x, y) => rank(x.c) - rank(y.c) || x.i - y.i)
    .map(({ c }) => c.id);
  const add = date !== null && !captures.some((c) => c.date === date) ? date : undefined;
  return add === undefined ? { pick } : { pick, add };
}
