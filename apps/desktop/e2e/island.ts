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
export async function pickGroupTab(win: Page, g: GroupId, bench: Locator): Promise<void> {
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

/**
 * The Volumes view (volumetric parity W3, W4) in the Volumes workbench: every volume measurement
 * as a live card (`volumes-pile`), the focused one's detail card (`volumes-detail`), the totals and
 * the site inventory over time (`volumes-inventory`).
 */
export async function volumesView(win: Page): Promise<Locator> {
  const view = (await islandGroup(win, 'volumes')).getByTestId('volumes-view');
  await expect(view).toBeVisible();
  return view;
}

/**
 * The stage's Show control (volumetrics redesign, board 1): top-left of the stage while the
 * Volumes tab is in front, the surface (Photo | Elevation | Cut & fill) and the pile overlays
 * (Outlines | Labels). The Volumes tab is brought to the front first.
 */
export async function stageShow(win: Page): Promise<Locator> {
  await islandGroup(win, 'volumes');
  const show = win.getByTestId('stage-show');
  await expect(show).toBeVisible();
  return show;
}

/** Pick the stage's surface in the Show control and wait for it to read as picked. */
export async function showSurface(
  win: Page,
  name: 'Photo' | 'Elevation' | 'Cut & fill',
): Promise<void> {
  const button = (await stageShow(win)).getByRole('button', { name, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

/** A tool button of a group's full set (the set opened, so it shows). */
export async function islandTool(win: Page, g: GroupId, name: string | RegExp): Promise<Locator> {
  const full = await islandGroup(win, g);
  return full.getByRole('button', { name, exact: typeof name === 'string' });
}

/** The notch's 3D, Map or Split switch, on its line at rest and open. */
export async function stageModeButton(win: Page, m: '3D' | 'Map' | 'Split'): Promise<Locator> {
  const bar = island(win);
  await expect(bar).toBeVisible();
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

/**
 * The notch with its date showing: at rest its line has the date's arrows already (the notch
 * needs no waking any more), open its line keeps them.
 */
export async function wakeIsland(win: Page): Promise<Locator> {
  const bar = island(win);
  await expect(bar.getByTestId('date-row')).toBeVisible();
  return bar;
}

/** Step the survey date with the island's ‹ or › arrow. */
export async function islandDateStep(win: Page, dir: 'prev' | 'next'): Promise<void> {
  const bar = await wakeIsland(win);
  await islandSettled(win);
  await bar.getByTestId(`date-bar-${dir}`).click();
}

/** Open the island's calendar from its date pill, as a person does. */
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
 * The open notch's line and tab row (the view switch and the date; the group tabs, Jobs, Keep
 * open and Close): the names of those that lie outside the capsule, cut off at its edge. Empty when
 * every one is in view.
 */
export async function islandCutOff(win: Page): Promise<string[]> {
  await openIslandTools(win);
  await islandSettled(win);
  return win.evaluate(() => {
    const capsule = document.querySelector('.island')?.getBoundingClientRect();
    if (!capsule) return ['no island'];
    // (one the narrow-stage rules leave out on purpose, the date's steps, is not drawn at all)
    const cut = [...document.querySelectorAll('.isl-layer > .isl-line button, .isl-tabs button')]
      .filter((b) => b.getClientRects().length > 0)
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width === 0 || r.left < capsule.left - 0.5 || r.right > capsule.right + 0.5;
      })
      .map((b) => b.getAttribute('aria-label') ?? b.textContent.trim());
    // a tab scrolled out of sight in the tablist (its last resort) is cut off too
    const tabs = document.querySelector('.isl-tabs [role="tablist"]');
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

/**
 * The Measurements group of the Datasets tree, in the left sidebar on the Scene: the sidebar
 * unfolded from its rail (the Scene folds it in a narrow window) and the group open. Returns the
 * group, its head row and its rows (`measure-row`, `measure-folder`). In a project with survey
 * dates each date folder holds its own Measurements group: `date` (a capture id) picks that
 * date's, its folder opened with its arrow first (the focus stays where it was). Without a date,
 * a project whose only site measurements are stockpiles has no Measurements group: its piles sit
 * in the project's Stockpiles group (volumetrics redesign, spec section 5), which is returned.
 */
export async function measureTree(win: Page, date?: string): Promise<Locator> {
  const handle = win.getByTestId('panel-handle-left');
  if ((await handle.getAttribute('aria-expanded')) !== 'true') await handle.click();
  await expect(handle).toHaveAttribute('aria-expanded', 'true');
  let scope: Page | Locator = win;
  if (date !== undefined) {
    const folder = win.getByTestId(`date-folder-${date}`);
    if ((await folder.getAttribute('aria-expanded')) !== 'true')
      await folder.getByRole('button', { name: /^Expand/ }).click();
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    scope = folder;
  }
  const toggle = scope.getByTestId('tree-group-toggle-measurements');
  if (date === undefined) {
    const piles = win.getByTestId('tree-group-toggle-stockpiles');
    await expect(toggle.or(piles).first()).toBeVisible();
    if ((await toggle.count()) === 0) return stockpileTree(win);
  }
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return scope.getByTestId('tree-group-measurements').locator('..');
}

/**
 * The project's Stockpiles group of the Datasets tree (volumetrics redesign, spec section 5): in
 * a project with survey dates, after the date folders, the site's piles with their figures on the
 * date in focus (the head counts them: "2 · 1 Feb 2026"). The sidebar unfolded and the group open;
 * returns the group with its head row (`tree-group-stockpiles`) and its rows (`measure-row`).
 */
export async function stockpileTree(win: Page): Promise<Locator> {
  const handle = win.getByTestId('panel-handle-left');
  if ((await handle.getAttribute('aria-expanded')) !== 'true') await handle.click();
  await expect(handle).toHaveAttribute('aria-expanded', 'true');
  const toggle = win.getByTestId('tree-group-toggle-stockpiles');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  return win.getByTestId('tree-group-stockpiles').locator('..');
}

/** The filter box at the top of the tree's Measurements group (the group opened first). */
export async function measureFilter(win: Page): Promise<Locator> {
  const group = await measureTree(win);
  return group.getByRole('searchbox', { name: 'Filter measurements', exact: true });
}

/** A measurement's row in the Datasets tree, by its label. */
export function measureRow(win: Page, label: string): Locator {
  return win.getByTestId('measure-row').filter({ hasText: label });
}

/** Select a measurement in the tree: a click on its name (the row's middle can be its eye). */
export async function selectMeasure(win: Page, label: string): Promise<void> {
  await measureRow(win, label).locator('.tn').click();
}

/** Mark a measurement in the tree (Ctrl+click on its name), for several at once. */
export async function markMeasure(win: Page, label: string): Promise<void> {
  await measureRow(win, label)
    .locator('.tn')
    .click({ modifiers: ['Control'] });
}

/**
 * The save controls of the measurements (`survey-saved`) under the Measure bench: Autosave, the
 * status line and Save. They show under the live strip too, while a tool draws.
 */
export async function measureSaved(win: Page): Promise<Locator> {
  const saved = win.getByTestId('survey-saved');
  if (!(await saved.isVisible())) await measureBench(win);
  await expect(saved).toBeVisible();
  return saved;
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
  rf: 'Coverage',
  review: 'Model review',
  thermal: 'Thermal',
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
