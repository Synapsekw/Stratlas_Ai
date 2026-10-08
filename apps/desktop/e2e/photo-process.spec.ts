/**
 * Process photos in the Builder (M10 G4): the wizard estimates for this computer, alignment runs
 * with progress per stage, pause and resume, cancel and resume, the products the wizard chose
 * start by themselves and come back as layers, the accuracy report and **Use refined poses**.
 *
 * Runs on the e2e stand-in pipelines (`e2e/photo-fake`, see `photoPack.ts`): the app's side of
 * processing. The real pipelines run in `photo-real.spec.ts` where this machine has their tools. Needs the development Python
 * (`uv sync` in python/, or QUADRION_E2E_PYTHON). Synthetic photos only; zero network.
 */
import type { Page } from '@playwright/test';
import { expectAccessible } from './a11y';
import { expect, hasPipelinePython, test as base, VENV_PYTHON } from './fixtures';
import {
  CAMERAS,
  openPhotoSite,
  openWizard,
  photoFixtures,
  runId,
  startRun,
  type PhotoFixtures,
  type PhotoWorkerFixtures,
} from './photoPack';

const test = base.extend<PhotoFixtures, PhotoWorkerFixtures>(photoFixtures);

test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

interface Probe {
  __stratlas: {
    workspace: {
      getState(): {
        project: {
          manifest: {
            layers: { id: string; kind: string; items?: { id: string; pos?: number[] }[] }[];
          };
        } | null;
      };
    };
  };
}

const layers = (win: Page) =>
  win.evaluate(() =>
    (window as unknown as Probe).__stratlas.workspace
      .getState()
      .project?.manifest.layers.map((l) => ({ id: l.id, kind: l.kind, items: l.items ?? [] })),
  );

/** The stage row of the run panel's current job. */
const stage = (win: Page, name: string) =>
  win.getByTestId('photo-job').getByRole('listitem').filter({ hasText: name });

test('the wizard estimates, alignment pauses and resumes, and the products come back as layers', async ({
  win,
}) => {
  test.setTimeout(180_000);
  await openPhotoSite(win);
  const wizard = await openWizard(win);

  // photos: the project's photos layer is offered first
  await expect(wizard.getByRole('button', { name: /A photos layer/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(wizard.getByRole('combobox')).toContainText('Synthetic flight (12 photos)');
  await wizard.getByRole('button', { name: 'Next' }).click();

  // cameras: one group, read from the photos' EXIF
  await expect(wizard.getByTestId('photo-groups')).toContainText(
    'Stratlas Synthetic SYN-20, 800 × 600 (12 photos)',
  );
  await wizard.getByRole('button', { name: 'Next' }).click();

  // place and heights: the project CRS, and the zone the photos are in
  await expect(wizard.getByRole('option', { name: /EPSG:32639/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(wizard).toContainText('The photos are in UTM zone 39N (EPSG:32639).');
  await expect(wizard.getByTestId('photo-heights')).toContainText('Heights:');
  await wizard.getByRole('button', { name: 'Next' }).click();

  // quality: three presets in plain words, Balanced by default
  for (const name of ['Quick', 'Balanced', 'High'])
    await expect(wizard.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  await expect(wizard.getByRole('button', { name: /^Balanced/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await wizard.getByRole('button', { name: 'Next' }).click();

  // estimate: this computer, the GPU line, time, disk and memory
  await expect(wizard.getByTestId('photo-probe')).toContainText('Photo processing: available');
  await expect(wizard.getByTestId('photo-gpu')).toContainText(/CPU only|used for High/);
  await expect(wizard.getByTestId('photo-estimate')).toContainText(/About \d/);
  await expectAccessible(win, 'process photos wizard', { include: '[data-testid="photo-wizard"]' });
  await wizard.getByTestId('photo-start').click();

  // progress per stage; pause during matching, then resume from there
  const panel = win.getByTestId('photo-run');
  await expect(panel).toBeVisible();
  const run = await runId(win);
  await expect(stage(win, 'Find features')).toHaveAttribute('data-state', 'running', {
    timeout: 60_000,
  });
  await panel.getByRole('button', { name: 'Pause' }).click();
  await expect(panel.getByTestId('photo-job').locator('[data-status="cancelled"]')).toHaveText(
    'Paused',
    { timeout: 20_000 },
  );
  await expect(stage(win, 'Read photos')).toHaveAttribute('data-state', 'done');
  await expect(panel.getByTestId('photo-pending')).toContainText('when the alignment finishes');
  await panel.getByRole('button', { name: 'Resume' }).click();
  // the read stage is kept from before the pause
  await expect(stage(win, 'Read photos')).toHaveAttribute('data-state', 'skipped', {
    timeout: 20_000,
  });

  // the queued products start by themselves and add a layer
  await expect(panel.getByTestId('photo-results')).toContainText(`Processed mesh ${run}`, {
    timeout: 60_000,
  });
  await expect
    .poll(async () => (await layers(win))?.map((l) => l.id))
    .toContain(`photo-${run}-mesh`);
  await expectAccessible(win, 'photo run progress', { include: '[data-testid="photo-run"]' });

  // accuracy without ground control says so
  await panel.getByRole('tab', { name: 'Accuracy' }).click();
  await expect(panel.getByTestId('accuracy-headline')).toContainText('GNSS only');
  await expect(panel.getByTestId('overlap-map')).toBeVisible();
  await expectAccessible(win, 'accuracy report (GNSS only)', {
    include: '[data-testid="photo-run"]',
  });

  // refined poses: a preview first, then the move on the person's word
  await panel.getByRole('tab', { name: 'Refined poses' }).click();
  await expect(panel.getByTestId('poses-preview')).toContainText('12 cameras move by');
  await panel.getByRole('button', { name: 'Use refined poses' }).click();
  await panel.getByRole('button', { name: 'Move the cameras' }).click();
  await expect(panel.getByTestId('poses-applied')).toBeVisible();
  await expect
    .poll(async () => {
      const photos = (await layers(win))?.find((l) => l.id === 'photos');
      return photos?.items.find((i) => i.id === CAMERAS[0]?.id)?.pos?.[0];
    })
    .toBeCloseTo((CAMERAS[0]?.pos[0] ?? 0) + 0.05, 6);
  await expectAccessible(win, 'refined poses', { include: '[data-testid="photo-run"]' });

  // the runs list in Jobs
  await panel.getByRole('button', { name: 'Close' }).click();
  const runs = win.getByTestId('photo-runs');
  await expect(runs.locator(`[data-run="${run}"]`)).toContainText('Done');
});

test('cancel keeps the work, resume continues, and a photo job opens its run', async ({ win }) => {
  test.setTimeout(180_000);
  await openPhotoSite(win);
  const panel = await startRun(win);
  const run = await runId(win);
  await expect(stage(win, 'Match photos')).toHaveAttribute('data-state', 'running', {
    timeout: 60_000,
  });
  await panel.getByRole('button', { name: 'Cancel' }).click();
  await expect(panel).toContainText('Cancelled. The work so far is kept', { timeout: 20_000 });
  // the products the wizard queued are dropped with the cancel
  await expect(panel.getByTestId('photo-pending')).toHaveCount(0);
  await panel.getByRole('button', { name: 'resume it' }).click();
  await expect(panel.getByRole('region', { name: 'Next steps' })).toContainText(
    'The photos are aligned',
    { timeout: 60_000 },
  );
  await expect(stage(win, 'Find features')).toHaveAttribute('data-state', 'skipped');

  // from the Jobs list: the photo job opens its run
  await panel.getByRole('button', { name: 'Close' }).click();
  await win.locator('.job-row', { hasText: 'Align photos' }).first().click();
  await win.getByRole('button', { name: `Open run ${run}` }).click();
  await expect(win.getByTestId('photo-run')).toBeVisible();
  await expect(win.getByTestId('photo-run').getByRole('heading', { level: 2 })).toHaveText(
    `Photo run ${run}`,
  );
});
