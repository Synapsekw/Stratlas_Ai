/**
 * A Globe request from outside the Globe screen (the agent's `show_on_globe`): the site to fly to
 * (a project id) or the whole library (null). Kept outside the lazy Globe chunk so the request can
 * be made before the screen loads; the screen takes it once its view is ready.
 */
let pending: { projectId: string | null } | null = null;
const listeners = new Set<() => void>();

export function requestGlobe(projectId: string | null): void {
  pending = { projectId };
  for (const l of listeners) l();
}

/** The standing request, once (null when there is none). */
export function takeGlobeRequest(): { projectId: string | null } | null {
  const p = pending;
  pending = null;
  return p;
}

/** Called on every new request while the Globe is open. */
export function onGlobeRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
