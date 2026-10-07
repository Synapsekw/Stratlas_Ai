/**
 * The survey-date timeline in the real app: the sidebar groups datasets by survey date, the date
 * bar and calendar move the focus, Alt+Left and Alt+Right step it, and the focus survives a reopen.
 * Runs on `e2e-three-dates` (4 Sep, 2 Oct, 6 Nov 2024; a model and a site outline per date and
 * one undated layer). Off-screen, zero network.
 */
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openProject, test as base, tinyManifest } from './fixtures';

/**
 * The tiny fixture project with its one capture removed, written before the app starts (list
 * `undatedProject` before `win`).
 */
const test = base.extend<{ undatedProject: { id: string } }>({
  undatedProject: async ({ dataRoot }, use) => {
    const manifest = { ...tinyManifest(), captures: [] };
    await writeFile(join(dataRoot.projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await use({ id: dataRoot.projectId });
  },
});

interface Probe {
  __stratlas: {
    workspace: { getState(): { hidden: Record<string, true> } };
  };
}

async function open(win: Page, name: string, id: string) {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: name }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe(id);
}

const openThreeDates = (win: Page, id: string) => open(win, 'E2E three dates', id);

/** Ids of the layers the store holds hidden, sorted. */
const hidden = (win: Page) =>
  win.evaluate(() =>
    Object.keys((window as unknown as Probe).__stratlas.workspace.getState().hidden).sort(),
  );

test.describe('survey date timeline', () => {
  test('opens on the latest date with other dates hidden', async ({ threeDateProject, win }) => {
    await openThreeDates(win, threeDateProject.id);
    await expect(win.getByTestId('date-bar-open')).toContainText('6 Nov 2024');
    await expect(win.getByTestId('date-folder-nov')).toHaveAttribute('aria-expanded', 'true');
    await expect(win.getByTestId('date-folder-oct')).toHaveAttribute('aria-expanded', 'false');
    expect(await hidden(win)).toEqual(['quad-oct', 'quad-sep', 'site-oct', 'site-sep']);
  });

  test('calendar jump swaps dates and keeps an extra', async ({ threeDateProject, win }) => {
    await openThreeDates(win, threeDateProject.id);
    // Turn on the September model by hand: expand Sep without focusing, use its eye.
    await win
      .getByTestId('date-folder-sep')
      .getByRole('button', { name: /Expand/ })
      .click();
    await win
      .getByTestId('date-folder-sep')
      .locator('.titem', { hasText: 'Quad' })
      .locator('.eye')
      .click();
    await win.getByTestId('date-bar-open').click();
    await win.getByTestId('cal-prev').click(); // November -> October
    await win.getByTestId('cal-day-2024-10-02').click();
    await expect(win.getByTestId('date-bar-open')).toContainText('2 Oct 2024');
    await expect(win.getByTestId('date-folder-oct')).toHaveAttribute('aria-expanded', 'true');
    await expect(win.getByTestId('date-on-sep')).toHaveText('1 on');
    expect(await hidden(win)).toEqual(['quad-nov', 'site-nov', 'site-sep']);
  });

  test('Alt+Left and Alt+Right step dates', async ({ threeDateProject, win }) => {
    await openThreeDates(win, threeDateProject.id);
    await win.keyboard.press('Alt+ArrowLeft');
    await expect(win.getByTestId('date-bar-open')).toContainText('2 Oct 2024');
    await win.keyboard.press('Alt+ArrowRight');
    await expect(win.getByTestId('date-bar-open')).toContainText('6 Nov 2024');
  });

  test('focus survives reopening the project', async ({ threeDateProject, win }) => {
    await openThreeDates(win, threeDateProject.id);
    await win.getByTestId('date-name-sep').click();
    await expect(win.getByTestId('date-bar-open')).toContainText('4 Sep 2024');
    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    await openThreeDates(win, threeDateProject.id);
    await expect(win.getByTestId('date-bar-open')).toContainText('4 Sep 2024');
  });

  test('a project without captures keeps the type-first tree and no date bar', async ({
    undatedProject,
    win,
  }) => {
    await open(win, 'E2E tiny project', undatedProject.id);
    await expect(win.locator('.titem').first()).toBeVisible();
    await expect(win.locator('[data-testid^="date-folder-"]')).toHaveCount(0);
    await expect(win.getByTestId('date-bar')).toHaveCount(0);
  });
});
