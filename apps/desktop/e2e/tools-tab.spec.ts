/**
 * The Tools tab from the one tool registry (UI revision W8), on the demo tank farm in the window
 * CI runs: the registry's groups as sections in one order, each with its tools; an armed tool
 * replaces the list with its card and "Back to tools", and Escape returns from the card to the
 * list. Off-screen.
 */
import { join } from 'node:path';
import { DEMO_FOLDER, expect, test } from './fixtures';
import { backToTools, measureControl } from './island';
import { openSection, panelSection } from './panel';
import { openDemo } from './surveyJobs';

test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x720', QUADRION_DEMO: DEMO_FOLDER } });

const SHOTS = process.env.QUADRION_E2E_SHOTS;

test('the groups in registry order; Escape returns from the tool card to the list', async ({
  win,
}, info) => {
  await openDemo(win, 'Demo tank farm', 'demo-tank-farm');
  const tools = await openSection(win, 'tools');
  const sections = () =>
    tools
      .locator('[data-section]')
      .evaluateAll((all) => all.map((s) => s.getAttribute('data-section')));
  // View, Measure, Annotate and Volumes lead, in that order (the demo has piles)
  await expect
    .poll(async () => (await sections()).slice(0, 4))
    .toEqual(['tools.view', 'tools.measure', 'tools.annotate', 'tools.volumes']);
  // a group opened lists its tools as rows
  const view = await openSection(win, 'tools', 'tools.view');
  await expect(view.getByTestId('tool-view.wholeSite')).toBeVisible();
  await win.screenshot({
    path: SHOTS ? join(SHOTS, 'tools-tab-list.png') : info.outputPath('tools-tab-list.png'),
  });

  // armed: the card replaces the list, with the way back above it
  await (await measureControl(win, 'survey-tool-area')).click();
  const armed = win.getByTestId('tools-armed');
  await expect(armed).toBeVisible();
  await expect(backToTools(win)).toBeVisible();
  await expect(win.getByTestId('survey-drawbar')).toBeVisible();
  await expect(panelSection(win, 'tools.view')).toHaveCount(0);
  await win.screenshot({
    path: SHOTS ? join(SHOTS, 'tools-tab-armed.png') : info.outputPath('tools-tab-armed.png'),
  });

  // Escape: the tool is put down and the list comes back
  await backToTools(win).focus();
  await win.keyboard.press('Escape');
  await expect(armed).toHaveCount(0);
  await expect(panelSection(win, 'tools.view')).toBeVisible();
  await expect(win.getByTestId('survey-tools')).toBeVisible();

  // Back to tools does the same
  await (await measureControl(win, 'survey-tool-area')).click();
  await expect(armed).toBeVisible();
  await backToTools(win).click();
  await expect(armed).toHaveCount(0);
  await expect(panelSection(win, 'tools.view')).toBeVisible();
});
