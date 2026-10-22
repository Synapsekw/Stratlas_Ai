import { clipStartMs, nowOf, workspace } from '@aio/workspace';

/** Select a video clip and make it the active one; the clock moves to its start if before it. */
export function selectClip(layerId: string) {
  const ws = workspace.getState();
  const layer = ws.project?.manifest.layers.find((l) => l.id === layerId);
  ws.select({ kind: 'clip', id: layerId, layer: layerId });
  ws.setActiveClip(layerId);
  if (layer?.kind === 'video') {
    const start = clipStartMs(layer);
    if (nowOf(workspace) < start) ws.setTime(start);
  }
}

/**
 * A clip bar was clicked: select the clip and seek, never play (Space or Play plays). From a
 * pointer the clock goes to the clicked time; from the keyboard it stays when it is inside the
 * clip, else it goes to the clip start.
 */
export function pickClip(
  layerId: string,
  atMs: number | undefined,
  clip: { startMs: number; endMs: number } | undefined,
): void {
  selectClip(layerId);
  const ws = workspace.getState();
  if (atMs !== undefined) ws.setTime(atMs);
  else if (clip) {
    const now = nowOf(workspace);
    if (now < clip.startMs || now >= clip.endMs - 250) ws.setTime(clip.startMs);
  }
}
