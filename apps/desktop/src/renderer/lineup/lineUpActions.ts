import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { lineUpApp } from './lineUpStore';
import { partnerOf } from './planLineUp';

/**
 * What the Changes panel and the date folder menu ask of the line-up step. They reach the app's
 * step through `lineUpApp` (set by `lineUpSession.ts`); without it they do nothing.
 */

/** Open the step for two dates; `then` runs after a saved line-up. */
export function openLineUp(from: string, to: string, then?: () => void): void {
  void lineUpApp.getState().store?.getState().open(from, to, then);
}

/**
 * Open the step for a date from its menu, with the date it most overlaps (the other date when
 * there are two). Returns a sentence when there is no such date, else null.
 */
export async function openLineUpFor(captureId: string): Promise<string | null> {
  const { store, extents } = lineUpApp.getState();
  const manifest = workspace.getState().project?.manifest;
  if (!store || !manifest) return null;
  let boxes = {};
  if (manifest.captures.length > 2 && extents) {
    try {
      boxes = await extents();
    } catch {
      return t('lineUp.extents.failed');
    }
  }
  const other = partnerOf(manifest, boxes, captureId);
  if (!other) return t('lineUp.refuse.noImagery');
  void store.getState().open(captureId, other);
  return null;
}

/** Take a date's line-up off (with Undo in the notice). */
export function removeLineUp(captureId: string): void {
  void lineUpApp.getState().store?.getState().remove(captureId);
}
