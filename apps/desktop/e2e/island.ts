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

/** The island has stopped moving: no morph, fade or slide runs in it (endless ones aside). */
export async function islandSettled(win: Page): Promise<void> {
  await expect
    .poll(() =>
      win
        .locator('.island-wrap')
        .evaluate(
          (el) =>
            el
              .getAnimations({ subtree: true })
              .filter(
                (a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity,
              ).length,
        ),
    )
    .toBe(0);
}

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

/** The View row's timeline tile, which shows and folds the timeline (pressed while it shows). */
export async function timelineToggle(win: Page): Promise<Locator> {
  const row = await islandRow(win, 'view');
  return row.getByTestId('timeline-toggle');
}

/**
 * Compare dates: beside the island while comparing (where it leaves the comparison), else the
 * View row's tile (the island's tools open).
 */
export async function compareDatesButton(win: Page): Promise<Locator> {
  const beside = win.locator('.isl-aside').getByTestId('compare-dates');
  if (await beside.isVisible()) return beside;
  const row = await islandRow(win, 'view');
  return row.getByTestId('compare-dates');
}

/** Start or leave Compare dates, and close the island's tools again if they were opened. */
export async function toggleCompareDates(win: Page): Promise<void> {
  await (await compareDatesButton(win)).click();
  await closeIslandTools(win);
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

/** A tool button of a group's full set (the set opened, so it shows). */
export async function islandTool(win: Page, g: GroupId, name: string | RegExp): Promise<Locator> {
  const full = await islandGroup(win, g);
  return full.getByRole('button', { name, exact: typeof name === 'string' });
}

/** The island's 3D, Map or Split switch (the tools open, so it shows). */
export async function stageModeButton(win: Page, m: '3D' | 'Map' | 'Split'): Promise<Locator> {
  const bar = await openIslandTools(win);
  return bar
    .getByRole('group', { name: 'Stage view' })
    .getByRole('button', { name: m, exact: true });
}

/**
 * Switch the stage to 3D, Map or Split from the island, wait for the switch, and close the tools
 * again (as the toolbar left the stage: nothing open over it, the keys the stage's).
 */
export async function stageMode(win: Page, m: '3D' | 'Map' | 'Split'): Promise<void> {
  const button = await stageModeButton(win, m);
  await button.focus();
  await win.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await closeIslandTools(win);
}

/** Wake the island at rest, as the pointer near it does: the date's arrows and Tools show. */
export async function wakeIsland(win: Page): Promise<Locator> {
  const bar = island(win);
  if ((await bar.getAttribute('data-state')) === 'rest') await win.locator('.island').hover();
  await expect(bar).not.toHaveAttribute('data-state', 'rest');
  return bar;
}

/** Step the survey date with the island's ‹ or › arrow. */
export async function islandDateStep(win: Page, dir: 'prev' | 'next'): Promise<void> {
  const bar = await wakeIsland(win);
  await islandSettled(win);
  await bar.getByTestId(`date-bar-${dir}`).click();
}

/**
 * Open the island's calendar from its date pill, as a person does: the pointer near the island
 * wakes it first (the line grows its arrows), then the pill is clicked.
 */
export async function openIslandCalendar(win: Page): Promise<Locator> {
  const bar = await wakeIsland(win);
  await islandSettled(win);
  await bar.getByTestId('date-bar-open').click();
  const cal = bar.getByTestId('calendar');
  await expect(cal).toBeVisible();
  return cal;
}

/** The survey date in the island (`date-row`). */
export const islandDate = (win: Page): Locator => island(win).getByTestId('date-row');

/**
 * The open island's first row (the view switch, the group tabs and Close): the names of those
 * that lie outside the capsule, cut off at its edge. Empty when every one is in view.
 */
export async function islandCutOff(win: Page): Promise<string[]> {
  await openIslandTools(win);
  await islandSettled(win);
  return win.evaluate(() => {
    const capsule = document.querySelector('.island')?.getBoundingClientRect();
    if (!capsule) return ['no island'];
    return [...document.querySelectorAll('.isl-r1 button')]
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width === 0 || r.left < capsule.left - 0.5 || r.right > capsule.right + 0.5;
      })
      .map((b) => b.getAttribute('aria-label') ?? b.textContent.trim());
  });
}
