/**
 * The command palette finds the workspace's tools (UI revision W5): on the demo tank farm, Ctrl+K
 * and "measure" put Measure: Distance first with its key, Enter starts it and the tool card shows;
 * an island mode opens its section and a Settings page is a search away; a tool that cannot start
 * here stays listed with its reason (the tool registry, W8). The volumes list (Project > Volumes)
 * opens from "Volumes tools" and from "Open the volumes table"; the Table tile is gone. Off-screen,
 * in the window CI runs.
 */
import { DEMO_FOLDER, expect, test } from './fixtures';
import { expectBench, openSection } from './panel';
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

test('an island mode opens its section and a Settings page opens by name', async ({ win }) => {
  await openDemo(win, 'Demo tank farm', 'demo-tank-farm');
  const palette = win.getByRole('dialog', { name: 'Command search' });

  await win.keyboard.press('Control+K');
  await palette.getByRole('combobox').fill('annotate tools');
  await expect(palette.getByRole('option').first()).toHaveText(/^Annotate tools/);
  await win.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  // its section in the right panel: Tools > Annotate (D2, W8)
  await expectBench(win, 'annotate');

  await win.keyboard.press('Control+K');
  await palette.getByRole('combobox').fill('settings: keyboard');
  await expect(palette.getByRole('option').first()).toHaveText(/^Settings: Keyboard/);
  await win.keyboard.press('Enter');
  await expect(win.locator('.set-page h1')).toHaveText('Keyboard');
});

test('every registered tool is listed: one that cannot start here says why', async ({ win }) => {
  await openDemo(win, 'Demo tank farm', 'demo-tank-farm');
  const palette = win.getByRole('dialog', { name: 'Command search' });
  await win.keyboard.press('Control+K');
  // the demo has no road: the road's tools are there, greyed with the reason
  await palette.getByRole('combobox').fill('pci grid');
  const pci = palette.getByRole('option', { name: /^Road: PCI grid/ });
  await expect(pci).toHaveCount(1);
  await expect(pci).toContainText('Needs a road survey');
  await expect(pci).toHaveAttribute('aria-disabled', 'true');
  await win.keyboard.press('Escape');
});

test('the volumes list opens from the palette; Tools > Volumes lists Draw volume and Swipe', async ({
  win,
}) => {
  await openDemo(win, 'Demo tank farm', 'demo-tank-farm');
  const palette = win.getByRole('dialog', { name: 'Command search' });
  await win.keyboard.press('Control+K');
  await palette.getByRole('combobox').fill('volumes');
  // the Volumes tools are the ones that act on the view; the Table tile is gone, its palette
  // entry stays (checked below)
  await expect(palette.getByRole('option', { name: /^Volumes: Draw volume/ })).toHaveCount(1);
  await expect(
    palette.getByRole('option', { name: /^Volumes: Swipe between surveys/ }),
  ).toHaveCount(1);
  await expect(
    palette.getByRole('option', { name: /^Volumes: Open the volumes table/ }),
  ).toHaveCount(1);
  await expect(palette.getByRole('option', { name: /Section line between/ })).toHaveCount(0);
  // the list itself: Project > Volumes
  await palette.getByRole('combobox').fill('volumes tools');
  await expect(palette.getByRole('option').first()).toHaveText(/^Volumes tools/);
  await win.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expectBench(win, 'volumes');
  await expect(win.getByTestId('volumes-view')).toBeVisible();
  // "Open the volumes table" opens the same list, from another tab of the right panel
  await openSection(win, 'tools');
  await win.keyboard.press('Control+K');
  await palette.getByRole('combobox').fill('open the volumes table');
  await palette.getByRole('option', { name: /^Volumes: Open the volumes table/ }).click();
  await expect(palette).toBeHidden();
  await expectBench(win, 'volumes');
  await expect(win.getByTestId('volumes-view')).toBeVisible();
});
