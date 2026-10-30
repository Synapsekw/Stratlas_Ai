/**
 * The command palette finds the workspace's tools (UI revision W5): on the demo tank farm, Ctrl+K
 * and "measure" put Measure: Distance first with its key, Enter starts it and the tool card shows;
 * an island group opens its workbench and a Settings page is a search away. Off-screen, in the
 * window CI runs.
 */
import { DEMO_FOLDER, expect, test } from './fixtures';
import { openDemo } from './surveyJobs';

test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x720', QUADRION_DEMO: DEMO_FOLDER } });

test('"measure" finds Distance first and Enter starts it', async ({ win }) => {
  await openDemo(win, 'Demo tank farm', 'demo-tank-farm');
  const palette = win.getByRole('dialog', { name: 'Command search' });

  await win.keyboard.press('Control+K');
  await expect(palette).toBeVisible();
  await win.keyboard.type('measure');
  const options = palette.getByRole('option');
  await expect(options.first()).toHaveText(/^Measure: Distance/);
  // the key that does the same sits at the row's end
  await expect(options.first().locator('.kbd')).toHaveText('M');
  // the other favourites and the group follow
  await expect(palette.getByRole('option', { name: /^Measure: Area/ })).toHaveCount(1);
  await expect(palette.getByRole('option', { name: /^Measure: Volume/ })).toHaveCount(1);
  await expect(palette.getByRole('option', { name: /^Measure: Elevation/ })).not.toHaveCount(0);
  await expect(palette.getByRole('option', { name: /^Measure tools/ })).toHaveCount(1);

  await win.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(win.getByTestId('survey-drawbar')).toBeVisible();
  await expect(win.getByTestId('measure-live-card')).toBeVisible();
  await win.keyboard.press('Escape');
});

test('an island group opens its workbench and a Settings page opens by name', async ({ win }) => {
  await openDemo(win, 'Demo tank farm', 'demo-tank-farm');
  const palette = win.getByRole('dialog', { name: 'Command search' });

  await win.keyboard.press('Control+K');
  await palette.getByRole('combobox').fill('display tools');
  await expect(palette.getByRole('option').first()).toHaveText(/^Display tools/);
  await win.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(win.getByRole('tab', { name: /^Display/, selected: true })).toBeVisible();

  await win.keyboard.press('Control+K');
  await palette.getByRole('combobox').fill('settings: keyboard');
  await expect(palette.getByRole('option').first()).toHaveText(/^Settings: Keyboard/);
  await win.keyboard.press('Enter');
  await expect(win.locator('.set-page h1')).toHaveText('Keyboard');
});
