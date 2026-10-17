/** Antenna detection in the real app: a synthetic tower cloud, the real pipeline job, a reload. */
import type { EngineStage } from '@aio/engine';
import { AntennasFile } from '@aio/schema';
import type { Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { PIPELINE_ENV, expect, hasPipelinePython, processingChip, test } from './fixtures';
import { writeTelecomTower } from './telecomFixtures';

interface Inspect {
  __stratlas: { stage(): EngineStage | null };
}

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), 'needs the pipeline Python (uv sync --frozen in python/)');

/**
 * Screenshots for a person to look at, only when AIO_EVIDENCE_DIR names a folder (never on CI);
 * the assertions never depend on them.
 */
const EVIDENCE = process.env.AIO_EVIDENCE_DIR;

async function evidence(win: Page, name: string): Promise<void> {
  if (!EVIDENCE) return;
  await mkdir(EVIDENCE, { recursive: true });
  await win.screenshot({ path: join(EVIDENCE, `${name}.png`) });
}

async function openTiny(win: Page) {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
}

/** Look at the crown of the synthetic tower (units about 26 to 29 m up). */
async function viewCrown(win: Page) {
  await win.evaluate(() => {
    (window as unknown as Inspect).__stratlas
      .stage()
      ?.restoreView({ position: [9, 31, 9], target: [0, 27.5, 0] }, false);
  });
}

/** How far the telecom tools' content reaches past their width, in CSS pixels. */
const horizontalOverflow = (win: Page) =>
  win.getByTestId('telecom-tools').evaluate((el) => el.scrollWidth - el.clientWidth);

/** Whether the Detect antennas button lies wholly inside the visible part of the telecom tools. */
const detectInView = (win: Page) =>
  win.getByTestId('detect-antennas').evaluate((button) => {
    const tools = button.closest('[data-testid="telecom-tools"]');
    if (!tools) return false;
    const b = button.getBoundingClientRect();
    const t = tools.getBoundingClientRect();
    return (
      b.left >= t.left &&
      b.right <= t.left + tools.clientWidth &&
      b.top >= t.top &&
      b.bottom <= t.top + tools.clientHeight
    );
  });

const sceneHas = (win: Page, name: string) =>
  win.evaluate(
    (n) => Boolean((window as unknown as Inspect).__stratlas.stage()?.scene.getObjectByName(n)),
    name,
  );

test('hides Detect antennas in a project without a point cloud', async ({ win }) => {
  await openTiny(win);
  await expect(win.getByTestId('telecom-tools')).toBeVisible();
  await expect(win.getByTestId('detect-antennas')).toHaveCount(0);
});

test('detects antennas, accepts one and keeps it after a reload', async ({ win, dataRoot }) => {
  test.setTimeout(300_000);
  await writeTelecomTower(dataRoot.projectDir);
  await openTiny(win);
  const detect = win.getByTestId('detect-antennas');
  await expect(detect).toBeVisible();
  // disabled with a reason while the cloud loads
  await expect(detect).toBeEnabled({ timeout: 60_000 });
  expect(await detectInView(win), 'Detect antennas is not clipped').toBe(true);
  await evidence(win, 'a-telecom-tools-detect-button');

  await detect.click();
  if (await processingChip(win).isVisible()) await evidence(win, 'b-job-running');

  const panel = win.getByTestId('antenna-panel');
  const rows = panel.getByTestId('antenna-row');
  await expect.poll(() => rows.count(), { timeout: 180_000 }).toBeGreaterThanOrEqual(3);
  await expect(panel).toContainText('Project north');
  await expect(detect).toBeEnabled();
  await viewCrown(win);
  await evidence(win, 'c-inventory-after-run');
  // select the first unit: its row, the halo in 3D and the details
  const first = rows.first();
  await first.focus();
  await win.keyboard.press('Enter');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => sceneHas(win, 'antenna-highlight')).toBe(true);
  await expect(panel.getByTestId('antenna-accept')).toBeVisible();
  await evidence(win, 'd-unit-selected');
  // at the CI size the tools scroll up and down inside the aside, never sideways
  await expect.poll(() => horizontalOverflow(win)).toBeLessThanOrEqual(0);
  await panel.getByTestId('antenna-accept').scrollIntoViewIfNeeded();
  await evidence(win, 'd-unit-details');

  await first.getByRole('button', { name: /^More for / }).click();
  await win.getByRole('menuitem', { name: 'Accept' }).click();
  await expect(first).toHaveAttribute('data-status', 'accepted');
  await expectAccessible(win, 'Antenna inventory', { include: '[data-testid="antenna-panel"]' });

  await win.reload();
  await expect(
    win.locator('[data-testid="project-card"], [data-scene-view] canvas').first(),
  ).toBeVisible();
  if (await win.getByTestId('project-card').first().isVisible()) await openTiny(win);
  const reopened = win.getByTestId('antenna-panel').getByTestId('antenna-row');
  await expect(reopened.first()).toHaveAttribute('data-status', 'accepted');
  await expect(win.getByTestId('antenna-panel')).toContainText('Accepted');
  await viewCrown(win);
  await evidence(win, 'e-accepted-after-reload');

  const saved = AntennasFile.parse(
    JSON.parse(await readFile(join(dataRoot.projectDir, 'telecom', 'antennas.json'), 'utf8')),
  );
  expect(saved.units.filter((u) => u.status === 'accepted')).toHaveLength(1);
});
