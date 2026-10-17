/**
 * The stage island in the e2e specs: the tools that used to sit on the stage toolbar are behind
 * it. Specs reach them through these helpers rather than learning the island each.
 */
import { expect, type Locator, type Page } from '@playwright/test';

/** The island's group tabs, by the short names it shows (`island.group.*`). */
export type GroupId =
  'view' | 'measure' | 'display' | 'clouds' | 'volumes' | 'video' | 'road' | 'annotate';

const GROUP_NAME: Record<GroupId, string> = {
  view: 'View',
  measure: 'Measure',
  display: 'Display',
  clouds: 'Point cloud',
  volumes: 'Volumes',
  video: 'Video',
  road: 'Road',
  annotate: 'Annotate',
};

/** The island itself, a toolbar named "Stage tools". */
export const island = (win: Page): Locator => win.getByRole('toolbar', { name: 'Stage tools' });

/** Open the island's tools (the view switch, the group tabs and a quick row). */
export async function openIslandTools(win: Page): Promise<Locator> {
  const bar = island(win);
  if ((await bar.getAttribute('data-state')) !== 'tools') {
    // Enter on the island opens its tools, wherever the pointer is
    await bar.focus();
    await win.keyboard.press('Enter');
  }
  await expect(bar).toHaveAttribute('data-state', 'tools');
  return bar;
}

/** Close the island's tools (Esc), back to its date. */
export async function closeIslandTools(win: Page): Promise<void> {
  const bar = island(win);
  if ((await bar.getAttribute('data-state')) === 'tools') {
    await bar.getByRole('tab', { selected: true }).focus();
    await win.keyboard.press('Escape');
  }
  await expect(bar).not.toHaveAttribute('data-state', 'tools');
}

/** A group's quick row: the tools opened on that group's tab. */
export async function islandRow(win: Page, g: GroupId): Promise<Locator> {
  const bar = await openIslandTools(win);
  const tab = bar.getByRole('tab', { name: GROUP_NAME[g], exact: true });
  await tab.hover();
  return bar.getByRole('tabpanel');
}

/** A group's full set (the toolbar's group as it was), opened from the group's tab. */
export async function islandGroup(win: Page, g: GroupId): Promise<Locator> {
  const bar = await openIslandTools(win);
  // by key: the capsule is still morphing to its open size, so a click could land beside the tab
  await bar.getByRole('tab', { name: GROUP_NAME[g], exact: true }).focus();
  await win.keyboard.press('Enter');
  const full = win.locator('.isl-full');
  await expect(full).toBeVisible();
  return full;
}

/** Switch the stage to 3D, Map or Split from the island, and wait for the switch. */
export async function stageMode(win: Page, m: '3D' | 'Map' | 'Split'): Promise<void> {
  const bar = await openIslandTools(win);
  const button = bar.getByRole('button', { name: m, exact: true });
  await button.focus();
  await win.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

/** The survey date in the island (`date-row`). */
export const islandDate = (win: Page): Locator => island(win).getByTestId('date-row');
