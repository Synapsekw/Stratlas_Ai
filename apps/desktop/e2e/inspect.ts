/**
 * The Inspect screen from a spec: open it from the sidebar, open a photo from its photo column,
 * and ask the AI about a scope. The photo tiles and the rows of "Findings on this photo" are
 * located the same way in every spec.
 */
import { expect, type Page } from '@playwright/test';

/** The Inspect screen from the sidebar. */
export async function openInspect(win: Page): Promise<void> {
  await win.locator('.sb-nav .nav-item', { hasText: 'Inspect' }).first().click();
  await expect(win.locator('section[aria-label="Inspect"]')).toBeVisible();
}

/** A photo opened from the photo column: its tile clicked, the viewer showing it. */
export async function openPhotoInInspect(win: Page, photoId: string): Promise<void> {
  const tile = win.getByTestId('inspect-photos').locator(`[data-photo="${photoId}"]`);
  await tile.scrollIntoViewIfNeeded();
  await tile.click();
  await expect(
    win.locator(`[data-testid="photo-viewer"][aria-label="Photo ${photoId}"]`),
  ).toBeVisible();
}

/**
 * The findings of the open photo in view. Under 1000 px (the CI window, with the sidebar open)
 * they are a drawer over the viewer, opened from its header.
 */
export async function openFindings(win: Page): Promise<void> {
  const toggle = win.getByTestId('inspect-panel-toggle');
  if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-expanded')) !== 'true')
    await toggle.click();
  await expect(win.getByTestId('inspect-findings')).toBeVisible();
}

/** Ask AI on a scope (This photo, the selected photos or all of them); a cloud run then asks first. */
export async function askAi(win: Page, scope: 'photo' | 'selected' | 'all'): Promise<void> {
  await win.getByTestId(`ask-ai-scope-${scope}`).click();
  await win.getByTestId('ask-ai').click();
}

export const photoTiles = (win: Page) => win.getByTestId('inspect-photos').locator('[data-photo]');

export const findingRows = (win: Page) =>
  win.getByTestId('inspect-findings').getByTestId('inspect-row');
