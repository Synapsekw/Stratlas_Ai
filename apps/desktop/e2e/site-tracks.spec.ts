/**
 * Tracks across survey dates (Wave 3 M2) in the real app, on a synthetic project: the RF fixture's
 * tiny project and tower (`rfFixtures.ts`, no real site or operator) with two survey dates. The
 * live inventory `telecom/antennas.json` is the later date's (`run.captureId`), with panel P1 at
 * azimuth 12 degrees; its copy for the earlier date, `telecom/history/<capture>.json`, has the
 * same unit at 4 degrees. Both are accepted. Selecting P1 in Project > In this project shows its
 * track in the details card (two dates, last change +8.0 degrees), and the site digest names the
 * turn (`antenna-turned`). The other units did not move, so they raise nothing.
 *
 * Hot spots and change regions are covered by the unit tests (`packages/change/src/tracks.test.ts`,
 * `packages/insights/src/trackRules.test.ts`, `siteTracks.test.ts`): a hot spot track needs placed
 * thermal detections on two photo dates (the thermal fixture has one date and runs the pipeline
 * Python), and a region track needs change sets of two consecutive pairs (the change demo has one).
 */
import { AntennasFile, ProjectManifest } from '@aio/schema';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, reportWindow, test } from './fixtures';
import { openSection } from './panel';
import { rfAntennas, writeRfProject } from './rfFixtures';
import { projectAntennas } from './telecomFixtures';

const EARLIER = { id: 'survey-2026-03-02', label: '2 Mar 2026', date: '2026-03-02' };
const LATER = { id: 'survey-2026-06-08', label: '8 Jun 2026', date: '2026-06-08' };
const UNIT = 'ant-p1';

/** The fixture's inventory filed under `capture`, with P1 at `azimuthDeg`. */
function inventoryAt(capture: string, azimuthDeg: number, at: string): AntennasFile {
  const file = rfAntennas();
  return AntennasFile.parse({
    ...file,
    run: {
      ...file.run,
      id: `run-${capture}`,
      at,
      params: { run: `run-${capture}` },
      captureId: capture,
    },
    units: file.units.map((u) =>
      u.id === UNIT
        ? {
            ...u,
            azimuthGridDeg: {
              value: azimuthDeg,
              basis: 'measured' as const,
              quality: {
                basis: 'measured' as const,
                residualM: 0.004,
                support: 900,
                coverage: 0.8,
              },
            },
            runId: `run-${capture}`,
          }
        : { ...u, runId: `run-${capture}` },
    ),
  });
}

async function writeTwoDateAntennas(dir: string): Promise<void> {
  await writeRfProject(dir, { cloud: true });
  const manifest = ProjectManifest.parse(
    JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')),
  );
  manifest.captures = [EARLIER, LATER];
  // each date holds a layer of its own (the Project tab's digest needs two dates to compare)
  for (const l of manifest.layers) l.capture = l.id === 'tower-cloud' ? LATER.id : EARLIER.id;
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(ProjectManifest.parse(manifest)));
  await writeFile(
    join(dir, 'telecom', 'antennas.json'),
    JSON.stringify(inventoryAt(LATER.id, 12, '2026-06-08T09:00:00Z')),
  );
  await mkdir(join(dir, 'telecom', 'history'), { recursive: true });
  await writeFile(
    join(dir, 'telecom', 'history', `${EARLIER.id}.json`),
    JSON.stringify(inventoryAt(EARLIER.id, 4, '2026-03-02T09:00:00Z')),
  );
}

test.describe('tracks across survey dates', () => {
  test('a turned antenna shows its track in the details card and in the site digest', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(120_000);
    await writeTwoDateAntennas(dataRoot.projectDir);
    await reportWindow(win);
    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
    await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();

    // select P1 in Project > In this project: its card shows the track over both dates
    const group = await projectAntennas(win);
    await group.getByTestId('antenna-filter-all').click();
    const row = group.locator(`[data-row-id="${UNIT}"] [data-testid="antenna-row"]`);
    await row.click();
    await expect(row).toHaveAttribute('aria-selected', 'true');
    const details = win.getByTestId('antenna-details');
    await expect(details).toBeVisible();
    const track = details.getByTestId('antenna-track');
    await expect(track).toBeVisible();
    const rows = track.getByTestId('antenna-track-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('data-capture', EARLIER.id);
    await expect(rows.nth(1)).toHaveAttribute('data-capture', LATER.id);
    await expect(rows.nth(0)).toContainText('4.0°');
    await expect(rows.nth(1)).toContainText('12.0°');
    // the sighting being looked at is the live one, on the later date
    await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(track.getByTestId('antenna-track-change')).toContainText('+8.0°');

    // the site digest names the turn, and only for P1
    await openSection(win, 'project', 'project.digest');
    const digest = win.getByTestId('site-digest');
    await expect(digest).toBeVisible();
    const turned = digest.locator('[data-testid="site-digest-item"][data-rule="antenna-turned"]');
    await expect(turned).toHaveCount(1);
    await expect(turned).toContainText('P1');
    await expect(turned).toContainText('8.0');
  });
});
