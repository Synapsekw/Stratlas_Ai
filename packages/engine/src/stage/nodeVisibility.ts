/**
 * Which nodes (engineering components) of a layer are hidden, per project and layer. The engine
 * owns it, not a view: every stage showing the layer (the main view, a view comparing dates)
 * applies it, also to a layer loaded again, and the UI reads it from here.
 */
const hidden = new Map<string, Set<string>>();
const listeners = new Set<(projectId: string, layerId: string) => void>();

const key = (projectId: string, layerId: string) => `${projectId}\u0000${layerId}`;
const NONE: ReadonlySet<string> = new Set();

/** The hidden node ids of a layer. */
export function hiddenNodesOf(projectId: string, layerId: string): ReadonlySet<string> {
  return hidden.get(key(projectId, layerId)) ?? NONE;
}

/** Show or hide one node of a layer; true when that changed anything. */
export function setNodeHidden(
  projectId: string,
  layerId: string,
  node: string,
  isHidden: boolean,
): boolean {
  const k = key(projectId, layerId);
  const set = hidden.get(k) ?? new Set<string>();
  if (set.has(node) === isHidden) return false;
  if (isHidden) set.add(node);
  else set.delete(node);
  if (set.size) hidden.set(k, set);
  else hidden.delete(k);
  for (const l of listeners) l(projectId, layerId);
  return true;
}

/**
 * Forget the hidden nodes of a layer that left the project, so the record does not grow with
 * every layer ever removed. Listeners hear it as a change.
 */
export function forgetHiddenNodes(projectId: string, layerId: string): void {
  if (!hidden.delete(key(projectId, layerId))) return;
  for (const l of listeners) l(projectId, layerId);
}

/** Listen for changes; returns an unsubscribe. */
export function onHiddenNodes(cb: (projectId: string, layerId: string) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Test helper: forget every hidden node. */
export function clearHiddenNodes(): void {
  hidden.clear();
}
