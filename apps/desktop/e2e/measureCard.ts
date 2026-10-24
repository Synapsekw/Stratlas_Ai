/**
 * The shared measurement card in the e2e specs (volumetric parity W2, W3): the focused
 * measurement's detail card (`survey-panel`), its name field, the volume card's base picker and
 * "settled", the wait until every comparison shows its figures and no compute runs.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { pickGroupTab, selectMeasure } from './island';

/** The seven bases of the volume card's picker (`survey/card/baseNames.ts`). */
export type BaseId = 'smart' | 'lowest' | 'plane' | 'level' | 'mean' | 'surface' | 'custom';

/** The focused measurement's detail card. */
export const measureCard = (win: Page): Locator => win.getByTestId('survey-panel');

/**
 * Select a measurement in the tree and wait for its card, its name in the Rename field. A pile
 * opens in the Volumes tab (its pile panel, `focusPile`); its full volume card is the Measure
 * tab's, which is brought forward for it.
 */
export async function focusMeasure(win: Page, label: string): Promise<Locator> {
  await selectMeasure(win, label);
  const card = measureCard(win);
  const name = card.getByRole('textbox', { name: 'Rename', exact: true });
  const panel = win.getByTestId('pile-panel');
  await expect(name.or(panel).first()).toBeVisible();
  if (!(await name.isVisible())) {
    await expect(panel).toHaveAttribute('aria-label', label);
    await pickGroupTab(win, 'measure', name);
  }
  await expect(name).toHaveValue(label);
  return card;
}

/** Select a pile in the tree and wait for its pile panel in the Volumes tab. */
export async function focusPile(win: Page, label: string): Promise<Locator> {
  await selectMeasure(win, label);
  const panel = win.getByTestId('pile-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('pile-name')).toHaveText(label);
  return panel;
}

/**
 * Pick a comparison's base in the volume card (the "Base: ..." chip opens the seven bases).
 * "Previous survey or design" opens the surveys and designs: `surface` picks the one whose name
 * holds that text ("2 March 2026", "pad").
 */
export async function pickBase(
  item: Locator,
  base: BaseId,
  surface?: string | RegExp,
): Promise<void> {
  const chip = item.getByTestId('survey-from');
  await chip.click();
  const menu = item.page().getByRole('menu', { name: 'Choose the base', exact: true });
  await expect(menu).toBeVisible();
  const row = menu.locator(`[data-base="${base}"]`);
  // a side already on a survey or design opens with that list unfolded: a press would fold it
  if (base !== 'surface' || (await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  if (base === 'surface') {
    if (surface === undefined) throw new Error('pickBase: name the survey or design');
    await menu
      .getByTestId('bp-surfaces')
      .getByRole('menuitemradio')
      .filter({ hasText: surface })
      .first()
      .click();
  }
  await expect(menu).toHaveCount(0);
  await expect(chip).toHaveAttribute('data-base', base);
}

/**
 * Every comparison of the volume card shows its figures: `n` items, `n` results, none stale,
 * nothing computing (Recompute keeps its name while busy and says so with `aria-busy`; it is not
 * there at all for a carried figure or without surfaces, which also counts as settled).
 */
export async function volumeSettled(card: Locator, n: number, timeout = 60_000): Promise<void> {
  await expect(card.getByTestId('survey-cmp-item')).toHaveCount(n);
  await expect(card.getByTestId('survey-cmp-result')).toHaveCount(n, { timeout });
  await expect(card.getByText('Stale, recompute')).toHaveCount(0, { timeout });
  await expect(
    card.getByTestId('survey-cmp-status').filter({ hasText: /^Computing$/ }),
  ).toHaveCount(0, { timeout });
  await expect(card.getByTestId('survey-recompute')).not.toHaveAttribute('aria-busy', 'true', {
    timeout,
  });
}
