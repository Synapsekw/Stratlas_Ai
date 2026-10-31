import {
  layersOfSpace,
  spaceFrame,
  spaceOfIssue,
  spacesOf,
  type Issue,
  type ProjectManifest,
} from '@aio/schema';

/** Hidden layer ids per space, remembered while another space is on screen. */
export type SpaceMemory = Record<string, string[]>;

/** The preferred space when the project still has it, else the first space. */
export function activeSpaceOf(m: ProjectManifest, pref: string | undefined): string {
  const spaces = spacesOf(m);
  if (pref !== undefined && spaces.some((s) => s.id === pref)) return pref;
  return spaces[0]?.id ?? 'main';
}

/** The space switcher only shows for two spaces or more. */
export function switcherShown(m: ProjectManifest): boolean {
  return spacesOf(m).length > 1;
}

/**
 * False only for a space with a `{ local }` frame (or no such space). A georeferenced crs the map
 * cannot project (WKT, a state plane or national grid) still has the map view.
 */
export function mapAvailable(m: ProjectManifest, spaceId: string): boolean {
  const frame = spaceFrame(m, spaceId);
  return frame !== null && !('local' in frame.crs);
}

/** Ids of the layers that belong to another space. */
export function offSpaceLayers(m: ProjectManifest, spaceId: string): string[] {
  const inside = new Set(layersOfSpace(m, spaceId).map((l) => l.id));
  return m.layers.filter((l) => !inside.has(l.id)).map((l) => l.id);
}

export function inSpace(m: ProjectManifest, spaceId: string): (issue: Issue) => boolean {
  return (issue) => spaceOfIssue(m, issue) === spaceId;
}

export function issuesInSpace(
  m: ProjectManifest,
  issues: readonly Issue[],
  spaceId: string,
): Issue[] {
  return issues.filter(inSpace(m, spaceId));
}

/**
 * Switching space: the layers to show and hide (idempotent intents for `applyVisibility`) and the
 * memory to keep. The hidden layers of the space left are remembered; the space entered gets back
 * what was hidden in it, and every layer of another space is hidden. Only the workspace's
 * in-memory hidden set changes through this, never a saved `visible` (checked for R17).
 */
export function scopeChange(
  m: ProjectManifest,
  from: string | null,
  to: string,
  hidden: Readonly<Record<string, true>>,
  memory: SpaceMemory,
): { show: string[]; hide: string[]; memory: SpaceMemory } {
  const next: SpaceMemory = { ...memory };
  if (from !== null && from !== to) {
    next[from] = layersOfSpace(m, from)
      .filter((l) => hidden[l.id])
      .map((l) => l.id);
  }
  // First entry: what is hidden now (saved `visible: false`, timeline dates) stays hidden.
  next[to] ??= layersOfSpace(m, to)
    .filter((l) => hidden[l.id])
    .map((l) => l.id);
  const kept = new Set(next[to]);
  const show: string[] = [];
  const hide: string[] = [];
  for (const l of layersOfSpace(m, to)) (kept.has(l.id) ? hide : show).push(l.id);
  hide.push(...offSpaceLayers(m, to));
  return { show, hide, memory: next };
}
