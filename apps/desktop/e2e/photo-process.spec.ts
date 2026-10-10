/**
 * Create maps from photos (M10 G4): choose the photos, then start. The one screen sums the photos
 * up and estimates for this computer, the run shows one list of steps in plain words with pause
 * and resume, cancel and resume, the maps start by themselves and come back as layers ("Your maps
 * are ready"), then the accuracy report and **Use refined poses**. What makes processing
 * impossible on this computer shows the moment the dialog opens, with the button that fixes it.
 *
 * Runs on the e2e stand-in pipelines (`e2e/photo-fake`, see `photoPack.ts`): the app's side of
 * processing. The real pipelines run in `photo-real.spec.ts` where this machine has their tools.
 * Needs the development Python (`uv sync` in python/, or QUADRION_E2E_PYTHON), except the blocked
 * states, which run nothing. Synthetic photos only; zero network.
 */
import type { Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { expect, hasPipelinePython, launchApp, test as plain, VENV_PYTHON } from './fixtures';
import {
  CAMERAS,
  chooseFolder,
  oldPackEnv,
  openOptions,
  openPhotoSite,
  openWizard,
  PHOTO_PLATFORM,
  PHOTO_PLATFORM_ONLY,
  photoFixtures,
  runId,
  startRun,
  type PhotoFixtures,
  type PhotoWorkerFixtures,
} from './photoPack';

const test = plain.extend<PhotoFixtures, PhotoWorkerFixtures>(photoFixtures);

/** Screenshots for a person to look at: only with QUADRION_E2E_SHOTS set to a folder. */
const SHOTS = process.env.QUADRION_E2E_SHOTS;
const shot = async (win: Page, name: string) => {
  if (SHOTS) await win.screenshot({ path: join(SHOTS, `${name}.png`) });
};

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

/** A step of the run in plain words: `read`, `match`, `map`, `model` or `add`. */
const phase = (win: Page, id: string) =>
  win.getByTestId('photo-phases').locator(`[data-phase="${id}"]`);

test.describe('on the stand-in pipelines', () => {
  test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);
  test.skip(!PHOTO_PLATFORM, PHOTO_PLATFORM_ONLY);

  test('choose photos and start: one screen, one run, and the maps come back as layers', async ({
    win,
  }) => {
    test.setTimeout(180_000);
    await openPhotoSite(win);
    const wizard = await openWizard(win);

    // one screen: the project's photos are already chosen, summed up in a line, with the time
    await expect(wizard.getByRole('button', { name: /Photos in this project/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(wizard.getByRole('combobox')).toContainText('Synthetic flight (12 photos)');
    await expect(wizard.getByTestId('photo-summary')).toHaveText(
      '12 photos, 1 camera, GPS on all',
      { timeout: 60_000 },
    );
    await expect(wizard.getByTestId('photo-estimate')).toContainText(
      /(About \d|Under a minute).* on this computer/,
    );
    await expect(wizard.getByTestId('photo-needs')).toContainText('of disk space and');
    // an ordinary flight on Standard: no question, no warning, nothing blocked, ready to start
    await expect(wizard.getByTestId('photo-blocked')).toHaveCount(0);
    for (const id of ['ask-disk', 'ask-time', 'ask-zone', 'photo-gps', 'photo-none'])
      await expect(wizard.getByTestId(id)).toHaveCount(0);
    await expect(wizard.locator('.notice')).toHaveCount(0);
    await expect(wizard.getByTestId('photo-missing')).toHaveText('');
    await expect(wizard.getByTestId('photo-start')).toBeEnabled();
    await expect(wizard.getByTestId('photo-start')).toHaveText('Create maps');
    // the plain words of the main view: no engine-room vocabulary
    const main = await wizard.evaluate((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelector('details')?.remove();
      return copy.textContent;
    });
    expect(main).not.toMatch(/photogrammetry|pipeline|align|products|warm laptop|GPU|CPU/i);
    await expectAccessible(win, 'create maps from photos', {
      include: '[data-testid="photo-wizard"]',
    });
    await shot(win, 'create-maps-ready');

    // every earlier choice is still there, under Options, with the same defaults
    const options = await openOptions(wizard);
    for (const name of ['Quick', 'Standard', 'High'])
      await expect(options.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
    await expect(options.getByRole('button', { name: /^Standard/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    for (const name of [
      'Orthomosaic',
      'Surface model (DSM)',
      'Terrain model (DTM)',
      'Point cloud',
      'Textured mesh',
    ])
      await expect(options.getByRole('checkbox', { name })).toBeChecked();
    await expect(options.getByRole('checkbox', { name: /^3D Tiles/ })).not.toBeChecked();
    await expect(options.getByRole('option', { name: /EPSG:32639/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(options).toContainText('The photos are in UTM zone 39N (EPSG:32639).');
    await expect(options.getByRole('radio', { name: /^Read each photo/ })).toBeChecked();
    await expect(options.getByTestId('photo-heights')).toContainText(
      'Every run states the heights',
    );
    await expect(
      options.getByRole('checkbox', { name: /ground control points/ }),
    ).not.toBeChecked();
    await expect(options.getByTestId('photo-groups')).toContainText(
      'Stratlas Synthetic SYN-20, 800 × 600 (12 photos)',
    );
    // what does the work is quiet detail, never a fault to fix
    await expect(options.getByTestId('photo-gpu')).toContainText(
      /Runs on the processor\. Graphics card acceleration is not available yet\.|used for High/,
    );
    await expect(options).not.toContainText('not installed');
    await expectAccessible(win, 'create maps from photos, options', {
      include: '[data-testid="photo-wizard"]',
    });
    await shot(win, 'create-maps-options');
    await wizard.getByTestId('photo-start').click();

    // one run, one list of steps in plain words; pause while matching, then resume from there
    const panel = win.getByTestId('photo-run');
    await expect(panel).toBeVisible();
    const run = await runId(win);
    await expect(phase(win, 'match')).toHaveAttribute('data-state', 'running', {
      timeout: 60_000,
    });
    await expect(phase(win, 'match')).toContainText('Matching photos');
    // the maps are part of the same run from the start
    await expect(phase(win, 'map')).toHaveAttribute('data-state', 'pending');
    await expect(phase(win, 'map')).toContainText('Building the map');
    await expect(phase(win, 'model')).toContainText('Building the 3D model');
    await shot(win, 'create-maps-running');
    await panel.getByRole('button', { name: 'Pause' }).click();
    await expect(panel.getByTestId('photo-job').locator('[data-status="cancelled"]')).toHaveText(
      'Paused',
      { timeout: 20_000 },
    );
    await expect(phase(win, 'read')).toHaveAttribute('data-state', 'done');
    await expect(phase(win, 'map')).toHaveAttribute('data-state', 'pending');
    await panel.getByRole('button', { name: 'Resume' }).click();
    // reading the photos is kept from before the pause
    await expect(phase(win, 'read')).toHaveAttribute('data-state', 'kept', { timeout: 20_000 });

    // the maps start by themselves and come back as layers
    const results = panel.getByTestId('photo-results');
    await expect(results).toContainText('Your maps are ready', { timeout: 60_000 });
    await expect(results).toContainText(`Processed mesh ${run}`);
    await expect(results.getByRole('button', { name: 'Show on map' })).toBeVisible();
    await expect(results.getByRole('button', { name: 'Show in 3D' })).toBeVisible();
    await expect(
      results.getByRole('button', { name: 'Improve accuracy with ground control points' }),
    ).toBeVisible();
    await expect
      .poll(async () => (await layers(win))?.map((l) => l.id))
      .toContain(`photo-${run}-mesh`);
    await expectAccessible(win, 'photo run, maps ready', { include: '[data-testid="photo-run"]' });
    await shot(win, 'create-maps-done');

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

    // the runs list in Jobs, and from the result straight to the map
    await panel.getByRole('button', { name: 'Close' }).click();
    const runs = win.getByTestId('photo-runs');
    await expect(runs.locator(`[data-run="${run}"]`)).toContainText('Done');
    await runs.locator(`[data-run="${run}"]`).getByRole('button', { name: 'Open run' }).click();
    await panel.getByRole('button', { name: 'Show on map' }).click();
    await expect(panel).toHaveCount(0);
    await expect(
      win.getByRole('group', { name: 'Stage view' }).getByRole('button', { name: 'Map' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test('cancel keeps the work, resume continues, and a photo job opens its run', async ({
    win,
  }) => {
    test.setTimeout(180_000);
    await openPhotoSite(win);
    const panel = await startRun(win);
    const run = await runId(win);
    await expect(phase(win, 'match')).toHaveAttribute('data-state', 'running', {
      timeout: 60_000,
    });
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel).toContainText('Cancelled. The work so far is kept', { timeout: 20_000 });
    // the maps queued at the start are dropped with the cancel
    await expect(phase(win, 'map')).toHaveCount(0);
    await panel.getByRole('button', { name: 'resume it' }).click();
    await expect(panel.getByRole('region', { name: 'Next steps' })).toContainText(
      'The photos are matched',
      { timeout: 60_000 },
    );
    await expect(phase(win, 'read')).toHaveAttribute('data-state', 'kept');
    // every stage of the job is still there for whoever wants it
    await panel.getByText('Every step').click();
    await expect(
      panel.getByRole('list', { name: 'Stages' }).getByRole('listitem').filter({
        hasText: 'Find features',
      }),
    ).toHaveAttribute('data-state', /skipped|done/);

    // from the Jobs list: the photo job reads in plain words and opens its run
    await panel.getByRole('button', { name: 'Close' }).click();
    await win
      .locator('.job-row', { hasText: 'Maps from photos: matching the photos' })
      .first()
      .click();
    await win.getByRole('button', { name: `Open run ${run}` }).click();
    await expect(win.getByTestId('photo-run')).toBeVisible();
    await expect(win.getByTestId('photo-run').getByRole('heading', { level: 2 })).toHaveText(
      `Photo run ${run}`,
    );
  });

  test('a short flight raises no warning at any quality', async ({ win }) => {
    test.setTimeout(120_000);
    await openPhotoSite(win);
    const wizard = await openWizard(win);
    await expect(wizard.getByTestId('photo-summary')).toBeVisible({ timeout: 60_000 });
    const options = await openOptions(wizard);
    await options.getByRole('button', { name: /^High/ }).click();
    await expect(options.getByRole('button', { name: /^High/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(wizard.getByTestId('photo-estimate')).toContainText('on this computer');
    // twelve small photos are quick at any quality: the long-run hint is for long runs only
    await expect(wizard.getByTestId('ask-time')).toHaveCount(0);
    await expect(wizard.locator('.notice')).toHaveCount(0);
    await expect(wizard.getByTestId('photo-start')).toBeEnabled();
  });

  test('a very long run says so once, with the quicker quality one click away', async ({
    app,
    win,
    dataRoot,
  }) => {
    test.setTimeout(120_000);
    // 2,000 photo heads of 108 megapixels without GPS (only the head of a photo is read for the
    // estimate): days of work at any quality, on any computer
    const flight = join(dataRoot.base, 'long flight');
    await mkdir(flight, { recursive: true });
    const [w, h] = [12000, 9000];
    const head = Buffer.from([
      0xff,
      0xd8,
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      h >> 8,
      h & 0xff,
      w >> 8,
      w & 0xff,
      0x03,
      0x01,
      0x22,
      0x00,
      0x02,
      0x11,
      0x01,
      0x03,
      0x11,
      0x01,
      0xff,
      0xd9,
    ]);
    for (let i = 0; i < 2000; i++)
      await writeFile(join(flight, `BIG_${String(i).padStart(4, '0')}.JPG`), head);

    await openPhotoSite(win);
    const wizard = await openWizard(win);
    await wizard.getByRole('button', { name: /Folders of photos/ }).click();
    // nothing chosen yet: the one thing missing is said beside the button, which waits
    await expect(wizard.getByTestId('photo-missing')).toHaveText(
      'Choose a folder of photos to begin.',
    );
    await expect(wizard.getByTestId('photo-start')).toBeDisabled();
    await chooseFolder(app, wizard, flight);
    await expect(wizard.getByTestId('photo-summary')).toHaveText(
      'About 2,000 photos, 1 camera, no GPS',
      { timeout: 60_000 },
    );
    // one hint about time, with the quicker quality and its own estimate
    const hint = wizard.getByTestId('ask-time');
    await expect(hint).toHaveText(
      /^Standard takes about .+ on this computer\. Quick: about .+\.\s*Use Quick$/,
    );
    // no GPS at all is said in plain words; nothing else: no boilerplate, no second copy
    await expect(wizard.getByTestId('photo-gps')).toContainText(
      'These photos have no GPS position.',
    );
    await expect(wizard).not.toContainText(/warm laptop|Times are a range|expect a long run/);
    await expect(wizard.getByTestId('photo-start')).toBeEnabled();
    await shot(win, 'create-maps-questions');

    // with Options open the hint sits beside the quality it is about, still only once
    const options = await openOptions(wizard);
    await expect(options.getByTestId('ask-time')).toHaveCount(1);
    await expect(wizard.getByTestId('ask-time')).toHaveCount(1);
    await hint.getByRole('button', { name: 'Use Quick' }).click();
    await expect(options.getByRole('button', { name: /^Quick/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Quick is the quickest there is: nothing is left to switch to (and on a computer with many
    // cores it is no longer a long run, so the hint goes)
    await expect(hint.getByRole('button')).toHaveCount(0);
    await expect(wizard.getByTestId('photo-estimate')).toContainText('on this computer');
  });
});

// the plain fixtures: no pack at all, so nothing here needs the pipeline Python
plain.describe('when this computer cannot create maps', () => {
  plain(
    'the dialog says so first, in place of the form, with the one button that fixes it',
    async ({ win }) => {
      // the plain fixtures have no pack at all; the tiny project is enough to open the dialog
      await win.getByTestId('project-card').first().click();
      const wizard = await openWizard(win);
      const blocked = wizard.getByTestId('photo-blocked');
      await expect(blocked).toBeVisible();
      // in place of the form: nothing to fill in, no second copy of the message, no dead Start
      await expect(wizard.getByTestId('photo-start')).toHaveCount(0);
      await expect(wizard.getByTestId('photo-options')).toHaveCount(0);
      await expect(wizard.locator('.notice, .b-foot')).toHaveCount(0);
      await expect(blocked.locator('p')).toHaveCount(1);
      await expect(wizard).not.toContainText(/pipeline pack/i);
      await expectAccessible(win, 'create maps from photos, blocked', {
        include: '[data-testid="photo-wizard"]',
      });
      const fix = blocked.getByRole('button', { name: 'Update processing tools' });
      if (!PHOTO_PLATFORM) {
        // an Intel Mac, Windows on Arm, Linux: nothing on this computer fixes it, so no button
        await expect(blocked).toContainText('This computer cannot create maps from photos');
        await expect(blocked).toContainText('Windows x64 and on Macs with Apple silicon');
        await expect(fix).toHaveCount(0);
        await blocked.getByRole('button', { name: 'Close' }).click();
        await expect(wizard).toHaveCount(0);
        return;
      }
      await expect(blocked).toContainText('The processing tools are not installed');
      await expect(blocked).toContainText('needs the processing tools, version 0.4.0 or later');
      await fix.click();
      await expect(wizard).toHaveCount(0);
      // Settings, on the page that shows this computer's processing tools
      await expect(win.locator('.screen.settings')).toBeVisible();
      await expect(win.getByTestId('pipeline-pack')).toBeVisible();
    },
  );

  plain(
    'with processing tools that are too old it asks for the update before anything is chosen',
    async ({ dataRoot, network }) => {
      // where the computer itself cannot process photos, that comes before the tools' version
      plain.skip(!PHOTO_PLATFORM, PHOTO_PLATFORM_ONLY);
      const dir = await mkdtemp(join(tmpdir(), 'aio-old-pack-'));
      const app = await launchApp(dataRoot, await oldPackEnv(dir));
      await network.attach(app);
      try {
        const win = await app.firstWindow();
        await win.getByTestId('project-card').first().click();
        const wizard = await openWizard(win);
        const blocked = wizard.getByTestId('photo-blocked');
        await expect(blocked).toContainText('The processing tools need an update');
        await expect(blocked).toContainText(
          'too old to create maps from photos. Update them to version 0.4.0 or later.',
        );
        await expect(
          blocked.getByRole('button', { name: 'Update processing tools' }),
        ).toBeVisible();
        await expect(wizard.getByTestId('photo-start')).toHaveCount(0);
        await expect(wizard.getByTestId('photo-drop')).toHaveCount(0);
        await shot(win, 'create-maps-blocked');
        expect(await network.outbound()).toEqual([]);
      } finally {
        await app.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
