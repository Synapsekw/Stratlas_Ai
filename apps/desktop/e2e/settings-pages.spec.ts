/**
 * Settings by topic (UI revision W6): every page opens with its heading and fits the window, the
 * "This project" group is listed only while a project is open, and the sections that moved
 * (detection, geoid grids, the project's privacy) are reached from where they used to be.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const nav = (win: Page) => win.getByRole('navigation', { name: 'Settings sections' });
const h1 = (win: Page) => win.locator('.set-page h1');

async function openSettings(win: Page, page?: string): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  if (page) await nav(win).locator('button', { hasText: page }).click();
  if (page) await expect(h1(win)).toHaveText(page);
}

async function openTiny(win: Page): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Projects' }).click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('.proj-switch')).toContainText('E2E tiny project');
}

test('every Settings page opens with its heading and fits the window', async ({ win }) => {
  await openSettings(win);
  const buttons = nav(win).locator('button');
  const names = (await buttons.allTextContents()).map((s) => s.trim());
  // grouped by topic; no project open, so no "This project"
  expect(names).toEqual([
    'AI providers',
    'Local model',
    'Models and detection',
    'Usage and cost',
    'Privacy and cloud',
    'Identity and team',
    'Data folder',
    'Processing tools',
    'Offline maps',
    'Map sources',
    'Datums',
    'Severity models',
    'Classes',
    'Report branding',
    'Graphics quality',
    'Appearance',
    'Keyboard',
    'About and updates',
  ]);
  await expect(nav(win)).not.toContainText('This project');
  for (const [i, name] of names.entries()) {
    await buttons.nth(i).click();
    await expect(h1(win)).toHaveText(name);
    // nothing on the page is wider than the page
    const wide = await win.locator('.set-body').evaluate((body) => {
      const right = body.getBoundingClientRect().right;
      return [...body.querySelectorAll<HTMLElement>('*')]
        .filter((el) => el.getBoundingClientRect().right > right + 1 && el.offsetParent !== null)
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`)
        .slice(0, 5);
    });
    expect(wide, `${name} scrolls sideways`).toEqual([]);
  }

  // the AI providers heading comes from the catalogue
  await nav(win).locator('button', { hasText: 'AI providers' }).click();
  await expect(win.getByRole('heading', { name: /^Providers \d+ supported$/ })).toBeVisible();
  await expect(win.getByTestId('local-model')).toHaveCount(0);
  await expect(win.getByTestId('detection-models')).toHaveCount(0);

  // Processing tools: the automatic surface switch sits inside the engine card
  await nav(win).locator('button', { hasText: 'Processing tools' }).click();
  await expect(win.getByTestId('engine').getByTestId('auto-prepare-row')).toBeVisible();

  // Keyboard: the search box fills its row
  await nav(win).locator('button', { hasText: 'Keyboard' }).click();
  const search = win.getByTestId('keymap-search');
  const [own, row] = await Promise.all([
    search.evaluate((el) => el.getBoundingClientRect().width),
    search.evaluate((el) => el.parentElement?.getBoundingClientRect().width ?? 0),
  ]);
  expect(own).toBeGreaterThanOrEqual(row - 1);
});

test('moved sections are reached from where they used to be', async ({ win }) => {
  // Processing tools points to Models and detection
  await openSettings(win, 'Processing tools');
  await expect(win.getByTestId('analytics-pack')).toHaveCount(0);
  await win.getByTestId('tools-models-moved').getByRole('button').click();
  await expect(h1(win)).toHaveText('Models and detection');
  await expect(win.getByTestId('analytics-pack')).toBeInViewport();
  // keyboard focus follows the moved section
  await expect(win.locator('[data-settings-focus="analytics-pack"]')).toBeFocused();
  await expect(win.getByTestId('detection-models')).toBeAttached();
  await expect(win.getByTestId('detector-library')).toBeAttached();

  // Offline maps points to Datums
  await nav(win).locator('button', { hasText: 'Offline maps' }).click();
  await expect(win.getByTestId('geoid-packs')).toHaveCount(0);
  await win.getByTestId('maps-geoid-moved').getByRole('button').click();
  await expect(h1(win)).toHaveText('Datums');
  await expect(win.getByTestId('geoid-packs')).toBeVisible();
});

test('Project settings is listed only with a project open', async ({ win }) => {
  await openTiny(win);
  await openSettings(win);
  await expect(nav(win)).toContainText('This project');

  // Privacy and cloud keeps the app-wide switches and points to the project's own
  await nav(win).locator('button', { hasText: 'Privacy and cloud' }).click();
  await expect(win.getByTestId('keep-local')).toHaveCount(0);
  await win.getByTestId('privacy-project-moved').getByRole('button').click();
  await expect(h1(win)).toHaveText('Project settings');
  await expect(win.getByTestId('keep-local')).toBeVisible();
  await expect(win.getByTestId('project-street-map-state')).not.toBeEmpty();

  // the street map leads to "Maps for your projects" on Offline maps
  await win.getByTestId('project-street-map-open').click();
  await expect(h1(win)).toHaveText('Offline maps');
  await expect(win.getByTestId('project-maps')).toBeInViewport();
});
