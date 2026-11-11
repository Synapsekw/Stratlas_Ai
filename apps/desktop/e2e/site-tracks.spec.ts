/**
 * Tracks across survey dates (Wave 3 M2) in the real app, on a synthetic project: the RF fixture's
 * tiny project and tower (`rfFixtures.ts`, no real site or operator) with two survey dates. Each
 * date has its record of what it measured, `telecom/history/<capture>.json`: P1 at azimuth 4
 * degrees on the earlier date and 12 degrees on the later one. The live inventory
 * `telecom/antennas.json` is the later date's and, as the re-run merge does for an accepted unit
 * whose new fit has less support, still holds P1's earlier 4 degrees; the track must read the later
 * date's own fit. P1 was a fresh draft in the later record and the person accepted it since, so it
 * counts as reviewed on that date. Selecting P1 in Project > In this project shows its track in the
 * details card (two dates, last change +8.0 degrees), and the site digest names the turn
 * (`antenna-turned`). The other units did not move, so they raise nothing. Without a record of the
 * live date (a run on an older pack), the card says what tracks need instead.
 *
 * Hot spots and change regions are covered by the unit tests (`packages/change/src/tracks.test.ts`,
 * `packages/insights/src/trackRules.test.ts`, `siteTracks.test.ts`): a hot spot track needs placed
 * thermal detections on two photo dates (the thermal fixture has one date and runs the pipeline
 * Python), and a region track needs change sets of two consecutive pairs (the change demo has one).
 */
import { AntennaHistoryFile, AntennasFile, ProjectManifest } from '@aio/schema';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, reportWindow, test } from './fixtures';
import { openSection } from './panel';
import { rfAntennas, writeRfProject } from './rfFixtures';
import { projectAntennas } from './telecomFixtures';

const EARLIER = { id: 'survey-2026-03-02', label: '2 Mar 2026', date: '2026-03-02' };
const LATER = { id: 'survey-2026-06-08', label: '8 Jun 2026', date: '2026-06-08' };
const UNIT = 'ant-p1';

/** The fixture's inventory as the later date's live file: every unit accepted, P1 at 4 degrees. */
function liveInventory(): AntennasFile {
  const file = rfAntennas();
  return AntennasFile.parse({
    ...file,
    run: {
      ...file.run,
      id: `run-${LATER.id}`,
      params: { run: `run-${LATER.id}` },
      captureId: LATER.id,
    },
    units: file.units.map((u) =>
      u.id === UNIT
        ? {
            ...u,
            status: 'accepted' as const,
            azimuthGridDeg: {
              value: 4,
              basis: 'measured' as const,
              quality: {
                basis: 'measured' as const,
                residualM: 0.004,
                support: 900,
                coverage: 0.8,
              },
            },
          }
        : u,
    ),
  });
}

/** What `capture` measured: the fixture's units, P1 at `azimuthDeg` with `status` and `reviewed`. */
function recordAt(
  capture: string,
  azimuthDeg: number,
  p1: { status: 'draft' | 'accepted'; reviewed: boolean },
): AntennaHistoryFile {
  const live = liveInventory();
  return AntennaHistoryFile.parse({
    schema: 'aio.antenna-history/1',
    captureId: capture,
    runId: `run-${capture}`,
    at: `${capture.slice(-10)}T09:00:00Z`,
    units: live.units.map((u) => ({
      id: u.id,
      name: u.name,
      kind: u.kind,
      status: u.id === UNIT ? p1.status : u.status,
      reviewed: u.id === UNIT ? p1.reviewed : true,
      centre: u.box.centre,
      extents: u.box.extents,
      ...(u.id === UNIT
        ? { azimuthGridDeg: azimuthDeg }
        : u.azimuthGridDeg
          ? { azimuthGridDeg: u.azimuthGridDeg.value }
          : {}),
      ...(u.downtiltDeg ? { downtiltDeg: u.downtiltDeg.value } : {}),
    })),
  });
}

async function writeTwoDateAntennas(dir: string, recordLater = true): Promise<void> {
  await writeRfProject(dir, { cloud: true });
  const manifest = ProjectManifest.parse(
    JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')),
  );
  manifest.captures = [EARLIER, LATER];
  // each date holds a layer of its own (the Project tab's digest needs two dates to compare)
  for (const l of manifest.layers) l.capture = l.id === 'tower-cloud' ? LATER.id : EARLIER.id;
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(ProjectManifest.parse(manifest)));
  await writeFile(join(dir, 'telecom', 'antennas.json'), JSON.stringify(liveInventory()));
  const history = join(dir, 'telecom', 'history');
  await mkdir(history, { recursive: true });
  await writeFile(
    join(history, `${EARLIER.id}.json`),
    JSON.stringify(recordAt(EARLIER.id, 4, { status: 'accepted', reviewed: true })),
  );
  if (recordLater)
    await writeFile(
      join(history, `${LATER.id}.json`),
      JSON.stringify(recordAt(LATER.id, 12, { status: 'draft', reviewed: false })),
    );
}

async function openP1(win: Parameters<typeof reportWindow>[0]) {
  await reportWindow(win);
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
  const group = await projectAntennas(win);
  await group.getByTestId('antenna-filter-all').click();
  const row = group.locator(`[data-row-id="${UNIT}"] [data-testid="antenna-row"]`);
  await row.click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  const details = win.getByTestId('antenna-details');
  await expect(details).toBeVisible();
  return details;
}

test.describe('tracks across survey dates', () => {
  test('a turned antenna shows its track in the details card and in the site digest', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(120_000);
    await writeTwoDateAntennas(dataRoot.projectDir);
    // select P1 in Project > In this project: its card shows the track over both dates
    const details = await openP1(win);
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

  test('without a record of the live date the card says what tracks need', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(120_000);
    await writeTwoDateAntennas(dataRoot.projectDir, false);
    const details = await openP1(win);
    await expect(details.getByTestId('antenna-track-hint')).toContainText('0.35.0');
    await expect(details.getByTestId('antenna-track')).toHaveCount(0);
  });
});
