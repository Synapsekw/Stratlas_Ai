/**
 * The stage island in the e2e specs: the tools that used to sit on the stage toolbar are behind
 * it. Specs reach them through these helpers rather than learning the island each.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { TabId } from '../src/renderer/workspace/workbench/tabsModel';

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
 * Compare dates: the View row's tile (the island's tools open), or beside the island while
 * comparing, where it leaves the comparison.
 */
export async function compareDatesButton(win: Page): Promise<Locator> {
  // the View row has the tile only while not comparing, so its absence says which one it is
  const tile = (await islandRow(win, 'view')).getByTestId('compare-dates');
  if ((await tile.count()) > 0) return tile;
  await closeIslandTools(win);
  // (none at all when the project has nothing to compare)
  return win.locator('.isl-aside').getByTestId('compare-dates');
}

/** Start or leave Compare dates, and close the island's tools again if they were opened. */
export async function toggleCompareDates(win: Page): Promise<void> {
  await (await compareDatesButton(win)).click();
  await closeIslandTools(win);
}

/**
 * A group's full set: its workbench in the right sidebar (D4, D12), opened from the group's tab,
 * with every folded section of it opened. View has no workbench: its set is its quick row (its
 * caret tiles open the Environment and Cutaway tabs).
 */
export async function islandGroup(win: Page, g: GroupId): Promise<Locator> {
  if (g === 'view') return islandRow(win, 'view');
  const bench = win.locator(`#wb-panel-${g}`);
  await pickGroupTab(win, g, bench);
  await unfoldAll(bench);
  return bench;
}

/**
 * Pick a group's tab in the open island, by key: the capsule is still morphing to its open size,
 * so a click could land beside the tab. An Enter pressed while it morphs can be lost too, so the
 * pick is tried again until the island is back at rest with `bench` showing.
 */
async function pickGroupTab(win: Page, g: GroupId, bench: Locator): Promise<void> {
  const bar = island(win);
  let tries = 0;
  await expect(async () => {
    const resting = (await bar.getAttribute('data-state')) !== 'tools';
    if (tries === 0 || !resting || !(await bench.isVisible())) {
      tries += 1;
      await openIslandTools(win);
      await bar.getByRole('tab', { name: GROUP_NAME[g], exact: true }).focus();
      await win.keyboard.press('Enter');
    }
    // the island goes back to rest, its workbench in front
    await expect(bar).not.toHaveAttribute('data-state', 'tools', { timeout: 3_000 });
    await expect(bench).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  // a lost Enter may be a real defect (the capsule swallowing a key while it morphs): each pick
  // that needed another try is recorded, so a rising rate shows in CI (T20 M1)
  if (tries > 1)
    test.info().annotations.push({
      type: 'island-pick-retry',
      description: `${g}: ${String(tries)} tries`,
    });
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
    const cut = [...document.querySelectorAll('.isl-r1 button')]
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width === 0 || r.left < capsule.left - 0.5 || r.right > capsule.right + 0.5;
      })
      .map((b) => b.getAttribute('aria-label') ?? b.textContent.trim());
    // a tab scrolled out of sight in the tablist (its last resort) is cut off too
    const tabs = document.querySelector('.isl-r1 [role="tablist"]');
    if (tabs && tabs.scrollWidth > tabs.clientWidth + 0.5) cut.push('the tabs scroll');
    return cut;
  });
}

/**
 * The Measure workbench in the right sidebar, opened from the island's Measure tab (unless it
 * shows already): its catalogue, `survey-tools`, with every tool, Site data, Drawing aids and
 * Templates in collapsible sections. While a tool is live the catalogue is a strip instead.
 */
export async function measureBench(win: Page): Promise<Locator> {
  const bench = win.getByTestId('survey-tools');
  if (!(await bench.isVisible())) await pickGroupTab(win, 'measure', bench);
  await expect(bench).toBeVisible();
  return bench;
}

/** Open a section's header when it is folded (a Measure workbench section, by its locator). */
async function unfold(section: Locator): Promise<void> {
  const head = section.locator('.wb-section-head').first();
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
}

/** Open every folded section of a workbench. */
async function unfoldAll(bench: Locator): Promise<void> {
  const folded = bench.locator('.wb-section-head[aria-expanded="false"]');
  // (bounded: a bench has a dozen sections at most)
  // by key: a long bench runs on under the agent below it, which would take a click
  for (let i = 0; i < 20 && (await folded.count()) > 0; i++) {
    await folded.first().focus();
    await folded.first().press('Enter');
  }
  await expect(folded).toHaveCount(0);
}

/** A section of the Measure workbench, by its id (`siteData`, `line`, `measurements`...), open. */
export async function measureSection(win: Page, id: string): Promise<Locator> {
  await measureBench(win);
  const section = win.getByTestId(`wb-section-${id}`);
  await unfold(section);
  return section;
}

/** A control of the Measure workbench's catalogue by its test id, its section opened first. */
export async function measureControl(win: Page, testId: string): Promise<Locator> {
  const bench = await measureBench(win);
  const control = bench.getByTestId(testId);
  await unfold(bench.locator('.wb-section', { has: win.getByTestId(testId) }).first());
  await expect(control).toBeVisible();
  return control;
}

/** A Site data button of the Measure workbench by its name ("Designs", "Hydrology"...). */
export async function siteDataButton(win: Page, name: string): Promise<Locator> {
  const section = await measureSection(win, 'siteData');
  return section.getByRole('button', { name, exact: true });
}

/** "Saved in this project" opened: the measurements list (`survey-list`). */
export async function measurementsList(win: Page): Promise<Locator> {
  // the section shows under the live strip too, while a tool draws
  const section = win.getByTestId('wb-section-measurements');
  if (!(await section.isVisible())) await measureBench(win);
  await unfold(section);
  const list = win.getByTestId('survey-list');
  await expect(list).toBeVisible();
  return list;
}

/**
 * The live tool strip of the Measure workbench (the catalogue while a tool draws): the tools as
 * short text buttons, by its accessible name.
 */
export function measureStrip(win: Page): Locator {
  return win.getByRole('group', { name: 'Measure tools', exact: true });
}

/** The workbench tabs' names (`wb.tab.*`); Issues and Volumes add a count after theirs. */
const TAB_NAME: Record<TabId, string> = {
  measure: 'Measure',
  display: 'Display',
  clouds: 'Point cloud',
  volumes: 'Volumes',
  video: 'Video',
  road: 'Road',
  annotate: 'Annotate',
  jobs: 'Jobs',
  selection: 'Selection',
  issues: 'Issues',
  changes: 'Changes',
  qa: 'Survey QA',
  overlays: 'Terrain overlays',
  hydro: 'Hydrology',
  cleanup: 'Point cloud cleanup',
  environment: 'Environment',
  cutaway: 'Cutaway',
};

/**
 * Bring a workbench tab that is open in the right sidebar to the front, and return its panel. A
 * tab that does not fit on the row sits in the row's "More tabs" menu (its element leaves the DOM:
 * `tab-changes` too), so it is picked there. The tabs are owned by the tablist through
 * `aria-owns`, so they are found by their ids, not inside the tablist. The sidebar is shown
 * first when it is folded.
 */
export async function openBench(win: Page, id: TabId): Promise<Locator> {
  const side = win.locator('.ws > .right');
  if (await win.locator('.ws.right-off').count()) {
    await win.locator('.stage-rp button').click();
    await expect(win.locator('.ws.right-off')).toHaveCount(0);
  }
  const tab = side.locator(`#wb-tab-${id}`);
  if (await tab.isVisible()) await tab.click();
  else {
    await side.getByRole('button', { name: 'More tabs', exact: true }).click();
    // the item says the tab's name, then its count and Live ("Issues · 3"); a pinned tab is a
    // checked item
    const name = new RegExp(`^${TAB_NAME[id]}( · .*)?$`);
    await win
      .getByRole('menu', { name: 'More tabs' })
      .locator('[role="menuitem"], [role="menuitemcheckbox"]')
      .filter({ hasText: name })
      .click();
  }
  await expect(side.locator(`#wb-tab-${id}`)).toHaveAttribute('aria-selected', 'true');
  const panel = side.locator(`#wb-panel-${id}`);
  await expect(panel).toBeVisible();
  return panel;
}
