import type { Issue } from './annotation';
import type { Vec3 } from './common';
import type { Layer } from './layers';
import type { Crs, ProjectManifest, Space } from './manifest';

/** The id of the implicit space every layer without `space` is in. */
export const DEFAULT_SPACE_ID = 'main';

/**
 * The spaces of a project, in order. The implicit `main` space (the project's own `crs` and
 * `origin`) comes first, unless the project lists spaces and every layer names one.
 */
export function spacesOf(m: ProjectManifest): Space[] {
  const listed = m.spaces ?? [];
  const implicit: Space = { id: DEFAULT_SPACE_ID, name: m.name, crs: m.crs, origin: m.origin };
  if (listed.length > 0 && m.layers.every((l) => l.space !== undefined)) return [...listed];
  return [implicit, ...listed.filter((s) => s.id !== DEFAULT_SPACE_ID)];
}

/** The space a layer is in. */
export function spaceOfLayer(l: Pick<Layer, 'space'>): string {
  return l.space ?? DEFAULT_SPACE_ID;
}

/** The layers of one space, in manifest order. */
export function layersOfSpace(m: ProjectManifest, spaceId: string): Layer[] {
  return m.layers.filter((l) => spaceOfLayer(l) === spaceId);
}

/** The space of an issue: that of its first sighting's layer, else `main`. */
export function spaceOfIssue(m: ProjectManifest, issue: Issue): string {
  const layerId = issue.sightings[0]?.layer;
  const layer = layerId === undefined ? undefined : m.layers.find((l) => l.id === layerId);
  return layer ? spaceOfLayer(layer) : DEFAULT_SPACE_ID;
}

/**
 * The frame a layer's files are written in: its space's crs and origin, else the project's (a
 * layer of a space the project does not list). A cloud's coordinates are read against this origin.
 */
export function layerFrame(
  m: ProjectManifest,
  l: Pick<Layer, 'space'>,
): { crs: Crs; origin: Vec3 } {
  return spaceFrame(m, spaceOfLayer(l)) ?? { crs: m.crs, origin: m.origin };
}

/** The frame (crs and origin) of a space, or null when the project has no such space. */
export function spaceFrame(m: ProjectManifest, spaceId: string): { crs: Crs; origin: Vec3 } | null {
  const s = spacesOf(m).find((x) => x.id === spaceId);
  return s ? { crs: s.crs, origin: s.origin } : null;
}
