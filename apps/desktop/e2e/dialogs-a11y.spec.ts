/**
 * Feature dialogs on the shared Dialog (UI revision W15b), in the real app. The volumetric report's
 * picture progress card is a modal: while the pictures are taken it holds the focus (Tab and
 * Shift+Tab stay inside), and Escape stops the run after the current shot: the card closes, the
 * person's view comes back and the report says the pictures were not taken. On the synthetic
 * quarry demo; off-screen, zero network, pipeline Python needed.
 */
import type { Page } from '@playwright/test';
import { expect, hasPipelinePython, PIPELINE_ENV, test } from './fixtures';
import { measureTree } from './island';
import { focusMeasure, volumeSettled } from './measureCard';
import { openDemo, setAutoPrepare } from './surveyJobs';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), 'needs the development pipeline Python (uv sync in python/)');

/** The focused element sits inside the element with this test id. */
const focusInside = (win: Page, testId: string) =>
  win.evaluate(
    (id) =>
      document.querySelector(`[data-testid="${id}"]`)?.contains(document.activeElement) === true,
    testId,
  );

test('the picture progress card traps focus and closes on Escape', async ({
  quarryProject,
  win,
}) => {
  test.setTimeout(900_000);
  const p = quarryProject;
  // one survey surface is enough to picture a pile
  await setAutoPrepare(win, false);
  await openDemo(win, p.name, p.id);
  await measureTree(win);
  const card = await focusMeasure(win, 'Stockpile SP1');
  await card.getByTestId('survey-prepare').click();
  await expect(card.getByTestId('survey-prepare')).toHaveCount(0, { timeout: 240_000 });
  await volumeSettled(card, 1, 120_000);

  await win.locator('.sb-nav .nav-item', { hasText: 'Reports' }).first().click();
  const block = win.getByTestId('customer-reports');
  await expect(block).toBeVisible({ timeout: 60_000 });
  await block.getByRole('button', { name: 'Open volumetric report' }).click();
  const editor = win.getByTestId('volumetric-editor');
  await expect(editor.getByRole('textbox', { name: 'Title', exact: true })).toBeVisible({
    timeout: 120_000,
  });
  const bar = editor.getByTestId('volumetric-pictures');
  await bar.getByRole('button', { name: /^Take pictures/ }).click();

  const progress = win.getByRole('alertdialog', { name: 'Taking the report pictures' });
  await expect(progress).toBeVisible({ timeout: 30_000 });
  await expect(progress).toHaveAttribute('data-testid', 'volumetric-picture-progress');
  await expect(progress).toHaveAttribute('aria-modal', 'true');
  await expect.poll(() => focusInside(win, 'volumetric-picture-progress')).toBe(true);
  await win.screenshot({ path: test.info().outputPath('picture-progress.png') });
  for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await win.keyboard.press(key);
    expect(await focusInside(win, 'volumetric-picture-progress'), `focus after ${key}`).toBe(true);
  }

  await win.keyboard.press('Escape');
  await expect(progress).toHaveCount(0, { timeout: 120_000 });
  // the run stopped: nothing saved, the report says so and offers the pictures again
  await expect(editor).toBeVisible({ timeout: 60_000 });
  await expect(editor.getByTestId('volumetric-pictures')).toContainText(/stopped/i, {
    timeout: 60_000,
  });
  await expect(
    editor.getByTestId('volumetric-pictures').getByRole('button', { name: /^Take pictures/ }),
  ).toBeVisible();
});

test('Report a problem and the new project wizard are modal Dialogs that Escape closes', async ({
  win,
}) => {
  // Report a problem, from the command search: focus in its first field, kept inside, Escape
  await win.keyboard.press('Control+K');
  await expect(win.getByRole('dialog', { name: 'Command search' })).toBeVisible();
  await win.keyboard.type('Report a problem');
  await win.keyboard.press('Enter');
  const problem = win.getByRole('dialog', { name: 'Report a problem' });
  await expect(problem).toBeVisible();
  await expect(problem).toHaveAttribute('aria-modal', 'true');
  await expect(win.getByTestId('problem-what')).toBeFocused();
  for (let i = 0; i < 8; i++) {
    await win.keyboard.press('Tab');
    expect(await focusInside(win, 'report-problem'), `focus after Tab ${String(i + 1)}`).toBe(true);
  }
  await win.screenshot({ path: test.info().outputPath('report-problem.png') });
  await win.keyboard.press('Escape');
  await expect(problem).toHaveCount(0);

  // the new project wizard: modal, focus inside, Escape closes it like Cancel and focus returns
  const opener = win.getByTestId('new-project').first();
  await opener.click();
  const wizard = win.getByTestId('new-project-wizard');
  await expect(wizard).toBeVisible();
  await expect(wizard).toHaveAttribute('aria-modal', 'true');
  await expect.poll(() => focusInside(win, 'new-project-wizard')).toBe(true);
  // the evidence after the opening fade
  await expect(wizard).toHaveCSS('opacity', '1');
  await win.waitForTimeout(300);
  await win.screenshot({ path: test.info().outputPath('new-project.png') });
  await win.keyboard.press('Escape');
  await expect(wizard).toHaveCount(0);
  await expect(opener).toBeFocused();
});
