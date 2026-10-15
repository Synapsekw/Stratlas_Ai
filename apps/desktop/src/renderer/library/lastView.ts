/**
 * "Use the last 3D view" in Change thumbnail: as the scene of a project is left, its 3D view is
 * copied (synchronously, before the stage goes) and turned into a cover JPEG in the background.
 * The picture is kept in the shell store per library id, in memory only.
 */
import { getActiveStage } from '@aio/engine';
import { renderSnapshot } from '../exports/exports';
import { shell } from '../shell';
import { onLeaveView } from '../store';
import { COVER_MAX, imageToCoverJpeg } from './cover';

/** A project left again this soon after its last picture keeps that picture. */
const MIN_GAP_MS = 2000;

/**
 * Copy the 3D view on screen now and hand its cover JPEG to `save` later. Never throws and never
 * waits: leaving the scene is not held up by the picture.
 */
export function grabLastView(save: (data: Uint8Array<ArrayBuffer>) => void): void {
  let copy: HTMLCanvasElement | null;
  try {
    const stage = getActiveStage();
    // drawn straight at cover size: a 4K view is never copied whole on the way out
    copy = stage ? renderSnapshot(stage, false, COVER_MAX) : null;
  } catch {
    return;
  }
  if (!copy) return;
  const canvas = copy;
  void (async () => {
    const bmp = await createImageBitmap(canvas);
    try {
      save(await imageToCoverJpeg(bmp));
    } finally {
      bmp.close();
    }
  })().catch(() => undefined);
}

/** Keep a picture of the last 3D view of each project as its scene is left. */
export function installLastView(): () => void {
  const taken = new Map<string, number>();
  onLeaveView((id) => {
    const now = Date.now();
    const last = taken.get(id);
    if (last !== undefined && now - last < MIN_GAP_MS) return;
    taken.set(id, now);
    grabLastView((data) => {
      shell.getState().setLastView(id, data);
    });
  });
  return () => {
    onLeaveView(null);
  };
}
