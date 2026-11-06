/**
 * Layout presets per project type (UI revision W13, D7), in the window CI runs: the demo tank farm
 * (a survey project with piles, two survey dates and a drone clip) opens on Project > Volumes with
 * the volume strip and its video docked as a tile; the demo access road opens on Map with the
 * chainage strip and Project > Road; the person's changes are remembered for the project, and
 * "Reset layout to project defaults" (the foot of Layers & display, and the palette) restores the
 * defaults. Presets never gate: the road project still lists the Measure tools.
 *
 * Needs the demos (`pnpm demo:build --quick`), or QUADRION_E2E_DEMO.
 */
import type { Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_FOLDER, expect, openProject, test } from './fixtures';
import { island, stageMode, stageModeButton } from './island';
import { panelSection, panelTab } from './panel';

const READY = { timeout: 60_000 };

test.skip(
  !existsSync(join(DEMO_FOLDER, 'demo-tank-farm', 'manifest.json')),
  `no demos in ${DEMO_FOLDER}: run pnpm demo:build --quick`,
);
test.use({ appEnv: { QUADRION_DEMO: DEMO_FOLDER } });

async function open(win: Page, name: string, id: string): Promise<void> {
  await win.locator('.sb-nav .nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: name }).first().click();
  await expect.poll(async () => (await openProject(win)).id, READY).toBe(id);
}

/** What this computer remembers of the open project's layout (`quadrion.layout.<projectId>`). */
const savedLayout = (win: Page): Promise<unknown> =>
  win.evaluate(() => {
    const id = (
      window as unknown as {
        __stratlas: { workspace: { getState(): { project: { id: string } | null } } };
      }
    ).__stratlas.workspace.getState().project?.id;
    const raw = id ? localStorage.getItem(`quadrion.layout.${id}`) : null;
    return raw === null ? null : (JSON.parse(raw) as unknown);
  });

const strip = (win: Page) => win.locator('[data-testid="bottom-strip"] .tl-wrap');
const docked = (win: Page) => win.locator('[data-testid="video-dock"][data-mode="docked"]');

/** The tank farm's defaults: Project > Volumes, the volume strip, 3D, the tile docked. */
async function expectSurveyDefaults(win: Page): Promise<void> {
  await expect(panelTab(win, 'project')).toHaveAttribute('aria-selected', 'true', READY);
  const volumes = panelSection(win, 'project.volumes');
  await expect(volumes).toHaveAttribute('data-open', 'true', READY);
  // Volumes leads Project's sections
  await expect(
    win.locator('[data-testid="panel-sections-project"] > .wb-psec').first(),
  ).toHaveAttribute('data-section', 'project.volumes');
  // the volume strip: the dates chart in its Volume mode
  await expect(strip(win)).toHaveAttribute('data-bottom', 'dates', READY);
  await expect(win.getByRole('button', { name: 'Volume', exact: true }).first()).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(await stageModeButton(win, '3D')).toHaveAttribute('aria-pressed', 'true');
  // a survey project with video docks the tile
  await expect(docked(win)).toBeVisible(READY);
}

test('the demo tank farm opens on Project > Volumes with the volume strip', async ({ win }) => {
  test.setTimeout(150_000);
  await open(win, 'Demo tank farm', 'demo-tank-farm');
  await expectSurveyDefaults(win);
});

test('a survey project with video docks the tile, and Reset layout restores the defaults', async ({
  win,
}) => {
  test.setTimeout(180_000);
  await open(win, 'Demo tank farm', 'demo-tank-farm');
  await expectSurveyDefaults(win);

  // the person moves away from every default
  await panelTab(win, 'tools').click();
  // the tile pops out (the strip's one button where it is too narrow for the tile)
  await win
    .locator('[data-testid="video-popout"]:visible, [data-testid="video-popout-compact"]:visible')
    .first()
    .click();
  await expect(win.getByTestId('video-window')).toBeVisible(READY);
  await expect(docked(win)).toHaveCount(0);
  await stageMode(win, 'Map');
  await expect.poll(() => savedLayout(win)).toMatchObject({ rightTab: 'tools', stage: 'map' });

  // Reset, at the foot of Layers & display
  await panelTab(win, 'layers').click();
  const reset = win.getByTestId('layout-reset');
  await reset.scrollIntoViewIfNeeded();
  await expect(reset).toHaveText('Reset layout to project defaults');
  await reset.click();
  await expectSurveyDefaults(win);
  expect(await savedLayout(win)).toBeNull();

  // and from the palette
  await panelTab(win, 'selection').click();
  await win.keyboard.press('Control+k');
  await win.keyboard.type('Reset layout');
  await expect(win.getByRole('option', { name: /Reset layout to project defaults/ })).toBeVisible();
  await win.keyboard.press('Enter');
  await expect(panelTab(win, 'project')).toHaveAttribute('aria-selected', 'true', READY);
});

test('the demo road opens on chainage and Map, and keeps every tool', async ({ win }) => {
  test.setTimeout(150_000);
  await open(win, 'Demo access road', 'demo-access-road');
  await expect(strip(win)).toHaveAttribute('data-bottom', 'road', READY);
  await expect(win.locator('.maplibregl-canvas').first()).toBeVisible(READY);
  await expect(await stageModeButton(win, 'Map')).toHaveAttribute('aria-pressed', 'true');
  await expect(panelTab(win, 'project')).toHaveAttribute('aria-selected', 'true');
  await expect(panelSection(win, 'project.road')).toHaveAttribute('data-open', 'true', READY);
  await expect(island(win)).toBeVisible();
  // a preset orders, it never gates: Tools leads with Road and still lists Measure
  await panelTab(win, 'tools').click();
  const tools = win.locator('[data-testid="panel-sections-tools"] > .wb-psec');
  await expect(tools.first()).toHaveAttribute('data-section', 'tools.road');
  await expect(panelSection(win, 'tools.measure')).toBeVisible();
});
