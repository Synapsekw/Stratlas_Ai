/**
 * "Use the last 3D view" in Change thumbnail: as the scene of a project is left, its 3D view is
 * copied (synchronously, before the stage goes) and turned into a cover JPEG in the background.
 * The picture is kept in the shell store per library id, in memory only.
 */
import { getActiveStage } from '@aio/engine';
import { renderSnapshot } from '../exports/exports';
import { shell } from '../shell';
import { onLeaveView } from '../store';
import { imageToCoverJpeg } from './cover';

/**
 * Copy the 3D view on screen now and hand its cover JPEG to `save` later. Never throws and never
 * waits: leaving the scene is not held up by the picture.
 */
export function grabLastView(save: (data: Uint8Array<ArrayBuffer>) => void): void {
  let copy: HTMLCanvasElement | null;
  try {
    const stage = getActiveStage();
    copy = stage ? renderSnapshot(stage, false) : null;
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
  onLeaveView((id) => {
    grabLastView((data) => {
      shell.getState().setLastView(id, data);
    });
  });
  return () => {
    onLeaveView(null);
  };
}
