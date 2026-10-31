/**
 * The site digest (intelligence review I2) in the real app, on the change demo (two dates,
 * synthetic, zero network): at the top of the Project tab it says what is worth a look. The later
 * date has no survey QA yet, so the digest says so first. Then the in-app change compute for the
 * pair runs (the same compute the checks after a new date, I1, start on their own; here it is
 * started from the Changes tab, since the chain needs a surface preparation job), and the digest
 * follows without a reload: the changes to review on the latest pair, whose action opens Changes
 * on that pair, and whose Compare dates runs the right-click registry's item (two views). The
 * unchecked date's action opens Survey QA. The digest only reads: opening the project leaves the
 * measurements saved (Save stays off). The demo has no volume measurements, so the figure rules
 * are covered by the unit tests. A screenshot of the digest is kept in the test's output folder
 * (`site-digest.png`).
 */
import { expectAccessible } from './a11y';
import { expect, reportWindow, test } from './fixtures';
import { openBench } from './island';

test('the site digest shows what to look at once a date lands', async ({
  demoProject,
}, testInfo) => {
  test.setTimeout(180_000);
  const { win, truth } = demoProject;
  // the size and scale this run is at, in the log (`[e2e] window ...`), as the CI log shows it
  await reportWindow(win);
  // two 3D views need the Medium tier (CI's software GPU is Low)
  await win.evaluate(() => {
    const g = (
      window as unknown as {
        __stratlas: {
          graphics(): { getState(): { tier: string; setOverride(t: string | null): void } };
        };
      }
    ).__stratlas
      .graphics()
      .getState();
    if (g.tier === 'low') g.setOverride('medium');
  });

  const project = await openBench(win, 'measure');
  const digest = project.getByTestId('site-digest');
  await expect(digest).toBeVisible();
  await expect(digest.getByRole('heading', { name: /Site digest/ })).toBeVisible();
  // the later date was never checked: a note, with the action that answers it
  const unchecked = digest.locator('[data-rule="survey-unchecked"]');
  await expect(unchecked).toHaveCount(1);
  await expect(unchecked).toContainText('has not been checked yet');
  await expect(digest.locator('[data-rule="change-review"]')).toHaveCount(0);
  // the digest only reads: nothing for the measurements to save
  const saving = project.getByRole('group', { name: 'Saving measurements' });
  await expect(saving.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(saving.getByRole('status')).toHaveText('All saved');

  // the change set for the new date lands (the in-app compute the checks after a date run)
  const changes = await openBench(win, 'changes');
  await changes.getByTestId('change-from').selectOption(truth.captures.from);
  await changes.getByTestId('change-to').selectOption(truth.captures.to);
  await changes.getByTestId('change-run').click();
  await expect(changes.locator('[data-testid="change-row"]').first()).toBeVisible({
    timeout: 60_000,
  });

  // the digest follows: the changes to review on the latest pair
  await openBench(win, 'measure');
  const review = digest.locator('[data-rule="change-review"]');
  await expect(review).toHaveCount(1);
  await expect(review).toContainText(/\d+ changes? from .+ to .+ to review/);
  await expectAccessible(win, 'Site digest', { include: '[data-testid="site-digest"]' });
  await digest.screenshot({ path: testInfo.outputPath('site-digest.png') });

  // its action opens Changes on that pair
  await review.getByTestId('site-digest-action-insights.openChanges').click();
  await expect(win.locator('.ws > .right #wb-tab-changes')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const panel = win.getByTestId('change-panel');
  await expect(panel.getByTestId('change-from')).toHaveValue(truth.captures.from);
  await expect(panel.getByTestId('change-to')).toHaveValue(truth.captures.to);

  // the unchecked date's action opens Survey QA
  await openBench(win, 'measure');
  await unchecked.getByTestId('site-digest-action-insights.openQa').click();
  await expect(win.locator('.ws > .right #wb-tab-qa')).toHaveAttribute('aria-selected', 'true');

  // Compare dates on the change line runs the right-click registry's item: two views
  await openBench(win, 'measure');
  await expect(digest.locator('[data-rule="change-review"]')).toHaveCount(1);
  await digest
    .locator('[data-rule="change-review"]')
    .getByTestId('site-digest-action-date.compare')
    .click();
  await expect(win.locator('[data-scene-view] canvas')).toHaveCount(2, { timeout: 30_000 });

  // and nothing was left to save
  await openBench(win, 'measure');
  await expect(saving.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});
