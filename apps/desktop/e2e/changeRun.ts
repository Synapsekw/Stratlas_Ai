import type { Locator, Page } from '@playwright/test';
import { expect } from './fixtures';

/**
 * The item of the Changes panel's Find changes menu that runs `producer` (imagery, surface, point
 * cloud, model, matched frames), with the menu opened from the arrow beside Find changes.
 */
export async function producerItem(win: Page, producer: string): Promise<Locator> {
  const menu = win.getByTestId('change-run-menu');
  if (!(await menu.isVisible()))
    await win.getByTestId('change-panel').getByTestId('change-run-more').click();
  await expect(menu).toBeVisible();
  return menu.getByTestId(`change-producer-${producer}`);
}
