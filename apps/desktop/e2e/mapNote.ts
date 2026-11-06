/**
 * The "No map pack installed" note of a single map view takes turns with the hints and toasts in
 * the stage's bottom-left slot (UI revision D5): a newer toast or hint holds it back. These wait
 * for it, closing the stage's toasts that have a close button meanwhile (the others time out),
 * with the pointer off the views so no hover hint comes up.
 */
import { expect, type Locator, type Page } from '@playwright/test';

export const NO_PACK_TEXT =
  'No map pack installed: project layers only. Add a pack in Settings, Offline maps.';

export async function noPackNote(win: Page, timeout = 60_000): Promise<Locator> {
  const note = win.getByTestId('map-no-packs');
  await win.mouse.move(2, 2);
  await expect
    .poll(
      async () => {
        if ((await note.count()) > 0) return true;
        for (const close of await win
          .locator('.stage-slot .q-toast')
          .getByRole('button', { name: 'Close' })
          .all())
          await close.click().catch(() => undefined);
        return false;
      },
      { timeout, intervals: [500, 1000] },
    )
    .toBe(true);
  return note;
}
